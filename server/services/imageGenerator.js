import { GoogleGenAI } from '@google/genai';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BRAND_LOCK =
  'BRAND LOCK - do NOT modify, replace, recolor, restyle, resize, or reinterpret typography or brand colors under any circumstance. Keep exact original font, weight, proportions, letter-spacing, and all colors unchanged.';

const CARD_REFERENCE_FOLDERS = {
  '1:1': '1-1',
  '9:16': '9-16',
};

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
  },
  required: ['cardText', 'buttonPresent', 'buttonLabel'],
};

const CARD_COPY_EXTRACTION_PROMPT = `
Read the promotional card in this source creative and extract its literal copy.

Return JSON with exactly these fields:
- "cardText": every non-button word that appears inside the promotional card, in reading order. Preserve punctuation, accents, capitalization, and separators exactly. Use "\\n" only when the source card clearly separates text into multiple visible lines or blocks.
- "buttonPresent": true if the card includes a CTA/button, otherwise false.
- "buttonLabel": the CTA/button text exactly as shown. Return an empty string if there is no button.

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
  };
};

const hasReliableCardCopy = (cardCopy) =>
  Boolean(
    cardCopy &&
      cardCopy.cardText &&
      (!cardCopy.buttonPresent || (cardCopy.buttonPresent && cardCopy.buttonLabel)),
  );

const buildCardCopyLockBlock = (cardCopy) => {
  const copyJson = JSON.stringify(
    {
      cardText: cardCopy.cardText,
      buttonPresent: cardCopy.buttonPresent,
      buttonLabel: cardCopy.buttonLabel,
    },
    null,
    2,
  );

  return `**CARD COPY LOCK (authoritative):**
\`\`\`json
${copyJson}
\`\`\`
- The ONLY allowed text source is the JSON above.
- Preserve the exact words, punctuation, accents, and capitalization from the JSON.
- You may reflow line breaks only if needed to fit the reference layout.
- If "buttonPresent" is false, do not render a button.
- If "buttonPresent" is true, render the button and copy "buttonLabel" exactly.
- The reference images may influence size, font sizing, color treatment, spacing, and position only. They must NEVER change the copy.`;
};

const buildReferenceInputList = (startIndex, count) =>
  Array.from({ length: count }, (_, index) => {
    const imageNumber = startIndex + index;
    return `${imageNumber}. Image ${imageNumber} - layout/style reference only.`;
  }).join('\n');

const buildReferenceStyleSection = (label, hasRefs) => {
  if (!hasRefs) {
    return `**REFERENCE STYLE LOCK:**
- No reference images were attached, so follow the numeric geometry below exactly.`;
  }

  return `**REFERENCE STYLE LOCK (${label}) - STYLE ONLY:**
- Use the reference images ONLY for card size, card position, typography scale, typography weight, alignment, color treatment, corner radius, shadow, padding, and button style.
- Do NOT copy ANY text, headline, CTA, or campaign copy from the reference images.
- Do NOT copy ANY scene, subject, object, logo, or background from the reference images.
- The reference images are visual guides only. They are never content sources.`;
};

const getCardPlacementPrompt = (targetRatio, refCount, cardCopy, useSourceImageForCopy = false) => {
  const ratio = String(targetRatio).trim();
  const hasRefs = refCount > 0;
  const referenceStartIndex = useSourceImageForCopy ? 3 : 2;
  const referenceLabel = useSourceImageForCopy ? 'Images 3+' : 'Images 2+';
  const referenceInputs = hasRefs ? buildReferenceInputList(referenceStartIndex, refCount) : '';

  const inputs = [
    '1. Image 1 - the clean scene (target aspect ratio, no card). Use this as the immutable base.',
    useSourceImageForCopy
      ? '2. Image 2 - the source creative. Read ONLY the original card copy from this image. Ignore its scene, subject, background, and layout.'
      : null,
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
    : buildCardCopyLockBlock(cardCopy);

  const shared = `**TASK:** Composite a Cabify UI card onto a clean scene.

**INPUTS (in order):**
${inputs}

${cardCopySection}

${buildReferenceStyleSection(referenceLabel, hasRefs)}

**WHAT TO DO:**
- Add exactly one foreground UI card to Image 1.
- Keep Image 1's scene, subject, background, and logo exactly as-is.
- Match the reference card's visual treatment only: size, position, typography scale, color, corner radius, padding, shadow, and button styling.
- Preserve the original card content exactly. The references may restyle the card, but they must not alter its words.

**STRICT:**
- Do NOT modify the scene, subject, background, or logo from Image 1.
- Do NOT invent or omit words in the card copy.
- Do NOT use any word from the reference images unless that exact word is already present in the original card copy.
- ${BRAND_LOCK}`;

  if (ratio === '1:1') {
    return `${shared}

**CARD DIMENSIONS - 1:1 (non-negotiable):**
- Card width: 93% of canvas width (1003px at 1080 reference). NEVER less than 91%. The card spans almost edge to edge - only about 3.5% gap on each side (about 41px at 1080).
- Card height: about 32% of canvas height (343px at 1080 reference).
- Card top edge: about 64.6% from the top of the canvas (y about 698px at 1080).
- Bottom gap below card: about 3.6% of canvas height (about 39px at 1080). Small gap only.
- Corner radius: about 3.9% of canvas width (42px at 1080).
- Card background color: #F4F4F4.
- Text color: #6F49E8. Text weight: 700 bold.
- Text alignment: left-aligned. Line-height about 1.1.
- Text size: about 5.5-6% of canvas height per line (60-66px at 1080).
- Padding inside card: about 3.7% top/left/right, about 2.8% bottom.
- Button: yellow pill, left-aligned, below text. Match the reference style only.`;
  }

  return `${shared}

**CARD DIMENSIONS - 9:16 (non-negotiable):**
- Card width: 93% of canvas width (1002px at 1080 reference). NEVER less than 91%. The card spans almost edge to edge - only about 3.5% gap on each side (about 39px at 1080).
- Card height: about 18% of canvas height (343px at 1920 reference). Flat and wide - NOT tall or square.
- Card top edge: about 65.5% from the top of the canvas (y about 1258px at 1920).
- Bottom gap below card: about 16.6% of canvas height (about 319px at 1920). Visible empty scene below card.
- Corner radius: about 3.9% of canvas width (42px at 1080).
- Card background color: #F4F4F4.
- Text color: #6F49E8. Text weight: 700 bold.
- Text alignment: centered. Line-height about 1.1.
- Text size: about 3.9-4.2% of canvas height per line (74-80px at 1920).
- Padding inside card: about 3.1% top, about 3.7% left/right, about 2.6% bottom.
- Button: yellow pill, centered, below text. Match the reference style only.`;
};

export const getVariationPrompts = (targetRatio) => {
  const ratio = String(targetRatio).trim();

  if (ratio === '1:1') {
    const base = `
**TASK:** Reframe the source image to a 1:1 square canvas - scene only, no UI card.

${SCENE_PROHIBITIONS}

## LAYOUT
- Canvas: 1:1 square.
- Logo: top-left. Width about 14-16% of canvas width. Top margin about 6-8%.
- Subject: prominent, full face visible.
- Bottom portion: clean scene/background only (a UI card will be added later by the system).

## GEOMETRY
- CROP or EXTEND the background only as needed to reach 1:1.
- Do NOT crop the subject face or logo.
`.trim();

    return [
      `${base}\n\n## THIS VARIATION\nTight crop - preserve as much of the original composition as possible.`,
      `${base}\n\n## THIS VARIATION\nSlightly more headroom above the subject.`,
      `${base}\n\n## THIS VARIATION\nWider crop to reveal more of the scene around the subject.`,
    ];
  }

  const base = `
**TASK:** Reframe the source image to a 9:16 vertical canvas - scene only, no UI card.

${SCENE_PROHIBITIONS}

## LAYOUT
- Canvas: 9:16 vertical.
- Logo: top-center. Width about 12-14% of canvas width. Top margin about 5-7%.
- Subject: large and prominent, fills most of the canvas height.
- Bottom portion: clean scene/background only (a UI card will be added later by the system).

## GEOMETRY
- EXTEND (outpaint) background above and/or below as needed.
- Keep the subject large - do not zoom out.
- Do NOT crop the subject face or logo.
`.trim();

  return [
    `${base}\n\n## THIS VARIATION\nMinimal intervention - preserve source background. Only extend background where strictly necessary to fill the canvas.`,
    `${base}\n\n## THIS VARIATION\nMore headroom above the subject - extend sky/background at the top.`,
    `${base}\n\n## THIS VARIATION\nKeep the car and its context in frame alongside the subject - the car must remain clearly visible. Extend background on the top or sides if needed but never at the cost of removing or hiding the car.`,
  ];
};

export const loadCardReferences = (targetRatio) => {
  const folderName = CARD_REFERENCE_FOLDERS[String(targetRatio).trim()];
  if (!folderName) return [];

  const folder = path.join(__dirname, `../assets/card-references/${folderName}`);
  if (!existsSync(folder)) return [];

  return readdirSync(folder)
    .filter((fileName) => /\.(png|jpg|jpeg|webp)$/i.test(fileName))
    .sort((left, right) => left.localeCompare(right))
    .map((fileName) => {
      const buffer = readFileSync(path.join(folder, fileName));
      const ext = path.extname(fileName).toLowerCase().replace('.', '');
      const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
      return { data: buffer.toString('base64'), mimeType };
    });
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
) => {
  const sceneMatch = sceneDataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!sceneMatch) throw new Error('Invalid scene data URL');
  const [, sceneMimeType, sceneData] = sceneMatch;

  const refs = loadCardReferences(targetRatio);
  const canLockCopy = hasReliableCardCopy(cardCopy);
  const parts = [
    { inlineData: { data: sceneData, mimeType: sceneMimeType } },
    ...(canLockCopy ? [] : [{ inlineData: { data: sourceImageData, mimeType: sourceMimeType } }]),
    ...refs.map((ref) => ({ inlineData: { data: ref.data, mimeType: ref.mimeType } })),
    { text: getCardPlacementPrompt(targetRatio, refs.length, cardCopy, !canLockCopy) },
  ];

  const response = await ai.models.generateContent({
    model: 'gemini-3-pro-image-preview',
    contents: { parts },
    config: { imageConfig: { aspectRatio: targetRatio, imageSize: '1K' } },
  });

  return extractFirstImageFromResponse(response);
};

export const generateAspectRatioImages = async (imageDataUrl, targetRatio) => {
  const match = imageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('Invalid imageDataUrl format.');
  const [, mimeType, imageData] = match;

  const ai = getGeminiClient();
  const variationPrompts = getVariationPrompts(targetRatio);
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
        config: { imageConfig: { aspectRatio: targetRatio, imageSize: '1K' } },
      });

      const sceneUrl = extractFirstImageFromResponse(sceneResponse);
      if (!sceneUrl) {
        errors.push('Pass 1 returned no scene.');
        continue;
      }

      const finalUrl = await placeCardOnScene(ai, sceneUrl, imageData, mimeType, targetRatio, cardCopy);
      outputs.push(finalUrl ?? sceneUrl);
    } catch (error) {
      errors.push(error.message);
    }
  }

  return { images: outputs, errors };
};
