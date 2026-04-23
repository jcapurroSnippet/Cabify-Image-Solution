import { GoogleGenAI } from '@google/genai';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BRAND_LOCK =
  'BRAND LOCK — do NOT modify, replace, recolor, restyle, resize, or reinterpret typography or brand colors under any circumstance. Keep exact original font, weight, proportions, letter-spacing, and all colors unchanged.';

const SCENE_PROHIBITIONS = `
## SCENE-ONLY GENERATION — CRITICAL
- Do NOT include any UI card, white rounded rectangle, text overlay, CTA button, or promotional panel in the output.
- The bottom portion of the canvas must be clean scene/background — no card elements at all.
- Remove any card/text overlay that exists in the source; replace it with natural scene/background continuation.
- Keep: subject, logo (brand logo at top), scene background.
- ${BRAND_LOCK}
- Do NOT modify the main subject. Do NOT add filters, blur, gradients, or color shifts.
`.trim();

export const getVariationPrompts = (targetRatio) => {
  const ratio = String(targetRatio).trim();

  if (ratio === '1:1') {
    const base = `
**TASK:** Reframe the source image to a **1:1 square** canvas — scene only, no UI card.

${SCENE_PROHIBITIONS}

## LAYOUT
- Canvas: 1:1 square.
- Logo: top-left. Width ~14-16% of canvas width. Top margin ~6-8%.
- Subject: prominent, full face visible.
- Bottom portion: clean scene/background only (a UI card will be added later by the system).

## GEOMETRY
- CROP or EXTEND the background only as needed to reach 1:1.
- Do NOT crop the subject face or logo.
`.trim();

    return [
      `${base}\n\n## THIS VARIATION\nTight crop — preserve as much of the original composition as possible.`,
      `${base}\n\n## THIS VARIATION\nSlightly more headroom above the subject.`,
      `${base}\n\n## THIS VARIATION\nWider crop to reveal more of the scene around the subject.`,
    ];
  }

  const base = `
**TASK:** Reframe the source image to a **9:16 vertical** canvas — scene only, no UI card.

${SCENE_PROHIBITIONS}

## LAYOUT
- Canvas: 9:16 vertical.
- Logo: top-center. Width ~12-14% of canvas width. Top margin ~5-7%.
- Subject: large and prominent, fills most of the canvas height.
- Bottom portion: clean scene/background only (a UI card will be added later by the system).

## GEOMETRY
- EXTEND (outpaint) background above and/or below as needed.
- Keep the subject large — do not zoom out.
- Do NOT crop the subject face or logo.
`.trim();

  return [
    `${base}\n\n## THIS VARIATION\nMinimal intervention — preserve source background. Only extend background where strictly necessary to fill the canvas.`,
    `${base}\n\n## THIS VARIATION\nMore headroom above the subject — extend sky/background at the top.`,
    `${base}\n\n## THIS VARIATION\nKeep the car and its context in frame alongside the subject — the car must remain clearly visible. Extend background on the top or sides if needed but never at the cost of removing or hiding the car.`,
  ];
};

export const loadCardReferences = (targetRatio) => {
  if (targetRatio === '1:1') return [];
  const folder = path.join(__dirname, '../assets/card-references/9-16');
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
    .map(f => {
      const buf = readFileSync(path.join(folder, f));
      const ext = path.extname(f).toLowerCase().replace('.', '');
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
      return { data: buf.toString('base64'), mimeType: mime };
    });
};

const getCardPlacementPrompt = (targetRatio, refCount) => {
  const ratio = String(targetRatio).trim();
  const refList = refCount > 0
    ? Array.from({ length: refCount }, (_, i) => `${i + 3}. Image ${i + 3} — layout reference (see LAYOUT REFERENCES below).`).join('\n')
    : '';

  const shared = `**TASK:** Composite a UI card onto a clean scene.

**INPUTS (in order):**
1. Image 1 — the clean scene (target aspect ratio, no card). Use this as the BASE — keep subject, background, logo EXACTLY as-is.
2. Image 2 — the source creative. Extract ONLY: the card text content, button label, and button colors. Do NOT copy its scene, background, or subject.
${refList}

**LAYOUT REFERENCES (Images 3+) — STYLE ONLY:**
- These are canonical Cabify ad layouts provided as visual style guides for the card.
- Observe ONLY: card size relative to canvas, card vertical position, card typography (font, weight, spacing), card colors (#F4F4F4 background, #6F49E8 text), corner radius, button shape and style.
- **DO NOT copy ANY text, headline, message, label, or campaign copy from Images 3+.** The card text must come exclusively from Image 2.
- **⚠️ CRITICAL: Reproduce the EXACT words from Image 2's card — character by character, word by word. Do NOT paraphrase, translate, summarize, or alter the text in any way. Only the font size may differ from Image 2.**
- **DO NOT copy ANY scene, subject, person, object, background, or logo from Images 3+.** The scene must come exclusively from Image 1.
- Images 3+ are purely a visual reference for card geometry and typographic style — nothing else.

**WHAT TO DO:**
- Place a UI card on Image 1 matching the layout, size, position, and typographic style shown in the reference images (3+).
- Card text content and button label must match Image 2.
- The card must appear as a foreground UI overlay (off-white #F4F4F4 rounded rectangle with soft shadow).

**STRICT:**
- Do NOT modify the scene, subject, background, or logo from Image 1.
- Do NOT copy scene/background from Image 2 or Images 3+.
- ${BRAND_LOCK}`;

  if (ratio === '1:1') {
    return `${shared}

**CARD DIMENSIONS — 1:1 (non-negotiable, confirmed by reference images):**
- Card width: **93% of canvas width** (1003px at 1080 reference). NEVER less than 91%. The card spans almost edge to edge — only ~3.5% gap on each side (~41px at 1080).
- Card height: ~32% of canvas height (343px at 1080 reference).
- Card top edge: ~64.6% from the top of the canvas (y≈698px at 1080).
- Bottom gap below card: ~3.6% of canvas height (~39px at 1080). Small gap only.
- Corner radius: ~3.9% of canvas width (42px at 1080).
- Card background color: #F4F4F4 (off-white — NOT pure white).
- Text color: #6F49E8 (Cabify purple). Text weight: 700 bold.
- Text alignment: left-aligned. Line-height ~1.1.
- Text size: ~5.5–6% of canvas height per line (60–66px at 1080).
- Padding inside card: ~3.7% top/left/right, ~2.8% bottom.
- Button: yellow pill, left-aligned, below text. Match reference images for style.
- **⚠️ CRITICAL: The button label must be copied character-by-character from Image 2. Do NOT alter, invent, or misspell any letter.**
- The reference images (3+) confirm these dimensions visually — use them to calibrate typography, corner radius, button style, and card proportions.`;
  }

  return `${shared}

**CARD DIMENSIONS — 9:16 (non-negotiable, confirmed by reference images):**
- Card width: **93% of canvas width** (1002px at 1080 reference). NEVER less than 91%. The card spans almost edge to edge — only ~3.5% gap on each side (~39px at 1080). This is the most critical dimension.
- Card height: ~18% of canvas height (343px at 1920 reference). Flat and wide — NOT tall or square.
- Card top edge: ~65.5% from the top of the canvas (y≈1258px at 1920).
- Bottom gap below card: ~16.6% of canvas height (~319px at 1920). Visible empty scene below card.
- Corner radius: ~3.9% of canvas width (42px at 1080).
- Card background color: #F4F4F4 (off-white — NOT pure white).
- Text color: #6F49E8 (Cabify purple). Text weight: 700 bold.
- Text alignment: centered. Line-height ~1.1.
- Text size: ~3.9–4.2% of canvas height per line (74–80px at 1920).
- Padding inside card: ~3.1% top, ~3.7% left/right, ~2.6% bottom.
- Button: yellow pill, centered, below text. Match reference images for style.
- **⚠️ CRITICAL: The button label must be copied character-by-character from Image 2. Do NOT alter, invent, or misspell any letter.**
- The reference images (3+) confirm these dimensions visually — use them to calibrate typography, corner radius, button style, and card proportions.`;
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

export const placeCardOnScene = async (ai, sceneDataUrl, sourceImageData, sourceMimeType, targetRatio) => {
  const sceneMatch = sceneDataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!sceneMatch) throw new Error('Invalid scene data URL');
  const [, sceneMime, sceneData] = sceneMatch;

  const refs = loadCardReferences(targetRatio);
  const parts = [
    { inlineData: { data: sceneData, mimeType: sceneMime } },
    { inlineData: { data: sourceImageData, mimeType: sourceMimeType } },
    ...refs.map(r => ({ inlineData: { data: r.data, mimeType: r.mimeType } })),
    { text: getCardPlacementPrompt(targetRatio, refs.length) },
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

  for (const prompt of variationPrompts) {
    try {
      const sceneResponse = await ai.models.generateContent({
        model: 'gemini-3-pro-image-preview',
        contents: { parts: [{ inlineData: { data: imageData, mimeType } }, { text: prompt }] },
        config: { imageConfig: { aspectRatio: targetRatio, imageSize: '1K' } },
      });

      const sceneUrl = extractFirstImageFromResponse(sceneResponse);
      if (!sceneUrl) { errors.push('Pass 1 returned no scene.'); continue; }

      const finalUrl = await placeCardOnScene(ai, sceneUrl, imageData, mimeType, targetRatio);
      outputs.push(finalUrl ?? sceneUrl);
    } catch (error) {
      console.error(`[GENERATOR] Variation failed for ${targetRatio}:`, error.message);
      errors.push(error.message);
    }
  }

  return { images: outputs, errors };
};
