import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');

const deepFreeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};

/**
 * Brand palette. The reference files are JPEG-compressed, so sampling them
 * lands a level or two off these values; the palette is authoritative, the
 * compression artifact is not.
 */
const FRAME_BLUE = '#C7E0F8';
// The lavender ground, shared by the second variant of each ratio and measured
// off both their references. It replaced a mint that no approved reference ever
// used; keep it pinned to what the files say, not to what the name suggests.
const FRAME_LAVENDER = '#DDDAF9';
const CARD_PURPLE = '#6034C6';
const CARD_TEXT_COLOUR = '#FFFFFF';
const LOGO_PURPLE = '#7145CE';

/**
 * Trace the rounded photo aperture: a rounded rectangle with a rounded bite
 * removed from its top-left corner for the local Cabify-logo notch. Deriving
 * the path from the measured rectangle keeps adding a reference a matter of
 * one table entry instead of a hand-written run of SVG commands.
 */
const buildAperturePath = ({ panel, notch, radius, notchRadius }) => [
  `M ${notch.right + notchRadius} ${panel.top}`,
  `H ${panel.right - radius}`,
  `Q ${panel.right} ${panel.top} ${panel.right} ${panel.top + radius}`,
  `V ${panel.bottom - radius}`,
  `Q ${panel.right} ${panel.bottom} ${panel.right - radius} ${panel.bottom}`,
  `H ${panel.left + radius}`,
  `Q ${panel.left} ${panel.bottom} ${panel.left} ${panel.bottom - radius}`,
  `V ${notch.bottom + radius}`,
  `Q ${panel.left} ${notch.bottom} ${panel.left + radius} ${notch.bottom}`,
  `H ${notch.right - notchRadius}`,
  `Q ${notch.right} ${notch.bottom} ${notch.right} ${notch.bottom - notchRadius}`,
  `V ${panel.top + notchRadius}`,
  `Q ${notch.right} ${panel.top} ${notch.right + notchRadius} ${panel.top}`,
  'Z',
].join(' ');

const buildTemplate = ({
  id,
  ratio,
  canvas,
  referenceAsset,
  referenceCanvas,
  frameBackground,
  aperture,
  logoBox,
  card,
}) => ({
  id,
  ratio,
  canvas,
  ...(referenceCanvas ? { referenceCanvas } : {}),
  referenceAsset,
  // A full-bleed reference has no aperture to cut, so it also has no visible
  // frame ground to declare.
  ...(aperture ? { frame: { background: frameBackground } } : {}),
  scene: aperture
    ? { mode: 'reference-panel', path: buildAperturePath(aperture) }
    : { mode: 'full-bleed' },
  logo: {
    mode: 'asset',
    assetFolder: 'branding',
    assetFile: 'cabify-logo-white-rgb.png',
    box: logoBox,
    colour: LOGO_PURPLE,
  },
  card: {
    background: CARD_PURPLE,
    textColour: CARD_TEXT_COLOUR,
    // Pango's own spelling, passed straight through: 'left' or 'centre'.
    align: 'centre',
    ...card,
  },
});

/**
 * Canonical, pixel-addressed templates for the Aspect Ratio tool.
 *
 * Reference images are the geometry and palette authority: every rectangle,
 * radius and aperture below was measured off the file named in
 * `referenceAsset`. The generated photograph and the OTF-rendered copy are the
 * only mutable pixels.
 *
 * A ratio ships one entry per approved reference, in variant order. That list
 * IS the set of variations the tool produces: one photograph is generated per
 * source row and composed once through each template, so the frame ground,
 * aperture, notch and card geometry are the only things that differ between a
 * row's outputs. Reframing the same photograph three ways produced
 * near-identical results, because the deterministic overlay dominates what the
 * eye actually reads.
 *
 * Index 0 is the default for callers that do not name a template.
 */
export const ASPECT_RATIO_TEMPLATE_VARIANTS = deepFreeze({
  '1:1': [
    buildTemplate({
      id: '1-1-riders-frame',
      ratio: '1:1',
      canvas: { width: 1024, height: 1024 },
      referenceAsset: '../assets/card-references/1-1/aspect-1-1-1_1-2- (7).png',
      frameBackground: FRAME_BLUE,
      aperture: {
        panel: { left: 47, top: 45, right: 977, bottom: 975 },
        notch: { right: 274, bottom: 170 },
        radius: 41,
        notchRadius: 41,
      },
      logoBox: { x: 72, y: 77, width: 187, height: 63 },
      card: {
        box: { x: 76, y: 749, width: 872, height: 199 },
        textBox: { x: 116, y: 779, width: 792, height: 139 },
        radius: 29,
        align: 'left',
        fontSize: { min: 28, max: 58 },
      },
    }),
    buildTemplate({
      id: '1-1-riders-frame-lavender',
      ratio: '1:1',
      canvas: { width: 1024, height: 1024 },
      referenceAsset: '../assets/card-references/1-1/aspect-1-1-1_1-2- (3).png',
      frameBackground: FRAME_LAVENDER,
      // A wider notch, a deeper card and the lavender ground: the same layout
      // language as the blue frame, measurably not the same template.
      aperture: {
        panel: { left: 44, top: 45, right: 979, bottom: 977 },
        notch: { right: 347, bottom: 190 },
        radius: 52,
        notchRadius: 51,
      },
      logoBox: { x: 89, y: 82, width: 218, height: 74 },
      card: {
        box: { x: 85, y: 720, width: 854, height: 220 },
        textBox: { x: 124, y: 753, width: 776, height: 154 },
        radius: 28,
        align: 'left',
        // `min` stays at the ratio's floor: raising it with the taller box
        // would reject copy the blue frame still fits.
        fontSize: { min: 28, max: 64 },
      },
    }),
    buildTemplate({
      id: '1-1-riders-fullbleed',
      ratio: '1:1',
      canvas: { width: 1024, height: 1024 },
      referenceAsset: '../assets/card-references/1-1/1024x1024_AR_FRAME_SEGURIDAD_ANIMA.png',
      // This reference has no rounded aperture at all: the artwork runs to
      // every canvas edge and only the logo and the card sit above it.
      aperture: null,
      logoBox: { x: 76, y: 77, width: 218, height: 74 },
      card: {
        box: { x: 66, y: 730, width: 892, height: 228 },
        textBox: { x: 107, y: 764, width: 810, height: 160 },
        radius: 35,
        align: 'left',
        fontSize: { min: 28, max: 67 },
      },
    }),
  ],
  '9:16': [
    buildTemplate({
      id: '9-16-riders-frame',
      ratio: '9:16',
      canvas: { width: 1080, height: 1920 },
      referenceCanvas: { width: 768, height: 1376 },
      referenceAsset: '../assets/card-references/9-16/aspect-9-16-9_16-2 (13).png',
      frameBackground: FRAME_BLUE,
      aperture: {
        panel: { left: 41, top: 56, right: 1038, bottom: 1872 },
        notch: { right: 388, bottom: 216 },
        radius: 58,
        notchRadius: 58,
      },
      logoBox: { x: 91, y: 95, width: 246, height: 80 },
      card: {
        box: { x: 86, y: 1291, width: 910, height: 374 },
        textBox: { x: 146, y: 1345, width: 790, height: 265 },
        radius: 44,
        fontSize: { min: 32, max: 74 },
      },
    }),
    buildTemplate({
      id: '9-16-riders-frame-lavender',
      ratio: '9:16',
      canvas: { width: 1080, height: 1920 },
      referenceCanvas: { width: 768, height: 1376 },
      referenceAsset: '../assets/card-references/9-16/aspect-9-16-9_16-0 (2) (1).png',
      frameBackground: FRAME_LAVENDER,
      // Aperture fitted to the reference mask rather than read off by hand:
      // 0.994 IoU against its flood-filled ground.
      aperture: {
        panel: { left: 44, top: 56, right: 1036, bottom: 1889 },
        notch: { right: 385, bottom: 222 },
        radius: 63,
        notchRadius: 65,
      },
      logoBox: { x: 86, y: 96, width: 253, height: 84 },
      card: {
        box: { x: 107, y: 1313, width: 865, height: 401 },
        textBox: { x: 142, y: 1358, width: 795, height: 311 },
        radius: 39,
        // The roomiest 9:16 card of the three. `max` is the size whose ink band
        // matches the reference's own copy (~85px); the reference sets looser
        // leading than Pango does, so the glyph height is what was matched, not
        // the line pitch. `min` stays at the ratio floor so copy the siblings
        // accept cannot fail only here.
        fontSize: { min: 28, max: 90 },
      },
    }),
    buildTemplate({
      id: '9-16-riders-frame-tall',
      ratio: '9:16',
      canvas: { width: 1080, height: 1920 },
      referenceCanvas: { width: 768, height: 1376 },
      referenceAsset: '../assets/card-references/9-16/alianzas chico 169.png',
      frameBackground: FRAME_BLUE,
      aperture: {
        panel: { left: 49, top: 57, right: 1028, bottom: 1863 },
        notch: { right: 363, bottom: 229 },
        radius: 51,
        notchRadius: 61,
      },
      logoBox: { x: 76, y: 99, width: 264, height: 88 },
      card: {
        box: { x: 97, y: 1214, width: 886, height: 395 },
        textBox: { x: 155, y: 1271, width: 770, height: 281 },
        radius: 42,
        // This box is taller but 20px narrower than the canonical 9:16 one, so
        // long copy wraps to more lines and runs out of height first. Measured
        // at min 32 it accepted less copy than the template already in
        // production; 28 puts it back above that floor.
        fontSize: { min: 28, max: 78 },
      },
    }),
  ],
});

/**
 * The first variant of each ratio, kept under the original export name for
 * callers and tests that only ever needed the canonical template.
 */
export const ASPECT_RATIO_TEMPLATE_DEFINITIONS = deepFreeze(Object.fromEntries(
  Object.entries(ASPECT_RATIO_TEMPLATE_VARIANTS).map(([ratio, variants]) => [ratio, variants[0]]),
));

/** Ordered template ids for a ratio: one generated variation per entry. */
export const listAspectRatioTemplateIds = (targetRatio) => {
  const variants = ASPECT_RATIO_TEMPLATE_VARIANTS[String(targetRatio ?? '').trim()];
  if (!variants) throw new Error(`Unsupported Aspect Ratio template ratio: ${targetRatio}.`);
  return variants.map((variant) => variant.id);
};

const buildFontDefinition = (id, family, weight, fileName) => ({
  id,
  family,
  weight,
  label: `${family} ${weight}`,
  pangoName: `${family} ${weight}`,
  fileName,
});

/** A whitelist prevents callers from selecting arbitrary server-side files. */
export const ASPECT_RATIO_FONT_REGISTRY = deepFreeze({
  'cabify-ciudad-light': buildFontDefinition(
    'cabify-ciudad-light',
    'Cabify Ciudad',
    'Light',
    'CabifyCiudad-Light.otf',
  ),
  'cabify-ciudad-book': buildFontDefinition(
    'cabify-ciudad-book',
    'Cabify Ciudad',
    'Book',
    'CabifyCiudad-Book.otf',
  ),
  'cabify-ciudad-semibold': buildFontDefinition(
    'cabify-ciudad-semibold',
    'Cabify Ciudad',
    'SemiBold',
    'CabifyCiudad-SemiBold.otf',
  ),
  'cabify-ciudad-bold': buildFontDefinition(
    'cabify-ciudad-bold',
    'Cabify Ciudad',
    'Bold',
    'CabifyCiudad-Bold.otf',
  ),
  'cabify-ciudad-extrabold': buildFontDefinition(
    'cabify-ciudad-extrabold',
    'Cabify Ciudad',
    'ExtraBold',
    'CabifyCiudad-ExtraBold.otf',
  ),
  'cabify-ciudad-black': buildFontDefinition(
    'cabify-ciudad-black',
    'Cabify Ciudad',
    'Black',
    'CabifyCiudad-Black.otf',
  ),
  'cabify-ciudad-text-light': buildFontDefinition(
    'cabify-ciudad-text-light',
    'Cabify Ciudad Text',
    'Light',
    'CabifyCiudadText-Light.otf',
  ),
  'cabify-ciudad-text-book': buildFontDefinition(
    'cabify-ciudad-text-book',
    'Cabify Ciudad Text',
    'Book',
    'CabifyCiudadText-Book.otf',
  ),
  'cabify-ciudad-text-semibold': buildFontDefinition(
    'cabify-ciudad-text-semibold',
    'Cabify Ciudad Text',
    'SemiBold',
    'CabifyCiudadText-SemiBold.otf',
  ),
  'cabify-ciudad-text-bold': buildFontDefinition(
    'cabify-ciudad-text-bold',
    'Cabify Ciudad Text',
    'Bold',
    'CabifyCiudadText-Bold.otf',
  ),
});

export const DEFAULT_ASPECT_RATIO_FONT_ID = 'cabify-ciudad-bold';

/**
 * The face every Aspect Ratio card is set in. Fixed, not detected.
 *
 * Detecting it was tried twice and neither attempt earned its keep. The
 * extraction model, shown a rendered catalog, scored 1 of 6 against inputs
 * whose face was known and put nearly everything on Bold. Measuring the ink
 * scored well but only after equalising scale, wrap and line count between the
 * source and each candidate — three couplings, each able to move the answer a
 * full weight on its own, and none of them observable in the output.
 *
 * The approved creatives are set in Bold, so the answer never needed to be
 * inferred. A constant cannot drift.
 */
export const CARD_COPY_FONT_ID = 'cabify-ciudad-bold';

const normalizeToken = (value) => String(value ?? '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '');

const FONT_ID_BY_NORMALIZED_ID = new Map(
  Object.keys(ASPECT_RATIO_FONT_REGISTRY).map((id) => [normalizeToken(id), id]),
);

const FONT_FAMILY_ALIASES = new Map([
  ['cabifyciudad', 'cabify-ciudad'],
  ['ciudad', 'cabify-ciudad'],
  ['cabifyciudadtext', 'cabify-ciudad-text'],
  ['ciudadtext', 'cabify-ciudad-text'],
]);

const FONT_WEIGHT_ALIASES = new Map([
  ['light', 'light'],
  ['300', 'light'],
  ['book', 'book'],
  ['regular', 'book'],
  ['normal', 'book'],
  ['400', 'book'],
  ['semibold', 'semibold'],
  ['demibold', 'semibold'],
  ['600', 'semibold'],
  ['bold', 'bold'],
  ['700', 'bold'],
  ['extrabold', 'extrabold'],
  ['ultrabold', 'extrabold'],
  ['800', 'extrabold'],
  ['black', 'black'],
  ['heavy', 'black'],
  ['900', 'black'],
]);

/**
 * Resolve either a stable font id or the family/weight fields returned by the
 * existing card-copy extractor. Missing font information selects the canonical
 * default; supplied but unknown information is rejected.
 */
export const resolveAspectRatioFontId = ({ fontId, fontFamily, fontWeight } = {}) => {
  if (fontId !== undefined && fontId !== null) {
    if (typeof fontId !== 'string' || fontId.trim().length === 0) {
      throw new Error('fontId must be a non-empty Aspect Ratio font id.');
    }
    const resolved = FONT_ID_BY_NORMALIZED_ID.get(normalizeToken(fontId));
    if (!resolved) throw new Error(`Unknown Aspect Ratio fontId: ${fontId}.`);
    return resolved;
  }

  const normalizedFamily = normalizeToken(fontFamily);
  const normalizedWeight = normalizeToken(fontWeight);
  const hasFamily = normalizedFamily.length > 0;
  const hasWeight = normalizedWeight.length > 0;
  if (!hasFamily && !hasWeight) return DEFAULT_ASPECT_RATIO_FONT_ID;

  const familyKey = hasFamily
    ? FONT_FAMILY_ALIASES.get(normalizedFamily)
    : 'cabify-ciudad';
  if (!familyKey) throw new Error(`Unknown Aspect Ratio font family: ${fontFamily}.`);

  const weightKey = hasWeight
    ? FONT_WEIGHT_ALIASES.get(normalizedWeight)
    : 'bold';
  if (!weightKey) throw new Error(`Unknown Aspect Ratio font weight: ${fontWeight}.`);

  const resolved = `${familyKey}-${weightKey}`;
  if (!ASPECT_RATIO_FONT_REGISTRY[resolved]) {
    throw new Error(`${fontFamily || 'Cabify Ciudad'} ${fontWeight || 'Bold'} is not an available OTF face.`);
  }
  return resolved;
};

const RUNTIME_ASSET_ROOTS = Object.freeze([
  path.join(projectRoot, 'public'),
  path.join(projectRoot, 'dist'),
]);

/** Exported so the typeface matcher can render with the very same OTF files. */
export const resolveRuntimeAsset = (folder, fileName) => {
  const candidates = RUNTIME_ASSET_ROOTS.map((root) => path.join(root, folder, fileName));
  const assetPath = candidates.find((candidate) => existsSync(candidate));
  if (!assetPath) {
    throw new Error(`Missing Aspect Ratio asset ${folder}/${fileName}. Checked public and dist.`);
  }
  return assetPath;
};

const assetBufferCache = new Map();

const readAsset = async (assetPath) => {
  if (!assetBufferCache.has(assetPath)) {
    const loading = readFile(assetPath).catch((error) => {
      assetBufferCache.delete(assetPath);
      throw error;
    });
    assetBufferCache.set(assetPath, loading);
  }
  return assetBufferCache.get(assetPath);
};

const resolveTemplate = (targetRatio, templateId) => {
  if (typeof targetRatio !== 'string' || !targetRatio.trim()) {
    throw new Error('targetRatio is required.');
  }
  const ratio = targetRatio.trim();
  const variants = ASPECT_RATIO_TEMPLATE_VARIANTS[ratio];
  if (!variants) throw new Error(`Unsupported Aspect Ratio template ratio: ${targetRatio}.`);
  if (templateId === undefined || templateId === null) return variants[0];

  if (typeof templateId !== 'string' || !templateId.trim()) {
    throw new Error('templateId must be a non-empty string when supplied.');
  }
  const requested = templateId.trim();
  if (requested === ratio) return variants[0];

  const template = variants.find((variant) => variant.id === requested);
  if (!template) throw new Error(`Template ${requested} is not valid for targetRatio ${ratio}.`);
  return template;
};

const SUPPORTED_DATA_URL_MIME_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/tiff',
  'image/webp',
]);

const parseSceneDataUrl = async (sceneDataUrl) => {
  if (typeof sceneDataUrl !== 'string' || sceneDataUrl.trim().length === 0) {
    throw new Error('sceneDataUrl is required.');
  }
  const match = sceneDataUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) throw new Error('Invalid sceneDataUrl. Expected a base64 image data URL.');

  const mimeType = match[1].trim().toLowerCase();
  if (!SUPPORTED_DATA_URL_MIME_TYPES.has(mimeType)) {
    throw new Error(`Unsupported sceneDataUrl MIME type: ${mimeType}.`);
  }

  const encoded = match[2].replace(/\s+/g, '');
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('Invalid sceneDataUrl base64 content.');
  }

  const buffer = Buffer.from(encoded, 'base64');
  const canonicalInput = encoded.replace(/=+$/g, '');
  const canonicalBuffer = buffer.toString('base64').replace(/=+$/g, '');
  if (!buffer.length || canonicalInput !== canonicalBuffer) {
    throw new Error('Invalid sceneDataUrl base64 content.');
  }

  try {
    const metadata = await sharp(buffer, { failOn: 'error' }).metadata();
    if (!metadata.width || !metadata.height) throw new Error('Image has no dimensions.');
  } catch (error) {
    throw new Error(`sceneDataUrl does not contain a readable image: ${error.message}`);
  }
  return buffer;
};

const normalizeText = (text) => {
  if (typeof text !== 'string') throw new Error('text is required.');
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').trim();
  if (!normalized) throw new Error('text must not be empty.');
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(normalized)) {
    throw new Error('text contains unsupported control characters.');
  }
  if ([...normalized].length > 1000) {
    throw new Error('text exceeds the 1000-character Aspect Ratio limit.');
  }
  return normalized;
};

const escapePangoMarkup = (value) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const roundedRectangleSvg = ({ width, height, radius, fill }) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
  + `<rect x="0" y="0" width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="${fill}"/>`
  + '</svg>',
);

const fixedCardShapeCache = new Map();

/**
 * The card is a flat rounded rectangle and nothing else. It carries no drop
 * shadow: the reference creatives do not have one, and a synthesized shadow
 * darkened the photograph in a halo around the box that no approved template
 * shows.
 */
const buildFixedCardShape = async (template) => {
  if (fixedCardShapeCache.has(template.id)) return fixedCardShapeCache.get(template.id);

  const { card } = template;
  const loading = sharp(roundedRectangleSvg({
    width: card.box.width,
    height: card.box.height,
    radius: card.radius,
    fill: card.background,
  })).png().toBuffer().catch((error) => {
    fixedCardShapeCache.delete(template.id);
    throw error;
  });

  fixedCardShapeCache.set(template.id, loading);
  return loading;
};

const sceneMaskCache = new Map();

const buildSceneMask = async (template) => {
  if (template.scene.mode !== 'reference-panel') return null;
  if (sceneMaskCache.has(template.id)) return sceneMaskCache.get(template.id);

  const { width, height } = template.canvas;
  const loading = sharp(Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<path d="${template.scene.path}" fill="#FFFFFF"/>`
    + '</svg>',
  )).png().toBuffer().catch((error) => {
    sceneMaskCache.delete(template.id);
    throw error;
  });

  sceneMaskCache.set(template.id, loading);
  return loading;
};

const normalizeSceneToCanvas = (sceneBuffer, canvas) => sharp(sceneBuffer, { failOn: 'error' })
  .rotate()
  .resize(canvas.width, canvas.height, {
    fit: 'cover',
    position: 'centre',
  })
  .flatten({ background: '#000000' })
  .toColourspace('srgb')
  .png()
  .toBuffer();

const buildTemplateBase = async (sceneBuffer, template) => {
  const normalizedScene = await normalizeSceneToCanvas(sceneBuffer, template.canvas);
  if (template.scene.mode === 'full-bleed') return normalizedScene;

  if (template.scene.mode !== 'reference-panel' || !template.referenceAsset || !template.frame) {
    throw new Error(`Template ${template.id} has an invalid scene definition.`);
  }

  const referencePath = path.resolve(__dirname, template.referenceAsset);
  if (!existsSync(referencePath)) {
    throw new Error(`Missing Aspect Ratio reference asset for template ${template.id}.`);
  }
  // Keep checking the declared reference: it is the provenance for this
  // pixel-addressed aperture even though its campaign colours are not reused.
  await readAsset(referencePath);
  const sceneMask = await buildSceneMask(template);

  const maskedScene = await sharp(normalizedScene)
    .ensureAlpha()
    .composite([{ input: sceneMask, blend: 'dest-in' }])
    .png()
    .toBuffer();

  // The path, dimensions, notch and fill are immutable template properties.
  return sharp({
    create: {
      width: template.canvas.width,
      height: template.canvas.height,
      channels: 4,
      background: template.frame.background,
    },
  })
    .composite([{ input: maskedScene, left: 0, top: 0 }])
    .png()
    .toBuffer();
};

const textLayerCache = new Map();
const MAX_TEXT_LAYER_CACHE_ENTRIES = 64;

const cacheTextLayer = (key, loader) => {
  if (textLayerCache.has(key)) {
    const cached = textLayerCache.get(key);
    textLayerCache.delete(key);
    textLayerCache.set(key, cached);
    return cached;
  }

  const loading = loader().catch((error) => {
    textLayerCache.delete(key);
    throw error;
  });
  textLayerCache.set(key, loading);
  while (textLayerCache.size > MAX_TEXT_LAYER_CACHE_ENTRIES) {
    textLayerCache.delete(textLayerCache.keys().next().value);
  }
  return loading;
};

const renderTextAtSize = async ({ text, font, fontPath, card, textBox, fontSize }) => {
  const escapedText = escapePangoMarkup(text);
  const markup = `<span foreground="${card.textColour}">${escapedText}</span>`;
  const buffer = await sharp({
    text: {
      text: markup,
      font: `${font.pangoName} ${fontSize}`,
      fontfile: fontPath,
      width: textBox.width,
      align: card.align,
      rgba: true,
      dpi: 72,
      wrap: 'word-char',
    },
  }).png().toBuffer();
  const metadata = await sharp(buffer).metadata();
  if (!metadata.width || !metadata.height) throw new Error('Sharp returned an empty text layer.');
  return { buffer, width: metadata.width, height: metadata.height, fontSize };
};

const textFits = (rendered, textBox) =>
  rendered.width <= textBox.width && rendered.height <= textBox.height;

const buildTextLayer = async (template, text, fontId, textBoxOverride) => {
  // The box is a parameter, not a constant: when the source card carries
  // buttons or partner marks they take a share of it and the copy is fitted
  // into what is left. The height goes in the cache key for that reason.
  const textBox = textBoxOverride || template.card.textBox;
  const key = `${template.id}\u0000${fontId}\u0000${textBox.height}\u0000${text}`;
  return cacheTextLayer(key, async () => {
    const font = ASPECT_RATIO_FONT_REGISTRY[fontId];
    const fontPath = resolveRuntimeAsset('fonts', font.fileName);
    const { card } = template;
    const minimum = card.fontSize.min;
    const maximum = card.fontSize.max;
    const renderedBySize = new Map();

    const render = async (fontSize) => {
      if (!renderedBySize.has(fontSize)) {
        renderedBySize.set(fontSize, renderTextAtSize({
          text,
          font,
          fontPath,
          card,
          textBox,
          fontSize,
        }));
      }
      return renderedBySize.get(fontSize);
    };

    const minimumRender = await render(minimum);
    if (!textFits(minimumRender, textBox)) {
      throw new Error(
        `Text overflow in template ${template.id}: copy does not fit at the minimum ${minimum}px font size.`,
      );
    }

    let best = minimumRender;
    const maximumRender = await render(maximum);
    if (textFits(maximumRender, textBox)) {
      best = maximumRender;
    } else {
      let low = minimum + 1;
      let high = maximum - 1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = await render(middle);
        if (textFits(candidate, textBox)) {
          best = candidate;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
    }

    const left = card.align === 'left'
      ? textBox.x
      : textBox.x + Math.floor((textBox.width - best.width) / 2);
    const top = textBox.y + Math.floor((textBox.height - best.height) / 2);
    if (
      left < textBox.x
      || top < textBox.y
      || left + best.width > textBox.x + textBox.width
      || top + best.height > textBox.y + textBox.height
    ) {
      throw new Error(`Text overflow in template ${template.id}.`);
    }

    return { input: best.buffer, left, top, fontSize: best.fontSize };
  });
};


/**
 * Buttons, pills and partner marks lifted from the source card.
 *
 * They cannot be synthesized: an "Efectivo" pill is artwork, not a string, so
 * the only faithful way to keep it is to carry its pixels across. The card
 * geometry does not move to accommodate them — it is measured from the approved
 * references — so the crop is scaled down until it fits beside the copy.
 */
const EXTRAS_HEIGHT_SHARES = Object.freeze([0.5, 0.4, 0.3, 0.22]);
const EXTRAS_GAP_SHARE = 0.08;
/** Under this the marks are a smudge; shipping nothing beats shipping mush. */
const EXTRAS_MIN_HEIGHT = 22;
/** How close to the source panel colour still counts as its background. */
const EXTRAS_KEY_TOLERANCE = 26;

/**
 * Drop the source panel colour to transparent so the crop sits on the target
 * card instead of pasting a slab of the old one over it. Without this a source
 * card in another colour arrives as a visible rectangle.
 */
const keyOutPanel = async (buffer, panelColour) => {
  if (!panelColour) return buffer;
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (let offset = 0; offset < data.length; offset += info.channels) {
    const distance = Math.max(
      Math.abs(data[offset] - panelColour[0]),
      Math.abs(data[offset + 1] - panelColour[1]),
      Math.abs(data[offset + 2] - panelColour[2]),
    );
    if (distance <= EXTRAS_KEY_TOLERANCE) data[offset + 3] = 0;
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .png()
    .toBuffer();
};

const buildExtrasLayer = async (template, extrasBuffer, panelColour, heightShare) => {
  const { card } = template;
  const maxHeight = Math.floor(card.textBox.height * heightShare);
  if (maxHeight < EXTRAS_MIN_HEIGHT) return null;

  const keyed = await keyOutPanel(extrasBuffer, panelColour);
  const resized = await sharp(keyed)
    .resize({
      width: card.textBox.width,
      height: maxHeight,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();
  const metadata = await sharp(resized).metadata();
  if (!metadata.width || !metadata.height) return null;
  if (metadata.height < EXTRAS_MIN_HEIGHT) return null;
  return { buffer: resized, width: metadata.width, height: metadata.height };
};

const fixedLogoCache = new Map();

const buildFixedLogo = async (template) => {
  if (template.logo.mode !== 'asset') return null;
  if (fixedLogoCache.has(template.id)) return fixedLogoCache.get(template.id);

  const loading = (async () => {
    const assetPath = resolveRuntimeAsset(template.logo.assetFolder, template.logo.assetFile);
    const source = await readAsset(assetPath);
    const resized = await sharp(source, { failOn: 'error' })
      .resize(template.logo.box.width, template.logo.box.height, { fit: 'fill' })
      .ensureAlpha()
      .png()
      .toBuffer();
    const alpha = await sharp(resized).extractChannel('alpha').png().toBuffer();
    const input = await sharp({
      create: {
        width: template.logo.box.width,
        height: template.logo.box.height,
        channels: 3,
        background: template.logo.colour,
      },
    })
      .joinChannel(alpha)
      .png()
      .toBuffer();
    return {
      input,
      left: template.logo.box.x,
      top: template.logo.box.y,
    };
  })().catch((error) => {
    fixedLogoCache.delete(template.id);
    throw error;
  });

  fixedLogoCache.set(template.id, loading);
  return loading;
};

/**
 * Place a generated scene behind immutable template layers and render the copy
 * locally with the selected OTF. No model call occurs in this function.
 */
export const composeAspectRatioTemplate = async ({
  sceneDataUrl,
  targetRatio,
  templateId,
  text,
  cardExtras,
  cardExtrasPanelColour,
} = {}) => {
  const template = resolveTemplate(targetRatio, templateId);
  const normalizedText = normalizeText(text);
  const sceneBuffer = await parseSceneDataUrl(sceneDataUrl);
  const { card } = template;

  const [base, cardShape, logoLayer] = await Promise.all([
    buildTemplateBase(sceneBuffer, template),
    buildFixedCardShape(template),
    buildFixedLogo(template),
  ]);

  // Copy and extras share one fixed box. Try the largest allowance for the
  // extras first and step down until the copy also fits: shrinking the marks
  // costs legibility, dropping the whole variation costs the operator a choice.
  let textLayer = null;
  let extrasLayer = null;
  let textBox = card.textBox;

  if (cardExtras) {
    for (const share of EXTRAS_HEIGHT_SHARES) {
      const candidate = await buildExtrasLayer(template, cardExtras, cardExtrasPanelColour, share);
      if (!candidate) continue;
      const gap = Math.round(card.textBox.height * EXTRAS_GAP_SHARE);
      const remaining = {
        ...card.textBox,
        height: card.textBox.height - candidate.height - gap,
      };
      if (remaining.height < EXTRAS_MIN_HEIGHT) continue;
      try {
        textLayer = await buildTextLayer(template, normalizedText, CARD_COPY_FONT_ID, remaining);
        extrasLayer = candidate;
        textBox = remaining;
        break;
      } catch {
        // Copy will not fit beside marks this tall; try a smaller allowance.
      }
    }
  }

  // No extras, or none small enough to leave room: the copy owns the box.
  if (!textLayer) {
    textLayer = await buildTextLayer(template, normalizedText, CARD_COPY_FONT_ID);
    extrasLayer = null;
  }

  const composites = [
    { input: cardShape, left: card.box.x, top: card.box.y },
    ...(logoLayer ? [logoLayer] : []),
  ];

  if (extrasLayer) {
    // Centre the copy-plus-marks stack in the box, then place the marks under
    // the copy on the card's own alignment.
    const gap = Math.round(card.textBox.height * EXTRAS_GAP_SHARE);
    const stackHeight = textLayer.input ? textBox.height + gap + extrasLayer.height : extrasLayer.height;
    const stackTop = card.textBox.y + Math.floor((card.textBox.height - stackHeight) / 2);
    const textShift = stackTop - textBox.y;
    composites.push({
      input: textLayer.input,
      left: textLayer.left,
      top: textLayer.top + textShift,
    });
    composites.push({
      input: extrasLayer.buffer,
      left: card.align === 'left'
        ? card.textBox.x
        : card.textBox.x + Math.floor((card.textBox.width - extrasLayer.width) / 2),
      top: stackTop + textBox.height + gap,
    });
  } else {
    composites.push({ input: textLayer.input, left: textLayer.left, top: textLayer.top });
  }

  const result = await sharp(base, { failOn: 'error' })
    .resize(template.canvas.width, template.canvas.height, { fit: 'fill' })
    .ensureAlpha()
    .composite(composites)
    .png()
    .toBuffer();

  return `data:image/png;base64,${result.toString('base64')}`;
};
