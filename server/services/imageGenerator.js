import { GoogleGenAI } from '@google/genai';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

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
  },
  required: ['cardText', 'buttonPresent', 'buttonLabel', 'cardBackgroundColor', 'cardTextColor', 'cardBrandMarks'],
};

const CARD_COPY_EXTRACTION_PROMPT = `
Read the promotional card in this source creative and extract its literal copy.

Return JSON with exactly these fields:
- "cardText": every non-button word that appears inside the promotional card, in reading order. Preserve punctuation, accents, capitalization, and separators exactly. Use "\\n" only when the source card clearly separates text into multiple visible lines or blocks.
- "buttonPresent": true if the card includes a CTA/button, otherwise false.
- "buttonLabel": the CTA/button text exactly as shown. Return an empty string if there is no button.
- "cardBackgroundColor": the hex colour of the card/panel the copy sits on, sampled from a flat area away from any shadow or gradient.
- "cardTextColor": the hex colour of that copy.
- "cardBrandMarks": any partner, product or sub-brand logo shown inside the card - name it and describe its container briefly. Do NOT list the main Cabify wordmark. Empty string if there is none.

Rules:
- Extract text only from the card. Ignore the rest of the scene, logo, people, cars, and background.
- Do NOT translate, rewrite, summarize, normalize, fix spelling, or infer missing words.
- Do NOT borrow copy from any other image.
- If a word is partially obscured, return the visible characters only.
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
## SCENE-ONLY GENERATION - CRITICAL
- Remove ONLY the promotional copy card from the source: the panel carrying the headline and its CTA. Replace it with a natural continuation of the scene behind it.
- Removing that card does NOT mean removing the brand layer. EVERY logo in the source - the Cabify wordmark and any partner, product or sub-brand mark - together with its container, the background colour, the margin and any frame around the photograph, all STAY.
- Do NOT add a new UI card, text overlay, CTA button, promo code or badge. Step 2 rebuilds the copy card later.
- Keep: the subject, the scene background, every logo exactly as the source styles it, and the source's ground, margins and frames.
- ${BRAND_LOCK}
- Do NOT modify the main subject. Do NOT add filters, blur, gradients, or color shifts.
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
 * This tool REFRAMES an approved creative; it does not redesign it. The source
 * already carries the brand's visual system - its logo treatment, its pastel
 * ground and margin, its panel shapes - and all of it has to survive the change
 * of canvas. Only the framing may change.
 */
const DESIGN_SYSTEM_LOCK = `
## SOURCE DESIGN SYSTEM - PRESERVE IT EXACTLY
- This is a REFRAME of an already-approved creative, NOT a redesign. Every brand element the source uses must survive in the output, styled exactly as the source styles it.
- Logos: keep EVERY logo the source shows - the Cabify wordmark and any partner, product or sub-brand mark - as it appears: same colour, same container (tab, panel, badge or none at all), same proportions. Do NOT recolour one, do NOT remove its container, do NOT add a container it does not have, and do NOT drop a mark because it is small or secondary.
- Ground and margins: if the source sits on a coloured or pastel background, or shows a visible margin, border or rounded frame around the photograph, KEEP that ground and that margin, in the same colour.
- That margin keeps its original THICKNESS. When the canvas grows, the PHOTOGRAPH grows to fill it; the margin does not widen into an empty band. A large area of bare ground above or below the photo is a failure.
- Panels and cards: keep the source's panel shapes, fills, corner radius and colour treatment.
- Only the FRAMING changes: the canvas ratio, and how much of the scene is visible. The design system does not change.
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
  ? `- Logo: keep the source's logo exactly as it is STYLED - same colour, same container, same proportions - at a comparable relative size (about ${widthRange} of canvas width). ${placement || 'Keep it in the upper area of the canvas, moving it only as much as the new ratio demands.'}`
  : legacyLine);

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

const normalizeExtractedCardCopy = (payload) => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const cardText = normalizeCardCopyField(payload.cardText);
  const buttonLabel = normalizeCardCopyField(payload.buttonLabel);
  const buttonPresent = payload.buttonPresent === true;

  return {
    cardText,
    buttonPresent,
    buttonLabel,
    cardBackgroundColor: normalizeHexColour(payload.cardBackgroundColor),
    cardTextColor: normalizeHexColour(payload.cardTextColor),
    cardBrandMarks: normalizeCardCopyField(payload.cardBrandMarks),
  };
};

const hasReliableCardCopy = (cardCopy) =>
  Boolean(
    cardCopy &&
      cardCopy.cardText &&
      (!cardCopy.buttonPresent || (cardCopy.buttonPresent && cardCopy.buttonLabel)),
  );

const buildCardCopyLockBlock = (cardCopy, marksFromSourceImage = false) => {
  const copyJson = JSON.stringify(
    {
      cardText: cardCopy.cardText,
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

  return `**CARD COPY LOCK (authoritative):**
\`\`\`json
${copyJson}
\`\`\`
- The ONLY allowed text source is the JSON above.
- Preserve the exact words, punctuation, accents, and capitalization from the JSON.
- You may reflow line breaks only if needed to fit the reference layout.
- If "buttonPresent" is false, do not render a button.
- If "buttonPresent" is true, render the button and copy "buttonLabel" exactly.
- The reference images may influence size, font sizing, color treatment, spacing, and position only. They must NEVER change the copy.${brandMarkRules}`;
};

const buildReferenceInputList = (startIndex, count) =>
  Array.from({ length: count }, (_, index) => {
    const imageNumber = startIndex + index;
    return `${imageNumber}. Image ${imageNumber} - layout/style reference only.`;
  }).join('\n');

const buildReferenceStyleSection = (label, hasRefs, profile) => {
  if (!hasRefs) {
    return `**REFERENCE STYLE LOCK:**
- No reference images were attached, so follow the numeric geometry below exactly.`;
  }

  // Describing the references' contents - a route map, a car on a progress bar,
  // a bordered tile - reads as a list of things to draw, and the model started
  // lifting whole elements: a promo code, a keyline, eventually the reference's
  // own subject. So the allowance is expressed as abstract style attributes
  // (proportions, colours, weights) and every visible element stays banned.
  if (usesAspectRatioProfile(profile)) {
    return `**REFERENCE IMAGES (${label}) - LAYOUT GUIDE ONLY:**
- Read the references as a LAYOUT DIAGRAM. They answer three questions and nothing else: WHERE each element sits on the canvas, HOW LARGE it is relative to the canvas, and WHAT COLOUR the brand surfaces are.
- They are deliberately low-resolution because they are a guide, not artwork. Do not try to recover or reproduce their detail.
- They are NOT a content source. Nothing visible in them may appear in the output: no person, no animal, no vehicle, no object, no graphic, no text.
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
) => {
  const ratio = String(targetRatio).trim();
  const isAspectRatioTool = usesAspectRatioProfile(profile);
  // The source creative rides along for either reason: to read copy that could
  // not be extracted, or to copy a partner mark that cannot be drawn from a
  // written description.
  const sourceAttached = useSourceImageForCopy || useSourceImageForMarks;
  // Every approved creative uses a purple pill, never a yellow one; the colour
  // is inherited from the references instead of being asserted here.
  // A single fixed size cannot serve both a two-line headline and a four-line
  // one: it either swims or overflows. The tuned spec anchors a starting size
  // and makes the type scale with the amount of copy.
  const textSizeSpec = (legacy, twoLine, minimum) => (isAspectRatioTool
    ? `- Text size: FIT THE COPY TO THE CARD instead of using one fixed size. Start around ${twoLine} of canvas height per line for a two-line headline, and step down as the copy grows, to no smaller than about ${minimum}.
- The text block must fill the card's inner area comfortably: it must never overflow the padding, and it must never leave more than about a third of the card empty.`
    : `- Text size: ${legacy}`);
  // Hardcoding #F4F4F4 / #6F49E8 contradicts the reframe rules: a source whose
  // card is a purple panel with white copy would come back inverted. The colours
  // are sampled from the source card instead.
  const sourceCardColour = normalizeHexColour(cardCopy?.cardBackgroundColor);
  const sourceTextColour = normalizeHexColour(cardCopy?.cardTextColor);
  const cardColourSpec = isAspectRatioTool
    ? (sourceCardColour && sourceTextColour
      ? `- Card background colour: EXACTLY ${sourceCardColour}. This is the colour of the source creative's own card; do not lighten, darken or substitute it.
- Text colour: EXACTLY ${sourceTextColour}. Text weight: 700 bold.
- These two colours are taken from the source creative. Never replace them with a default, and never take a colour from anywhere else.`
      : `- Card background colour and text colour: reproduce the ones the SOURCE creative uses on its own card, preserving the same contrast relationship. If the source card is a purple panel with white copy, the output is a purple panel with white copy. Never substitute a default.`)
    : `- Card background color: #F4F4F4.
- Text color: #6F49E8. Text weight: 700 bold.`;
  // A stroke around the copy panel is not part of the brand: the approved
  // creatives use a flat fill, whatever colour the source gives it.
  const cardSurfaceSpec = isAspectRatioTool
    ? '\n- The card is a FLAT, single-colour fill with NO border, outline, stroke or keyline around it. A soft shadow is the only edge treatment allowed.'
    : '';
  const buttonSpec = (alignment) => (isAspectRatioTool
    ? `- Button/pill (only when the source card has one): ${alignment}, below the text. Reproduce the shape, colours and typography the SOURCE card gives it. Do NOT invent a colour.`
    : `- Button: yellow pill, ${alignment}, below text. Match the reference style only.`);
  const hasRefs = refCount > 0;
  const referenceStartIndex = sourceAttached ? 3 : 2;
  const referenceLabel = sourceAttached ? 'Images 3+' : 'Images 2+';
  const referenceInputs = hasRefs ? buildReferenceInputList(referenceStartIndex, refCount) : '';

  const sourceInputLine = useSourceImageForCopy
    ? '2. Image 2 - the source creative. Read ONLY the original card copy from this image. Ignore its scene, subject, background, and layout.'
    : (useSourceImageForMarks
      ? '2. Image 2 - the source creative. Use it ONLY to copy the brand marks listed below, exactly as they are drawn there. Ignore its scene, subject, background, and layout.'
      : null);

  const inputs = [
    '1. Image 1 - the clean scene (target aspect ratio, no card). Use this as the immutable base.',
    sourceInputLine,
    referenceInputs || null,
  ]
    .filter(Boolean)
    .join('\n');

  const cardCopySection = useSourceImageForCopy
    ? `**CARD COPY LOCK:**
- Read the exact card text and button label from Image 2 only.
- Preserve the original card content exactly - do NOT paraphrase, shorten, extend, translate, or correct it.
- The reference images may influence size, font sizing, color treatment, spacing, and position only.
- The reference images must NEVER change, replace, or inspire the card copy.`
    : buildCardCopyLockBlock(cardCopy, useSourceImageForMarks);

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

${buildReferenceStyleSection(referenceLabel, hasRefs, profile)}

**WHAT TO DO:**
- Rebuild the canvas as the two-panel layout specified below. Image 1 supplies ONLY the photograph.
- Place that photograph inside the photo panel. It must NOT bleed to the canvas edges.
- Build the purple copy panel, the pastel background and the logo tab around it.
- Preserve the original card content exactly. The references may restyle the layout, but they must not alter its words.

**STRICT:**
- Do NOT alter the photograph's subject, background, lighting or colours. Only its placement and crop may change.
- Do NOT invent or omit words in the card copy.
- Do NOT use any word from the reference images unless that exact word is already present in the original card copy.
- ${BRAND_LOCK}`
    : `**TASK:** Composite a Cabify UI card onto a clean scene.

**INPUTS (in order):**
${inputs}

${cardCopySection}

${buildReferenceStyleSection(referenceLabel, hasRefs, profile)}

**WHAT TO DO:**
- Add exactly one foreground UI card to Image 1.
- Keep Image 1's scene, subject, background, and logo exactly as-is.
- Match the reference card's visual treatment only: size, position, typography scale, color, corner radius, padding, shadow, and button styling.
- Preserve the original card content exactly. The references may restyle the card, but they must not alter its words.

**STRICT:**
- Do NOT modify the scene, subject, background, or logo from Image 1.${isAspectRatioTool ? '\n- The photograph in the output IS Image 1. Never replace it, or any part of it, with a photograph taken from a reference image.' : ''}
- Do NOT invent or omit words in the card copy.
- Do NOT use any word from the reference images unless that exact word is already present in the original card copy.
- ${BRAND_LOCK}`;

  if (ratio === '1:1') {
    return `${shared}

**CARD DIMENSIONS - 1:1 (non-negotiable):**
${isAspectRatioTool
    ? `- Card width: about 88% of canvas width (950px at 1080 reference), leaving a gap of about 6% on each side.
- Card height: about 38% of canvas height (410px at 1080 reference). Taller than it is in most references - the copy needs the room.
- Card top edge: about 58% from the top of the canvas (y about 626px at 1080).
- Bottom gap below card: about 4% of canvas height (about 43px at 1080).`
    : `- Card width: 93% of canvas width (1003px at 1080 reference). NEVER less than 91%. The card spans almost edge to edge - only about 3.5% gap on each side (about 41px at 1080).
- Card height: about 32% of canvas height (343px at 1080 reference).
- Card top edge: about 64.6% from the top of the canvas (y about 698px at 1080).
- Bottom gap below card: about 3.6% of canvas height (about 39px at 1080). Small gap only.`}
- Corner radius: about 3.9% of canvas width (42px at 1080).
${cardColourSpec}
- Text alignment: left-aligned. Line-height about 1.1.
${textSizeSpec(
    'about 5.5-6% of canvas height per line (60-66px at 1080).',
    '5%',
    '3.4%',
  )}
- Padding inside card: about 3.7% top/left/right, about 2.8% bottom.
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

**CARD DIMENSIONS - 9:16 (non-negotiable):**
${isAspectRatioTool
    ? `- Card width: about 88% of canvas width (950px at 1080 reference), leaving a gap of about 6% on each side.
- Card height: about 23% of canvas height (440px at 1920 reference). Still wider than it is tall, but with room for three or four lines of copy.
- Card top edge: about 62% from the top of the canvas (y about 1190px at 1920).
- Bottom gap below card: about 15% of canvas height (about 288px at 1920). Visible empty scene below the card.`
    : `- Card width: 93% of canvas width (1002px at 1080 reference). NEVER less than 91%. The card spans almost edge to edge - only about 3.5% gap on each side (about 39px at 1080).
- Card height: about 18% of canvas height (343px at 1920 reference). Flat and wide - NOT tall or square.
- Card top edge: about 65.5% from the top of the canvas (y about 1258px at 1920).
- Bottom gap below card: about 16.6% of canvas height (about 319px at 1920). Visible empty scene below card.`}
- Corner radius: about 3.9% of canvas width (42px at 1080).
${cardColourSpec}
- Text alignment: centered. Line-height about 1.1.
${textSizeSpec(
    'about 3.9-4.2% of canvas height per line (74-80px at 1920).',
    '3.4%',
    '2.3%',
  )}
- Padding inside card: about 3.1% top, about 3.7% left/right, about 2.6% bottom.
${buttonSpec('centered')}${cardSurfaceSpec}`;
};

export const getVariationPrompts = (targetRatio, profile = '') => {
  const ratio = String(targetRatio).trim();
  const isAspectRatioTool = usesAspectRatioProfile(profile);
  const guards = buildSceneGuards(profile);

  if (ratio === '1:1') {
    const base = `
**TASK:** Reframe the source image to a 1:1 square canvas - scene only, no UI card.

${guards}
${isAspectRatioTool ? `\n${DESIGN_SYSTEM_LOCK}\n` : ''}
## LAYOUT
- Canvas: 1:1 square.
${buildLogoLayoutLine(profile, '- Logo: top-left. Width about 14-16% of canvas width. Top margin about 6-8%.', '14-16%')}
- Subject: prominent, full face visible.
- Bottom portion: clean scene/background only (a UI card will be added later by the system).

## GEOMETRY
- CROP or EXTEND the background only as needed to reach 1:1.
- Do NOT crop the subject face or logo.
`.trim();

    return isAspectRatioTool
      ? [
        `${base}\n\n## THIS VARIATION\nClosest framing. Keep the original composition as intact as possible; extend background only where strictly needed to reach the square canvas.`,
        `${base}\n\n## THIS VARIATION\nSame composition shifted down slightly, adding breathing room above the subject's head. Do NOT change the subject's size.`,
        `${base}\n\n## THIS VARIATION\nWidest framing. Reveal more of the surroundings that already exist around the subject. Do NOT introduce new elements to fill the space.`,
      ]
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
      ? [
        `${base}\n\n## THIS VARIATION\nClosest framing. Keep the original composition as intact as possible; extend the sides only where strictly needed to reach the wide canvas.`,
        `${base}\n\n## THIS VARIATION\nMore horizontal context, revealing more of the environment that already exists on both sides. Do NOT change the subject's size.`,
        `${base}\n\n## THIS VARIATION\nWidest framing of the three. Reveal as much of the existing surroundings as the canvas allows, while keeping the subject centred. Do NOT introduce new elements to fill the space.`,
      ]
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
- Reach 9:16 by EXTENDING (outpainting) the PHOTOGRAPH itself above and/or below the subject - never by growing the margin or the flat ground around it.
- If the source frames its photograph inside a panel, that panel grows with the canvas: the photograph gets TALLER and keeps filling its frame edge to edge. The frame's border thickness stays as it was in the source.
- The photo panel fills the whole height available between the logo and the area reserved for the copy card. Bands of empty ground above or below the photo are a failure.
- Do NOT rescale or re-shoot the subject to make it fit. The subject keeps its original scale and detail; the photograph grows around it, and the subject should still occupy roughly 45-60% of the canvas height.
- Do NOT crop the subject's face or the logo.`
    : `## GEOMETRY
- EXTEND (outpaint) background above and/or below as needed.
- Keep the subject large - do not zoom out.
- Do NOT crop the subject face or logo.`;

  const base = `
**TASK:** Reframe the source image to a 9:16 vertical canvas - scene only, no UI card.

${guards}
${isAspectRatioTool ? `\n${DESIGN_SYSTEM_LOCK}\n` : ''}
## LAYOUT
- Canvas: 9:16 vertical.
${buildLogoLayoutLine(
    profile,
    '- Logo: top-center. Width about 12-14% of canvas width. Top margin about 5-7%.',
    '12-14%',
    'Place it HORIZONTALLY CENTRED at the top of the canvas, together with its container. Instagram Stories overlays the account profile across the top-left corner, so a left-aligned logo would be covered. Centre it even when the source places it elsewhere.',
  )}
- Subject: large and prominent, fills most of the canvas height.
- Bottom portion: clean scene/background only (a UI card will be added later by the system).

${geometry}
`.trim();

  return isAspectRatioTool
    ? [
      `${base}\n\n## THIS VARIATION\nMinimal intervention. Preserve the source background and only extend it where strictly necessary to fill the canvas.`,
      `${base}\n\n## THIS VARIATION\nMore headroom above the subject, extending the existing sky or background upward. Do NOT change the subject's size.`,
      // Never assert that a vehicle exists: half the approved creatives are
      // phone-in-hand scenes, and demanding a visible car invites the model to
      // invent one.
      `${base}\n\n## THIS VARIATION\nWidest context of the three. If the source contains a vehicle or another defining object, keep it fully in frame alongside the subject. If the source contains no such object, simply reveal more of the surroundings that are already there. Never introduce an object that is not in the source.`,
    ]
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
  const response = await ai.models.generateContent({
    model: 'gemini-3-pro-image-preview',
    contents: {
      parts: [
        { inlineData: { data: sourceImageData, mimeType: sourceMimeType } },
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

export const placeCardOnScene = async (
  ai,
  sceneDataUrl,
  sourceImageData,
  sourceMimeType,
  targetRatio,
  cardCopy,
  profile = '',
) => {
  const sceneMatch = sceneDataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!sceneMatch) throw new Error('Invalid scene data URL');
  const [, sceneMimeType, sceneData] = sceneMatch;

  // The Aspect Ratio tool ships no reference images. Three separate leaks - a
  // promo code, a keyline, then an entire reference subject - survived every
  // textual ban and a downscale to 512px. Asking the model to study six
  // photographs and copy none of them is a losing instruction, and the written
  // measurements below already took precedence over them anyway.
  const refs = usesAspectRatioProfile(profile) ? [] : await loadCardReferences(targetRatio, profile);
  const canLockCopy = hasReliableCardCopy(cardCopy);
  // A partner mark cannot be drawn from its name alone, so when the source card
  // carries one the source image rides along for the model to copy it from.
  const needsSourceForMarks = canLockCopy && Boolean(cardCopy?.cardBrandMarks);
  const parts = [
    { inlineData: { data: sceneData, mimeType: sceneMimeType } },
    ...(canLockCopy && !needsSourceForMarks
      ? []
      : [{ inlineData: { data: sourceImageData, mimeType: sourceMimeType } }]),
    ...refs.map((ref) => ({ inlineData: { data: ref.data, mimeType: ref.mimeType } })),
    {
      text: getCardPlacementPrompt(
        targetRatio,
        refs.length,
        cardCopy,
        !canLockCopy,
        profile,
        needsSourceForMarks,
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

/**
 * `profile` selects the prompt wording. Callers from the Aspect Ratio tool pass
 * ASPECT_RATIO_PROMPT_PROFILE; the ciclo omits it and keeps the legacy prompts.
 */
export const generateAspectRatioImages = async (imageDataUrl, targetRatio, { profile = '' } = {}) => {
  const match = imageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('Invalid imageDataUrl format.');
  const [, mimeType, imageData] = match;

  const ai = getGeminiClient();
  const variationPrompts = getVariationPrompts(targetRatio, profile);
  const outputs = [];
  const errors = [];

  let cardCopy = null;
  try {
    cardCopy = await extractCardCopyFromSource(ai, imageData, mimeType);
    if (!hasReliableCardCopy(cardCopy)) {
      errors.push('Card copy extraction was incomplete; falling back to source-image copy reading.');
    }
  } catch (error) {
    errors.push(`Card copy extraction failed: ${error.message}`);
  }

  for (const prompt of variationPrompts) {
    try {
      const sceneResponse = await ai.models.generateContent({
        model: 'gemini-3-pro-image-preview',
        contents: { parts: [{ inlineData: { data: imageData, mimeType } }, { text: prompt }] },
        config: { imageConfig: { aspectRatio: resolveGeminiAspectRatio(targetRatio), imageSize: '1K' } },
      });

      let sceneUrl = extractFirstImageFromResponse(sceneResponse);
      if (!sceneUrl) {
        errors.push('Pass 1 returned no scene.');
        continue;
      }
      if (needsAspectRatioCrop(targetRatio)) {
        sceneUrl = await cropDataUrlToAspectRatio(sceneUrl, targetRatio);
      }

      const finalUrl = await placeCardOnScene(ai, sceneUrl, imageData, mimeType, targetRatio, cardCopy, profile);
      outputs.push(finalUrl ?? sceneUrl);
    } catch (error) {
      errors.push(error.message);
    }
  }

  return { images: outputs, errors };
};
