import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { DEFAULT_CABIFY_ACCOUNT } from '../../prompts/accounts.js';

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
 * Drivers fallback palette, used only where a colour cannot be read off the
 * input. Sampled off the five approved 1200x628 Drivers creatives, which agree
 * on every value: purple ground, white copy card, and a headline whose purple
 * lead-in is followed by near-black copy.
 */
const DRIVERS_GROUND = LOGO_PURPLE;
const DRIVERS_CARD = '#FFFFFF';
const DRIVERS_ACCENT = CARD_PURPLE;
const DRIVERS_TEXT = '#17171F';

/**
 * Corp fallback palette, sampled off its five approved 1200x628 creatives:
 * the same white card and two-colour headline as Drivers, on a dark navy
 * ground instead of purple.
 */
const CORP_GROUND = '#1A1A38';
const CORP_CARD = '#FFFFFF';
const CORP_ACCENT = CARD_PURPLE;
const CORP_TEXT = DRIVERS_TEXT;

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
 * Drivers composes through the Riders templates unchanged — same variants,
 * aperture, notch, logo box, card box, type sizes and alignment — and differs
 * only in colour. The two accounts' 1.91:1 sources share their layout; what
 * changes is that Drivers sets its copy on a white card over a purple ground,
 * in two colours.
 *
 * So these templates take their colours from each input at compose time
 * (`colours`, see sampleSourceColours in imageGenerator.js). The DRIVERS_*
 * values are only the fallback. The logo has no fixed colour: it takes
 * whichever of the wordmark purple or the card colour reads better on what
 * sits behind it, which on the Riders pastel frames is the purple they use.
 */
/**
 * The Drivers steering-wheel badge, lifted from the input, needs a slot the
 * Riders layout does not have. It mirrors the logo across the canvas: top-right,
 * as far from the right edge as the logo is from the left, top-aligned with it,
 * which keeps it on the picture and clear of the card on every variant. It is
 * square, 1.6 times the logo's height (the badge-to-wordmark proportion of the
 * Drivers 1.91:1 sources), with corners a fifth of its side.
 */
const BADGE_TO_LOGO_HEIGHT = 1.6;

const buildBadgeSlot = ({ canvas, logo }) => {
  const size = Math.round(logo.box.height * BADGE_TO_LOGO_HEIGHT);
  return {
    box: { x: canvas.width - logo.box.x - size, y: logo.box.y, width: size, height: size },
    radius: Math.round(size * 0.2),
  };
};

const takeColoursFromInput = (template, {
  account,
  palette,
  badge = false,
  logoDescriptor = null,
  extras = null,
}) => ({
  ...template,
  id: template.id.replace('-riders-', `-${account}-`),
  derivedFrom: template.id,
  colourSource: 'input',
  ...(template.frame ? { frame: { background: palette.ground } } : {}),
  logo: { ...template.logo, colour: null, ...(logoDescriptor ? { descriptor: logoDescriptor } : {}) },
  ...(badge ? { badge: buildBadgeSlot(template) } : {}),
  card: {
    ...template.card,
    background: palette.card,
    textColour: palette.text,
    accentColour: palette.accent,
    ...(extras || {}),
  },
});

/**
 * Grow (or shrink) a box around its own centre, so the element keeps the
 * optical position it was measured into instead of drifting towards one corner.
 */
const scaleBoxAboutCentre = (box, scale) => {
  const width = Math.round(box.width * scale);
  const height = Math.round(box.height * scale);
  return {
    x: box.x - Math.round((width - box.width) / 2),
    y: box.y - Math.round((height - box.height) / 2),
    width,
    height,
  };
};

/**
 * Corrections that apply to one ratio only, on top of the recolouring. They
 * exist because a layout measured for a single wordmark and a promo pill does
 * not carry every account's signature and CTA equally well at every ratio.
 * A ratio that names no tuning keeps the Riders geometry exactly.
 *
 * `logoScale` is one factor for the whole ratio, or one per template id: a
 * notch is measured for the reference that owns it, so how far a signature can
 * grow before it crowds the photograph is a property of the variant, not of
 * the ratio.
 */
const applyRatioTuning = (template, tuning, sourceId) => {
  if (!tuning) return template;
  const { logoScale = 1, card } = tuning;
  const scale = typeof logoScale === 'number' ? logoScale : (logoScale[sourceId] ?? 1);
  return {
    ...template,
    ...(scale === 1
      ? {}
      : { logo: { ...template.logo, box: scaleBoxAboutCentre(template.logo.box, scale) } }),
    ...(card ? { card: { ...template.card, ...card } } : {}),
  };
};

const buildAccountVariants = ({ perRatio = {}, ...options }) => deepFreeze(Object.fromEntries(
  Object.entries(ASPECT_RATIO_TEMPLATE_VARIANTS)
    .map(([ratio, variants]) => [ratio, variants.map((template) => (
      applyRatioTuning(takeColoursFromInput(template, options), perRatio[ratio], template.id)
    ))]),
));

export const DRIVERS_TEMPLATE_VARIANTS = buildAccountVariants({
  account: 'drivers',
  palette: { ground: DRIVERS_GROUND, card: DRIVERS_CARD, text: DRIVERS_TEXT, accent: DRIVERS_ACCENT },
  badge: true,
});

/**
 * Corp signs its creatives "cabify para empresas". The sources set the two
 * side by side; stacked here, the wordmark sits above the descriptor inside
 * the very same logo box, so the Riders notch it lives in does not move.
 */
export const CORP_TEMPLATE_VARIANTS = buildAccountVariants({
  account: 'corp',
  palette: { ground: CORP_GROUND, card: CORP_CARD, text: CORP_TEXT, accent: CORP_ACCENT },
  logoDescriptor: { text: 'para empresas', fontId: 'cabify-ciudad-light' },
  // Corp's CTA reads as a button under the copy, not as a promo pill beside
  // it, so it is set closer to the type than the default marks are.
  extras: { extrasGapShare: 0.05 },
  perRatio: {
    // The 1:1 card is the shallowest of the three, so Corp's longer copy lands
    // as two tight lines with the button pressed against them. Leading and a
    // wider gap buy back the air; both are paid for out of the type size, which
    // the fitter drops by a few points.
    //
    // The button takes the default proportion and the default refusal to
    // enlarge (see EXTRAS_TO_FONT_RATIO, EXTRAS_MAX_SCALE): asking for the
    // taller 9:16 button here spent a whole step of the extras ladder on it —
    // a 55px button under 33px copy — and the copy paid for it. At the default
    // the ladder drops a step, the button comes back to the height of about one
    // line, and the height it gives up goes into the type.
    '1:1': { card: { lineSpacingShare: 0.10, extrasGapShare: 0.08 } },
    // The stacked signature spends about a third of the logo box on "para
    // empresas", so its wordmark reads smaller than the single-line Riders one
    // the box was measured for. 9:16 is where that shows.
    //
    // The notch is the ceiling, and each reference drew its own, so the factor
    // is per variant: growing all three by what the tightest tolerates left the
    // other two short of their own ground. Each value below is the largest that
    // still leaves the signature about 16px of flat ground before the
    // photograph, measured on the ink rather than on the box.
    //
    // They do not converge, and should not: the three notches are 347, 341 and
    // 314px wide, and the references' own wordmarks track that spread. The tall
    // frame is the narrow one, and its signature already runs wider across its
    // notch than the approved wordmark does, so it has nothing left to give.
    //
    // Corp's own sources ship the button at about 311x75, too small for this
    // card, so here alone a little enlargement is allowed and the button is
    // asked to sit taller against the type; the copy gives up a few points.
    '9:16': {
      logoScale: {
        '9-16-riders-frame': 1.34,
        '9-16-riders-frame-lavender': 1.26,
        '9-16-riders-frame-tall': 1.14,
      },
      card: { extrasToFontRatio: 1.5, extrasMaxScale: 1.3 },
    },
  },
});

/** Template set per Cabify account. */
const ACCOUNT_TEMPLATE_VARIANTS = Object.freeze({
  riders: ASPECT_RATIO_TEMPLATE_VARIANTS,
  drivers: DRIVERS_TEMPLATE_VARIANTS,
  corp: CORP_TEMPLATE_VARIANTS,
});

export const getAspectRatioTemplateVariants = (account) => {
  const id = account || DEFAULT_CABIFY_ACCOUNT;
  if (!Object.hasOwn(ACCOUNT_TEMPLATE_VARIANTS, id)) {
    throw new Error(`Unknown Cabify account for Aspect Ratio templates: ${account}.`);
  }
  return ACCOUNT_TEMPLATE_VARIANTS[id];
};

/**
 * The first variant of each ratio, kept under the original export name for
 * callers and tests that only ever needed the canonical template.
 */
export const ASPECT_RATIO_TEMPLATE_DEFINITIONS = deepFreeze(Object.fromEntries(
  Object.entries(ASPECT_RATIO_TEMPLATE_VARIANTS).map(([ratio, variants]) => [ratio, variants[0]]),
));

/** Ordered template ids for a ratio: one generated variation per entry. */
export const listAspectRatioTemplateIds = (targetRatio, account) => {
  const variants = getAspectRatioTemplateVariants(account)[String(targetRatio ?? '').trim()];
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

const resolveTemplate = (targetRatio, templateId, account) => {
  if (typeof targetRatio !== 'string' || !targetRatio.trim()) {
    throw new Error('targetRatio is required.');
  }
  const ratio = targetRatio.trim();
  const variants = getAspectRatioTemplateVariants(account)[ratio];
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
  // Keyed by fill as well: a template that takes its colours from the input
  // paints the same geometry in whatever the source uses.
  const key = `${template.id}|${template.card.background}`;
  if (fixedCardShapeCache.has(key)) return fixedCardShapeCache.get(key);

  const { card } = template;
  const loading = sharp(roundedRectangleSvg({
    width: card.box.width,
    height: card.box.height,
    radius: card.radius,
    fill: card.background,
  })).png().toBuffer().catch((error) => {
    fixedCardShapeCache.delete(key);
    throw error;
  });

  fixedCardShapeCache.set(key, loading);
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

/**
 * Split the copy into colour runs. Only a template with an accent colour uses
 * one, and the caller only names WHICH words take it: an accent that is not
 * literally part of the copy leaves the copy in a single colour.
 */
const buildTextMarkup = (text, card, accentText) => {
  const run = (colour, value) => (value ? `<span foreground="${colour}">${escapePangoMarkup(value)}</span>` : '');
  const accentIndex = card.accentColour && accentText ? text.indexOf(accentText) : -1;
  if (accentIndex < 0) return run(card.textColour, text);
  return run(card.textColour, text.slice(0, accentIndex))
    + run(card.accentColour, accentText)
    + run(card.textColour, text.slice(accentIndex + accentText.length));
};

const renderTextAtSize = async ({ text, accentText, font, fontPath, card, textBox, fontSize }) => {
  const markup = buildTextMarkup(text, card, accentText);
  // Extra leading, as a share of the fitted type size so it tracks the copy
  // instead of the box. Sharp adds it between lines and nowhere else, and zero
  // is its own default, so a template that does not ask for it renders exactly
  // as it did before this knob existed.
  const spacing = Math.round(fontSize * (card.lineSpacingShare ?? 0));
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
      ...(spacing > 0 ? { spacing } : {}),
    },
  }).png().toBuffer();
  const metadata = await sharp(buffer).metadata();
  if (!metadata.width || !metadata.height) throw new Error('Sharp returned an empty text layer.');
  return { buffer, width: metadata.width, height: metadata.height, fontSize };
};

const textFits = (rendered, textBox) =>
  rendered.width <= textBox.width && rendered.height <= textBox.height;

const buildTextLayer = async (template, text, fontId, textBoxOverride, accentText = '') => {
  // The box is a parameter, not a constant: when the source card carries
  // buttons or partner marks they take a share of it and the copy is fitted
  // into what is left. The height goes in the cache key for that reason.
  const textBox = textBoxOverride || template.card.textBox;
  const { textColour, accentColour = '' } = template.card;
  const key = `${template.id}\u0000${fontId}\u0000${textBox.height}\u0000${textColour}\u0000${accentColour}\u0000${accentText}\u0000${text}`;
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
          accentText,
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
/**
 * How tall the marks should be relative to the copy's own type size.
 *
 * Estimated off a source creative, by eye rather than in pixels: a promo pill
 * sits at roughly the height of one line of the headline. Taking the largest
 * share the copy merely survives inflates the marks past the type they sit
 * under — a 69px pill beneath 36px copy — so the share is chosen to land
 * nearest this ratio instead.
 *
 * The exact value matters less than it looks: the candidate shares are coarse,
 * so anything from about 1.0 to 1.4 selects the same one. Re-measure before
 * moving it, not after.
 */
const EXTRAS_TO_FONT_RATIO = 1.15;
/**
 * How far past its own pixels a crop may be stretched. The default never
 * enlarges: a promo pill lifted from a source creative is only as sharp as the
 * pixels it came with. A template whose sources ship a CTA too small for the
 * target card raises this (see the Corp set), at the cost of a soft edge.
 */
const EXTRAS_MAX_SCALE = 1;
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
  const maxScale = card.extrasMaxScale ?? EXTRAS_MAX_SCALE;
  const source = await sharp(extrasBuffer).metadata();
  const maxHeight = Math.min(
    Math.floor(card.textBox.height * heightShare),
    Math.floor((source.height || 0) * maxScale),
  );
  if (maxHeight < EXTRAS_MIN_HEIGHT) return null;

  const keyed = await keyOutPanel(extrasBuffer, panelColour);
  const resized = await sharp(keyed)
    .resize({
      width: card.textBox.width,
      height: maxHeight,
      fit: 'inside',
      withoutEnlargement: maxScale <= 1,
    })
    .png()
    .toBuffer();
  const metadata = await sharp(resized).metadata();
  if (!metadata.width || !metadata.height) return null;
  if (metadata.height < EXTRAS_MIN_HEIGHT) return null;
  return { buffer: resized, width: metadata.width, height: metadata.height };
};

const fixedLogoCache = new Map();

/** Paint the wordmark's own alpha in a flat colour. */
const tintAlpha = async (alphaSource, { width, height, colour }) => {
  const alpha = await sharp(alphaSource).extractChannel('alpha').png().toBuffer();
  return sharp({ create: { width, height, channels: 3, background: colour } })
    .joinChannel(alpha)
    .png()
    .toBuffer();
};

/**
 * Measured off the approved Corp lockup: "cabify" is 183x59 and "para
 * empresas" 288x30, both from the same baseline. Stacking the two keeps those
 * proportions, so the wordmark is about two thirds of the block's height and
 * the descriptor about half again as wide as the wordmark.
 */
const DESCRIPTOR_TO_WORDMARK_WIDTH = 288 / 183;
const DESCRIPTOR_HEIGHT_SHARE = 30 / 288;
const LOCKUP_GAP_SHARE = 0.1;

const buildLockupParts = (box, wordmarkAspect) => {
  const gap = Math.round(box.height * LOCKUP_GAP_SHARE);
  const available = box.height - gap;
  // Split the height the way the two parts' own proportions do.
  const wordmarkShare = (1 / wordmarkAspect)
    / ((1 / wordmarkAspect) + DESCRIPTOR_TO_WORDMARK_WIDTH * DESCRIPTOR_HEIGHT_SHARE);
  const wordmarkHeight = Math.max(1, Math.round(available * wordmarkShare));
  const descriptorHeight = Math.max(1, available - wordmarkHeight);
  const wordmarkWidth = Math.min(box.width, Math.round(wordmarkHeight * wordmarkAspect));
  const descriptorWidth = Math.min(box.width, Math.round(wordmarkWidth * DESCRIPTOR_TO_WORDMARK_WIDTH));
  return { gap, wordmarkWidth, wordmarkHeight, descriptorWidth, descriptorHeight };
};

/** The descriptor, set in its own face and trimmed to its ink. */
const renderDescriptor = async ({ descriptor, colour, width, height }) => {
  const font = ASPECT_RATIO_FONT_REGISTRY[descriptor.fontId];
  if (!font) throw new Error(`Unknown Aspect Ratio fontId: ${descriptor.fontId}.`);
  // The source lockup sets 30px-tall ink at 41px; start there and let the
  // resize below land it exactly on the box.
  const fontSize = Math.max(6, Math.round(height * (41 / 30)));
  const rendered = await sharp({
    text: {
      text: `<span foreground="${colour}">${escapePangoMarkup(descriptor.text)}</span>`,
      font: `${font.pangoName} ${fontSize}`,
      fontfile: resolveRuntimeAsset('fonts', font.fileName),
      rgba: true,
      dpi: 72,
    },
  }).png().toBuffer();

  const { data, info } = await sharp(rendered).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width;
  let right = -1;
  let top = info.height;
  let bottom = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * 4 + 3] <= 40) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < left || bottom < top) throw new Error('The logo descriptor rendered empty.');

  return sharp(rendered)
    .extract({ left, top, width: right - left + 1, height: bottom - top + 1 })
    .resize(width, height, { fit: 'fill' })
    .png()
    .toBuffer();
};

const buildFixedLogo = async (template) => {
  if (template.logo.mode !== 'asset') return null;
  const { box, colour, descriptor } = template.logo;
  const key = `${template.id}|${colour}|${descriptor ? `${descriptor.fontId}:${descriptor.text}` : ''}`;
  if (fixedLogoCache.has(key)) return fixedLogoCache.get(key);

  const loading = (async () => {
    const assetPath = resolveRuntimeAsset(template.logo.assetFolder, template.logo.assetFile);
    const source = await readAsset(assetPath);

    if (!descriptor) {
      const resized = await sharp(source, { failOn: 'error' })
        .resize(box.width, box.height, { fit: 'fill' })
        .ensureAlpha()
        .png()
        .toBuffer();
      const input = await tintAlpha(resized, { width: box.width, height: box.height, colour });
      return { input, left: box.x, top: box.y };
    }

    // Stacked lockup: the wordmark above its descriptor, both centred on the
    // box the horizontal wordmark would have filled.
    //
    // Centred, not flush left, and the two are not the same picture here: the
    // descriptor is half again as wide as the wordmark, so left-aligning them
    // hung "cabify" off the left end of "para empresas" and pushed the whole
    // signature to the left of the notch it sits in. The box is centred in that
    // notch, so centring the lockup in the box centres it in the notch too.
    const { width: assetWidth, height: assetHeight } = await sharp(source).metadata();
    const parts = buildLockupParts(box, assetWidth / assetHeight);
    const wordmark = await tintAlpha(
      await sharp(source, { failOn: 'error' })
        .resize(parts.wordmarkWidth, parts.wordmarkHeight, { fit: 'fill' })
        .ensureAlpha()
        .png()
        .toBuffer(),
      { width: parts.wordmarkWidth, height: parts.wordmarkHeight, colour },
    );
    const descriptorLayer = await renderDescriptor({
      descriptor,
      colour,
      width: parts.descriptorWidth,
      height: parts.descriptorHeight,
    });
    const input = await sharp({
      create: { width: box.width, height: box.height, channels: 4, background: '#00000000' },
    })
      .composite([
        { input: wordmark, left: Math.round((box.width - parts.wordmarkWidth) / 2), top: 0 },
        {
          input: descriptorLayer,
          left: Math.round((box.width - parts.descriptorWidth) / 2),
          top: parts.wordmarkHeight + parts.gap,
        },
      ])
      .png()
      .toBuffer();
    return { input, left: box.x, top: box.y };
  })().catch((error) => {
    fixedLogoCache.delete(key);
    throw error;
  });

  fixedLogoCache.set(key, loading);
  return loading;
};

const HEX_COLOUR = /^#[0-9A-F]{6}$/;

const hexToChannels = (hex) => [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));

/** WCAG relative luminance of an sRGB colour given as channels. */
const relativeLuminance = (channels) => {
  const [r, g, b] = channels.map((value) => {
    const unit = value / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrastRatio = (first, second) => {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
};

/**
 * Apply the input's colours to a template that takes them from the input; any
 * other template ignores them, which keeps the measured palettes immutable.
 * A missing or malformed colour keeps the template's own value.
 */
const applyInputColours = (template, colours) => {
  if (template.colourSource !== 'input') return template;
  const pick = (value, fallback) => {
    const hex = typeof value === 'string' ? value.trim().toUpperCase() : '';
    return HEX_COLOUR.test(hex) ? hex : fallback;
  };
  return {
    ...template,
    ...(template.frame ? { frame: { background: pick(colours?.ground, template.frame.background) } } : {}),
    card: {
      ...template.card,
      background: pick(colours?.card, template.card.background),
      textColour: pick(colours?.text, template.card.textColour),
      accentColour: pick(colours?.accent, template.card.accentColour),
    },
  };
};

/**
 * A template without a fixed logo colour sets the wordmark in whichever of its
 * purple or the card colour contrasts more with what lies under the logo box:
 * white on a purple frame, purple on a pastel one or a light photograph.
 */
const resolveLogoColour = async (template, base) => {
  if (template.logo.colour) return template;
  const { box } = template.logo;
  // Read the pixels out rather than calling stats(), which measures the whole
  // input and ignores the extract.
  const { data } = await sharp(base)
    .extract({ left: box.x, top: box.y, width: box.width, height: box.height })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const behind = [0, 0, 0];
  for (let offset = 0; offset < data.length; offset += 3) {
    behind[0] += data[offset];
    behind[1] += data[offset + 1];
    behind[2] += data[offset + 2];
  }
  const pixelCount = data.length / 3;
  for (let channel = 0; channel < 3; channel += 1) behind[channel] /= pixelCount;
  const colour = [LOGO_PURPLE, template.card.background]
    .reduce((best, candidate) => (
      contrastRatio(hexToChannels(candidate), behind) > contrastRatio(hexToChannels(best), behind) ? candidate : best
    ));
  return { ...template, logo: { ...template.logo, colour } };
};

/**
 * The input's badge re-cut into the template's rounded square. The crop
 * carries a sliver of the source photograph at its corners, which the mask
 * removes. A template without a badge slot, or an input without a badge,
 * yields nothing.
 */
const buildBadgeLayer = async (template, badgeBuffer) => {
  if (!template.badge || !badgeBuffer) return null;
  const { box, radius } = template.badge;
  try {
    const input = await sharp(badgeBuffer, { failOn: 'error' })
      .resize(box.width, box.height, { fit: 'cover', kernel: 'lanczos3' })
      .ensureAlpha()
      .composite([{
        input: roundedRectangleSvg({ width: box.width, height: box.height, radius, fill: '#FFFFFF' }),
        blend: 'dest-in',
      }])
      .png()
      .toBuffer();
    return { input, left: box.x, top: box.y };
  } catch {
    // The badge is an enhancement; an unreadable crop must not cost the variation.
    return null;
  }
};

/**
 * Place a generated scene behind immutable template layers and render the copy
 * locally with the selected OTF. No model call occurs in this function.
 *
 * `account` picks the template set. `colours` ({ ground, card, text, accent })
 * and `accentText` — the words set in the accent colour — only reach templates
 * that take their colours from the input, and `badge` (the input's badge crop)
 * only templates with a badge slot.
 */
export const composeAspectRatioTemplate = async ({
  sceneDataUrl,
  targetRatio,
  templateId,
  text,
  cardExtras,
  cardExtrasPanelColour,
  account,
  colours,
  accentText,
  badge,
} = {}) => {
  const resolvedTemplate = applyInputColours(resolveTemplate(targetRatio, templateId, account), colours);
  const normalizedText = normalizeText(text);
  const accent = resolvedTemplate.card.accentColour && typeof accentText === 'string'
    ? accentText.replace(/\s+/g, ' ').trim()
    : '';
  const sceneBuffer = await parseSceneDataUrl(sceneDataUrl);

  const [base, cardShape, badgeLayer] = await Promise.all([
    buildTemplateBase(sceneBuffer, resolvedTemplate),
    buildFixedCardShape(resolvedTemplate),
    buildBadgeLayer(resolvedTemplate, badge),
  ]);
  const template = await resolveLogoColour(resolvedTemplate, base);
  const logoLayer = await buildFixedLogo(template);
  const { card } = template;

  // Copy and extras share one fixed box. Try the largest allowance for the
  // extras first and step down until the copy also fits: shrinking the marks
  // costs legibility, dropping the whole variation costs the operator a choice.
  let textLayer = null;
  let extrasLayer = null;
  let textBox = card.textBox;

  if (cardExtras) {
    // Every allowance the copy survives is scored, not just the first: the
    // largest one usually fits by a hair and leaves the headline half its size.
    let bestDistance = Infinity;
    for (const share of EXTRAS_HEIGHT_SHARES) {
      const candidate = await buildExtrasLayer(template, cardExtras, cardExtrasPanelColour, share);
      if (!candidate) continue;
      const gap = Math.round(card.textBox.height * (card.extrasGapShare ?? EXTRAS_GAP_SHARE));
      const remaining = {
        ...card.textBox,
        height: card.textBox.height - candidate.height - gap,
      };
      if (remaining.height < EXTRAS_MIN_HEIGHT) continue;
      let fitted;
      try {
        fitted = await buildTextLayer(template, normalizedText, CARD_COPY_FONT_ID, remaining, accent);
      } catch {
        // Copy will not fit beside marks this tall; try a smaller allowance.
        continue;
      }
      const targetRatio = card.extrasToFontRatio ?? EXTRAS_TO_FONT_RATIO;
      const distance = Math.abs(candidate.height - fitted.fontSize * targetRatio);
      if (distance >= bestDistance) continue;
      bestDistance = distance;
      textLayer = fitted;
      extrasLayer = candidate;
      textBox = remaining;
    }
  }

  // No extras, or none small enough to leave room: the copy owns the box.
  if (!textLayer) {
    textLayer = await buildTextLayer(template, normalizedText, CARD_COPY_FONT_ID, undefined, accent);
    extrasLayer = null;
  }

  const composites = [
    ...(badgeLayer ? [badgeLayer] : []),
    { input: cardShape, left: card.box.x, top: card.box.y },
    ...(logoLayer ? [logoLayer] : []),
  ];

  if (extrasLayer) {
    // Centre the copy-plus-marks stack in the box, then place the marks under
    // the copy on the card's own alignment.
    const gap = Math.round(card.textBox.height * (card.extrasGapShare ?? EXTRAS_GAP_SHARE));
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
