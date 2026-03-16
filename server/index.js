import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import axios from 'axios';
import { GoogleGenAI } from '@google/genai';
import { processBatch } from './services/batchProcessor.js';

class RequestValidationError extends Error {}

const app = express();
const port = Number.parseInt(process.env.PORT ?? '8080', 10);

app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '30mb' }));

const PROMPT_LIMITATIONS = `**Role & Mission**
You are the **Cabify Creative Refiner**. Generate exactly one ad variation using only assets already present in the source image.

**Non-negotiable constraints**
1. Do not add new visual elements.
2. Do not change style direction.
3. Do not rotate, mirror, or flip existing elements.
4. Typography must stay exactly as source.
5. Colors must stay exactly as source.
6. Brand fidelity must stay strict.
7. Allowed changes are only layout-level: reorder, reposition, recombine, proportional scale.
8. Do not redraw or replace objects.
9. Produce one output only.
`;

const extractFirstImageFromResponse = (response) => {
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

const getVariationPrompt = (targetRatio, variationInstruction) => `
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

const getVariationsForRatio = (targetRatio) => {
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

  return [
    `Variation A: centered subject, balanced headroom, floating bottom sheet with visible gap below. ${lockedBrandRules}`,
    `Variation B: centered subject, extra headroom, outpaint only background. ${lockedBrandRules}`,
    `Variation C: centered subject, width container and slightly bigger letters. ${lockedBrandRules}`,
  ];
};

const getGeminiClient = () => {
  const apiKey = process.env.GEMINI_API_KEY?.trim() ?? '';

  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY environment variable.');
  }

  return new GoogleGenAI({ apiKey });
};

const getErrorMessage = (error, fallbackMessage) => {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  return message || fallbackMessage;
};

const parseDataUrl = (imageDataUrl) => {
  if (typeof imageDataUrl !== 'string' || imageDataUrl.trim().length === 0) {
    throw new RequestValidationError('imageDataUrl is required.');
  }

  const match = imageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new RequestValidationError('Invalid imageDataUrl format. Expected data URL.');
  }

  const [, mimeType, imageData] = match;
  if (!mimeType || !imageData) {
    throw new RequestValidationError('Invalid imageDataUrl content.');
  }

  return { imageData, mimeType };
};

const downloadImageAsDataUrl = async (imageUrl) => {
  try {
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const mimeType = response.headers['content-type'] || 'image/png';
    const base64 = Buffer.from(response.data).toString('base64');
    return `data:${mimeType};base64,${base64}`;
  } catch (error) {
    throw new RequestValidationError(`Failed to download image from URL: ${error.message}`);
  }
};

app.get('/healthz', (_request, response) => {
  response.status(200).json({ ok: true });
});

app.post('/api/nano-editor', async (request, response) => {
  try {
    const { imageDataUrl, prompt } = request.body ?? {};

    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new RequestValidationError('prompt is required.');
    }

    const { imageData, mimeType } = parseDataUrl(imageDataUrl);
    const ai = getGeminiClient();

    const modelResponse = await ai.models.generateContent({
      model: 'gemini-3.1-flash-image-preview',
      contents: {
        parts: [
          {
            inlineData: {
              data: imageData,
              mimeType,
            },
          },
          {
            text: `${prompt.trim()}\n\n${PROMPT_LIMITATIONS}`,
          },
        ],
      },
      config: {
        responseModalities: ['IMAGE', 'TEXT'],
      },
    });

    const imageUrl = extractFirstImageFromResponse(modelResponse);

    if (!imageUrl) {
      return response.status(502).json({ error: 'The model did not return an image.' });
    }

    return response.status(200).json({ imageUrl });
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return response.status(400).json({ error: error.message });
    }

    console.error('Nano editor generation error:', error);
    return response.status(500).json({
      error: getErrorMessage(error, 'Unexpected image generation error.'),
    });
  }
});

app.post('/api/aspect-ratio', async (request, response) => {
  try {
    const { imageDataUrl, imageUrl, targetRatio } = request.body ?? {};
    const parsedRatio = String(targetRatio ?? '').trim();

    if (!['1:1', '9:16'].includes(parsedRatio)) {
      throw new RequestValidationError('targetRatio must be "1:1" or "9:16".');
    }

    // Support both imageDataUrl and imageUrl
    let finalImageDataUrl = imageDataUrl;
    if (!imageDataUrl && imageUrl) {
      finalImageDataUrl = await downloadImageAsDataUrl(imageUrl);
    }

    const { imageData, mimeType } = parseDataUrl(finalImageDataUrl);
    const ai = getGeminiClient();
    const variations = getVariationsForRatio(parsedRatio);

    const outputs = [];
    const errors = [];

    for (const variationText of variations) {
      try {
        const modelResponse = await ai.models.generateContent({
          model: 'gemini-3-pro-image-preview',
          contents: {
            parts: [
              { inlineData: { data: imageData, mimeType } },
              { text: getVariationPrompt(parsedRatio, variationText) },
            ],
          },
          config: {
            imageConfig: {
              aspectRatio: parsedRatio,
              imageSize: '1K',
            },
          },
        });

        const imageUrl = extractFirstImageFromResponse(modelResponse);
        if (imageUrl) {
          outputs.push(imageUrl);
        } else {
          errors.push({
            variation: variationText,
            message: 'Model returned no image data in response parts.',
          });
        }
      } catch (error) {
        console.error('Aspect ratio variation generation failed', variationText, error);
        errors.push({
          variation: variationText,
          message: getErrorMessage(error, 'Unknown model error.'),
        });
      }
    }

    if (outputs.length === 0) {
      return response.status(502).json({
        error: 'Failed to generate images.',
        details: errors,
      });
    }

    return response.status(200).json({ images: outputs });
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return response.status(400).json({ error: error.message });
    }

    console.error('Aspect ratio generation error:', error);
    return response.status(500).json({
      error: getErrorMessage(error, 'Unexpected image generation error.'),
    });
  }
});

app.post('/api/batch-aspect-ratio', async (request, response) => {
  try {
    const { sheetsUrl, sheetName, driveFolderUrl, driveFolderId } = request.body ?? {};

    if (typeof sheetsUrl !== 'string' || sheetsUrl.trim().length === 0) {
      throw new RequestValidationError('sheetsUrl is required.');
    }

    // Set response headers for streaming progress
    response.setHeader('Content-Type', 'application/x-ndjson');
    response.setHeader('Transfer-Encoding', 'chunked');
    response.setHeader('Cache-Control', 'no-cache');
    if (typeof response.flushHeaders === 'function') {
      response.flushHeaders();
    }
    response.write(JSON.stringify({ state: 'started' }) + '\n');

    // Define progress callback
    const onProgress = (progressData) => {
      response.write(JSON.stringify(progressData) + '\n');
    };

    // Start batch processing asynchronously
    // Note: driveFolderUrl is now hardcoded inside processBatch
    const forwardedProto = request.get('x-forwarded-proto')?.split(',')[0]?.trim();
    let protocol = forwardedProto || request.protocol;
    const host = request.get('host');
    if (protocol === 'http' && host?.endsWith('run.app')) {
      protocol = 'https';
    }

    processBatch({
      sheetsUrl: sheetsUrl.trim(),
      sheetName: sheetName ? sheetName.trim() : undefined,
      driveFolderUrl: driveFolderUrl ? String(driveFolderUrl).trim() : undefined,
      driveFolderId: driveFolderId ? String(driveFolderId).trim() : undefined,
      baseUrl: `${protocol}://${host}`,
      onProgress,
    })
      .then((result) => {
        response.write(JSON.stringify({ state: 'completed', ...result }) + '\n');
        response.end();
      })
      .catch((error) => {
        console.error('Batch processing error:', error);
        response.write(
          JSON.stringify({
            state: 'error',
            error: getErrorMessage(error, 'Batch processing failed.'),
          }) + '\n'
        );
        response.end();
      });
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return response.status(400).json({ error: error.message });
    }

    console.error('Batch aspect ratio error:', error);
    return response.status(500).json({
      error: getErrorMessage(error, 'Unexpected batch processing error.'),
    });
  }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.resolve(__dirname, '..', 'dist');
const indexFile = path.resolve(distDir, 'index.html');

app.use(express.static(distDir));

app.get(/.*/, (request, response) => {
  if (request.path.startsWith('/api/')) {
    return response.status(404).json({ error: 'Route not found.' });
  }

  if (!existsSync(indexFile)) {
    return response
      .status(503)
      .send('Frontend build not found. Run "npm run build" before starting the server.');
  }

  return response.sendFile(indexFile);
});

app.listen(port, () => {
  console.log(`Cabify Image Suite server listening on port ${port}`);
});
