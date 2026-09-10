import sharp from 'sharp';
import { ASPECT_RATIO_FONT_REGISTRY, resolveRuntimeAsset } from './aspectRatioTemplate.js';

/**
 * Deterministic weight matching for the Aspect Ratio card copy.
 *
 * The extraction model classifies the source's face by eye against a rendered
 * catalog. Measured against inputs whose face was known it scored 1 of 6 and
 * put nearly everything on Bold — by the time the source has been downscaled
 * into the request, the stroke difference between Light and Black is not there
 * to see. Stroke weight is a measurement, not a judgement call.
 *
 * The metric is the ratio between the average run of ink and the average gap
 * between ink on the same scanline. A heavier face thickens its stems and eats
 * into its counters, so the ratio climbs monotonically Light → Black. Being a
 * ratio of two lengths measured on the same rows, it does not care how large
 * the source card was, how the copy wrapped, or how tightly the copy block was
 * cropped — the three things that broke every size-normalised metric tried
 * before it.
 *
 * Candidates are the six Cabify Ciudad faces. That is not a shortcut: the
 * typography system reserves Cabify Ciudad Text for CTA labels and UI, and the
 * copy this compositor renders is the promotional headline.
 */

const CARD_COPY_FONT_IDS = Object.freeze(
  Object.keys(ASPECT_RATIO_FONT_REGISTRY).filter((fontId) => !fontId.includes('-text-')),
);

const channelDistance = (data, offset, colour) => Math.max(
  Math.abs(data[offset] - colour[0]),
  Math.abs(data[offset + 1] - colour[1]),
  Math.abs(data[offset + 2] - colour[2]),
);

/**
 * Ink is whatever crosses the halfway point between the panel colour and the
 * copy colour. A fixed threshold read every face a step heavy: sitting below
 * the midpoint, it counted JPEG-softened edge as stroke. The 50% contour is
 * where the glyph edge is, and a symmetric blur leaves it in place.
 */
const buildInkMask = (data, info, background, foreground) => {
  const span = foreground
    ? Math.max(
      Math.abs(foreground[0] - background[0]),
      Math.abs(foreground[1] - background[1]),
      Math.abs(foreground[2] - background[2]),
    )
    : 0;
  const threshold = span > 40 ? span / 2 : 90;
  const mask = new Uint8Array(info.width * info.height);
  for (let offset = 0, pixel = 0; offset < data.length; offset += info.channels, pixel += 1) {
    mask[pixel] = channelDistance(data, offset, background) >= threshold ? 1 : 0;
  }
  return mask;
};

const MIN_RUNS = 30;

/**
 * Average ink run over average interior gap. Only gaps BETWEEN ink on a row
 * count: the empty margin before the first glyph and after the last one is
 * padding, not a counter, and including it would make the reading depend on
 * how generously the copy block was cropped.
 */
export const measureInkDensity = (mask, width, height) => {
  // Everything is measured inside the ink's own bounding box, and nothing is
  // filtered. Both sides of the comparison MUST go through this function
  // identically: an earlier version rejected rows by their share of the crop
  // width, which meant the wide source crop and the tight candidate plate were
  // filtered on different scales and every face read Light.
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;

  let inkTotal = 0;
  let inkRuns = 0;
  let gapTotal = 0;
  let gapRuns = 0;

  for (let y = minY; y <= maxY; y += 1) {
    let ink = 0;
    let gap = 0;
    let started = false;
    for (let x = minX; x <= maxX; x += 1) {
      if (mask[y * width + x]) {
        if (started && gap > 0) { gapTotal += gap; gapRuns += 1; }
        gap = 0;
        ink += 1;
        started = true;
        continue;
      }
      if (ink > 0) { inkTotal += ink; inkRuns += 1; }
      ink = 0;
      if (started) gap += 1;
    }
    if (ink > 0) { inkTotal += ink; inkRuns += 1; }
  }

  if (inkRuns < MIN_RUNS || gapRuns < MIN_RUNS) return null;
  const inkMean = inkTotal / inkRuns;
  const gapMean = gapTotal / gapRuns;
  if (!(gapMean > 0)) return null;

  return { density: inkMean / gapMean, inkMean, gapMean, inkRuns };
};

const parseHexColour = (value) => {
  const match = typeof value === 'string' && value.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!match) return null;
  const digits = match[1];
  return [0, 2, 4].map((index) => Number.parseInt(digits.slice(index, index + 2), 16));
};

/** The panel colour when extraction could not read it: the crop's own mode. */
const dominantColour = (data, info) => {
  const counts = new Map();
  for (let offset = 0; offset < data.length; offset += info.channels) {
    // Quantised so antialiasing does not split one flat fill into many bins.
    const key = `${data[offset] >> 3},${data[offset + 1] >> 3},${data[offset + 2] >> 3}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const [key] = [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
  return key.split(',').map((channel) => (Number(channel) << 3) + 4);
};

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/**
 * The copy block as the model reported it, taken verbatim.
 *
 * It is deliberately NOT padded. Padding a box that is already generous drags
 * in the panel edge and a slice of the photograph behind it, and to a mask
 * keyed on the panel colour a photograph is solid ink — which swamped the
 * reading. A box drawn slightly tight costs a little antialiased edge on both
 * sides of the comparison equally, so the ratio survives it.
 */
const cropCopyBlock = async (sourceImageData, cardTextBox) => {
  const buffer = Buffer.from(sourceImageData, 'base64');
  const { width, height } = await sharp(buffer).metadata();
  if (!width || !height) return null;

  const [yMin, xMin, yMax, xMax] = cardTextBox;
  const left = Math.round(clamp((xMin / 1000) * width, 0, width - 2));
  const top = Math.round(clamp((yMin / 1000) * height, 0, height - 2));
  const right = Math.round(clamp((xMax / 1000) * width, left + 1, width));
  const bottom = Math.round(clamp((yMax / 1000) * height, top + 1, height));
  if (right - left < 40 || bottom - top < 16) return null;

  return sharp(buffer)
    .extract({ left, top, width: right - left, height: bottom - top })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
};

// Large enough that pixel quantisation does not merge adjacent weights, and
// wrapped so the sample carries both inter-word and intra-glyph gaps.
const REFERENCE_FONT_SIZE = 60;
const REFERENCE_WRAP_WIDTH = 700;

/** The same words in one candidate face, on the same panel colour. */
const measureCandidate = async ({ fontId, text, background, textColour }) => {
  const font = ASPECT_RATIO_FONT_REGISTRY[fontId];
  const layer = await sharp({
    text: {
      text: `<span foreground="${textColour}">${text}</span>`,
      font: `${font.pangoName} ${REFERENCE_FONT_SIZE}`,
      fontfile: resolveRuntimeAsset('fonts', font.fileName),
      width: REFERENCE_WRAP_WIDTH,
      align: 'centre',
      rgba: true,
      dpi: 72,
      wrap: 'word-char',
    },
  }).png().toBuffer();
  const metadata = await sharp(layer).metadata();
  if (!metadata.width || !metadata.height) return null;

  const { data, info } = await sharp({
    create: {
      width: metadata.width + 20,
      height: metadata.height + 20,
      channels: 4,
      background: { r: background[0], g: background[1], b: background[2], alpha: 1 },
    },
  })
    .composite([{ input: layer, left: 10, top: 10 }])
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const foreground = parseHexColour(textColour);
  return measureInkDensity(buildInkMask(data, info, background, foreground), info.width, info.height);
};

const escapePango = (value) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

/**
 * Measure the source card's weight. Returns null whenever the copy block cannot
 * be read — no box, too little ink, an unusable crop — so the caller keeps
 * whatever the model said rather than trusting a reading that was never made.
 */
export const classifyCardTypeface = async ({
  sourceImageData,
  cardTextBox,
  cardText,
  cardBackgroundColor,
  cardTextColor,
} = {}) => {
  if (!sourceImageData || !Array.isArray(cardTextBox) || cardTextBox.length !== 4) return null;
  const text = typeof cardText === 'string' ? cardText.trim() : '';
  if (text.length < 4) return null;

  try {
    const crop = await cropCopyBlock(sourceImageData, cardTextBox);
    if (!crop) return null;

    const background = parseHexColour(cardBackgroundColor) || dominantColour(crop.data, crop.info);
    const foreground = parseHexColour(cardTextColor);
    const source = measureInkDensity(
      buildInkMask(crop.data, crop.info, background, foreground),
      crop.info.width,
      crop.info.height,
    );
    if (!source) return null;

    const textColour = foreground ? cardTextColor : '#FFFFFF';
    const escaped = escapePango(text);

    let best = null;
    for (const fontId of CARD_COPY_FONT_IDS) {
      const candidate = await measureCandidate({
        fontId,
        text: escaped,
        background,
        textColour,
      });
      if (!candidate) continue;
      const distance = Math.abs(candidate.density - source.density);
      if (!best || distance < best.distance) best = { fontId, distance, candidate };
    }
    if (!best) return null;

    return {
      fontId: best.fontId,
      density: source.density,
      matchedDensity: best.candidate.density,
      distance: best.distance,
    };
  } catch {
    // Weight matching is a refinement, never a reason to fail generation.
    return null;
  }
};
