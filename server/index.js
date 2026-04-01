import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import axios from 'axios';
import { GoogleGenAI } from '@google/genai';
import { processBatch, getBatchStatus } from './services/batchProcessor.js';
import { getAccounts as getGoogleAccounts, getCampaigns as getGoogleCampaigns, getWorstPerformers as getGoogleWorstPerformers, replaceAdCreative as replaceGoogleAdCreative } from './services/googleAdsService.js';
import { getAccounts as getMetaAccounts, getCampaigns as getMetaCampaigns, getWorstPerformers as getMetaWorstPerformers, replaceAdCreative as replaceMetaAdCreative } from './services/metaAdsService.js';
import { downloadAdImage } from './services/adImageDownloader.js';

class RequestValidationError extends Error {}

const app = express();
const port = Number.parseInt(process.env.PORT ?? '8080', 10);

app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '30mb' }));

const PROMPT_LIMITATIONS = `**Role & Mission**
You are the **Cabify Creative Refiner**. Generate exactly one ad variation. The variation must strictly follow the user’s prompt, doing exactly what the user requests, and must not modify anything else beyond those requested changes.

**Non-negotiable constraints**
1. Do not add new visual elements.
2. Do not change style direction.
3. Do not mirror or flip existing elements.
4. Typography must stay exactly as source.
5. Colors must stay exactly as source.
6. Brand fidelity must stay strict.
7. Allowed changes are only layout-level: reorder, reposition, recombine, proportional scale.
8. Do not redraw or replace objects.
9. DO NOT output the same image as input, even if the prompt is vague. If the prompt is vague, make a reasonable interpretation that results in a different layout while respecting all constraints and brand fidelity.
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
**TASK:** Adapt source image to **${targetRatio}** while matching the attached reference layout.
**CONSTRAINT:** Any deviation from the Cabify Visual Identity System is a failure.

## PROHIBITIONS
- Scene Integrity: Do NOT modify the main subject or key objects. You MAY outpaint only missing background areas.
- Logo Isolation: Do NOT place any logo inside white UI card components.
- UI Singularity: Create exactly one unified UI container per output.
- No re-styling: do not add filters, blur, gradients, or color shifts.

## BRAND LOCKS
- Keep the source palette exactly.
- Keep source typography exactly (family, weight, scale, spacing).
- Do not change orientation of any element.
- No style drift: keep Cabify look and feel.

## COMPOSITION LOCKS
- Preserve the car window frame geometry and diagonal lines.
- Keep the subject face fully visible and natural; keep the raised hand visible.
- Preserve the original camera angle and perspective.

## SAFE MARGINS & SIZE LOCKS (relative to canvas)
- Respect consistent safe margins from the canvas edges.
- Logo size must remain within a tight band; do not scale up/down noticeably.
- Card size must remain within a tight band; do not stretch.

## GEOMETRY
- CROP only what is necessary to fit **${targetRatio}**.
- EXTEND (outpaint) only background areas if needed.
- Do NOT crop through the subject, hand, logo, or UI card.

## UI CARD SPEC
- White rounded rectangle card, consistent corner radius and soft shadow.
- Text and button must match source colors and style exactly.
- Keep original line breaks and text alignment.
- Button: mantain colour, icon on the left, uppercase label, same padding as source.
- Card must span nearly the full width of the canvas with only small side margins (edge-to-edge look like the references).

## LOGO PLACEMENT
- Keep logo size the same as source.
- Align to the reference layout for the target ratio (do not put logo inside the card).

### If target is 9:16
- Logo top-center.
- Card centered horizontally near the bottom with equal side margins.
- Keep visible background below the card.
- Text centered.
- Logo width: ~12-14% of canvas width.
- Top margin: ~5-7% of canvas height.
- Card width: ~94-96% of canvas width (near full width).
- Card height: ~22-26% of canvas height.
- Side margins: ~2-3% each.
- Bottom margin: ~6-8% of canvas height.

### If target is 1:1
- Logo top-left.
- Card anchored near the bottom with small side margins (near full width).
- Text left aligned.
- Logo width: ~14-16% of canvas width.
- Top margin: ~6-8% of canvas height.
- Side margins: ~2-3% each.
- Card width: ~94-96% of canvas width (near full width).
- Card height: ~28-32% of canvas height.
- Bottom margin: ~4-6% of canvas height.

## CONTENT REPLICATION
- Copy text content exactly.
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
      `Variation A: match reference layout exactly (logo top-left, card bottom-left, left-aligned text). Keep subject on right half with full face + hand visible. ${lockedBrandRules}`,
      `Variation B: keep the same layout but add slightly more headroom above the subject; do not change logo or card size. ${lockedBrandRules}`,
      `Variation C: keep layout, allow a slightly wider crop to show more car door/frame while preserving the card margins. ${lockedBrandRules}`,
    ];
  }

  return [
    `Variation A: match reference layout exactly (logo top-center, card bottom-center, centered text). Keep full face + hand visible. ${lockedBrandRules}`,
    `Variation B: keep layout, slightly more headroom above the subject; do not change card or logo size. ${lockedBrandRules}`,
    `Variation C: keep layout, slightly lower the subject (more sky/background at top) while preserving card position. ${lockedBrandRules}`,
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
      model: 'gemini-3-pro-image-preview',
      contents: {
        parts: [
          {
            inlineData: {
              data: imageData,
              mimeType,
            },
          },
          {
            text: `USER PROMPT: ${prompt.trim()}\n\n${PROMPT_LIMITATIONS}`,
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
    response.setHeader('X-Accel-Buffering', 'no');
    if (typeof response.flushHeaders === 'function') {
      response.flushHeaders();
    }
    response.write(JSON.stringify({ state: 'started' }) + '\n');
    if (typeof response.flush === 'function') {
      response.flush();
    }

    const keepAlive = setInterval(() => {
      if (response.writableEnded || response.destroyed) {
        clearInterval(keepAlive);
        return;
      }
      response.write(JSON.stringify({ state: 'keepalive' }) + '\n');
      if (typeof response.flush === 'function') {
        response.flush();
      }
    }, 15000);

    const stopKeepAlive = () => clearInterval(keepAlive);
    response.on('close', stopKeepAlive);
    response.on('finish', stopKeepAlive);

    // Define progress callback
    const onProgress = (progressData) => {
      response.write(JSON.stringify(progressData) + '\n');
      if (typeof response.flush === 'function') {
        response.flush();
      }
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
        stopKeepAlive();
        response.write(JSON.stringify({ state: 'completed', ...result }) + '\n');
        if (typeof response.flush === 'function') {
          response.flush();
        }
        response.end();
      })
      .catch((error) => {
        console.error('Batch processing error:', error);
        stopKeepAlive();
        response.write(
          JSON.stringify({
            state: 'error',
            error: getErrorMessage(error, 'Batch processing failed.'),
          }) + '\n'
        );
        if (typeof response.flush === 'function') {
          response.flush();
        }
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

app.post('/api/batch-status', async (request, response) => {
  try {
    const { sheetsUrl, sheetName } = request.body ?? {};

    if (typeof sheetsUrl !== 'string' || sheetsUrl.trim().length === 0) {
      throw new RequestValidationError('sheetsUrl is required.');
    }

    const status = await getBatchStatus({
      sheetsUrl: sheetsUrl.trim(),
      sheetName: sheetName ? String(sheetName).trim() : undefined,
    });

    return response.status(200).json(status);
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return response.status(400).json({ error: error.message });
    }

    console.error('Batch status error:', error);
    return response.status(500).json({
      error: getErrorMessage(error, 'Unexpected batch status error.'),
    });
  }
});

// ── Ad Optimizer endpoints ──────────────────────────────────────────────────

app.get('/api/ads/accounts', (request, response) => {
  try {
    const platform = String(request.query.platform ?? '').trim();

    if (!['google', 'meta'].includes(platform)) {
      throw new RequestValidationError('platform query param must be "google" or "meta".');
    }

    const accounts =
      platform === 'google' ? getGoogleAccounts() : getMetaAccounts();

    return response.status(200).json({ accounts });
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return response.status(400).json({ error: error.message });
    }

    return response.status(500).json({
      error: getErrorMessage(error, 'Failed to fetch accounts.'),
    });
  }
});

app.get('/api/ads/campaigns', async (request, response) => {
  try {
    const platform = String(request.query.platform ?? '').trim();
    const accountId = String(request.query.accountId ?? '').trim();

    if (!['google', 'meta'].includes(platform)) {
      throw new RequestValidationError('platform query param must be "google" or "meta".');
    }
    if (!accountId) {
      throw new RequestValidationError('accountId query param is required.');
    }

    const campaigns =
      platform === 'google'
        ? await getGoogleCampaigns(accountId)
        : await getMetaCampaigns(accountId);

    return response.status(200).json({ campaigns });
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return response.status(400).json({ error: error.message });
    }
    console.error('Campaigns error:', error);
    return response.status(500).json({
      error: getErrorMessage(error, 'Failed to fetch campaigns.'),
    });
  }
});

app.get('/api/ads/worst-performers', async (request, response) => {
  try {
    const platform = String(request.query.platform ?? '').trim();
    const accountId = String(request.query.accountId ?? '').trim();
    const campaignId = String(request.query.campaignId ?? '').trim();
    const days = Number(request.query.days) || 30;

    if (!['google', 'meta'].includes(platform)) {
      throw new RequestValidationError('platform query param must be "google" or "meta".');
    }
    if (!accountId) {
      throw new RequestValidationError('accountId query param is required.');
    }
    if (!campaignId) {
      throw new RequestValidationError('campaignId query param is required.');
    }

    const ads =
      platform === 'google'
        ? await getGoogleWorstPerformers(accountId, campaignId, days)
        : await getMetaWorstPerformers(accountId, campaignId, days);

    return response.status(200).json({ ads });
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return response.status(400).json({ error: error.message });
    }

    console.error('Worst performers error:', error);
    return response.status(500).json({
      error: getErrorMessage(error, 'Failed to fetch worst performers.'),
    });
  }
});

app.post('/api/ads/download-image', async (request, response) => {
  try {
    const { imageUrl } = request.body ?? {};

    if (typeof imageUrl !== 'string' || imageUrl.trim().length === 0) {
      throw new RequestValidationError('imageUrl is required.');
    }

    const imageDataUrl = await downloadAdImage(imageUrl.trim());
    return response.status(200).json({ imageDataUrl });
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return response.status(400).json({ error: error.message });
    }

    console.error('Download ad image error:', error);
    return response.status(500).json({
      error: getErrorMessage(error, 'Failed to download ad image.'),
    });
  }
});

app.post('/api/ads/replace-creative', async (request, response) => {
  try {
    const { platform, accountId, adId, adGroupId, imageDataUrl } = request.body ?? {};

    if (!['google', 'meta'].includes(platform)) {
      throw new RequestValidationError('platform must be "google" or "meta".');
    }
    if (!accountId) {
      throw new RequestValidationError('accountId is required.');
    }
    if (!adId) {
      throw new RequestValidationError('adId is required.');
    }
    if (!imageDataUrl) {
      throw new RequestValidationError('imageDataUrl is required.');
    }

    let result;
    if (platform === 'google') {
      if (!adGroupId) {
        throw new RequestValidationError('adGroupId is required for Google Ads.');
      }
      result = await replaceGoogleAdCreative(accountId, adGroupId, adId, imageDataUrl);
    } else {
      result = await replaceMetaAdCreative(accountId, adId, imageDataUrl);
    }

    return response.status(200).json(result);
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return response.status(400).json({ error: error.message });
    }

    console.error('Replace creative error:', error);
    return response.status(500).json({
      error: getErrorMessage(error, 'Failed to replace ad creative.'),
    });
  }
});

// ── Static files & SPA fallback ─────────────────────────────────────────────

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
