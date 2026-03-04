import { GenerateContentResponse } from '@google/genai';
import { getGeminiClient } from '../../../lib/geminiClient';
import { AspectRatio } from '../types';

const extractFirstImageFromResponse = (response: GenerateContentResponse): string | null => {
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

const getVariationPrompt = (targetRatio: AspectRatio, variationInstruction: string): string => `
**ROLE:** Cabify Brand Guardian (Strict Compliance Mode).
**TASK:** Adapt source image to **${targetRatio}**.
**CONSTRAINT:** Any deviation from the Cabify Visual Identity System is a failure.

## PROHIBITIONS
- Scene Integrity: Do NOT modify the main subject or key objects. You MAY outpaint only missing background areas.
- Logo Isolation: Do NOT place any logo inside white UI card components.
- UI Singularity: Create exactly one unified UI container per output.

## BRAND LOCKS
- Keep the source palette exactly.
- Keep source typography exactly (family, weight, scale, spacing).
- Do not change orientation of any element.
- No style drift: keep Cabify look and feel.

## GEOMETRY
1. CROP: discard left side from 16:9 source when needed.
2. CENTER: keep the subject centered.
3. EXTEND: outpaint top/bottom only as needed for **${targetRatio}**.

## UI CONTAINER BEHAVIOR
- Keep lateral margins, never stretch full edge-to-edge.
- One card/sheet only.

### If target is 9:16
- Use a floating white bottom sheet with rounded top corners.
- Keep visible background below the sheet.
- Text centered.

### If target is 1:1
- Use a docked white card touching the bottom edge.
- Text left aligned.

## CONTENT REPLICATION
- Text content must be copied exactly.
- Button color and text style must match source.
- Do not add new objects, logos, icons, or decorative assets.

## VARIATION
${variationInstruction}
`;

const getVariationsForRatio = (targetRatio: AspectRatio): string[] => {
  const ratio = String(targetRatio).trim();

  const lockedBrandRules =
    'Brand lock: do NOT modify, replace, recolor, restyle, resize, or reinterpret the typography or brand colors under any circumstance. Keep the exact original font, font weight, font proportions, letter spacing, and all original colors unchanged.';

  if (ratio === '1:1') {
    return [
      `Variation A: centered subject, standard crop, keep face fully visible above the docked card. ${lockedBrandRules}`,
      `Variation B: centered subject, slightly higher framing for safer card space, no typography shrink. ${lockedBrandRules}`,
      `Variation C: centered subject, slightly wider crop, outpaint only background if needed. ${lockedBrandRules}`,
    ];
  }

  if (ratio === '9:16') {
    return [
      `Variation A: centered subject, balanced headroom, floating bottom sheet with visible gap below. ${lockedBrandRules}`,
      `Variation B: centered subject, extra headroom, outpaint only background. ${lockedBrandRules}`,
      `Variation C: centered subject, ensure sheet never overlaps face or hands. ${lockedBrandRules}`,
    ];
  }

  return [
    `Variation A: centered subject with standard crop and no reinterpretation. ${lockedBrandRules}`,
    `Variation B: centered subject with a 5-10% tighter crop, keep key features visible. ${lockedBrandRules}`,
    `Variation C: centered subject with a 5-10% wider crop, outpaint only background when needed. ${lockedBrandRules}`,
  ];
};

export const generateResizedImages = async (
  base64Image: string,
  targetRatio: AspectRatio,
): Promise<string[]> => {
  const [header, imageData] = base64Image.split(',');
  if (!header || !imageData) {
    throw new Error('Invalid image format.');
  }

  const mimeType = header.split(';')[0].split(':')[1];
  if (!mimeType) {
    throw new Error('Could not detect image mime type.');
  }

  const ai = getGeminiClient();
  const variations = getVariationsForRatio(targetRatio);

  const outputs: string[] = [];
  const errors: Array<{ variation: string; error: unknown }> = [];

  for (const variationText of variations) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3-pro-image-preview',
        contents: {
          parts: [
            { inlineData: { data: imageData, mimeType } },
            { text: getVariationPrompt(targetRatio, variationText) },
          ],
        },
        config: {
          imageConfig: {
            aspectRatio: targetRatio as any,
            imageSize: '1K',
          },
        },
      });

      const imageUrl = extractFirstImageFromResponse(response);

      if (imageUrl) {
        outputs.push(imageUrl);
      } else {
        errors.push({
          variation: variationText,
          error: new Error('Model returned no image data in response parts.'),
        });
      }
    } catch (error) {
      console.error('Aspect ratio variation generation failed', variationText, error);
      errors.push({ variation: variationText, error });
    }
  }

  if (outputs.length === 0) {
    throw new Error(
      `Failed to generate images. Errors: ${JSON.stringify(
        errors.map((entry) => ({
          variation: entry.variation,
          message: (entry.error as { message?: string })?.message ?? String(entry.error),
        })),
        null,
        2,
      )}`,
    );
  }

  return outputs;
};