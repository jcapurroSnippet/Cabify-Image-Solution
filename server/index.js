import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

const loadCardReferences = (targetRatio) => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const folder = targetRatio === '1:1'
    ? path.join(__dirname, 'assets/card-references/1-1')
    : path.join(__dirname, 'assets/card-references/9-16');

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

**LAYOUT REFERENCES (Images 3+):**
- These are canonical Cabify ad layouts showing the correct card as it should appear in the final composition.
- Observe ONLY: card size relative to canvas, card vertical position, card typography (font, weight, spacing), card colors, corner radius, button style.
- IGNORE everything else in images 3+: their scene, subject, background, logo — ALL of that must come from Image 1.

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
- **Preserve button label character-by-character from Image 2. Do NOT alter any letters.**
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
- **Preserve button label character-by-character from Image 2. Do NOT alter any letters.**
- The reference images (3+) confirm these dimensions visually — use them to calibrate typography, corner radius, button style, and card proportions.`;
};

const placeCardOnScene = async (ai, sceneDataUrl, sourceImageData, sourceMimeType, targetRatio) => {
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
