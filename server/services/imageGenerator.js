import { GoogleGenAI } from '@google/genai';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  ASPECT_RATIO_FONT_REGISTRY,
  ASPECT_RATIO_TEMPLATE_VARIANTS,
  DEFAULT_ASPECT_RATIO_FONT_ID,
  buildAspectRatioFontReference,
  composeAspectRatioTemplate,
  resolveAspectRatioFontId,
} from './aspectRatioTemplate.js';
import { mapWithBoundedConcurrency } from './concurrency.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Gemini's imageConfig.aspectRatio only accepts a fixed enum: "1:1", "2:3",
 * "3:2", "3:4", "4:3", "9:16", "16:9", "21:9". Ratios outside that enum
 * (e.g. "1.91:1", the standard Google marketing-image ratio) get silently
 * mishandled by the API. For those we request the closest supported enum
 * value instead and center-crop the result down to the exact target ratio
 * afterward.
 */
const GEMINI_SUPPORTED_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'];

const parseAspectRatioValue = (ratio) => {
  const [w, h] = String(ratio).split(':').map(Number);
  return w > 0 && h > 0 ? w / h : null;
};

const resolveGeminiAspectRatio = (targetRatio) => {
  if (GEMINI_SUPPORTED_ASPECT_RATIOS.includes(targetRatio)) return targetRatio;
  const targetValue = parseAspectRatioValue(targetRatio);
  if (targetValue == null) return targetRatio;
  return GEMINI_SUPPORTED_ASPECT_RATIOS.reduce((closest, candidate) => {
    const diff = Math.abs(parseAspectRatioValue(candidate) - targetValue);
    const closestDiff = Math.abs(parseAspectRatioValue(closest) - targetValue);
    return diff < closestDiff ? candidate : closest;
  });
};

const needsAspectRatioCrop = (targetRatio) => !GEMINI_SUPPORTED_ASPECT_RATIOS.includes(targetRatio);

/** Center-crops a data URL image down to the exact target "W:H" ratio. */
const cropDataUrlToAspectRatio = async (dataUrl, targetRatio) => {
  const match = typeof dataUrl === 'string' && dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  const targetValue = parseAspectRatioValue(targetRatio);
  if (!match || targetValue == null) return dataUrl;

  const buffer = Buffer.from(match[2], 'base64');
  const image = sharp(buffer);
  const { width, height } = await image.metadata();
  if (!width || !height) return dataUrl;

  const currentValue = width / height;
  let cropWidth = width;
  let cropHeight = height;
  if (currentValue > targetValue) {
    cropWidth = Math.max(1, Math.round(height * targetValue));
  } else if (currentValue < targetValue) {
    cropHeight = Math.max(1, Math.round(width / targetValue));
  } else {
    return dataUrl;
  }

  const left = Math.max(0, Math.floor((width - cropWidth) / 2));
  const top = Math.max(0, Math.floor((height - cropHeight) / 2));

  const outputBuffer = await image
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .png()
    .toBuffer();

  return `data:image/png;base64,${outputBuffer.toString('base64')}`;
};

const BRAND_LOCK =
  'BRAND LOCK - do NOT modify, replace, recolor, restyle, resize, or reinterpret typography or brand colors under any circumstance. Keep exact original font, weight, proportions, letter-spacing, and all colors unchanged.';

const ASPECT_RATIO_BRAND_LOCK =
  'BRAND LOCK - preserve the CURRENT source identity exactly: typography, logos, colours, card surface and CTA artwork. The target-ratio geometry may change only an element\'s size and position; never redraw, substitute, recolour, stretch, condense, skew, rotate or otherwise restyle it.';

const INPUT_COLOUR_LOCK = `
## INPUT COLOUR LOCK - ABSOLUTE
- Every visible colour from the input is locked: logo/wordmark, logo tab, typography, card, CTA, border, shadow, icon, illustration, partner mark, photograph and background.
- Reproduce each source colour exactly, including its hue, saturation, lightness, opacity, gradient and contrast relationship. Do NOT recolour, invert, brighten, darken, tint, desaturate, replace or "improve" any colour.
- Image 1 is the colour authority for the generated scene and logo. Image 2 is the colour authority for card typography, card surface, CTA and their internal artwork. Never borrow a colour from a target-frame example or another campaign.
`.trim();

const CABIFY_TYPOGRAPHY_SYSTEM = `
## CABIFY CIUDAD TYPOGRAPHY SYSTEM - REQUIRED
- Promotional headlines and expressive card messages use Cabify Ciudad only (the supplied Light, Book, SemiBold, Bold, ExtraBold and Black family). Match the source's exact approved weight; do not substitute another family or synthesize bold/condensed letters.
- CTA labels, promo codes, buttons and any UI-like component use Cabify Ciudad Text only (the supplied Light, Book, SemiBold and Bold family). Match the source's approved weight; usually use SemiBold or Bold only when the source uses that emphasis.
- The Cabify wordmark is an artwork asset, never typeset or recreated with either family.
- Preserve comfortable, readable tracking and line-height. Never tighten tracking or line-height merely to fit more copy. Reflow first; preserve a clear weight hierarchy between headline and CTA.
- Cabify Ciudad Text is for UI/longer reading, never for the promotional headline. Cabify Ciudad is never used for a CTA/button label.
`.trim();

const CARD_REFERENCE_FOLDERS = {
  '1:1': '1-1',
  '9:16': '9-16',
  '1.91:1': '1-91-1',
};

/**
 * Ratios that may borrow another ratio's references when their own folder is
 * absent. Deliberately empty: landscape used to borrow the square folder, but
 * those references show a card spanning 93% of the canvas while the 1.91:1
 * prompt demands a compact 48-54% card and explicitly rules out a full-width
 * banner. Since the prompt asks the model to copy the reference's size and
 * position, borrowing contradicted the instruction it was meant to support —
 * and shipped ~7.7MB of inline images per call to do it.
 *
 * Drop real 1200x628 references into assets/card-references/1-91-1/ to give
 * landscape its own styling; no fallback entry is needed for that to work.
 */
const CARD_REFERENCE_FALLBACKS = {};

const ASPECT_RATIO_FONT_IDS = Object.freeze(Object.keys(ASPECT_RATIO_FONT_REGISTRY));
const ASPECT_RATIO_FONT_CLASSIFICATION_OPTIONS = ASPECT_RATIO_FONT_IDS
  .map((fontId) => `  - "${fontId}": ${ASPECT_RATIO_FONT_REGISTRY[fontId].label}`)
  .join('\n');

const CARD_COPY_EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cardText: {
      type: 'string',
      description: 'Exact non-button text visible inside the promotional card.',
    },
    buttonPresent: {
      type: 'boolean',
      description: 'Whether the source card includes a CTA button.',
    },
    buttonLabel: {
      type: 'string',
      description: 'Exact CTA/button label text. Empty string if no button exists.',
    },
    // Step 2 never sees the source card: step 1 strips it from the scene, and
    // the source image itself is only attached when this extraction fails. So
    // the card's colours have to be captured here, while the source is in view.
    cardBackgroundColor: {
      type: 'string',
      description: 'Hex colour of the card/panel background, e.g. "#5B2DD5". Empty string if unreadable.',
    },
    cardTextColor: {
      type: 'string',
      description: 'Hex colour of the card copy, e.g. "#FFFFFF". Empty string if unreadable.',
    },
    // A partner mark usually sits inside the card, which step 1 strips out. If
    // it is not recorded here it is lost for good, so the output silently drops
    // a co-branding the source was built around.
    cardBrandMarks: {
      type: 'string',
      description: 'Partner, product or sub-brand logos shown INSIDE the card, named and briefly described, comma-separated (e.g. "Mercado Pago logo in a white rounded container"). Exclude the main Cabify wordmark. Empty string if there are none.',
    },
    // Legacy model-backed profiles can still use the source box as a magnified
    // letterform reference. Aspect Ratio itself uses cardFontId to render the
    // copy deterministically with the matching bundled OTF.
    cardTextBox: {
      type: 'array',
      items: { type: 'integer' },
      minItems: 4,
      maxItems: 4,
      description: 'Bounding box of the card COPY BLOCK (headline plus CTA label, excluding the panel\'s empty margins) as [ymin, xmin, ymax, xmax] normalised to 0-1000 over the whole image.',
    },
    cardFontId: {
      type: 'string',
      enum: ASPECT_RATIO_FONT_IDS,
      description: 'Closest bundled Cabify OTF face for the main card copy. Always select exactly one allow-listed id.',
    },
    buttonFontWeight: {
      type: 'string',
      description: 'Weight of the CTA label: Light, Book, SemiBold, Bold, ExtraBold or Black. Empty string if there is no button or it is unclear.',
    },
  },
  required: [
    'cardText',
    'buttonPresent',
    'buttonLabel',
    'cardBackgroundColor',
    'cardTextColor',
    'cardBrandMarks',
    'cardTextBox',
    'cardFontId',
    'buttonFontWeight',
  ],
};

const CARD_COPY_EXTRACTION_PROMPT = `
Image 1 is the source creative. Image 2 is a labelled visual catalog rendered
with the exact ten Cabify OTF files available to the compositor.

Read the promotional card in Image 1 and extract its literal copy.

Return JSON with exactly these fields:
- "cardText": every non-button word that appears inside the promotional card, in reading order. Preserve punctuation, accents, capitalization, and separators exactly. Join visual line wrapping with a single space: line breaks caused by the source card's narrow width are NOT content. Use "\\n" only for genuinely separate paragraphs or text blocks.
- "buttonPresent": true if the card includes a CTA/button, otherwise false.
- "buttonLabel": the CTA/button text exactly as shown. Return an empty string if there is no button.
- "cardBackgroundColor": the hex colour of the card/panel the copy sits on, sampled from a flat area away from any shadow or gradient.
- "cardTextColor": the hex colour of that copy.
- "cardBrandMarks": any partner, product or sub-brand logo shown inside the card - name it and describe its container briefly. Do NOT list the main Cabify wordmark. Empty string if there is none.
- "cardTextBox": the bounding box that tightly encloses the card's copy block - the headline plus the CTA label - as [ymin, xmin, ymax, xmax] normalised to 0-1000 over the whole image. Wrap the text itself, not the card panel's empty margins. Exclude any partner logo that sits apart from the copy.
- "cardFontId": compare the main card copy in Image 1 directly against the labelled rows in Image 2 and choose the ONE bundled OTF face that is visually closest. Compare glyph proportions first (Cabify Ciudad versus Cabify Ciudad Text), then stroke thickness. Allowed values:
${ASPECT_RATIO_FONT_CLASSIFICATION_OPTIONS}
- "buttonFontWeight": the CTA label's weight: "Light", "Book", "SemiBold", "Bold", "ExtraBold" or "Black". Empty string if there is no button or you cannot tell.

Rules:
- Extract text only from the card. Ignore the rest of the scene, logo, people, cars, and background.
- Image 2 is typography reference only. Never copy its ids, alphabet samples, numbers or example sentence into "cardText".
- Do NOT translate, rewrite, summarize, normalize, fix spelling, or infer missing words.
- Do NOT borrow copy from any other image.
- If a word is partially obscured, return the visible characters only.
- "cardFontId" may never be blank or custom. If the match is ambiguous, choose the closest allowed face; default to "${DEFAULT_ASPECT_RATIO_FONT_ID}" only when the source has too little legible copy to compare.
- Return JSON only.
`.trim();

const SCENE_PROHIBITIONS = `
## SCENE-ONLY GENERATION - CRITICAL
- Do NOT include any UI card, white rounded rectangle, text overlay, CTA button, or promotional panel in the output.
- The bottom portion of the canvas must be clean scene/background - no card elements at all.
- Remove any card/text overlay that exists in the source; replace it with natural scene/background continuation.
- Keep: subject, logo (brand logo at top), scene background.
- ${BRAND_LOCK}
- Do NOT modify the main subject. Do NOT add filters, blur, gradients, or color shifts.
`.trim();

/**
 * Same as SCENE_PROHIBITIONS, but it strips only the copy card - the element
 * step 2 rebuilds - while making explicit that the logo and the surrounding
 * brand furniture are NOT card elements and must stay untouched. Without that
 * distinction the model treats the whole brand layer as an overlay to remove.
 */
const SCENE_PROHIBITIONS_REFRAME = `
## BACKGROUND-ONLY GENERATION - CRITICAL
- Return only the photograph/background. A deterministic compositor adds the template frame, logo, text box and OTF-rendered text after this model call.
- Remove the COMPLETE promotional copy card/panel from the source: headline, CTA, partner mark, coloured panel, shadow and every reserved area belonging to it. Reclaim its footprint with a natural continuation of the same photograph/background.
- Remove every logo, wordmark, logo tab, frame, border, badge, promo code and text overlay from the source. Rebuild the pixels behind them as a plausible continuation of the same scene.
- Do NOT draw a replacement frame, logo, card, placeholder, solid-colour band or split-screen layout. Do not leave an empty area reserved for them; the photograph/background must continue edge to edge.
- Preserve the main subject and the source scene. Do NOT add filters, blur, gradients or colour shifts.
`.trim();

/**
 * Prompt profile used by the Aspect Ratio tool (Single Image and Batch from
 * Sheets). The ciclo shares this generator but deliberately keeps the previous
 * wording, so every profile-aware block below defaults to the legacy text.
 */
export const ASPECT_RATIO_PROMPT_PROFILE = 'aspect-ratio';

const usesAspectRatioProfile = (profile) => profile === ASPECT_RATIO_PROMPT_PROFILE;

/**
 * The scene prohibitions say what to REMOVE but never that adding is
 * forbidden, which is how invented cars, props and re-imagined settings get in.
 * This closes that gap for the Aspect Ratio tool.
 */
const CONTENT_LOCK = `
## CONTENT LOCK - THE SOURCE IS THE ONLY TRUTH
- The output must contain ONLY what already exists in the source image. Do NOT add any object, vehicle, person, animal, building, or prop that is not visible in the source.
- If the source has no vehicle, the output has no vehicle. If the source is an interior, it stays an interior.
- Do NOT change the subject's identity, face, pose, clothing, hair, or skin tone.
- Do NOT change the setting, time of day, weather, or colour palette of the scene.
- Any extended background must be a plausible continuation of the SAME scene: same materials, same lighting direction, same depth of field. Never a new environment.
- Do NOT add a CTA, button, promo code, coupon, badge or any other element the source does not already contain. If the source card has no promo code, the output has no promo code.
`.trim();

/**
 * The older target examples establish geometry only. The incoming source owns
 * the current visual identity. Keeping those authorities separate prevents a
 * narrow or split source card from being copied into a wide target-ratio box.
 */
const DESIGN_SYSTEM_LOCK = `
## CURRENT IDENTITY / TARGET GEOMETRY - AUTHORITY ORDER
- The stored target examples belong to a PREVIOUS visual identity. Their pixels are NOT a style reference. Only their numeric geometry, already written below, is valid: element size, target position, margins and typography scale.
- The SOURCE creative is the ONLY current-identity reference. Preserve its colours, typeface, glyph shapes, weight, logo artwork/container, card fill/shape/radius/shadow, illustrations and CTA styling exactly.
- The SOURCE layout is NOT authoritative. Never copy its card/panel width, height, aspect ratio, X/Y position, split-screen proportion, margin, padding, typography scale, line breaks, logo scale or logo position.
- The written target-ratio geometry below is absolute. It rebuilds the source identity responsively inside its target bounding boxes. A narrow, tall or side-panel source card MUST become the specified wide target card while retaining its current colours, type and surface treatment.
- The target frame is geometry, not a visual reference: preserve/rebuild only its thin margins, rounded photo-panel silhouette and local logo notch using the numeric rules below. Its ground colour, finish and logo/container styling come from the CURRENT source, never from an older reference. Never use the source's frame size, never expand the local logo notch into a strip or band, and never reserve an empty header.
- The three variants may change photographic framing only. Card and logo target geometry must remain identical across all variants.
`.trim();

const TEMPLATE_COMPOSITOR_LOCK = `
## IMMUTABLE TEMPLATE LAYERS
- This model call owns ONLY the photograph/background.
- The server, not the model, adds the reference template's frame, logo and text box at exact pixel coordinates.
- Do not imitate, reserve space for, redraw or include any of those layers in this output.
- The server also renders the approved copy with a real Cabify OTF. Return no text of any kind.
`.trim();

/**
 * Pass 2 receives the original creative as a visual authority. The structured
 * extraction remains authoritative for literal copy, while the source pixels
 * carry the details that cannot be represented faithfully in JSON: glyph
 * shapes, spacing, CTA artwork and other small brand treatments.
 */
const SOURCE_CARD_APPEARANCE_LOCK = `
## CURRENT SOURCE IDENTITY LOCK - IMAGE 2 DEFINES STYLE, NEVER LAYOUT
- The CARD COPY LOCK is authoritative for literal words and "buttonPresent". If extraction fell back to Image 2, inspect it only for literal copy and CTA presence. Image 2 is authoritative for CURRENT identity: colours, card surface, typography, logo artwork/container and CTA artwork. The written target-ratio measurements are authoritative for ALL geometry.
- Image 2 is the SOURCE creative. Use it only as a pixel-level identity reference. Image 1 remains the immutable source for the photograph, subject, background and target-ratio framing, including the final-ratio logo.
- NEVER take from Image 2: card width, card height, card aspect ratio, card X/Y position, card margins, padding, text alignment, typography scale, line breaks, logo scale, logo position or logo rotation. Never scale Image 2's complete card as one rigid object.
${INPUT_COLOUR_LOCK}
${CABIFY_TYPOGRAPHY_SYSTEM}
- TYPOGRAPHY: reproduce Image 2's typeface and glyph shapes, weight, width, capitalization, letter-spacing, line-height and hierarchy so the result is visually indistinguishable from the source. Do NOT substitute a generic sans-serif, synthesize a different bold weight, condense or stretch the letters, or change the typographic hierarchy.
- Source line wrapping is incidental and must NOT be copied. Reflow the exact words naturally for the target box at the locked target type scale, using the fewest natural lines that fit. For example, do not preserve one-word-per-line wrapping from a narrow source card.
- CTA: if the structured CARD COPY LOCK says a button exists, or the extraction fallback reveals a CTA in Image 2, reproduce Image 2's complete CTA as one locked visual component: same proportions, internal padding and spacing, fill or gradient, colour values, border, corner radius, shadow, opacity, typography, label, icons, logos, illustrations, photographs and image crop. Only uniform scaling and repositioning of the complete CTA are allowed to follow the target-ratio layout. Do not simplify an illustrated CTA into a generic button and do not replace its imagery.
- If Image 2 has no CTA, do not create one. Never borrow a CTA, icon, image, colour or word from another creative.
`.trim();

const buildSceneGuards = (profile) => (usesAspectRatioProfile(profile)
  ? `${SCENE_PROHIBITIONS_REFRAME}\n\n${CONTENT_LOCK}`
  : SCENE_PROHIBITIONS);

/**
 * A hard position/size for the logo fights the reframe rules: the source's own
 * lockup is what has to survive. The reframe wording keeps a size anchor but
 * defers the treatment to whatever the source already does.
 */
/**
 * Styling comes from the source; placement does not always. A ratio can carry a
 * hard placement rule of its own (9:16 must clear the Stories profile overlay),
 * so it is passed separately instead of being folded into "keep it as it is".
 */
const buildLogoLayoutLine = (profile, legacyLine, widthRange, placement = '') => (usesAspectRatioProfile(profile)
  ? '- Logo: do NOT render one. The deterministic target template adds the locked logo later at its exact pixel size and position.'
  : legacyLine);

/**
 * These measurements are taken from the user-supplied example frames. They
 * intentionally describe geometry only; no old-identity pixels are sent to
 * the image model.
 */
const getTargetFrameGeometry = (targetRatio, profile) => {
  if (!usesAspectRatioProfile(profile)) return '';

  if (String(targetRatio).trim() === '1:1') {
    return `## TEMPLATE APERTURE - 1:1
- Generate a continuous square photograph/background all the way to every canvas edge.
- Do NOT render the rounded photo aperture, outer frame, local logo notch, logo or text box. The server applies those immutable pixels from the 1:1 reference template afterward.`;
  }

  if (String(targetRatio).trim() === '9:16') {
    return `## TEMPLATE APERTURE - 9:16
- Generate a continuous vertical photograph/background all the way to every canvas edge.
- Do NOT render a frame, logo, logo tab or text box. The server applies the immutable 9:16 reference template afterward.`;
  }

  return '';
};

const NINE_SIXTEEN_SUBJECT_COMPOSITION = `## 9:16 SUBJECT COMPOSITION - NON-NEGOTIABLE
- Reframe horizontally so the primary person's face and upper torso are centred around x=50% and remain inside the central x=42%-58% band. The person must read as centred, not pressed against either side.
- When an arm, phone or other held object extends sideways, centre the person's face and torso rather than the combined silhouette. The extended hand or object may remain off-centre.
- Add or extend the same background on the side that needs room to achieve this balance. Horizontal translation/reframing of the complete unchanged subject is required when needed and is not a subject redesign.
- Preserve the person's exact identity, pose, anatomy, clothing, scale and photographic detail. Do not mirror, redraw, warp or crop the person.`;

const NINE_SIXTEEN_CARD_SAFE_ZONE = `**9:16 PLATFORM SAFE ZONE - ABSOLUTE:**
- The copy-card safe region runs vertically from y=15% through y=84% of the canvas. The top 15% and bottom 16% are exclusion bands used by the platform UI.
- Keep the ENTIRE card inside that safe region: panel, shadow, headline, CTA/button, partner marks and every decorative extension. No card pixel may enter either exclusion band.
- The yellow areas shown in review guides are annotations only. Never render a yellow overlay, safe-zone tint, guide line or boundary in the final creative.`;

const parseJsonResponseText = (text) => {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const normalizeCardCopyField = (value) =>
  typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : '';

// Narrow source cards often visually wrap every word. Those wraps are layout,
// not copy, and must not force a tall/narrow target-ratio card.
const normalizeCardTextForResponsiveLayout = (value) =>
  normalizeCardCopyField(value).replace(/\s+/g, ' ').trim();

/** Accepts #RGB or #RRGGBB and normalises to uppercase #RRGGBB. */
const normalizeHexColour = (value) => {
  const text = typeof value === 'string' ? value.trim() : '';
  const match = text.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return '';
  const digits = match[1];
  const full = digits.length === 3
    ? digits.split('').map((digit) => digit + digit).join('')
    : digits;
  return `#${full.toUpperCase()}`;
};

const CABIFY_FONT_WEIGHTS = ['Light', 'Book', 'SemiBold', 'ExtraBold', 'Bold', 'Black'];
const CABIFY_FONT_FAMILIES = ['Cabify Ciudad Text', 'Cabify Ciudad'];

/** Matches loosely ("extra bold", "semibold") but only ever returns a real face name. */
const normalizeFromVocabulary = (value, vocabulary) => {
  const text = typeof value === 'string' ? value.toLowerCase().replace(/[^a-z]/g, '') : '';
  if (!text) return '';
  return vocabulary.find((entry) => text === entry.toLowerCase().replace(/[^a-z]/g, ''))
    || vocabulary.find((entry) => text.includes(entry.toLowerCase().replace(/[^a-z]/g, '')))
    || '';
};

/**
 * Gemini reports boxes as [ymin, xmin, ymax, xmax] over a 0-1000 grid. A box
 * that covers most of the canvas means the model never localised the copy, and
 * a sliver means it locked onto an edge; both crop to something useless, so
 * they are dropped rather than shipped as a typography reference.
 */
const CARD_TEXT_BOX_MIN_SPAN = 20;
const CARD_TEXT_BOX_MAX_AREA = 0.6;

const normalizeCardTextBox = (value) => {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const box = value.map(Number);
  if (box.some((coordinate) => !Number.isFinite(coordinate) || coordinate < 0 || coordinate > 1000)) return null;

  const [yMin, xMin, yMax, xMax] = box;
  const height = yMax - yMin;
  const width = xMax - xMin;
  if (height < CARD_TEXT_BOX_MIN_SPAN || width < CARD_TEXT_BOX_MIN_SPAN) return null;
  if ((width / 1000) * (height / 1000) > CARD_TEXT_BOX_MAX_AREA) return null;

  return [yMin, xMin, yMax, xMax];
};

const normalizeExtractedCardCopy = (payload) => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const cardText = normalizeCardTextForResponsiveLayout(payload.cardText);
  const buttonLabel = normalizeCardCopyField(payload.buttonLabel);
  const buttonPresent = payload.buttonPresent === true;
  const legacyFamily = normalizeFromVocabulary(payload.cardFontFamily, CABIFY_FONT_FAMILIES);
  const legacyWeight = normalizeFromVocabulary(payload.cardFontWeight, CABIFY_FONT_WEIGHTS);
  let cardFontId = null;
  if (payload.cardFontId) {
    try {
      cardFontId = resolveAspectRatioFontId({ fontId: payload.cardFontId });
    } catch {
      // Try the old family/weight fields below before taking the default.
    }
  }
  if (!cardFontId && (legacyFamily || legacyWeight)) {
    try {
      cardFontId = resolveAspectRatioFontId({
        fontFamily: legacyFamily,
        fontWeight: legacyWeight,
      });
    } catch {
      // The requested family/weight combination may not exist as an OTF.
    }
  }
  // The renderer must always land on a shipped OTF. Invalid or unavailable
  // classifications fall back to the canonical display face.
  cardFontId ||= DEFAULT_ASPECT_RATIO_FONT_ID;
  const selectedFont = ASPECT_RATIO_FONT_REGISTRY[cardFontId];

  return {
    cardText,
    buttonPresent,
    buttonLabel,
    cardBackgroundColor: normalizeHexColour(payload.cardBackgroundColor),
    cardTextColor: normalizeHexColour(payload.cardTextColor),
    cardBrandMarks: normalizeCardCopyField(payload.cardBrandMarks),
    cardTextBox: normalizeCardTextBox(payload.cardTextBox),
    cardFontId,
    cardFontFamily: selectedFont.family,
    cardFontWeight: selectedFont.weight,
    buttonFontWeight: normalizeFromVocabulary(payload.buttonFontWeight, CABIFY_FONT_WEIGHTS),
  };
};

/**
 * The whole creative reaches Gemini downscaled, so a 60px headline arrives as
 * a text-shaped smudge and pass 2 redraws it in whatever sans it likes. This
 * crops the source copy block out at full resolution and magnifies it, so the
 * letterforms the output has to match are actually legible in the request.
 *
 * Geometry from this crop is never usable - the prompt restricts it to
 * letterforms - and it carries no content the source did not already have, so
 * unlike the old campaign references it cannot leak a foreign element.
 */
const TYPOGRAPHY_REFERENCE_TARGET_EDGE = 1024;
const TYPOGRAPHY_REFERENCE_MAX_EDGE = 1536;
const TYPOGRAPHY_REFERENCE_PADDING = 0.06;
const TYPOGRAPHY_REFERENCE_MIN_CROP = { width: 64, height: 24 };

const clampToRange = (value, min, max) => Math.min(max, Math.max(min, value));

export const buildSourceTypographyReference = async (sourceImageData, cardTextBox) => {
  const box = normalizeCardTextBox(cardTextBox);
  if (!box) return null;

  try {
    const buffer = Buffer.from(sourceImageData, 'base64');
    const { width, height } = await sharp(buffer).metadata();
    if (!width || !height) return null;

    const [yMin, xMin, yMax, xMax] = box;
    const padX = ((xMax - xMin) / 1000) * width * TYPOGRAPHY_REFERENCE_PADDING;
    const padY = ((yMax - yMin) / 1000) * height * TYPOGRAPHY_REFERENCE_PADDING;

    const left = Math.round(clampToRange((xMin / 1000) * width - padX, 0, width - 1));
    const top = Math.round(clampToRange((yMin / 1000) * height - padY, 0, height - 1));
    const right = Math.round(clampToRange((xMax / 1000) * width + padX, left + 1, width));
    const bottom = Math.round(clampToRange((yMax / 1000) * height + padY, top + 1, height));

    const cropWidth = right - left;
    const cropHeight = bottom - top;
    if (cropWidth < TYPOGRAPHY_REFERENCE_MIN_CROP.width || cropHeight < TYPOGRAPHY_REFERENCE_MIN_CROP.height) {
      return null;
    }

    // Magnify a small crop up to a legible size, but never past the point where
    // the upscale invents edges the source never had - a fake glyph is worse
    // than a small one. PNG keeps the letter edges free of JPEG ringing.
    const scale = clampToRange(TYPOGRAPHY_REFERENCE_TARGET_EDGE / Math.max(cropWidth, cropHeight), 1, 4);
    const data = await sharp(buffer)
      .extract({ left, top, width: cropWidth, height: cropHeight })
      .resize({
        width: Math.min(TYPOGRAPHY_REFERENCE_MAX_EDGE, Math.round(cropWidth * scale)),
        height: Math.min(TYPOGRAPHY_REFERENCE_MAX_EDGE, Math.round(cropHeight * scale)),
        fit: 'inside',
        kernel: 'lanczos3',
      })
      .png()
      .toBuffer();

    return { data: data.toString('base64'), mimeType: 'image/png' };
  } catch {
    // A typography reference is an enhancement; losing it must never take the
    // generation down with it.
    return null;
  }
};

const hasReliableCardCopy = (cardCopy) =>
  Boolean(
    cardCopy &&
      cardCopy.cardText &&
      (!cardCopy.buttonPresent || (cardCopy.buttonPresent && cardCopy.buttonLabel)),
  );

const buildCardCopyLockBlock = (
  cardCopy,
  marksFromSourceImage = false,
  responsiveTargetLayout = false,
) => {
  const copyJson = JSON.stringify(
    {
      cardText: responsiveTargetLayout
        ? normalizeCardTextForResponsiveLayout(cardCopy.cardText)
        : cardCopy.cardText,
      buttonPresent: cardCopy.buttonPresent,
      buttonLabel: cardCopy.buttonLabel,
    },
    null,
    2,
  );

  const brandMarks = typeof cardCopy.cardBrandMarks === 'string' ? cardCopy.cardBrandMarks.trim() : '';
  const brandMarkRules = brandMarks
    ? `
**BRAND MARKS FROM THE SOURCE (must be reproduced):**
- The source card carries: ${brandMarks}
- Reproduce ${marksFromSourceImage ? 'them exactly as they are drawn in Image 2' : 'them faithfully'}, in their own container, keeping their own colours and proportions. They are part of the creative, not decoration.
- Place them inside the card, below the copy, without overlapping the text.
- Do NOT redraw, restyle, recolour, translate or reinterpret a partner mark. Do NOT add any mark that is not listed here.`
    : '';

  const referenceRule = responsiveTargetLayout
    ? '- The numeric target-ratio rules provide geometry and type scale only. The current source image provides every visual-identity decision: colour, font, card surface, logo and CTA style.'
    : '- The reference images may influence size, font sizing, color treatment, spacing, and position only. They must NEVER change the copy.';

  return `**CARD COPY LOCK (authoritative):**
\`\`\`json
${copyJson}
\`\`\`
- The ONLY allowed text source is the JSON above.
- Preserve the exact words, punctuation, accents, and capitalization from the JSON.
- ${responsiveTargetLayout
    ? 'Line wrapping is target geometry, not source content. Reflow the text naturally for the target box; never preserve visual wraps from Image 2.'
    : 'You may reflow line breaks only if needed to fit the reference layout.'}
- If "buttonPresent" is false, do not render a button.
- If "buttonPresent" is true, render the button and copy "buttonLabel" exactly.
${referenceRule}${brandMarkRules}`;
};

/**
 * Typography kept drifting to a generic sans because its rules were scattered
 * across the colour lock, the identity lock and the per-ratio card block. This
 * states the requirement once, in one place, and points at the highest-fidelity
 * evidence available for it: the magnified crop when there is one, Image 2
 * otherwise.
 */
const buildTypographyLockBlock = (cardCopy, typographyReferenceIndex) => {
  const family = typeof cardCopy?.cardFontFamily === 'string' ? cardCopy.cardFontFamily : '';
  const headlineWeight = typeof cardCopy?.cardFontWeight === 'string' ? cardCopy.cardFontWeight : '';
  const buttonWeight = typeof cardCopy?.buttonFontWeight === 'string' ? cardCopy.buttonFontWeight : '';
  const authority = typographyReferenceIndex ? `Image ${typographyReferenceIndex}` : 'Image 2';

  const referenceLines = typographyReferenceIndex
    ? `- ${authority} is a MAGNIFIED CROP of the source card's own copy, attached for exactly one purpose: letterforms. It is the highest authority on typeface, glyph skeleton, stroke weight, width, capitalization and letter-spacing.
- Redraw the CARD COPY LOCK words in those letterforms. Compare glyph by glyph before you finish: a, e, g, y, t, s and the numerals must share the same skeleton, terminals, corner rounding, counter shapes and stroke modulation as ${authority}.
- ${authority} supplies LETTERFORMS ONLY. Ignore its crop boundaries, its background, its line breaks, its type size, its position and the fact that it is a fragment. Never draw its edges, its background block, a zoomed panel or a second copy of the text into the output.`
    : `- ${authority} is the authority on typeface, glyph skeleton, stroke weight, width, capitalization and letter-spacing. Redraw the copy in exactly those letterforms, at the target type scale.`;

  const detectedLines = [
    family ? `- The source copy is set in ${family}. Use that family; do not switch to the other Cabify family or to anything else.` : '',
    headlineWeight ? `- The headline weight reads as ${family || 'Cabify Ciudad'} ${headlineWeight}. Use that weight.` : '',
    buttonWeight ? `- The CTA label weight reads as ${headlineWeight && buttonWeight === headlineWeight ? 'the same' : buttonWeight}. Preserve the weight difference between headline and CTA exactly as the source has it.` : '',
    family || headlineWeight || buttonWeight
      ? `- These names describe what ${authority} already shows. Where a name and ${authority} disagree, ${authority} wins.`
      : '',
  ].filter(Boolean).join('\n');

  return [
    '## TYPOGRAPHY LOCK - THE INPUT OWNS THE LETTERFORMS',
    referenceLines,
    detectedLines,
    `- Substituting a system or generic sans - Helvetica, Arial, Inter, Roboto, Poppins, Montserrat, Nunito, DM Sans or similar - is a FAILED output, even when the words, colours and layout are correct.
- Never synthesize a weight: do not fake bold by thickening strokes, do not fake light by thinning them, and never condense, stretch, slant, outline or re-space the letters to make copy fit. Reflow the words instead.
- Final check before returning the image: read your rendered headline and CTA against ${authority}. If any glyph differs in skeleton, weight or proportion, redraw it.`,
  ].filter(Boolean).join('\n');
};

const buildReferenceInputList = (startIndex, count) =>
  Array.from({ length: count }, (_, index) => {
    const imageNumber = startIndex + index;
    return `${imageNumber}. Image ${imageNumber} - layout/style reference only.`;
  }).join('\n');

const buildReferenceStyleSection = (label, hasRefs, profile, hasSourceStyleReference = false) => {
  if (!hasRefs) {
    if (hasSourceStyleReference) {
      return `**TARGET-SIZE GUIDE / CURRENT-IDENTITY LOCK:**
- No old campaign reference images are attached. Their allowed geometry has already been transcribed into the numeric target-ratio rules below.
- Image 2 supplies only the CURRENT identity: typography, colour, card treatment, logo artwork/container and CTA appearance. It never supplies layout.
- Follow the written target-ratio geometry below for card and logo size/position; do not enlarge its specified margins.`;
    }

    return `**REFERENCE STYLE LOCK:**
- No reference images were attached, so follow the numeric geometry below exactly.`;
  }

  // Describing the references' contents - a route map, a car on a progress bar,
  // a bordered tile - reads as a list of things to draw, and the model started
  // lifting whole elements: a promo code, a keyline, eventually the reference's
  // own subject. So the allowance is expressed as abstract style attributes
  // (proportions and positions) and every visible element stays banned.
  if (usesAspectRatioProfile(profile)) {
    return `**REFERENCE IMAGES (${label}) - LAYOUT GUIDE ONLY:**
- Read the references as a GEOMETRY DIAGRAM. They answer two questions and nothing else: WHERE each element sits on the canvas and HOW LARGE it is relative to the canvas.
- They are deliberately low-resolution because they are a guide, not artwork. Do not try to recover or reproduce their detail.
- They are NOT a content source. Nothing visible in them may appear in the output: no person, no animal, no vehicle, no object, no graphic, no text.
- They are from a PREVIOUS identity. Never copy their colours, font family/weight, logo version/container, card fill, corner treatment, shadow, CTA style or illustration.
- The photograph in the output comes EXCLUSIVELY from Image 1. If a reference shows a different subject, ignore it entirely. A dog, a phone or a person seen in a reference must never reach the output.
- Never reproduce a promo code, coupon, partner mark, CTA or headline seen in a reference: those belong to other campaigns. Such an element appears only if the SOURCE card already had it.
- Where the references and the written measurements below disagree, the WRITTEN MEASUREMENTS win.`;
  }

  return `**REFERENCE STYLE LOCK (${label}) - STYLE ONLY:**
- Use the reference images ONLY for card size, card position, typography scale, typography weight, alignment, color treatment, corner radius, shadow, padding, and button style.
- Do NOT copy ANY text, headline, CTA, or campaign copy from the reference images.
- Do NOT copy ANY scene, subject, object, logo, or background from the reference images.
- The reference images are visual guides only. They are never content sources.`;
};

const getCardPlacementPrompt = (
  targetRatio,
  refCount,
  cardCopy,
  useSourceImageForCopy = false,
  profile = '',
  useSourceImageForMarks = false,
  hasTypographyReference = false,
) => {
  const ratio = String(targetRatio).trim();
  const isAspectRatioTool = usesAspectRatioProfile(profile);
  // Single and Batch expose only these two ratios. Landscape has a separate
  // two-panel template whose hard layout must not inherit this source-card lock.
  const usesSourceCardStyleReference = isAspectRatioTool && ['1:1', '9:16'].includes(ratio);
  // Every approved creative uses a purple pill, never a yellow one; the colour
  // is inherited from the references instead of being asserted here.
  // The previous-identity target examples provide numeric scale only, while
  // Image 2 supplies the exact current typeface and its visual metrics.
  const textSizeSpec = (referenceSize) => (usesSourceCardStyleReference
    ? `- Text size: ${referenceSize} This target-ratio measurement controls uniform scale; do NOT shrink the type merely to create more whitespace.
- Typeface, glyph shapes, weight, letter-spacing and line-height: copy Image 2 exactly. If the copy needs more room, first reflow it for the wide target box, then use the allowed adaptive card height. Only as a last resort may the complete typography scale down uniformly by at most 10%; never substitute, condense or stretch the font.`
    : `- Text size: ${referenceSize}`);
  // Hardcoding #F4F4F4 / #6F49E8 contradicts the reframe rules: a source whose
  // card is a purple panel with white copy would come back inverted. The colours
  // are sampled from the source card instead.
  const sourceCardColour = normalizeHexColour(cardCopy?.cardBackgroundColor);
  const sourceTextColour = normalizeHexColour(cardCopy?.cardTextColor);
  const cardColourSpec = usesSourceCardStyleReference
    ? (sourceCardColour && sourceTextColour
      ? `- Card background colour: EXACTLY ${sourceCardColour}. This is the colour of the source creative's own card; do not lighten, darken or substitute it.
- Text colour: EXACTLY ${sourceTextColour}. Copy the text weight from Image 2; do not default to 700 unless the source actually uses that weight.
- These two colours are taken from the source creative. Never replace them with a default, and never take a colour from anywhere else.`
      : `- Card background colour and text colour: reproduce the ones the SOURCE creative uses on its own card, preserving the same contrast relationship. If the source card is a purple panel with white copy, the output is a purple panel with white copy. Never substitute a default.`)
    : `- Card background color: #F4F4F4.
- Text color: #6F49E8. Text weight: 700 bold.`;
  // Image 2 resolves details such as a real border versus an invented keyline.
  const cardSurfaceSpec = usesSourceCardStyleReference
    ? '\n- Card surface treatment: copy Image 2 exactly, including its fill, gradient (if any), border or absence of border, corner treatment and shadow. Do not add a keyline that the source does not have or remove one that it does.'
    : '';
  const buttonSpec = (alignment) => (usesSourceCardStyleReference
    ? `- CTA/button/pill (when the structured CARD COPY LOCK says one exists, or when the extraction fallback visibly shows one in Image 2): ${alignment} in the target-ratio layout. Reproduce Image 2's component exactly: same proportions, shape, internal spacing, fill or gradient, colour values, border, radius, shadow, typography, label, icon, logo, illustration, photograph and image crop. Only uniform scaling and repositioning of the whole CTA are allowed. Do NOT invent, omit, recolour or replace any CTA element.`
    : `- Button: yellow pill, ${alignment}, below text. Match the reference style only.`);
  const hasRefs = refCount > 0;
  // The Aspect Ratio profile always supplies the source as a visual style
  // authority. Legacy callers retain the smaller conditional payload.
  const sourceAttached = usesSourceCardStyleReference || useSourceImageForCopy || useSourceImageForMarks;
  // The magnified copy crop only rides along when the source itself does, so it
  // always lands right after it and pushes the old campaign references down one.
  const typographyReferenceIndex = sourceAttached && hasTypographyReference ? 3 : 0;
  const referenceStartIndex = (sourceAttached ? 3 : 2) + (typographyReferenceIndex ? 1 : 0);
  const referenceLabel = `Images ${referenceStartIndex}+`;
  const referenceInputs = hasRefs ? buildReferenceInputList(referenceStartIndex, refCount) : '';

  const sourceInputLine = usesSourceCardStyleReference
    ? '2. Image 2 - the CURRENT source creative and identity reference. Copy only its typography, colours, card surface, logo artwork/container and complete CTA exactly. Never copy its photograph, card/panel geometry, margins, split layout, source line wrapping or logo placement; target geometry comes only from the written rules.'
    : (useSourceImageForCopy
      ? '2. Image 2 - the source creative. Read ONLY the original card copy from this image. Ignore its scene, subject, background, and layout.'
    : (useSourceImageForMarks
      ? '2. Image 2 - the source creative. Use it ONLY to copy the brand marks listed below, exactly as they are drawn there. Ignore its scene, subject, background, and layout.'
      : null));

  const logoOrientationLock = usesSourceCardStyleReference && ratio === '9:16'
    ? `**9:16 LOGO ORIENTATION LOCK:**
- Treat the Cabify wordmark in Image 1 as one rigid horizontal asset. Keep it perfectly upright at exactly 0-degree rotation: its baseline and top and bottom edges are parallel to the horizontal canvas edges, and both ends sit at the same Y coordinate.
- Keep the logo tab and its notch in the fixed LOCAL TOP-LEFT position, anchored to the left frame edge. Do not recenter or move them to the right.
- Do not tilt, skew, warp, curve, rotate, redraw or apply perspective to the wordmark. Never place it vertically or diagonally.`
    : '';

  const typographyInputLine = typographyReferenceIndex
    ? `${typographyReferenceIndex}. Image ${typographyReferenceIndex} - a magnified crop of the SOURCE card copy. Letterform reference only: it defines the typeface, never the layout, size or position.`
    : null;

  const inputs = [
    '1. Image 1 - the clean scene (target aspect ratio, no card). Use this as the immutable base.',
    sourceInputLine,
    typographyInputLine,
    referenceInputs || null,
  ]
    .filter(Boolean)
    .join('\n');

  const typographyLock = usesSourceCardStyleReference
    ? buildTypographyLockBlock(cardCopy, typographyReferenceIndex)
    : '';

  const cardCopySection = useSourceImageForCopy
    ? `**CARD COPY LOCK:**
- Read the exact card text and button label from Image 2 only.
- Preserve the original card content exactly - do NOT paraphrase, shorten, extend, translate, or correct it.
- Visual line wrapping in Image 2 is layout, not content. Reflow the exact words for the target box; do not retain a narrow source card's one-word-per-line breaks.
- The numeric target-ratio rules may affect only geometry and type scale. Current visual identity must come from Image 2.
- The reference images must NEVER change, replace, or inspire the card copy.`
    : buildCardCopyLockBlock(cardCopy, useSourceImageForMarks, usesSourceCardStyleReference);

  // The landscape marketing template does not overlay a card on a full-bleed
  // photo: it rebuilds the canvas as two panels on a pastel ground, with the
  // photograph living inside one of them. The overlay wording below would
  // forbid exactly the restructuring that template requires.
  const isLandscapeTemplate = isAspectRatioTool && ratio === '1.91:1';

  const shared = isLandscapeTemplate
    ? `**TASK:** Assemble a Cabify landscape marketing image from a photograph and its card copy.

**INPUTS (in order):**
${inputs}

${cardCopySection}

${usesSourceCardStyleReference ? SOURCE_CARD_APPEARANCE_LOCK : ''}

${typographyLock}

${logoOrientationLock}

${buildReferenceStyleSection(referenceLabel, hasRefs, profile, usesSourceCardStyleReference)}

**WHAT TO DO:**
- Rebuild the canvas as the two-panel layout specified below. Image 1 supplies ONLY the photograph.
- Place that photograph inside the photo panel. It must NOT bleed to the canvas edges.
- Build the purple copy panel, the pastel background and the logo tab around it.
- Preserve the original card content exactly. The references may restyle the layout, but they must not alter its words.

**STRICT:**
- Do NOT alter the photograph's subject, background, lighting or colours. Only its placement and crop may change.
- Do NOT invent or omit words in the card copy.
- Do NOT use any word from the reference images unless that exact word is already present in the original card copy.
- ${isAspectRatioTool ? ASPECT_RATIO_BRAND_LOCK : BRAND_LOCK}`
    : `**TASK:** Composite a Cabify UI card onto a clean scene.

**INPUTS (in order):**
${inputs}

${cardCopySection}

${usesSourceCardStyleReference ? SOURCE_CARD_APPEARANCE_LOCK : ''}

${typographyLock}

${logoOrientationLock}

${buildReferenceStyleSection(referenceLabel, hasRefs, profile, usesSourceCardStyleReference)}

**WHAT TO DO:**
- Add exactly one foreground UI card to Image 1.
- Keep Image 1's scene, subject, background, and logo exactly as-is.
${usesSourceCardStyleReference
    ? `- Rebuild the CURRENT source identity inside the exact target bounding box below. Image 2 supplies colours, card surface, typography, logo styling and CTA; the numeric target rules supply box/logo size, position, margins, padding and type scale.
- Do NOT copy Image 2's card/panel aspect ratio or layout. If it is narrow, tall or lateral, rebuild it as the required wide target card.
- Preserve the original card content exactly. The numeric target guide may reflow it but may never alter its words.`
    : `- Match the reference card's visual treatment only: size, position, typography scale, color, corner radius, padding, shadow, and button styling.
- Preserve the original card content exactly. The references may restyle the card, but they must not alter its words.`}

**STRICT:**
- Do NOT modify the scene, subject, background, or logo from Image 1.${isAspectRatioTool ? '\n- The photograph in the output IS Image 1. Never replace it, or any part of it, with a photograph taken from a reference image.' : ''}
- Do NOT invent or omit words in the card copy.
- Do NOT use any word from the reference images unless that exact word is already present in the original card copy.
- ${isAspectRatioTool ? ASPECT_RATIO_BRAND_LOCK : BRAND_LOCK}`;

  if (ratio === '1:1') {
    return `${shared}

**CARD DIMENSIONS - 1:1 (non-negotiable):**
${isAspectRatioTool
    ? '- TARGET BOUNDING BOX: x=7.5%, y=71%, width=85%, height=22% of canvas. Its bottom edge is fixed at y=93%. This geometry is measured from the replacement 1:1 references and applies to every variation, regardless of Image 2.'
    : '- Card width: 93% of canvas width (1003px at 1080 reference). NEVER less than 91%. The card spans almost edge to edge - only about 3.5% gap on each side (about 41px at 1080).'}
${isAspectRatioTool
    ? `- Card width is ALWAYS 85%; left and right gaps are ALWAYS 7.5% each and must NEVER be larger. Never use the narrow source-card width.
- The 1:1 card is ALWAYS HORIZONTAL / LANDSCAPE. Its width-to-height ratio must never be below 2.3:1. Never make it square, portrait, narrow, tall or vertically oriented, even when the source card is.
- Default card height is 22% (225px at 1024). If exact copy plus CTA cannot fit after target reflow, grow the card UPWARD only to a maximum of 32%; its bottom edge remains fixed at 93%. Never solve overflow by changing its width, side gaps, bottom gap or the required landscape orientation.`
    : `- Card height: about 32% of canvas height (343px at 1080 reference).
- Card top edge: about 64.6% from the top of the canvas (y about 698px at 1080).`}
- Bottom gap below card: about 7% of canvas height (about 72px at 1024). Small, visible gap only.
- ${isAspectRatioTool ? 'Card corner radius and edge treatment: copy the CURRENT source card and scale it responsively inside this box. Do not inherit corner styling from the old target examples.' : 'Corner radius: about 3.9% of canvas width (42px at 1080).' }
${cardColourSpec}
- ${isAspectRatioTool ? 'Text alignment and line-height: preserve the CURRENT source treatment; text size and the outer box geometry follow this target guide.' : 'Text alignment: left-aligned. Line-height about 1.1.'}
${textSizeSpec(
    'about 5.5-6% of canvas height per line (60-66px at 1080).',
  )}
- Padding inside card: about 4.5% top/left/right, about 3.5% bottom.
${buttonSpec('left-aligned')}${cardSurfaceSpec}`;
  }

  if (ratio === '1.91:1') {
    if (!isLandscapeTemplate) {
      return `${shared}

**CARD DIMENSIONS - 1.91:1 (non-negotiable):**
- Canvas: wide Google marketing image, equivalent to 1200x628.
- Card width: about 48-54% of canvas width. It must feel like a compact marketing card, not a full-width banner.
- Card height: about 34-40% of canvas height.
- Card position: lower-left or lower-center, with at least 4% canvas margin from left and bottom edges.
- Keep the main subject, vehicle, and logo fully visible. Do not cover faces, car details, or the logo.
- Corner radius: about 3.5% of canvas height.
- Card background color: #F4F4F4.
- Text color: #6F49E8. Text weight: 700 bold.
- Text alignment: left-aligned. Line-height about 1.1.
- Text size: about 8-10% of canvas height per line.
- Padding inside card: about 4% of canvas width left/right, about 5% of card height top/bottom.
${buttonSpec('left-aligned')}`;
    }

    // Proportions below are read off the approved 1200x628 creatives by eye.
    // Replace them with measured values once real references are dropped into
    // assets/card-references/1-91-1/.
    return `${shared}

**CANVAS COMPOSITION - 1.91:1 (non-negotiable):**
- Canvas: wide marketing image, equivalent to 1200x628.
- The canvas is NOT a full-bleed photograph. It is two rounded panels side by side on a flat pastel background.
- Outer background: ONE flat pastel colour (pale blue, lavender, mint or cream). It stays visible as a margin around both panels and in the gap between them. Never white.
- Panel A - copy panel: solid Cabify purple, about 40-45% of canvas width, nearly full canvas height inside the margin.
- Panel B - photo panel: the photograph from Image 1, about 45-50% of canvas width, the same height and the same corner radius as Panel A.
- Default order: copy panel on the LEFT, photo panel on the RIGHT. The mirrored arrangement is equally valid; proportions stay the same either way.
- Corner radius on both panels: about 6-7% of canvas height. Generous and clearly rounded.

**LOGO LOCKUP (non-negotiable):**
- The logo is NEVER placed directly on the photograph and NEVER on the purple panel.
- It sits inside a WHITE rounded tab anchored to the TOP-LEFT corner of the photo panel, overlapping that panel's edge.
- The tab is white; the "cabify" wordmark inside it is Cabify PURPLE - never white, never reversed, never recoloured.
- The tab's corner radius matches the panels'. Its width is roughly 20-25% of the photo panel's width.

**COPY PANEL TYPOGRAPHY (non-negotiable):**
- Text colour: WHITE on the purple panel. Never purple text on a light card in this ratio.
- Text weight: 700 bold. Alignment: left. Line-height about 1.1.
- Text is vertically centred within the panel, with generous padding of about 8-10% of the panel width on each side.

**SECONDARY CONTAINERS (only when the source card has one):**
- Promo code: a soft translucent white pill inside the purple panel, below the copy, with a small coupon icon to the left of the code. Code in white, uppercase, letter-spaced.
- Partner logo: a solid white rounded container with a thin border, holding the partner's mark. It sits INSIDE the purple panel below the copy - never on the photograph.

**STRICT - LANDSCAPE LAYOUT:**
- Do NOT bleed the photograph to the canvas edges.
- Do NOT place a white card on top of the photograph; that is the square/vertical layout, not this one.
- Do NOT show the logo without its white tab.
- Do NOT use white as the outer background; it is always a pastel.`;
  }

  return `${shared}

${isAspectRatioTool ? `${NINE_SIXTEEN_CARD_SAFE_ZONE}\n\n` : ''}**CARD DIMENSIONS - 9:16 (non-negotiable):**
${isAspectRatioTool
    ? '- TARGET BOUNDING BOX: x=3.5%, y=62%, width=93%, height=18% of canvas. Its bottom edge is fixed at y=80%, leaving a visible 4% buffer before the safe region ends at y=84%. This is the geometry for every variation, regardless of Image 2.'
    : '- Card width: 93% of canvas width (1002px at 1080 reference). NEVER less than 91%. The card spans almost edge to edge - only about 3.5% gap on each side (about 39px at 1080).'}
${isAspectRatioTool
    ? `- Card width is ALWAYS 93%; left and right gaps are ALWAYS 3.5% each and must NEVER be larger. Never use the narrow source-card width.
- Default card height is 18% (346px at 1920). If exact copy plus CTA cannot fit after target reflow, grow the card UPWARD only to a maximum of 28%; its bottom edge remains fixed at 80%. Never solve overflow by changing its width, side gaps or bottom gap.
- The fixed y=80% bottom edge applies to the panel AND its shadow. Text, CTA and partner marks must stay inside the panel; never let any component hang below it or cross into the bottom exclusion band.`
    : `- Card height: about 18% of canvas height (343px at 1920 reference). Flat and wide - NOT tall or square.
- Card top edge: about 65.5% from the top of the canvas (y about 1258px at 1920).`}
- Bottom gap below card: ${isAspectRatioTool ? '20% of canvas height, including a mandatory 4% clear buffer inside the safe region before the bottom exclusion band begins' : 'about 16.6% of canvas height (about 319px at 1920). Visible empty scene below card'}.
- ${isAspectRatioTool ? 'Card corner radius and edge treatment: copy the CURRENT source card and scale it responsively inside this box. Do not inherit corner styling from the old target examples.' : 'Corner radius: about 3.9% of canvas width (42px at 1080).' }
${cardColourSpec}
- ${isAspectRatioTool ? 'Text alignment and line-height: preserve the CURRENT source treatment; text size and the outer box geometry follow this target guide.' : 'Text alignment: centered. Line-height about 1.1.'}
${textSizeSpec(
    'about 3.9-4.2% of canvas height per line (74-80px at 1920).',
  )}
- Padding inside card: about 3.1% top, about 3.7% left/right, about 2.6% bottom.
${buttonSpec('centered')}${cardSurfaceSpec}`;
};

/**
 * One prompt per model call in pass 1.
 *
 * The ciclo still asks for three differently framed scenes. The Aspect Ratio
 * tool asks for ONE: its variations now differ by template, not by framing.
 * Three reframes of the same source produced outputs an operator could not
 * tell apart, because the deterministic frame, logo and card dominate the
 * composition; swapping the approved reference behind them does not.
 */
export const getVariationPrompts = (targetRatio, profile = '') => {
  const ratio = String(targetRatio).trim();
  const isAspectRatioTool = usesAspectRatioProfile(profile);
  const guards = buildSceneGuards(profile);

  if (ratio === '1:1') {
    const base = `
**TASK:** Reframe the source image to a 1:1 square canvas - scene only, no UI card.

${guards}
${isAspectRatioTool ? `\n${TEMPLATE_COMPOSITOR_LOCK}\n` : ''}
## LAYOUT
- Canvas: 1:1 square.
${getTargetFrameGeometry(ratio, profile)}
${buildLogoLayoutLine(
    profile,
    '- Logo: top-left. Width about 14-16% of canvas width. Top margin about 6-8%.',
    '19%',
    'Place the visible logo lockup inside the local top-left frame notch at approximately x=8.5% and y=8% of the canvas. It must fit completely inside that local notch and never create a full-width header. This position and size are fixed across all three variations.',
  )}
- Subject: prominent, full face visible.
- Bottom portion: clean scene/background only (a UI card will be added later by the system).

## GEOMETRY
- CROP or EXTEND the background only as needed to reach 1:1.
- Do NOT crop the subject face.
`.trim();

    return isAspectRatioTool
      ? [base]
      : [
        `${base}\n\n## THIS VARIATION\nTight crop - preserve as much of the original composition as possible.`,
        `${base}\n\n## THIS VARIATION\nSlightly more headroom above the subject.`,
        `${base}\n\n## THIS VARIATION\nWider crop to reveal more of the scene around the subject.`,
      ];
  }

  if (ratio === '1.91:1') {
    // Step 2 rebuilds this scene into the two-panel layout and supplies the
    // logo inside its white tab. So this step must NOT bake a logo in (that
    // would ship two), and must keep the subject centred enough to survive the
    // crop into a roughly square photo panel.
    const layout = isAspectRatioTool
      ? `## LAYOUT
- Canvas: 1.91:1 landscape, equivalent to a 1200x628 marketing image.
- Do NOT draw, keep or recreate any logo. The system adds the brand logo later, in its own container.
- Subject: prominent and natural, with the full face visible.
- Keep the subject and the essential context within the central 55% of the width. This frame is later cropped into a roughly square panel, so anything near the left and right edges will be lost.
- Leave no space reserved for a card: the copy lives on a separate panel that the system builds later.

## GEOMETRY
- EXTEND the scene sideways as needed to reach the wide canvas.
- Do NOT stretch the subject or any element.
- Do NOT crop the subject's face.`
      : `## LAYOUT
- Canvas: 1.91:1 landscape, equivalent to a 1200x628 Google marketing image.
- Logo: top-left. Width about 10-12% of canvas width. Top margin about 6-8%.
- Subject: prominent and natural, with the full face visible.
- Vehicle/context: keep useful scene detail visible across the wide frame.
- Bottom-left/lower-center portion: clean scene/background only (a UI card will be added later by the system).

## GEOMETRY
- EXTEND the scene sideways as needed to reach the wide canvas.
- Do NOT stretch the subject, car, logo, or any brand element.
- Do NOT crop the subject face or logo.`;

    const base = `
**TASK:** Reframe the source image to a 1.91:1 landscape canvas - scene only, no UI card.

${guards}

${layout}
`.trim();

    return isAspectRatioTool
      ? [base]
      : [
        `${base}\n\n## THIS VARIATION\nBalanced landscape crop - preserve the original subject size and extend the sides naturally.`,
        `${base}\n\n## THIS VARIATION\nMore horizontal scene context - reveal extra environment on both sides while keeping the subject prominent.`,
        `${base}\n\n## THIS VARIATION\nMarketing image composition - keep a clean lower area for the card while preserving the subject and vehicle context.`,
      ];
  }

  // Extending the canvas vertically shrinks the subject relative to it, so the
  // legacy "keep the subject large / do not zoom out" pairing is self-
  // contradictory. The Aspect Ratio profile states it once, with a measurable
  // target, instead of leaving the model to pick which half to disobey.
  const geometry = isAspectRatioTool
    ? `## GEOMETRY
- Reach 9:16 by EXTENDING (outpainting) the PHOTOGRAPH itself above and/or below the subject. Return a continuous edge-to-edge background; never grow a source margin, flat ground or split-panel proportion.
- The photograph continues behind the future template overlays. Do NOT reserve empty ground above or below it and do not draw a frame, logo or card placeholder.
- Do NOT rescale or re-shoot the subject to make it fit. The subject keeps its original scale and detail; the photograph grows around it, and the subject should still occupy roughly 45-60% of the canvas height.
- Do NOT crop the subject's face.`
    : `## GEOMETRY
- EXTEND (outpaint) background above and/or below as needed.
- Keep the subject large - do not zoom out.
- Do NOT crop the subject face or logo.`;

  const base = `
**TASK:** Reframe the source image to a 9:16 vertical canvas - scene only, no UI card.

${guards}
${isAspectRatioTool ? `\n${TEMPLATE_COMPOSITOR_LOCK}\n` : ''}
## LAYOUT
- Canvas: 9:16 vertical.
${getTargetFrameGeometry(ratio, profile)}
${buildLogoLayoutLine(
    profile,
    '- Logo: top-left. Width about 12-14% of canvas width. Top margin about 5-7%.',
    '24%',
    'Place the visible logo lockup inside the LOCAL TOP-LEFT frame notch, anchored to the left frame edge at x=4.7%, with its top edge at y=5.5% of the canvas. It must fit completely inside the local notch and never create a full-width header. This left tab/notch position and size are fixed across all three variations. The wordmark must be perfectly straight and horizontal: baseline parallel to the top edge, 0-degree rotation, upright, with no tilt, skew, curve or perspective distortion.',
  )}
${isAspectRatioTool ? NINE_SIXTEEN_SUBJECT_COMPOSITION : '- Subject: large and prominent, fills most of the canvas height.'}
- Bottom portion: clean scene/background only (a UI card will be added later by the system).

${geometry}
`.trim();

  return isAspectRatioTool
    ? [base]
    : [
      `${base}\n\n## THIS VARIATION\nMinimal intervention - preserve source background. Only extend background where strictly necessary to fill the canvas.`,
      `${base}\n\n## THIS VARIATION\nMore headroom above the subject - extend sky/background at the top.`,
      `${base}\n\n## THIS VARIATION\nKeep the car and its context in frame alongside the subject - the car must remain clearly visible. Extend background on the top or sides if needed but never at the cost of removing or hiding the car.`,
    ];
};

/**
 * References are shipped assets that never change while the process lives, but
 * a single row asks for them several times, so the encoded parts are memoized.
 *
 * The Aspect Ratio profile downsamples them first. At full 1080px the six
 * references carry more visual weight than the prompt does and the model starts
 * lifting their content wholesale - a promo code, a keyline, once an entire dog.
 * Shrunk to a long edge of REFERENCE_GUIDE_MAX_EDGE they still show exactly what
 * they are meant to teach - where each element sits, how big it is, what colour
 * it is - while their fine detail and their text stop being legible enough to
 * copy. It also cuts the payload by roughly 95%.
 */
const cardReferenceCache = new Map();
const REFERENCE_GUIDE_MAX_EDGE = 512;

const toLayoutGuide = async (buffer) => {
  const output = await sharp(buffer)
    .resize({
      width: REFERENCE_GUIDE_MAX_EDGE,
      height: REFERENCE_GUIDE_MAX_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 80 })
    .toBuffer();
  return { data: output.toString('base64'), mimeType: 'image/jpeg' };
};

export const loadCardReferences = (targetRatio, profile = '') => {
  const ratio = String(targetRatio).trim();
  const asLayoutGuide = usesAspectRatioProfile(profile);
  const cacheKey = `${ratio}::${asLayoutGuide ? 'guide' : 'full'}`;
  const cached = cardReferenceCache.get(cacheKey);
  if (cached) return cached;

  const loading = (async () => {
    const folderName = CARD_REFERENCE_FOLDERS[ratio];
    if (!folderName) return [];

    const candidates = [folderName, ...(CARD_REFERENCE_FALLBACKS[ratio] || [])];
    const folder = candidates
      .map((name) => path.join(__dirname, `../assets/card-references/${name}`))
      .find((candidate) => existsSync(candidate));
    if (!folder) return [];

    const fileNames = readdirSync(folder)
      .filter((fileName) => /\.(png|jpg|jpeg|webp)$/i.test(fileName))
      .sort((left, right) => left.localeCompare(right));

    return Promise.all(fileNames.map(async (fileName) => {
      const buffer = readFileSync(path.join(folder, fileName));
      if (asLayoutGuide) return toLayoutGuide(buffer);
      const ext = path.extname(fileName).toLowerCase().replace('.', '');
      const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
      return { data: buffer.toString('base64'), mimeType };
    }));
  })();

  cardReferenceCache.set(cacheKey, loading);
  return loading;
};

export const extractFirstImageFromResponse = (response) => {
  for (const candidate of response.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (part.inlineData?.data) {
        const mimeType = part.inlineData.mimeType || 'image/png';
        return `data:${mimeType};base64,${part.inlineData.data}`;
      }
    }
  }
  return null;
};

export const getGeminiClient = () => {
  const apiKey = process.env.GEMINI_API_KEY?.trim() ?? '';
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY environment variable.');
  return new GoogleGenAI({ apiKey });
};

export const extractCardCopyFromSource = async (ai, sourceImageData, sourceMimeType) => {
  const fontReference = await buildAspectRatioFontReference();
  const response = await ai.models.generateContent({
    model: 'gemini-3-pro-image-preview',
    contents: {
      parts: [
        { inlineData: { data: sourceImageData, mimeType: sourceMimeType } },
        { inlineData: fontReference },
        { text: CARD_COPY_EXTRACTION_PROMPT },
      ],
    },
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: CARD_COPY_EXTRACTION_SCHEMA,
      responseModalities: ['TEXT'],
    },
  });

  return normalizeExtractedCardCopy(parseJsonResponseText(response.text));
};

/**
 * A caller generating more than one ratio from the same source image should
 * call this ONCE and pass the result to every generateAspectRatioImages call
 * via `cardCopy`/`cardCopyError`, instead of letting each ratio re-run its
 * own extraction pass against an identical source image.
 */
export const resolveCardCopyForSource = async (ai, imageDataUrl) => {
  const match = imageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('Invalid imageDataUrl format.');
  const [, mimeType, imageData] = match;

  try {
    const cardCopy = await extractCardCopyFromSource(ai, imageData, mimeType);
    if (!hasReliableCardCopy(cardCopy)) {
      return { cardCopy, error: 'Card copy extraction was incomplete.' };
    }
    return { cardCopy, error: null };
  } catch (error) {
    return { cardCopy: null, error: `Card copy extraction failed: ${error.message}` };
  }
};

export const placeCardOnScene = async (
  ai,
  sceneDataUrl,
  sourceImageData,
  sourceMimeType,
  targetRatio,
  cardCopy,
  profile = '',
  templateId,
) => {
  const sceneMatch = sceneDataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!sceneMatch) throw new Error('Invalid scene data URL');
  const [, sceneMimeType, sceneData] = sceneMatch;

  if (usesAspectRatioProfile(profile)) {
    const text = normalizeCardCopyField(cardCopy?.cardText);
    if (!text) {
      throw new Error('The immutable Aspect Ratio template requires non-empty card text.');
    }

    const resolvedFontId = resolveAspectRatioFontId({
      fontId: cardCopy?.cardFontId,
      fontFamily: cardCopy?.cardFontFamily,
      fontWeight: cardCopy?.cardFontWeight,
    });

    // `templateId` is what distinguishes one variation from the next: the same
    // scene, the same copy and the same OTF, composed through a different
    // approved reference. Omitting it keeps the ratio's canonical template.
    return composeAspectRatioTemplate({
      sceneDataUrl,
      targetRatio,
      text,
      fontId: resolvedFontId,
      templateId,
    });
  }

  const refs = await loadCardReferences(targetRatio, profile);
  const canLockCopy = hasReliableCardCopy(cardCopy);
  // A partner mark cannot be drawn from its name alone, so when the source card
  // carries one the source image rides along for the model to copy it from.
  const needsSourceForMarks = canLockCopy && Boolean(cardCopy?.cardBrandMarks);
  // Exact typography and CTA artwork cannot be serialized into the copy JSON.
  // The supported Aspect Ratio outputs therefore send the source as Image 2;
  // the prompt limits it to card appearance so Image 1 stays scene authority.
  const usesSourceCardStyleReference = usesAspectRatioProfile(profile) &&
    ['1:1', '9:16'].includes(String(targetRatio).trim());
  const includeSourceImage = usesSourceCardStyleReference || !canLockCopy || needsSourceForMarks;
  // The full source arrives downscaled on Gemini's side, which is where the
  // source typeface stops being legible and a generic sans creeps in. When the
  // extraction located the copy block, its magnified crop rides along so the
  // letterforms the output must match are actually readable in the request.
  const typographyReference = includeSourceImage
    ? await buildSourceTypographyReference(sourceImageData, cardCopy?.cardTextBox)
    : null;
  const parts = [
    { inlineData: { data: sceneData, mimeType: sceneMimeType } },
    ...(includeSourceImage
      ? [{ inlineData: { data: sourceImageData, mimeType: sourceMimeType } }]
      : []),
    ...(typographyReference
      ? [{ inlineData: { data: typographyReference.data, mimeType: typographyReference.mimeType } }]
      : []),
    ...refs.map((ref) => ({ inlineData: { data: ref.data, mimeType: ref.mimeType } })),
    {
      text: getCardPlacementPrompt(
        targetRatio,
        refs.length,
        cardCopy,
        !canLockCopy,
        profile,
        needsSourceForMarks,
        Boolean(typographyReference),
      ),
    },
  ];

  const response = await ai.models.generateContent({
    model: 'gemini-3-pro-image-preview',
    contents: { parts },
    config: { imageConfig: { aspectRatio: resolveGeminiAspectRatio(targetRatio), imageSize: '1K' } },
  });

  const finalUrl = extractFirstImageFromResponse(response);
  if (!finalUrl) return null;
  return needsAspectRatioCrop(targetRatio) ? await cropDataUrlToAspectRatio(finalUrl, targetRatio) : finalUrl;
};

const getGenerationRetryDelayMs = (error, attempt) => {
  const message = String(error?.message || error || '');
  const retrySeconds = Number(message.match(/retry(?:\s+in|Delay["']?\s*[:=])\s*["']?([\d.]+)\s*s/i)?.[1]);
  if (Number.isFinite(retrySeconds) && retrySeconds > 0) {
    return Math.min(60_000, Math.ceil(retrySeconds * 1000));
  }
  return Math.min(10_000, 1000 * (2 ** Math.max(0, attempt - 1)));
};

const isRetryableGenerationError = (error) => {
  const message = String(error?.message || error || '');
  const code = String(error?.code || error?.cause?.code || '').toUpperCase();
  const status = Number(error?.status || error?.code || error?.response?.status);
  return status === 429
    || status === 503
    || /^(ECONNRESET|ETIMEDOUT)$/.test(code)
    || /RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED|rate.?limit|quota|time(?:d?\s*out|out)|ECONNRESET|ETIMEDOUT/i.test(message);
};

/**
 * `profile` selects the prompt wording. Callers from the Aspect Ratio tool pass
 * ASPECT_RATIO_PROMPT_PROFILE; the ciclo omits it and keeps the legacy prompts.
 *
 * It also selects how the variations are produced. The Aspect Ratio profile
 * generates ONE photograph and composes it through every template declared for
 * the ratio in ASPECT_RATIO_TEMPLATE_VARIANTS, so the reference template is the
 * only difference between a source row's outputs — and one model call covers
 * the whole ratio instead of three. The ciclo still generates one scene per
 * variation prompt.
 *
 * A caller generating several ratios from the same source image should
 * resolve card copy once via resolveCardCopyForSource and pass it (plus a
 * shared `ai` client) through `cardCopy`/`cardCopyError`/`ai`, instead of
 * paying for a fresh extraction pass on every ratio.
 */
export const generateAspectRatioImages = async (
  imageDataUrl,
  targetRatio,
  {
    profile = '',
    maxAttemptsPerVariation = 1,
    ai: providedAi,
    cardCopy: providedCardCopy,
    cardCopyError,
    variationConcurrency = 3,
  } = {},
) => {
  const match = imageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('Invalid imageDataUrl format.');
  const [, mimeType, imageData] = match;

  const ai = providedAi || getGeminiClient();
  const variationPrompts = getVariationPrompts(targetRatio, profile);
  const errors = [];

  let cardCopy;
  if (providedCardCopy !== undefined) {
    cardCopy = providedCardCopy;
    if (cardCopyError) errors.push(cardCopyError);
  } else {
    const resolved = await resolveCardCopyForSource(ai, imageDataUrl);
    cardCopy = resolved.cardCopy;
    if (resolved.error) errors.push(resolved.error);
  }

  const attemptsPerVariation = Math.min(3, Math.max(1, Number(maxAttemptsPerVariation) || 1));

  // Each pass now carries its own attempt budget. Before, a card-pass failure
  // burned an attempt the scene had already spent; the scene is generated once
  // for the whole ratio here, so the two can no longer share a counter.
  const runWithRetries = async (label, run) => {
    for (let attempt = 1; attempt <= attemptsPerVariation; attempt += 1) {
      try {
        const result = await run();
        if (!result) throw new Error(`${label} returned no image.`);
        return result;
      } catch (error) {
        const errorMessage = String(error?.message || error || 'Unknown generation error.');
        errors.push(`${label} attempt ${attempt}/${attemptsPerVariation}: ${errorMessage}`);
        const canRetry = attempt < attemptsPerVariation
          && (isRetryableGenerationError(error) || /returned no (scene|image)/i.test(errorMessage));
        if (!canRetry) return null;
        await new Promise((resolve) => setTimeout(resolve, getGenerationRetryDelayMs(error, attempt)));
      }
    }
    return null;
  };

  const generateScene = (prompt) => runWithRetries('Scene', async () => {
    const sceneResponse = await ai.models.generateContent({
      model: 'gemini-3-pro-image-preview',
      contents: { parts: [{ inlineData: { data: imageData, mimeType } }, { text: prompt }] },
      config: { imageConfig: { aspectRatio: resolveGeminiAspectRatio(targetRatio), imageSize: '1K' } },
    });

    const candidateSceneUrl = extractFirstImageFromResponse(sceneResponse);
    if (!candidateSceneUrl) throw new Error('Pass 1 returned no scene.');
    return needsAspectRatioCrop(targetRatio)
      ? cropDataUrlToAspectRatio(candidateSceneUrl, targetRatio)
      : candidateSceneUrl;
  });

  // A background without its deterministic template is not a usable Aspect
  // Ratio variant. Legacy profiles can still reach the old model-backed card
  // pass, so both paths share this completion guard.
  const composeVariation = (sceneUrl, templateId) => runWithRetries('Variation', () => placeCardOnScene(
    ai,
    sceneUrl,
    imageData,
    mimeType,
    targetRatio,
    cardCopy,
    profile,
    templateId,
  ));

  const templateVariants = usesAspectRatioProfile(profile)
    ? ASPECT_RATIO_TEMPLATE_VARIANTS[String(targetRatio).trim()]
    : null;

  // Aspect Ratio varies the template, not the framing: one photograph, one
  // model call, then one local composition per approved reference. The ciclo
  // keeps a scene per prompt.
  if (templateVariants) {
    const sceneUrl = await generateScene(variationPrompts[0]);
    if (!sceneUrl) return { images: [], errors };

    const templateIds = templateVariants.map((variant) => variant.id);
    const results = await mapWithBoundedConcurrency(
      templateIds,
      Math.min(templateIds.length, Math.max(1, Number(variationConcurrency) || 1)),
      (templateId) => composeVariation(sceneUrl, templateId),
    );
    return { images: results.filter(Boolean), errors };
  }

  const concurrency = Math.min(variationPrompts.length, Math.max(1, Number(variationConcurrency) || 1));
  const results = await mapWithBoundedConcurrency(variationPrompts, concurrency, async (prompt) => {
    const sceneUrl = await generateScene(prompt);
    return sceneUrl ? composeVariation(sceneUrl, undefined) : null;
  });

  return { images: results.filter(Boolean), errors };
};
