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
You are the Cabify Creative Refiner. Your sole task is to generate exactly one modified version of the provided base image, applying only the specific change requested by the user — nothing more.

**What you must do**
- Apply the user's requested change precisely and literally.
- Preserve every visual element not mentioned in the request: layout, typography, colors, style, brand elements, proportions.
- If the request involves repositioning, reordering, or scaling an element, treat all other elements as locked and immovable.

**What you must never do**
1. Do not add new visual elements that don't exist in the base image.
2. Do not remove visual elements that exist in the base image (unless explicitly requested).
3. Do not change colors, fonts, or typographic styling.
4. Do not change the visual style or aesthetic direction.
5. Do not mirror, flip, or rotate elements unless explicitly requested.
6. Do not redraw, replace, or reinterpret any object.
7. Do not apply any change beyond what the user explicitly requests.
8. Do not interpret a vague prompt as license to make multiple changes — if the request is ambiguous, apply the most minimal, conservative interpretation.

**Output**
Generate exactly one image. No explanation, no alternatives, no commentary.`;

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

// ─── PASS 1: Crop/outpaint only ──────────────────────────────────────────────
// Goal: adapt the image to the target ratio. Do NOT touch card layout at all.

const CROP_PROHIBITIONS = `
## PROHIBITIONS
- Do NOT modify the main subject or any foreground object.
- Do NOT add filters, blur, gradients, or color shifts.
- Do NOT add new objects or decorative assets.
- Do NOT remove existing visual elements.
- Do NOT reposition, resize, or restyle the UI card, logo, text, or button.
- BRAND LOCK: keep all colors, fonts, and brand elements exactly as in the source.
`.trim();

const getCropPrompts = (targetRatio) => {
  const ratio = String(targetRatio).trim();

  if (ratio === '1:1') {
    const base = `
**TASK:** Reframe the source image into a **1:1 square** canvas. Your only job is geometry — crop or extend the background to fit the square. Do not touch any other element.

${CROP_PROHIBITIONS}

## GEOMETRY RULES
- Target canvas: 1:1 square.
- CROP or EXTEND only the background/scene areas as needed.
- Keep the subject face, raised hand, logo, and UI card fully visible and unmodified.
- Prefer cropping over extending when possible.
`.trim();

    return [
      `${base}\n\n## FRAMING\nTight crop — show as much of the original composition as possible. Keep subject on the right half with full face and raised hand visible.`,
      `${base}\n\n## FRAMING\nSlightly more headroom above the subject than Variation A. Extend or shift the top background area only.`,
      `${base}\n\n## FRAMING\nReveal slightly more of the car door/frame on the left side. Do not change vertical framing.`,
    ];
  }

  // 9:16
  const base = `
**TASK:** Reframe the source image into a **9:16 vertical** canvas. Your only job is geometry — crop or extend the background to fit the tall canvas. Do not touch any other element.

${CROP_PROHIBITIONS}

## GEOMETRY RULES
- Target canvas: 9:16 vertical.
- EXTEND background above and/or below the subject as needed to fill the canvas.
- Keep the subject face, logo, and UI card fully visible and unmodified.
- Subject should be centered or slightly right of center.
`.trim();

  return [
    `${base}\n\n## FRAMING\nKeep subject framing close to the source. Extend background evenly above and below.`,
    `${base}\n\n## FRAMING\nMore headroom above the subject — extend sky/background more at the top than the bottom.`,
    `${base}\n\n## FRAMING\nMore space below the subject — extend background more at the bottom than the top.`,
  ];
};

// ─── PASS 2: Card fix only ───────────────────────────────────────────────────
// Goal: correct the card dimensions and position. Do NOT touch anything else.

const getCardFixPrompt = (targetRatio) => {
  const ratio = String(targetRatio).trim();

  const shared = `
**WHAT THIS IS:**
The white rounded rectangle at the bottom is a UI card — a graphic overlay rendered on top of the photo. It is NOT part of the background. It must always appear in the foreground, visually floating above the photo.

**STRICT PROHIBITIONS:**
- Do NOT change the card's text content, font, size, color, or button design in any way.
- Do NOT redesign or reinterpret the card — reproduce it exactly, only wider.
- Do NOT alter the background, subject, or logo.
- Do NOT move the card vertically from where it currently is.
- Do NOT add or remove any element.
- This is a resize operation only — zero creative decisions allowed.
`.trim();

  if (ratio === '1:1') {
    return `
**TASK:** Resize the white UI card in this 1:1 image to the correct width. One change only.

**THE CHANGE:**
- Widen the card to span ~94-96% of the canvas width (~2-3% margin each side).
- Keep card height as-is.
- The card sits on top of the photo as a foreground overlay — render it above the background, not embedded in it.

${shared}
`.trim();
  }

  return `
**TASK:** Resize the white UI card in this 9:16 image to the correct width. One change only.

**THE CHANGE:**
- Widen the card to span ~94-96% of the canvas width (~2-3% margin each side).
- Keep card height as-is.
- The card sits on top of the photo as a foreground overlay — render it above the background, not embedded in it.

${shared}
`.trim();
};

// ─── Two-pass pipeline ───────────────────────────────────────────────────────

const runTwoPassGeneration = async (ai, imageData, mimeType, targetRatio) => {
  const cropPrompts = getCropPrompts(targetRatio);
  const cardFixPrompt = getCardFixPrompt(targetRatio);
  const outputs = [];
  const errors = [];

  for (const cropPrompt of cropPrompts) {
    // Pass 1: geometry only
    let pass1ImageUrl;
    try {
      const pass1Response = await ai.models.generateContent({
        model: 'gemini-3-pro-image-preview',
        contents: {
          parts: [
            { inlineData: { data: imageData, mimeType } },
            { text: cropPrompt },
          ],
        },
        config: { imageConfig: { aspectRatio: targetRatio, imageSize: '1K' } },
      });
      pass1ImageUrl = extractFirstImageFromResponse(pass1Response);
    } catch (error) {
      errors.push({ pass: 1, message: getErrorMessage(error, 'Pass 1 failed.') });
      continue;
    }

    if (!pass1ImageUrl) {
      errors.push({ pass: 1, message: 'Pass 1 returned no image.' });
      continue;
    }

    // Pass 2: card fix only
    try {
      const { imageData: p1Data, mimeType: p1Mime } = parseDataUrl(pass1ImageUrl);
      const pass2Response = await ai.models.generateContent({
        model: 'gemini-3-pro-image-preview',
        contents: {
          parts: [
            { inlineData: { data: p1Data, mimeType: p1Mime } },
            { text: cardFixPrompt },
          ],
        },
        config: { imageConfig: { aspectRatio: targetRatio, imageSize: '1K' } },
      });
      const pass2ImageUrl = extractFirstImageFromResponse(pass2Response);
      outputs.push(pass2ImageUrl ?? pass1ImageUrl);
    } catch (error) {
      console.warn('Pass 2 (card fix) failed, using pass-1 result:', error.message);
      outputs.push(pass1ImageUrl);
    }
  }

  return { outputs, errors };
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

    const { outputs, errors } = await runTwoPassGeneration(ai, imageData, mimeType, parsedRatio);

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
