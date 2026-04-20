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

const getVariationPrompts = (targetRatio) => {
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

  // 9:16
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

const getCardPlacementPrompt = (targetRatio) => {
  const ratio = String(targetRatio).trim();

  const shared = `**TASK:** Composite a UI card onto a clean scene.

**INPUTS (in order):**
1. First image — the clean scene (target aspect ratio, no card yet). Use this as the base.
2. Second image — the source reference containing the white rounded UI card. Extract the card design from here (text, colors, button, typography, corner radius).

**WHAT TO DO:**
- Output must be the first image with the card from the second image added on top of it.
- Keep the first image's subject, background, logo, and composition EXACTLY as-is.
- Reproduce the card's text, colors, typography, and button EXACTLY as in the second image.

**STRICT:**
- Do NOT copy the background/subject/scene from the second image — only the card.
- Do NOT modify anything else in the first image.
- The card must appear as a foreground UI overlay (white rounded rectangle with soft shadow).
- ${BRAND_LOCK}`;

  if (ratio === '1:1') {
    return `${shared}

**CARD POSITION AND SIZE (1:1 output):**
- Width: ~94% of canvas width (nearly edge to edge, only ~3% margin each side).
- Height: ~28-32% of canvas height.
- Position: anchored near the bottom, ~5% bottom margin.
- Text alignment inside card: left-aligned.
- Corner radius: ~2-3% of canvas width.`;
  }

  return `${shared}

**CARD POSITION AND SIZE (9:16 output):**
- Width: ~94% of canvas width (nearly edge to edge, only ~3% margin each side). This is the most important dimension — the card MUST span nearly the full width.
- Height: ~15-20% of canvas height (flat and wide, not tall/square).
- Position: horizontally centered, ~22-25% bottom margin (card sits visibly above the bottom — there must be clear background space between the card and the bottom edge of the canvas).
- Text alignment inside card: centered.
- Corner radius: ~2-3% of canvas width.
- **Text size:** REDUCE the text size compared to the source. The card is wider than in the source, so the text should look smaller/more compact inside the card, fitting comfortably on 1-2 short lines with clear padding around it. Do NOT scale the text proportionally with the card width — keep text small so the card stays flat and wide.
- Button: small, compact, centered below the text.`;
};

const placeCardOnScene = async (ai, sceneDataUrl, sourceImageData, sourceMimeType, targetRatio) => {
  const sceneMatch = sceneDataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!sceneMatch) throw new Error('Invalid scene data URL');
  const [, sceneMime, sceneData] = sceneMatch;

  const response = await ai.models.generateContent({
    model: 'gemini-3-pro-image-preview',
    contents: {
      parts: [
        { inlineData: { data: sceneData, mimeType: sceneMime } },
        { inlineData: { data: sourceImageData, mimeType: sourceMimeType } },
        { text: getCardPlacementPrompt(targetRatio) },
      ],
    },
    config: { imageConfig: { aspectRatio: targetRatio, imageSize: '1K' } },
  });
  return extractFirstImageFromResponse(response);
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
    const variationPrompts = getVariationPrompts(parsedRatio);

    const outputs = [];
    const errors = [];

    for (const prompt of variationPrompts) {
      try {
        // Pass 1: generate clean scene (no card)
        const sceneResponse = await ai.models.generateContent({
          model: 'gemini-3-pro-image-preview',
          contents: { parts: [{ inlineData: { data: imageData, mimeType } }, { text: prompt }] },
          config: { imageConfig: { aspectRatio: parsedRatio, imageSize: '1K' } },
        });

        const sceneUrl = extractFirstImageFromResponse(sceneResponse);
        if (!sceneUrl) {
          errors.push({ variation: prompt.slice(0, 80), message: 'Pass 1 returned no scene.' });
          continue;
        }

        // Pass 2: place source card onto the clean scene
        const finalUrl = await placeCardOnScene(ai, sceneUrl, imageData, mimeType, parsedRatio);
        outputs.push(finalUrl ?? sceneUrl);
      } catch (error) {
        console.error('Aspect ratio variation generation failed', error);
        errors.push({
          variation: prompt.slice(0, 80),
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
