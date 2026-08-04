import express from 'express';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { processBatch, getBatchStatus, downloadImageAsDataUrl as downloadSheetImageAsDataUrl } from './services/batchProcessor.js';
import { extractFirstImageFromResponse, generateAspectRatioImages, getGeminiClient } from './services/imageGenerator.js';
import { getAccounts as getGoogleAccounts, getCampaigns as getGoogleCampaigns, getWorstPerformers as getGoogleWorstPerformers, replaceAdCreative as replaceGoogleAdCreative } from './services/googleAdsService.js';
import { getAccounts as getMetaAccounts, getCampaigns as getMetaCampaigns, getWorstPerformers as getMetaWorstPerformers, replaceAdCreative as replaceMetaAdCreative } from './services/metaAdsService.js';
import { downloadAdImage } from './services/adImageDownloader.js';
import {
  CREATIVE_LIBRARY_SYNC_LOG_PATH,
  getCreativeLibrarySheetConfig,
  listCreativeAuditHistory,
  listCreativeLibrary,
  syncAcceptedCreatives,
  writeCreativeLibrarySyncLog,
} from './services/creativeLibraryService.js';
import { getCreativeLibraryConfig } from './services/creativeLibraryConfig.js';
import {
  buildGoogleReplacementPlan,
  executeGoogleReplacements,
  getGoogleLowPerformers,
} from './services/googleReplacementService.js';
import {
  buildAdsReplacementPlan,
  executeAdsReplacements,
  getAdsLowPerformers,
} from './services/adsReplacementService.js';
import {
  cacheCreativeReviewPreviewAuthorization,
  clearCreativeReviewSession,
  clearCreativeReviewPreviewAuthorization,
  getCreativeReviewPreviewAuthorization,
  getCreativeReviewSessionToken,
  isCreativeReviewWriterAuthorized,
  isReviewRuntimeApiAllowed,
  normalizeCreativeReviewDecisionPayload,
  serializeCreativeReviewSession,
} from './services/creativeReviewHttp.js';
import { CreativeReviewError } from './services/creativeReviewCore.js';
import {
  createReviewBatch,
  ensureReviewSheets,
  exchangeReviewToken,
  finalizeReviewBatch,
  getPublicReviewBatch,
  getReviewBatch,
  importLegacyReviewBatch,
  issueReviewLink,
  listReviewBatches,
  registerReviewItems,
  retryReviewPublication,
  revokeReviewBatch,
  saveReviewDecisions,
} from './services/creativeReviewService.js';
import { findOrCreateDriveFolder, getShareableLink, uploadBufferToDrive } from './services/driveService.js';
import { sanitizeFileName } from './services/creativeLibraryCore.js';

class RequestValidationError extends Error {}

const app = express();
const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const appMode = String(process.env.APP_MODE || 'studio').trim().toLowerCase();

app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '30mb' }));
app.use((request, response, next) => {
  if (
    appMode === 'review' &&
    request.path.startsWith('/api/') &&
    !isReviewRuntimeApiAllowed(request.path)
  ) {
    return response.status(404).json({ error: 'Route not found.' });
  }
  return next();
});

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


const getErrorMessage = (error, fallbackMessage) => {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  const apiMessage =
    error &&
    typeof error === 'object' &&
    'errors' in error &&
    Array.isArray(error.errors) &&
    error.errors[0]?.message
      ? String(error.errors[0].message)
      : '';

  return apiMessage || message || fallbackMessage;
};

const IMAGE_PREVIEW_PLACEHOLDER_SVG = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320" role="img" aria-label="Preview unavailable">
  <rect width="320" height="320" rx="18" fill="#eef2f7"/>
  <path d="M94 206l45-52 31 34 20-22 36 40H94z" fill="#cbd5e1"/>
  <circle cx="211" cy="119" r="22" fill="#cbd5e1"/>
  <rect x="74" y="84" width="172" height="152" rx="14" fill="none" stroke="#94a3b8" stroke-width="8"/>
  <text x="160" y="270" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" fill="#64748b">Preview unavailable</text>
</svg>`
);

const getHeaderSafeMessage = (message) =>
  String(message || '')
    .replace(/[^\t\x20-\x7e]/g, ' ')
    .slice(0, 300);

const sendImagePreviewPlaceholder = (response, error) => {
  const message = getErrorMessage(error, 'Failed to load image preview.');
  console.warn('[IMAGE_PREVIEW] Returning placeholder:', message);
  response.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  response.setHeader('Cache-Control', 'private, max-age=60');
  response.setHeader('X-Image-Preview-Error', getHeaderSafeMessage(message));
  return response.status(200).send(IMAGE_PREVIEW_PLACEHOLDER_SVG);
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

const getImageFileExtension = (mimeType) => {
  if (/jpe?g/i.test(mimeType)) return 'jpg';
  if (/webp/i.test(mimeType)) return 'webp';
  if (/gif/i.test(mimeType)) return 'gif';
  return 'png';
};

const persistEditorReference = async ({ imageDataUrl, batchId, sourceAssetName }) => {
  const { imageData, mimeType } = parseDataUrl(imageDataUrl);
  const config = getCreativeLibraryConfig();
  const root = await findOrCreateDriveFolder('Creative Reviews', config.driveRootFolderId);
  const batchFolder = await findOrCreateDriveFolder(batchId, root.folderId);
  const referenceFolder = await findOrCreateDriveFolder('References', batchFolder.folderId);
  const baseName = sanitizeFileName(sourceAssetName || 'reference');
  const fileName = `${baseName}_original.${getImageFileExtension(mimeType)}`;
  const upload = await uploadBufferToDrive(Buffer.from(imageData, 'base64'), fileName, mimeType, referenceFolder.folderId);
  return getShareableLink(upload.fileId);
};

const sendCreativeReviewError = (response, error, fallbackMessage) => {
  if (error instanceof CreativeReviewError) {
    return response.status(error.statusCode || 400).json({
      error: error.message,
      code: error.code,
      details: error.details,
    });
  }
  console.error('[CREATIVE_REVIEW]', error);
  return response.status(500).json({ error: getErrorMessage(error, fallbackMessage) });
};

const normalizeOptionalStringList = (value) => {
  if (value === undefined || value === null || value === '') return [];
  const rawValues = Array.isArray(value) ? value : [value];
  return [...new Set(rawValues.map((item) => String(item).trim()).filter(Boolean))];
};

const normalizeAdsSource = (value) => {
  const source = String(value || 'google').trim().toLowerCase();
  if (!['google', 'meta'].includes(source)) {
    throw new RequestValidationError('source must be "google" or "meta".');
  }
  return source;
};

const normalizeOptionalNumber = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const getActiveAdsPlatforms = (source) => [source];

const normalizeAdsSelections = ({ source, selections, accountId, campaignId, campaignIds }) => {
  const normalizedSelections = {};
  for (const platform of getActiveAdsPlatforms(source)) {
    const selection = selections?.[platform] || {};
    const resolvedAccountId = String(selection.accountId || (source === platform ? accountId : '') || '').trim();
    if (!resolvedAccountId) {
      throw new RequestValidationError(`${platform} accountId is required.`);
    }

    normalizedSelections[platform] = {
      accountId: resolvedAccountId,
      campaignIds: normalizeOptionalStringList(
        selection.campaignIds ??
          selection.campaignId ??
          (source === platform ? campaignIds ?? campaignId : undefined),
      ),
    };
  }
  return normalizedSelections;
};

const getCategoryOptions = async (sheetsUrl) => {
  const trimmedSheetsUrl = typeof sheetsUrl === 'string' ? sheetsUrl.trim() : '';
  if (!trimmedSheetsUrl) return getCreativeLibraryConfig().categories;
  return (await getCreativeLibrarySheetConfig({ sheetsUrl: trimmedSheetsUrl })).categories;
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

app.get('/api/image-preview', async (request, response) => {
  try {
    const imageUrl = String(request.query.url ?? request.query.u ?? '').trim();
    if (!imageUrl) {
      throw new RequestValidationError('url query param is required.');
    }

    if (appMode === 'review') {
      const token = getCreativeReviewSessionToken(request);
      const allowedUrls = await getCreativeReviewPreviewAuthorization({
        token,
        load: () => getPublicReviewBatch({ token }),
      });
      if (!allowedUrls.has(imageUrl)) {
        return response.status(403).json({ error: 'This preview does not belong to the active review batch.' });
      }
    }

    const dataUrl = await downloadSheetImageAsDataUrl(imageUrl);
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      throw new Error('Invalid image response.');
    }

    response.setHeader('Content-Type', match[1]);
    response.setHeader('Cache-Control', 'private, max-age=300');
    return response.send(Buffer.from(match[2], 'base64'));
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return response.status(400).json({ error: error.message });
    }

    if (error instanceof CreativeReviewError) {
      return sendCreativeReviewError(response, error, 'Failed to authorize image preview.');
    }

    return sendImagePreviewPlaceholder(response, error);
  }
});

app.post('/api/nano-editor', async (request, response) => {
  try {
    const { imageDataUrl, prompt, reviewContext } = request.body ?? {};

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

    if (!reviewContext) {
      return response.status(200).json({ imageUrl });
    }

    if (typeof reviewContext !== 'object' || Array.isArray(reviewContext)) {
      throw new RequestValidationError('reviewContext must be an object.');
    }
    const sheetsUrl = String(reviewContext.sheetsUrl || '').trim();
    const batchId = String(reviewContext.batchId || reviewContext.reviewBatchId || '').trim();
    const familyId = String(reviewContext.familyId || '').trim();
    const generationId = String(reviewContext.generationId || reviewContext.generation_id || '').trim();
    const category = String(reviewContext.category || '').trim();
    const plazas = normalizeOptionalStringList(reviewContext.plazas);
    if (!sheetsUrl || !batchId || !familyId || !generationId || !category || plazas.length === 0) {
      throw new RequestValidationError(
        'reviewContext requires sheetsUrl, batchId, familyId, generationId, category and at least one plaza.',
      );
    }

    const sourceAssetName = String(reviewContext.sourceAssetName || `asset-${reviewContext.sourceIndex || 1}`).trim();
    const referenceUrl = await persistEditorReference({
      imageDataUrl,
      batchId,
      sourceAssetName,
    });
    const registration = await registerReviewItems({
      sheetsUrl,
      batchId,
      items: [{
        familyId,
        generationId,
        variantIndex: 1,
        imageUrl,
        referenceUrl,
        category,
        plazas,
        // Editor assets have no stable Sheet cell across separate batches, so
        // their lineage is intentionally scoped to this review batch.
        sourceOutput: `editor_batch:${batchId}:${reviewContext.sourceIndex || sourceAssetName}`,
        metadata: {
          sourceAssetName,
          sourceIndex: reviewContext.sourceIndex || '',
          prompt: prompt.trim(),
        },
      }],
    });
    const registeredItem = registration.items?.[0];
    const stableImageUrl = registeredItem?.image_url || registeredItem?.imageUrl;
    if (!stableImageUrl) {
      throw new Error('The generated image was not persisted in the review batch.');
    }

    return response.status(200).json({
      imageUrl: `/api/image-preview?url=${encodeURIComponent(stableImageUrl)}`,
      stableImageUrl,
      batchId,
      reviewBatchId: batchId,
      reviewItemId: registeredItem.review_item_id || registeredItem.reviewItemId || registeredItem.itemId,
    });
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return response.status(400).json({ error: error.message });
    }

    if (error instanceof CreativeReviewError) {
      return sendCreativeReviewError(response, error, 'Failed to persist generated review image.');
    }

    return response.status(500).json({
      error: getErrorMessage(error, 'Unexpected image generation error.'),
    });
  }
});

app.post('/api/aspect-ratio', async (request, response) => {
  try {
    const { imageDataUrl, imageUrl, targetRatio } = request.body ?? {};
    const parsedRatio = String(targetRatio ?? '').trim();

    if (!['1:1', '9:16', '1.91:1'].includes(parsedRatio)) {
      throw new RequestValidationError('targetRatio must be "1:1", "9:16", or "1.91:1".');
    }

    let finalImageDataUrl = imageDataUrl;
    if (!imageDataUrl && imageUrl) {
      finalImageDataUrl = await downloadImageAsDataUrl(imageUrl);
    }

    if (!finalImageDataUrl) throw new RequestValidationError('imageDataUrl is required.');

    const { images, errors } = await generateAspectRatioImages(finalImageDataUrl, parsedRatio);

    if (images.length === 0) {
      return response.status(502).json({ error: 'Failed to generate images.', details: errors });
    }

    return response.status(200).json({ images });
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return response.status(400).json({ error: error.message });
    }

    return response.status(500).json({
      error: getErrorMessage(error, 'Unexpected image generation error.'),
    });
  }
});

app.post('/api/batch-aspect-ratio', async (request, response) => {
  try {
    const {
      sheetsUrl,
      sheetName,
      driveFolderUrl,
      driveFolderId,
      title,
      category,
      plazas,
      createdBy,
    } = request.body ?? {};

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
      title,
      category,
      plazas,
      createdBy,
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

// ── Creative review endpoints ──────────────────────────────────────────────

const creativeReviewWriterActions = new Map([
  ['ensureReviewSheets', ensureReviewSheets],
  ['createReviewBatch', createReviewBatch],
  ['registerReviewItems', registerReviewItems],
  ['issueReviewLink', issueReviewLink],
  ['revokeReviewBatch', revokeReviewBatch],
  ['saveReviewDecisions', saveReviewDecisions],
  ['finalizeReviewBatch', finalizeReviewBatch],
  ['retryReviewPublication', retryReviewPublication],
  ['importLegacyReviewBatch', importLegacyReviewBatch],
]);

app.post('/api/creative-reviews/internal/writer', async (request, response) => {
  if (appMode !== 'review') return response.status(404).json({ error: 'Route not found.' });
  if (!isCreativeReviewWriterAuthorized({
    providedSecret: request.get('x-creative-review-writer-secret'),
  })) {
    return response.status(401).json({
      error: 'Creative review writer authentication failed.',
      code: 'REVIEW_WRITER_UNAUTHORIZED',
    });
  }

  try {
    const action = String(request.body?.action || '').trim();
    const handler = creativeReviewWriterActions.get(action);
    if (!handler) {
      throw new CreativeReviewError(
        `Unsupported creative review writer action "${action || '(missing)'}".`,
        'REVIEW_WRITER_ACTION_INVALID',
        400,
      );
    }
    const result = await handler(request.body?.input || {});
    return response.status(200).json(result);
  } catch (error) {
    return sendCreativeReviewError(response, error, 'Creative review writer mutation failed.');
  }
});

app.get('/api/creative-reviews/batches', async (request, response) => {
  try {
    const sheetsUrl = String(request.query.sheetsUrl || '').trim();
    const batches = await listReviewBatches({
      sheetsUrl,
      status: request.query.status,
      sourceType: request.query.sourceType,
    });
    return response.status(200).json({ batches });
  } catch (error) {
    return sendCreativeReviewError(response, error, 'Failed to list creative review batches.');
  }
});

app.post('/api/creative-reviews/batches', async (request, response) => {
  try {
    const batch = await createReviewBatch(request.body || {});
    return response.status(201).json(batch);
  } catch (error) {
    return sendCreativeReviewError(response, error, 'Failed to create creative review batch.');
  }
});

app.get('/api/creative-reviews/batches/:batchId', async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  try {
    const batch = await getReviewBatch({
      sheetsUrl: request.query.sheetsUrl,
      batchId: request.params.batchId,
    });
    return response.status(200).json(batch);
  } catch (error) {
    return sendCreativeReviewError(response, error, 'Failed to read creative review batch.');
  }
});

app.patch('/api/creative-reviews/batches/:batchId/decisions', async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  try {
    const result = await saveReviewDecisions({
      sheetsUrl: request.body?.sheetsUrl || request.query.sheetsUrl,
      batchId: request.params.batchId,
      decisions: normalizeCreativeReviewDecisionPayload(request.body),
      reviewerName: request.body?.reviewerName,
      reviewerEmail: request.body?.reviewerEmail,
    });
    return response.status(200).json(result);
  } catch (error) {
    return sendCreativeReviewError(response, error, 'Failed to save internal creative review decisions.');
  }
});

app.post('/api/creative-reviews/batches/:batchId/finalize', async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  try {
    const result = await finalizeReviewBatch({
      sheetsUrl: request.body?.sheetsUrl || request.query.sheetsUrl,
      batchId: request.params.batchId,
      reviewerName: request.body?.reviewerName,
      reviewerEmail: request.body?.reviewerEmail,
    });
    return response.status(200).json(result);
  } catch (error) {
    return sendCreativeReviewError(response, error, 'Failed to finalize internal creative review.');
  }
});

app.post('/api/creative-reviews/batches/:batchId/items', async (request, response) => {
  try {
    const result = await registerReviewItems({
      ...(request.body || {}),
      batchId: request.params.batchId,
    });
    return response.status(201).json(result);
  } catch (error) {
    return sendCreativeReviewError(response, error, 'Failed to register creative review items.');
  }
});

const issueReviewLinkHandler = async (request, response) => {
  try {
    const result = await issueReviewLink({
      ...(request.body || {}),
      batchId: request.params.batchId,
    });
    return response.status(200).json({
      ...result,
      privateUrl: result.privateUrl || result.reviewUrl,
    });
  } catch (error) {
    return sendCreativeReviewError(response, error, 'Failed to issue creative review link.');
  }
};

app.post('/api/creative-reviews/batches/:batchId/send', issueReviewLinkHandler);
app.post('/api/creative-reviews/batches/:batchId/prepare', issueReviewLinkHandler);
app.post('/api/creative-reviews/batches/:batchId/renew', issueReviewLinkHandler);

app.post('/api/creative-reviews/batches/:batchId/revoke', async (request, response) => {
  try {
    const batch = await revokeReviewBatch({
      ...(request.body || {}),
      batchId: request.params.batchId,
    });
    return response.status(200).json({ batch });
  } catch (error) {
    return sendCreativeReviewError(response, error, 'Failed to revoke creative review batch.');
  }
});

app.post('/api/creative-reviews/batches/:batchId/retry', async (request, response) => {
  try {
    const result = await retryReviewPublication({
      ...(request.body || {}),
      batchId: request.params.batchId,
    });
    return response.status(200).json(result?.batch ? result : { batch: result });
  } catch (error) {
    return sendCreativeReviewError(response, error, 'Failed to retry creative review publication.');
  }
});

app.post('/api/creative-reviews/import-legacy', async (request, response) => {
  try {
    const result = await importLegacyReviewBatch(request.body || {});
    return response.status(201).json(result);
  } catch (error) {
    return sendCreativeReviewError(response, error, 'Failed to import legacy creative review data.');
  }
});

app.post('/api/creative-reviews/session', async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  try {
    const token = String(request.body?.token || '').trim();
    const session = await exchangeReviewToken({ token });
    response.setHeader('Set-Cookie', serializeCreativeReviewSession({
      token: session.sessionToken || session.cookieToken || token,
      expiresAt: session.expiresAt,
      secure: request.secure || request.get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https',
    }));
    return response.status(200).json({
      batchId: session.batchId,
      expiresAt: session.expiresAt,
    });
  } catch (error) {
    clearCreativeReviewPreviewAuthorization(String(request.body?.token || '').trim());
    response.setHeader('Set-Cookie', clearCreativeReviewSession({
      secure: request.secure || request.get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https',
    }));
    return sendCreativeReviewError(response, error, 'Failed to start creative review session.');
  }
});

app.get('/api/creative-reviews/public', async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  try {
    const token = getCreativeReviewSessionToken(request);
    const result = await getPublicReviewBatch({ token });
    cacheCreativeReviewPreviewAuthorization({ token, payload: result });
    return response.status(200).json(result);
  } catch (error) {
    clearCreativeReviewPreviewAuthorization(getCreativeReviewSessionToken(request));
    return sendCreativeReviewError(response, error, 'Failed to read creative review.');
  }
});

app.patch('/api/creative-reviews/public/decisions', async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  try {
    const result = await saveReviewDecisions({
      token: getCreativeReviewSessionToken(request),
      decisions: normalizeCreativeReviewDecisionPayload(request.body),
    });
    return response.status(200).json(result);
  } catch (error) {
    if (error instanceof CreativeReviewError && error.statusCode >= 401 && error.statusCode <= 410) {
      clearCreativeReviewPreviewAuthorization(getCreativeReviewSessionToken(request));
    }
    return sendCreativeReviewError(response, error, 'Failed to save creative review decisions.');
  }
});

app.post('/api/creative-reviews/public/finalize', async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  try {
    const result = await finalizeReviewBatch({
      token: getCreativeReviewSessionToken(request),
      reviewerName: request.body?.reviewerName,
      reviewerEmail: request.body?.reviewerEmail,
    });
    cacheCreativeReviewPreviewAuthorization({
      token: getCreativeReviewSessionToken(request),
      payload: result,
    });
    return response.status(200).json(result);
  } catch (error) {
    if (error instanceof CreativeReviewError && error.statusCode >= 401 && error.statusCode <= 410) {
      clearCreativeReviewPreviewAuthorization(getCreativeReviewSessionToken(request));
    }
    return sendCreativeReviewError(response, error, 'Failed to finalize creative review.');
  }
});

// ── Creative Library endpoints ──────────────────────────────────────────────

app.post('/api/creative-library/sync', async (request, response) => {
  try {
    const { sheetsUrl, sheetName } = request.body ?? {};

    if (typeof sheetsUrl !== 'string' || sheetsUrl.trim().length === 0) {
      throw new RequestValidationError('sheetsUrl is required.');
    }

    const result = await syncAcceptedCreatives({
      sheetsUrl: sheetsUrl.trim(),
      sheetName: sheetName ? String(sheetName).trim() : undefined,
    });

    return response.status(200).json(result);
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return response.status(400).json({ error: error.message });
    }

    writeCreativeLibrarySyncLog('error', 'Sync failed', {
      error: error?.message || String(error),
      stack: error?.stack || null,
    });
    return response.status(500).json({
      error: getErrorMessage(error, 'Failed to sync accepted creatives.'),
      debugLogPath: CREATIVE_LIBRARY_SYNC_LOG_PATH,
      details: {
        message: error?.message || String(error),
      },
    });
  }
});

app.get('/api/creative-library', async (request, response) => {
  try {
    const sheetsUrl = String(request.query.sheetsUrl ?? '').trim();

    if (!sheetsUrl) {
      throw new RequestValidationError('sheetsUrl query param is required.');
    }

    const result = await listCreativeLibrary({ sheetsUrl });
    return response.status(200).json(result);
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return response.status(400).json({ error: error.message });
    }

    return response.status(500).json({
      error: getErrorMessage(error, 'Failed to read creative library.'),
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

    return response.status(500).json({
      error: getErrorMessage(error, 'Failed to replace ad creative.'),
      metaAdsTrace: error?.metaAdsTrace || undefined,
      details: {
        message: error?.message || String(error),
        status: error?.response?.status || error?.code || null,
        data: error?.response?.data || null,
      },
    });
  }
});

app.post('/api/ads/low-performers', async (request, response) => {
  try {
    const {
      accountId,
      campaignId,
      campaignIds,
      limit,
      sheetsUrl,
      selections,
      minImpressions,
      maxAssetsPerAd,
      datePreset,
      date_preset: datePresetSnake,
    } = request.body ?? {};
    const source = normalizeAdsSource(request.body?.source);
    const normalizedSelections = normalizeAdsSelections({
      source,
      selections,
      accountId,
      campaignId,
      campaignIds,
    });

    const result = await getAdsLowPerformers({
      source,
      selections: normalizedSelections,
      sheetsUrl: sheetsUrl ? String(sheetsUrl).trim() : undefined,
      limit: Number(limit) || 100,
      analysisDays: 30,
      minImpressions: normalizeOptionalNumber(minImpressions) ?? 0,
      maxAssetsPerAd: normalizeOptionalNumber(maxAssetsPerAd),
      datePreset: datePreset || datePresetSnake,
    });

    return response.status(200).json({
      ...result,
      categories: await getCategoryOptions(sheetsUrl),
    });
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return response.status(400).json({ error: error.message });
    }

    return response.status(500).json({
      error: getErrorMessage(error, 'Failed to fetch Ads low performers.'),
    });
  }
});

app.get('/api/ads-replacements/history', async (request, response) => {
  try {
    const { sheetsUrl, accountId, campaignId, status, from } = request.query ?? {};
    if (!sheetsUrl) throw new RequestValidationError('sheetsUrl is required.');
    const entries = await listCreativeAuditHistory({
      sheetsUrl: String(sheetsUrl).trim(),
      accountId: String(accountId || ''),
      campaignId: String(campaignId || ''),
      status: String(status || ''),
      from: String(from || ''),
    });
    return response.status(200).json({ entries });
  } catch (error) {
    if (error instanceof RequestValidationError) return response.status(400).json({ error: error.message });
    return response.status(500).json({ error: getErrorMessage(error, 'Failed to fetch replacement history.') });
  }
});

app.post('/api/ads/replacement-plan', async (request, response) => {
  try {
    const {
      sheetsUrl,
      accountId,
      campaignId,
      campaignIds,
      limit,
      selectedLowPerformerIds,
      lowPerformerCategories,
      replacementMode,
      selections,
      minImpressions,
      maxAssetsPerAd,
      datePreset,
      date_preset: datePresetSnake,
    } = request.body ?? {};

    if (!sheetsUrl) {
      throw new RequestValidationError('sheetsUrl is required.');
    }

    const source = normalizeAdsSource(request.body?.source);
    const normalizedSelections = normalizeAdsSelections({
      source,
      selections,
      accountId,
      campaignId,
      campaignIds,
    });
    const plan = await buildAdsReplacementPlan({
      source,
      selections: normalizedSelections,
      sheetsUrl: String(sheetsUrl).trim(),
      limit: Number(limit) || 20,
      selectedLowPerformerIds,
      lowPerformerCategories,
      replacementMode,
      analysisDays: 30,
      minImpressions: normalizeOptionalNumber(minImpressions) ?? 0,
      maxAssetsPerAd: normalizeOptionalNumber(maxAssetsPerAd),
      datePreset: datePreset || datePresetSnake,
    });

    return response.status(200).json(plan);
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return response.status(400).json({ error: error.message });
    }

    return response.status(500).json({
      error: getErrorMessage(error, 'Failed to build Ads replacement plan.'),
    });
  }
});

app.post('/api/ads/execute-replacements', async (request, response) => {
  try {
    const {
      sheetsUrl,
      accountId,
      campaignId,
      campaignIds,
      limit,
      confirm,
      selectedOperationIds,
      selectedLowPerformerIds,
      lowPerformerCategories,
      replacementMode,
      allowNewAdCreation,
      selections,
      minImpressions,
      maxAssetsPerAd,
      datePreset,
      date_preset: datePresetSnake,
    } = request.body ?? {};

    if (!sheetsUrl) {
      throw new RequestValidationError('sheetsUrl is required.');
    }
    if (confirm !== true) {
      throw new RequestValidationError('confirm must be true.');
    }

    const source = normalizeAdsSource(request.body?.source);
    const normalizedSelections = normalizeAdsSelections({
      source,
      selections,
      accountId,
      campaignId,
      campaignIds,
    });

    const result = await executeAdsReplacements({
      source,
      selections: normalizedSelections,
      sheetsUrl: String(sheetsUrl).trim(),
      limit: Number(limit) || 10,
      confirm,
      selectedOperationIds,
      selectedLowPerformerIds,
      lowPerformerCategories,
      replacementMode,
      allowNewAdCreation,
      analysisDays: 30,
      minImpressions: normalizeOptionalNumber(minImpressions) ?? 0,
      maxAssetsPerAd: normalizeOptionalNumber(maxAssetsPerAd),
      datePreset: datePreset || datePresetSnake,
    });

    return response.status(200).json(result);
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return response.status(400).json({ error: error.message });
    }

    console.error('[ADS_REPLACEMENT] Execute request failed', {
      message: error?.message || String(error),
      stack: error?.stack || null,
      status: error?.response?.status || error?.code || null,
      data: error?.response?.data || null,
      googleAdsTrace: error?.googleAdsTrace || [],
      metaAdsTrace: error?.metaAdsTrace || [],
    });

    return response.status(500).json({
      error: getErrorMessage(error, 'Failed to execute Ads replacements.'),
      googleAdsTrace: error?.googleAdsTrace || undefined,
      metaAdsTrace: error?.metaAdsTrace || undefined,
    });
  }
});

app.post('/api/ads/google/low-performers', async (request, response) => {
  try {
    const { accountId, campaignId, campaignIds, limit, sheetsUrl } = request.body ?? {};

    if (!accountId) {
      throw new RequestValidationError('accountId is required.');
    }

    const assets = await getGoogleLowPerformers({
      accountId: String(accountId).trim(),
      campaignIds: normalizeOptionalStringList(campaignIds ?? campaignId),
      sheetsUrl: sheetsUrl ? String(sheetsUrl).trim() : undefined,
      limit: Number(limit) || 100,
      analysisDays: 30,
      minImpressions: 0,
    });

    return response.status(200).json({
      assets,
      categories: await getCategoryOptions(sheetsUrl),
    });
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return response.status(400).json({ error: error.message });
    }

    return response.status(500).json({
      error: getErrorMessage(error, 'Failed to fetch Google Ads low performers.'),
    });
  }
});

app.post('/api/ads/google/replacement-plan', async (request, response) => {
  try {
    const {
      sheetsUrl,
      accountId,
      campaignId,
      campaignIds,
      limit,
      selectedLowPerformerIds,
      lowPerformerCategories,
      replacementMode,
    } = request.body ?? {};

    if (!sheetsUrl) {
      throw new RequestValidationError('sheetsUrl is required.');
    }
    if (!accountId) {
      throw new RequestValidationError('accountId is required.');
    }

    const plan = await buildGoogleReplacementPlan({
      sheetsUrl: String(sheetsUrl).trim(),
      accountId: String(accountId).trim(),
      campaignIds: normalizeOptionalStringList(campaignIds ?? campaignId),
      limit: Number(limit) || 20,
      selectedLowPerformerIds,
      lowPerformerCategories,
      replacementMode,
      analysisDays: 30,
      minImpressions: 0,
    });

    return response.status(200).json(plan);
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return response.status(400).json({ error: error.message });
    }

    return response.status(500).json({
      error: getErrorMessage(error, 'Failed to build Google Ads replacement plan.'),
    });
  }
});

app.post('/api/ads/google/execute-replacements', async (request, response) => {
  try {
    const {
      sheetsUrl,
      accountId,
      campaignId,
      campaignIds,
      limit,
      confirm,
      selectedOperationIds,
      selectedLowPerformerIds,
      lowPerformerCategories,
      replacementMode,
      allowNewAdCreation,
    } = request.body ?? {};

    if (!sheetsUrl) {
      throw new RequestValidationError('sheetsUrl is required.');
    }
    if (!accountId) {
      throw new RequestValidationError('accountId is required.');
    }
    if (confirm !== true) {
      throw new RequestValidationError('confirm must be true.');
    }

    const normalizedCampaignIds = normalizeOptionalStringList(campaignIds ?? campaignId);
    console.log('[GOOGLE_REPLACEMENT] Execute request', {
      accountId: String(accountId).trim(),
      campaignIds: normalizedCampaignIds,
      limit: Number(limit) || 10,
      selectedOperationCount: Array.isArray(selectedOperationIds) ? selectedOperationIds.length : null,
      selectedLowPerformerCount: Array.isArray(selectedLowPerformerIds) ? selectedLowPerformerIds.length : null,
      replacementMode: replacementMode || null,
      allowNewAdCreation: allowNewAdCreation === true,
    });

    const result = await executeGoogleReplacements({
      sheetsUrl: String(sheetsUrl).trim(),
      accountId: String(accountId).trim(),
      campaignIds: normalizedCampaignIds,
      limit: Number(limit) || 10,
      confirm,
      selectedOperationIds,
      selectedLowPerformerIds,
      lowPerformerCategories,
      replacementMode,
      allowNewAdCreation,
      analysisDays: 30,
      minImpressions: 0,
    });

    console.log('[GOOGLE_REPLACEMENT] Execute response', {
      accountId: String(accountId).trim(),
      summary: result.summary,
    });

    return response.status(200).json(result);
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return response.status(400).json({ error: error.message });
    }

    console.error('[GOOGLE_REPLACEMENT] Execute request failed', {
      message: error?.message || String(error),
      stack: error?.stack || null,
      status: error?.response?.status || error?.code || null,
      data: error?.response?.data || null,
    });

    return response.status(500).json({
      error: getErrorMessage(error, 'Failed to execute Google Ads replacements.'),
    });
  }
});

// ── Static files & SPA fallback ─────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.resolve(__dirname, '..', 'dist');
const indexFile = path.resolve(distDir, 'index.html');

if (appMode === 'review') {
  app.get('/', (_request, response) => response.redirect('/review'));
}

app.use(express.static(distDir));

app.get(/.*/, (request, response) => {
  if (request.path.startsWith('/api/')) {
    return response.status(404).json({ error: 'Route not found.' });
  }

  if (appMode === 'review' && request.path !== '/review' && !request.path.startsWith('/r/')) {
    return response.redirect('/review');
  }

  if (!existsSync(indexFile)) {
    return response
      .status(503)
      .send('Frontend build not found. Run "npm run build" before starting the server.');
  }

  return response.sendFile(indexFile);
});

export { app };

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  app.listen(port, () => {});
}
