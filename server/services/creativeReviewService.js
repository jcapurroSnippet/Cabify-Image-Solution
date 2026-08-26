import axios from 'axios';
import crypto from 'node:crypto';
import {
  CREATIVE_REVIEW_BATCHES_SHEET,
  CREATIVE_REVIEW_BATCH_HEADERS,
  CREATIVE_REVIEW_ITEMS_SHEET,
  CREATIVE_REVIEW_ITEM_HEADERS,
  getCreativeLibraryConfig,
} from './creativeLibraryConfig.js';
import {
  CreativeReviewError,
  applyReviewDecisions,
  backfillReviewDecisionAudit,
  buildPartialFamilyWarnings,
  createReviewId,
  createReviewToken,
  getReviewExpiry,
  hashReviewToken,
  isReviewLinkActive,
  legacyReviewStatusToDecision,
  normalizeImportedReviewDecision,
  normalizeReviewSourceType,
  parseReviewToken,
  planReviewItemRegistration,
  planReviewPublication,
  resolveVerifiedReviewAspectRatio,
  summarizeReviewItems,
  transitionReviewBatch,
} from './creativeReviewCore.js';
import { getDriveClient, getSheetsClient } from './googleAuth.js';
import { findOrCreateDriveFolder, uploadBufferToDrive } from './driveService.js';
import {
  appendRows,
  buildRange,
  columnIndexToLetter,
  extractSpreadsheetId,
  objectToRow,
  valuesToObjects,
} from './sheetsService.js';
import {
  classifyBackgroundColor,
  dataUrlToBuffer,
  extractDriveFileId,
  getCellText,
  getCellUrl,
  hashBuffer,
  normalizeHeader,
  normalizeUrl,
  sanitizeFileName,
} from './creativeLibraryCore.js';
import {
  classifyAspectRatio,
  formatResolution,
  getImageResolutionFromBuffer,
  normalizeAspectRatio,
} from './imageRatio.js';

let creativeReviewDependencyOverrides = {};

// Narrow dependency seam used by the integration tests. Production callers
// never set overrides and continue through the real Google/Drive services.
export const setCreativeReviewServiceDependenciesForTest = (overrides = {}) => {
  creativeReviewDependencyOverrides = { ...overrides };
};

export const resetCreativeReviewServiceDependenciesForTest = () => {
  creativeReviewDependencyOverrides = {};
};

const getReviewSheetsClient = () => (
  creativeReviewDependencyOverrides.getSheetsClient?.() || getSheetsClient()
);
const getReviewDriveClient = () => (
  creativeReviewDependencyOverrides.getDriveClient?.() || getDriveClient()
);
const findReviewDriveFolder = (...args) => (
  creativeReviewDependencyOverrides.findOrCreateDriveFolder?.(...args) || findOrCreateDriveFolder(...args)
);
const uploadReviewBuffer = (...args) => (
  creativeReviewDependencyOverrides.uploadBufferToDrive?.(...args) || uploadBufferToDrive(...args)
);
const ingestReviewCreative = async (args) => {
  if (creativeReviewDependencyOverrides.ingestApprovedReviewCreative) {
    return creativeReviewDependencyOverrides.ingestApprovedReviewCreative(args);
  }
  const { ingestApprovedReviewCreative } = await import('./creativeLibraryService.js');
  return ingestApprovedReviewCreative(args);
};
const listReviewLibrary = async (args) => {
  if (creativeReviewDependencyOverrides.listCreativeLibrary) {
    return creativeReviewDependencyOverrides.listCreativeLibrary(args);
  }
  const { listCreativeLibrary } = await import('./creativeLibraryService.js');
  return listCreativeLibrary(args);
};

const getReviewWriterBaseUrl = () => clean(process.env.CREATIVE_REVIEW_WRITER_BASE_URL).replace(/\/$/, '');
const shouldProxyReviewMutation = () => (
  clean(process.env.APP_MODE).toLowerCase() === 'studio' && Boolean(getReviewWriterBaseUrl())
);
const assertReviewWriterConfigured = () => {
  if (
    clean(process.env.APP_MODE).toLowerCase() === 'studio'
    && clean(process.env.NODE_ENV).toLowerCase() === 'production'
    && !getReviewWriterBaseUrl()
  ) {
    throw new CreativeReviewError(
      'CREATIVE_REVIEW_WRITER_BASE_URL is required for Studio mutations in production.',
      'REVIEW_WRITER_REQUIRED',
      503,
    );
  }
};
const runReviewWriterMutation = async (action, input) => {
  assertReviewWriterConfigured();
  if (!shouldProxyReviewMutation()) return null;
  const secret = clean(process.env.CREATIVE_REVIEW_WRITER_SECRET);
  if (secret.length < 32) {
    throw new CreativeReviewError(
      'CREATIVE_REVIEW_WRITER_SECRET must contain at least 32 characters.',
      'REVIEW_WRITER_SECRET_REQUIRED',
      503,
    );
  }
  try {
    const response = await axios.post(
      `${getReviewWriterBaseUrl()}/api/creative-reviews/internal/writer`,
      { action, input },
      {
        timeout: Math.max(30_000, Number(process.env.CREATIVE_REVIEW_WRITER_TIMEOUT_MS || 3_600_000)),
        maxBodyLength: getCreativeLibraryConfig().maxDownloadSizeBytes * 2,
        headers: { 'x-creative-review-writer-secret': secret },
      },
    );
    return response.data;
  } catch (error) {
    const payload = error?.response?.data || {};
    if (payload.code) {
      throw new CreativeReviewError(
        payload.error || payload.message || 'Creative review writer rejected the mutation.',
        payload.code,
        error.response?.status || 500,
        payload.details || {},
      );
    }
    throw new CreativeReviewError(
      error?.message || 'Creative review writer is unavailable.',
      'REVIEW_WRITER_UNAVAILABLE',
      503,
    );
  }
};

const nowIso = () => new Date().toISOString();
const canonicalSheetsUrl = (spreadsheetId) =>
  `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
const clean = (value) => String(value ?? '').trim();
const cleanInteger = (value, fallback = 0) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
};
const parseJson = (value, fallback = {}) => {
  if (value && typeof value === 'object') return value;
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};
const stringifyJson = (value) => {
  if (typeof value === 'string') return value;
  return JSON.stringify(value || {});
};

const normalizeInput = (input) =>
  typeof input === 'string' ? { sheetsUrl: input } : { ...(input || {}) };

const getSpreadsheetId = (value) => {
  const text = clean(value);
  if (!text) return '';
  if (/^[a-zA-Z0-9_-]+$/.test(text)) return text;
  try {
    return extractSpreadsheetId(text);
  } catch {
    return '';
  }
};

const resolveSpreadsheetContext = (input = {}) => {
  const args = normalizeInput(input);
  const config = getCreativeLibraryConfig();
  const explicit = args.spreadsheetId || args.sheetsUrl || args.sheetUrl;
  const fallback = config.reviewSheetsUrl;
  const spreadsheetId = getSpreadsheetId(explicit || fallback);
  if (!spreadsheetId) {
    throw new CreativeReviewError(
      'sheetsUrl is required. Configure CREATIVE_REVIEW_SHEETS_URL for requests that omit it.',
      'REVIEW_SHEETS_URL_REQUIRED',
      400,
    );
  }
  return {
    args,
    config,
    spreadsheetId,
    sheetsUrl: canonicalSheetsUrl(spreadsheetId),
  };
};

const getSheetMetadata = async (sheets, spreadsheetId) => {
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))',
  });
  return response.data.sheets || [];
};

const ensureSheetWithHeaders = async (sheets, spreadsheetId, sheetName, headers) => {
  let metadata = await getSheetMetadata(sheets, spreadsheetId);
  let sheet = metadata.find((entry) => entry.properties?.title === sheetName);
  if (!sheet) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          addSheet: {
            properties: {
              title: sheetName,
              gridProperties: { rowCount: 1000, columnCount: Math.max(40, headers.length) },
            },
          },
        }],
      },
    });
    metadata = await getSheetMetadata(sheets, spreadsheetId);
    sheet = metadata.find((entry) => entry.properties?.title === sheetName);
  } else if ((sheet.properties?.gridProperties?.columnCount || 0) < headers.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          appendDimension: {
            sheetId: sheet.properties.sheetId,
            dimension: 'COLUMNS',
            length: headers.length - sheet.properties.gridProperties.columnCount,
          },
        }],
      },
    });
  }

  const current = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: buildRange(sheetName, 'A1:ZZ1'),
    valueRenderOption: 'FORMULA',
  });
  const currentHeaders = current.data.values?.[0] || [];
  if (headers.some((header, index) => currentHeaders[index] !== header) || currentHeaders.length < headers.length) {
    const lastCurrentColumn = columnIndexToLetter(Math.max(0, currentHeaders.length - 1));
    const existing = currentHeaders.length
      ? await sheets.spreadsheets.values.get({
          spreadsheetId,
          range: buildRange(sheetName, `A:${lastCurrentColumn}`),
          valueRenderOption: 'FORMULA',
        })
      : { data: { values: [] } };
    const oldValues = existing.data.values || [];
    const oldHeaderIndexes = new Map(
      (oldValues[0] || []).map((header, index) => [normalizeHeader(header), index]),
    );
    const migrated = oldValues.slice(1).map((row) =>
      headers.map((header) => {
        const index = oldHeaderIndexes.get(normalizeHeader(header));
        return index === undefined ? '' : row?.[index] ?? '';
      }),
    );
    const lastColumn = columnIndexToLetter(headers.length - 1);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: buildRange(sheetName, `A1:${lastColumn}${Math.max(1, migrated.length + 1)}`),
      valueInputOption: 'RAW',
      requestBody: { values: [headers, ...migrated] },
    });
  }
  return sheet?.properties?.sheetId;
};

export const ensureReviewSheets = async (input = {}) => {
  const remote = await runReviewWriterMutation('ensureReviewSheets', input);
  if (remote) return remote;
  const { spreadsheetId, sheetsUrl } = resolveSpreadsheetContext(input);
  const sheets = await getReviewSheetsClient();
  const [batchesSheetId, itemsSheetId] = await Promise.all([
    ensureSheetWithHeaders(
      sheets,
      spreadsheetId,
      CREATIVE_REVIEW_BATCHES_SHEET,
      CREATIVE_REVIEW_BATCH_HEADERS,
    ),
    ensureSheetWithHeaders(
      sheets,
      spreadsheetId,
      CREATIVE_REVIEW_ITEMS_SHEET,
      CREATIVE_REVIEW_ITEM_HEADERS,
    ),
  ]);
  return { spreadsheetId, sheetsUrl, batchesSheetId, itemsSheetId };
};

const readRows = async (sheets, spreadsheetId, sheetName, headers) => {
  const lastColumn = columnIndexToLetter(headers.length - 1);
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: buildRange(sheetName, `A:${lastColumn}`),
    valueRenderOption: 'FORMULA',
  });
  return valuesToObjects(response.data.values || []);
};

const readReviewRows = async (sheets, spreadsheetId) => {
  await Promise.all([
    ensureSheetWithHeaders(sheets, spreadsheetId, CREATIVE_REVIEW_BATCHES_SHEET, CREATIVE_REVIEW_BATCH_HEADERS),
    ensureSheetWithHeaders(sheets, spreadsheetId, CREATIVE_REVIEW_ITEMS_SHEET, CREATIVE_REVIEW_ITEM_HEADERS),
  ]);
  const [batches, items] = await Promise.all([
    readRows(sheets, spreadsheetId, CREATIVE_REVIEW_BATCHES_SHEET, CREATIVE_REVIEW_BATCH_HEADERS),
    readRows(sheets, spreadsheetId, CREATIVE_REVIEW_ITEMS_SHEET, CREATIVE_REVIEW_ITEM_HEADERS),
  ]);
  return { batches, items };
};

const readReviewRowsIfPresent = async (sheets, spreadsheetId, knownMetadata) => {
  const metadata = knownMetadata || await getSheetMetadata(sheets, spreadsheetId);
  const titles = new Set(metadata.map((sheet) => sheet.properties?.title));
  if (!titles.has(CREATIVE_REVIEW_BATCHES_SHEET) || !titles.has(CREATIVE_REVIEW_ITEMS_SHEET)) {
    return null;
  }
  const [batches, items] = await Promise.all([
    readRows(sheets, spreadsheetId, CREATIVE_REVIEW_BATCHES_SHEET, CREATIVE_REVIEW_BATCH_HEADERS),
    readRows(sheets, spreadsheetId, CREATIVE_REVIEW_ITEMS_SHEET, CREATIVE_REVIEW_ITEM_HEADERS),
  ]);
  return { batches, items };
};

const readExistingReviewRows = async (sheets, spreadsheetId) => {
  const rows = await readReviewRowsIfPresent(sheets, spreadsheetId);
  if (!rows) {
    throw new CreativeReviewError('Review link is invalid.', 'REVIEW_TOKEN_INVALID', 401);
  }
  return rows;
};

const updateRows = async (sheets, spreadsheetId, sheetName, headers, rows) => {
  if (!rows.length) return;
  const lastColumn = columnIndexToLetter(headers.length - 1);
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: rows.map((row) => ({
        range: buildRange(sheetName, `A${row.__rowNumber}:${lastColumn}${row.__rowNumber}`),
        values: [objectToRow(headers, row)],
      })),
    },
  });
};

const updateRowPatches = async (sheets, spreadsheetId, sheetName, headers, entries) => {
  const data = [];
  for (const { rowNumber, patch } of entries || []) {
    if (!rowNumber) continue;
    for (const [field, value] of Object.entries(patch || {})) {
      const columnIndex = headers.indexOf(field);
      if (columnIndex < 0) continue;
      data.push({
        range: buildRange(sheetName, `${columnIndexToLetter(columnIndex)}${rowNumber}`),
        values: [[value ?? '']],
      });
    }
  }
  if (!data.length) return;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data },
  });
};

const hydrateBatch = (row, spreadsheetId) => {
  const metadata = parseJson(row.metadata_json);
  return ({
  ...row,
  metadata,
  version: Math.max(1, cleanInteger(row.version, 1)),
  item_count: cleanInteger(row.item_count),
  approved_count: cleanInteger(row.approved_count),
  rejected_count: cleanInteger(row.rejected_count),
  pending_count: cleanInteger(row.pending_count),
  batchId: row.review_batch_id,
  reviewBatchId: row.review_batch_id,
  sourceType: row.source_type,
  createdBy: row.created_by,
  category: row.category || metadata.category || '',
  plazas: row.plazas || metadata.plazas || '',
  plaza: row.plaza || metadata.plaza || metadata.plazas || '',
  sheetsUrl: canonicalSheetsUrl(spreadsheetId),
  });
};

const hydrateItem = (row) => ({
  ...row,
  metadata: parseJson(row.metadata_json),
  version: Math.max(1, cleanInteger(row.version, 1)),
  creative_version: Math.max(1, cleanInteger(row.creative_version, 1)),
  source_row: cleanInteger(row.source_row, row.source_row || 0),
  itemId: row.review_item_id,
  reviewItemId: row.review_item_id,
  batchId: row.review_batch_id,
  familyId: row.creative_family_id,
  ratio: row.aspect_ratio,
  variantIndex: row.variant,
  imageUrl: row.image_url,
  referenceUrl: row.reference_url,
});

const prepareBatchForWrite = (batch) => ({
  ...batch,
  metadata_json: stringifyJson(batch.metadata ?? batch.metadata_json),
});
const prepareItemForWrite = (item) => ({
  ...item,
  metadata_json: stringifyJson(item.metadata ?? item.metadata_json),
});

const getBatchId = (args) => clean(args.batchId || args.reviewBatchId || args.review_batch_id || args.id);
const findBatch = (batches, batchId) => batches.find((batch) => batch.review_batch_id === batchId);
const getBatchItems = (items, batchId) => items.filter((item) => item.review_batch_id === batchId);

const readLatestBatch = async (sheets, spreadsheetId, batchId) => {
  const batches = await readRows(
    sheets,
    spreadsheetId,
    CREATIVE_REVIEW_BATCHES_SHEET,
    CREATIVE_REVIEW_BATCH_HEADERS,
  );
  return assertBatch(findBatch(batches, batchId), batchId);
};

const preserveLatestAccessState = (candidate, latest) => {
  const wasRevoked = latest.status === 'revoked' || (candidate.token_hash && !latest.token_hash);
  if (wasRevoked) {
    return {
      ...candidate,
      status: 'revoked',
      token_hash: '',
      expires_at: '',
      revoked_at: latest.revoked_at || nowIso(),
      version: Math.max(cleanInteger(candidate.version, 1), cleanInteger(latest.version, 1) + 1),
    };
  }
  return {
    ...candidate,
    token_hash: latest.token_hash,
    expires_at: latest.expires_at,
    revoked_at: latest.revoked_at,
  };
};

const reviewLocks = new Map();
const withReviewLock = async (spreadsheetId, callback) => {
  const previous = reviewLocks.get(spreadsheetId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  reviewLocks.set(spreadsheetId, current);
  await previous;
  try {
    return await callback();
  } finally {
    release();
    if (reviewLocks.get(spreadsheetId) === current) reviewLocks.delete(spreadsheetId);
  }
};

const legacyImportLocks = new Map();
const withLegacyImportLock = async (spreadsheetId, callback) => {
  const previous = legacyImportLocks.get(spreadsheetId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  legacyImportLocks.set(spreadsheetId, current);
  await previous;
  try {
    return await callback();
  } finally {
    release();
    if (legacyImportLocks.get(spreadsheetId) === current) legacyImportLocks.delete(spreadsheetId);
  }
};

const assertBatch = (batch, batchId) => {
  if (!batch) {
    throw new CreativeReviewError(`Review batch ${batchId} was not found.`, 'REVIEW_BATCH_NOT_FOUND', 404);
  }
  return batch;
};

const updateBatchSummary = (batch, items, timestamp = nowIso()) => {
  const summary = summarizeReviewItems(items);
  return {
    ...batch,
    item_count: summary.total,
    approved_count: summary.approved,
    rejected_count: summary.rejected,
    pending_count: summary.pending,
    updated_at: timestamp,
  };
};

export const createReviewBatch = async (input = {}) => {
  const remote = await runReviewWriterMutation('createReviewBatch', input);
  if (remote) return remote;
  const { args, spreadsheetId, sheetsUrl } = resolveSpreadsheetContext(input);
  return withReviewLock(spreadsheetId, async () => {
    const sheets = await getReviewSheetsClient();
    await ensureSheetWithHeaders(sheets, spreadsheetId, CREATIVE_REVIEW_BATCHES_SHEET, CREATIVE_REVIEW_BATCH_HEADERS);
    const timestamp = nowIso();
    const reviewBatchId = clean(args.batchId || args.reviewBatchId) || createReviewId('batch');
    const existing = await readRows(sheets, spreadsheetId, CREATIVE_REVIEW_BATCHES_SHEET, CREATIVE_REVIEW_BATCH_HEADERS);
    if (findBatch(existing, reviewBatchId)) {
      throw new CreativeReviewError(`Review batch ${reviewBatchId} already exists.`, 'REVIEW_BATCH_EXISTS', 409);
    }
    const batch = prepareBatchForWrite({
      review_batch_id: reviewBatchId,
      source_type: normalizeReviewSourceType(args.sourceType || args.origin),
      status: 'draft',
      title: clean(args.title || args.name) || `Creative review ${timestamp.slice(0, 10)}`,
      context: clean(args.context),
      created_by: typeof args.createdBy === 'object' ? stringifyJson(args.createdBy) : clean(args.createdBy),
      created_at: timestamp,
      updated_at: timestamp,
      issued_at: '',
      expires_at: '',
      token_hash: '',
      revoked_at: '',
      reviewer_name: '',
      reviewer_email: '',
      review_started_at: '',
      finalized_at: '',
      published_at: '',
      source_sheet_id: clean(args.sourceSpreadsheetId || args.source_sheet_id || spreadsheetId),
      source_tab: clean(args.sourceTab || args.sheetName),
      version: 1,
      item_count: 0,
      approved_count: 0,
      rejected_count: 0,
      pending_count: 0,
      publish_error: '',
      metadata: {
        ...(args.metadata || {}),
        ...(args.category ? { category: args.category } : {}),
        ...(args.plazas ? { plazas: args.plazas } : {}),
      },
    });
    await appendRows(sheets, spreadsheetId, CREATIVE_REVIEW_BATCHES_SHEET, CREATIVE_REVIEW_BATCH_HEADERS, [batch]);
    return hydrateBatch({ ...batch, __rowNumber: existing.length + 2 }, spreadsheetId);
  });
};

export const listReviewBatches = async (input = {}) => {
  const { args, spreadsheetId } = resolveSpreadsheetContext(input);
  const sheets = await getReviewSheetsClient();
  const { batches, items } = await readReviewRows(sheets, spreadsheetId);
  const status = clean(args.status).toLowerCase();
  const sourceType = args.sourceType ? normalizeReviewSourceType(args.sourceType) : '';
  return batches
    .filter((batch) => !status || clean(batch.status).toLowerCase() === status)
    .filter((batch) => !sourceType || batch.source_type === sourceType)
    .map((batch) => hydrateBatch(updateBatchSummary(batch, getBatchItems(items, batch.review_batch_id)), spreadsheetId))
    .sort((left, right) => Date.parse(right.created_at || '') - Date.parse(left.created_at || ''));
};

export const getReviewBatch = async (input = {}) => {
  const { args, spreadsheetId } = resolveSpreadsheetContext(input);
  const batchId = getBatchId(args);
  if (!batchId) throw new CreativeReviewError('batchId is required.', 'REVIEW_BATCH_ID_REQUIRED');
  const sheets = await getReviewSheetsClient();
  const { batches, items } = await readReviewRows(sheets, spreadsheetId);
  const batch = assertBatch(findBatch(batches, batchId), batchId);
  const batchItems = getBatchItems(items, batchId).map(hydrateItem);
  return {
    ...hydrateBatch(updateBatchSummary(batch, batchItems), spreadsheetId),
    items: batchItems,
    summary: summarizeReviewItems(batchItems),
    warnings: buildPartialFamilyWarnings(batchItems),
  };
};

const downloadReviewImage = async (imageUrl) => {
  if (String(imageUrl).startsWith('data:image/')) return dataUrlToBuffer(imageUrl);
  const driveFileId = extractDriveFileId(imageUrl);
  if (driveFileId) {
    const drive = await getReviewDriveClient();
    const [media, metadata] = await Promise.all([
      drive.files.get(
        { fileId: driveFileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'arraybuffer' },
      ),
      drive.files.get({ fileId: driveFileId, fields: 'mimeType', supportsAllDrives: true }),
    ]);
    return {
      buffer: Buffer.isBuffer(media.data) ? media.data : Buffer.from(media.data),
      mimeType: metadata.data.mimeType || 'image/png',
    };
  }
  const response = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    maxRedirects: 10,
    timeout: 30_000,
    maxContentLength: getCreativeLibraryConfig().maxDownloadSizeBytes,
  });
  return {
    buffer: Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data),
    mimeType: String(response.headers?.['content-type'] || 'image/png').split(';')[0],
  };
};

const extensionForMimeType = (mimeType) => {
  if (/jpe?g/i.test(mimeType)) return 'jpg';
  if (/webp/i.test(mimeType)) return 'webp';
  if (/gif/i.test(mimeType)) return 'gif';
  return 'png';
};

const persistReviewItemImage = async ({ imageUrl, batchId, batchFolderId, item, config }) => {
  const normalizedUrl = normalizeUrl(imageUrl) || (String(imageUrl).startsWith('data:image/') ? String(imageUrl) : '');
  if (!normalizedUrl) {
    throw new CreativeReviewError('Every review item requires a valid imageUrl.', 'REVIEW_IMAGE_REQUIRED');
  }
  const { buffer, mimeType } = await downloadReviewImage(normalizedUrl);
  if (buffer.byteLength > config.maxDownloadSizeBytes) {
    throw new CreativeReviewError('Review image exceeds the configured size limit.', 'REVIEW_IMAGE_TOO_LARGE');
  }
  const imageHash = hashBuffer(buffer);
  const resolution = await getImageResolutionFromBuffer(buffer);
  const imageResolution = formatResolution(resolution);
  const declaredAspectRatio = normalizeAspectRatio(item.ratio || item.aspectRatio || item.aspect_ratio) || '';
  const detectedAspectRatio = classifyAspectRatio(resolution) || '';
  const aspectRatio = resolveVerifiedReviewAspectRatio({
    declared: declaredAspectRatio,
    detected: detectedAspectRatio,
  });

  const family = item.familyId || item.creativeFamilyId || item.creative_family_id || 'creative';
  const ratio = aspectRatio || 'ratio';
  const variant = item.variantIndex ?? item.variant ?? '1';
  const fileName = `${sanitizeFileName(family)}_${sanitizeFileName(ratio)}_v${sanitizeFileName(variant)}.${extensionForMimeType(mimeType)}`;
  // Always snapshot the exact reviewed bytes into the batch folder, even when
  // the source is another Drive file. The source owner can then replace or
  // remove their file without silently changing what the client approved.
  const upload = await uploadReviewBuffer(buffer, fileName, mimeType, batchFolderId);
  return {
    // Keep review assets private. The portal loads them through the authenticated
    // image-preview endpoint, which downloads with the server's Drive identity.
    imageUrl: `https://drive.google.com/file/d/${upload.fileId}/view`,
    driveFileId: upload.fileId,
    imageHash,
    imageResolution,
    aspectRatio,
  };
};

const mapWithBoundedConcurrency = async (values, limit, mapper) => {
  const results = new Array(values.length);
  let nextIndex = 0;
  let firstError = null;
  const workerCount = Math.min(values.length, Math.max(1, limit));
  const workers = Array.from({ length: workerCount }, async () => {
    while (!firstError) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      try {
        results[index] = await mapper(values[index], index);
      } catch (error) {
        firstError ||= error;
      }
    }
  });
  // Wait for every in-flight Drive operation to settle before releasing the
  // per-spreadsheet lock. No additional item is started after the first error.
  await Promise.all(workers);
  if (firstError) throw firstError;
  return results;
};

export const registerReviewItems = async (input = {}) => {
  const remote = await runReviewWriterMutation('registerReviewItems', input);
  if (remote) return remote;
  const { args, config, spreadsheetId } = resolveSpreadsheetContext(input);
  const batchId = getBatchId(args);
  const inputItems = Array.isArray(args.items) ? args.items : [];
  if (!batchId) throw new CreativeReviewError('batchId is required.', 'REVIEW_BATCH_ID_REQUIRED');
  if (!inputItems.length) throw new CreativeReviewError('items must contain at least one creative.', 'REVIEW_ITEMS_REQUIRED');

  return withReviewLock(spreadsheetId, async () => {
    const sheets = await getReviewSheetsClient();
    const { batches, items: storedRows } = await readReviewRows(sheets, spreadsheetId);
    let batch = assertBatch(findBatch(batches, batchId), batchId);
    if (!['draft', 'in_review'].includes(clean(batch.status).toLowerCase())) {
      throw new CreativeReviewError(
        `Items cannot be registered while batch ${batchId} is ${batch.status}.`,
        'REVIEW_BATCH_LOCKED',
        409,
      );
    }
    const timestamp = nowIso();
    const storedItems = storedRows.map(hydrateItem);
    const batchItems = getBatchItems(storedItems, batchId);
    const lineageItems = [...storedItems];
    const batchStatusById = new Map(
      batches.map((candidate) => [candidate.review_batch_id, clean(candidate.status).toLowerCase()]),
    );
    const superseded = [];
    const appended = [];

    // Resolve the batch folder once, then snapshot independent assets with
    // bounded concurrency. A legacy import can contain hundreds of cells; doing
    // two folder lookups plus download/upload serially for each one makes the
    // request unnecessarily slow and prone to proxy timeouts.
    const root = await findReviewDriveFolder('Creative Reviews', config.driveRootFolderId);
    const batchFolder = await findReviewDriveFolder(batchId, root.folderId);
    const configuredConcurrency = cleanInteger(process.env.CREATIVE_REVIEW_IMAGE_CONCURRENCY, 4);
    const imageConcurrency = Math.min(8, Math.max(1, configuredConcurrency));
    const persistedItems = await mapWithBoundedConcurrency(
      inputItems,
      imageConcurrency,
      async (inputItem) => ({
        inputItem,
        image: await persistReviewItemImage({
          imageUrl: inputItem.imageUrl || inputItem.image_url || inputItem.url,
          batchId,
          batchFolderId: batchFolder.folderId,
          item: inputItem,
          config,
        }),
      }),
    );

    for (const { inputItem, image } of persistedItems) {
      const requestedItemId = clean(inputItem.itemId || inputItem.reviewItemId || inputItem.review_item_id);
      const existingByRequestedId = requestedItemId
        ? batchItems.find((candidate) => candidate.review_item_id === requestedItemId)
        : null;
      if (existingByRequestedId) {
        if (existingByRequestedId.image_hash === image.imageHash) {
          appended.push(existingByRequestedId);
          continue;
        }
        throw new CreativeReviewError(
          `Review item ${requestedItemId} already exists with different image content.`,
          'REVIEW_ITEM_EXISTS',
          409,
        );
      }
      const sourceSheetId = clean(
        inputItem.sourceSpreadsheetId || inputItem.source_sheet_id || batch.source_sheet_id || spreadsheetId,
      );
      const sourceTab = clean(inputItem.sourceTab || inputItem.sheetName || inputItem.source_tab || batch.source_tab);
      const sourceRow = clean(inputItem.sourceRowNumber ?? inputItem.sourceRow ?? inputItem.source_row);
      const sourceCell = clean(inputItem.sourceCell || inputItem.source_cell);
      const sourceOutput = clean(inputItem.sourceOutput || inputItem.source_output);
      const familyId = clean(inputItem.familyId || inputItem.creativeFamilyId || inputItem.creative_family_id)
        || createReviewId('family');
      const suppliedGenerationId = clean(
        inputItem.generationId || inputItem.generation_id || inputItem.registrationKey || inputItem.registration_key,
      );
      if (!suppliedGenerationId && !requestedItemId) {
        throw new CreativeReviewError(
          'Every review item requires a stable generationId or reviewItemId for idempotent registration.',
          'REVIEW_GENERATION_ID_REQUIRED',
          400,
        );
      }
      const generationId = suppliedGenerationId || `item:${requestedItemId}`;
      const requestedCreativeVersion = Math.max(
        1,
        cleanInteger(inputItem.creativeVersion ?? inputItem.creative_version ?? inputItem.version, 1),
      );
      const registrationPlan = planReviewItemRegistration(lineageItems, {
        review_batch_id: batchId,
        source_sheet_id: sourceSheetId,
        source_tab: sourceTab,
        source_cell: sourceCell,
        source_output: sourceOutput,
        creative_family_id: familyId,
        aspect_ratio: image.aspectRatio,
        variant: inputItem.variantIndex ?? inputItem.variant,
        image_hash: image.imageHash,
        generation_id: generationId,
      }, {
        requestedCreativeVersion,
        now: timestamp,
        // Preserve terminal audit history, but invalidate the same source cell
        // in any other draft/in-review batch so old and new bytes cannot both
        // be approved and published.
        canSupersede: (candidate) => ['draft', 'in_review'].includes(
          batchStatusById.get(candidate.review_batch_id),
        ),
      });
      const { sourceKey: identity, previousVersions } = registrationPlan;
      if (registrationPlan.sameImage) {
        appended.push(registrationPlan.sameImage);
        continue;
      }
      if (previousVersions.some((candidate) => !candidate.__rowNumber)) {
        throw new CreativeReviewError(
          `The request contains more than one creative for source ${identity}.`,
          'DUPLICATE_REVIEW_ITEM_SOURCE',
          409,
        );
      }
      superseded.push(...registrationPlan.superseded);
      const creativeVersion = registrationPlan.creativeVersion;
      const imported = args.allowImportedDecision
        ? normalizeImportedReviewDecision({
            decision: inputItem.decision,
            feedback: inputItem.feedback || inputItem.reason,
            reviewerName: inputItem.reviewerName || args.reviewerName,
            reviewerEmail: inputItem.reviewerEmail || args.reviewerEmail,
            now: timestamp,
          })
        : normalizeImportedReviewDecision({ decision: 'pending', now: timestamp });
      const item = prepareItemForWrite({
        review_item_id: requestedItemId || createReviewId('item'),
        review_batch_id: batchId,
        creative_family_id: familyId,
        creative_version: creativeVersion,
        generation_id: generationId,
        version: 1,
        aspect_ratio: image.aspectRatio,
        variant: clean(inputItem.variantIndex ?? inputItem.variant),
        reference_url: normalizeUrl(inputItem.referenceUrl || inputItem.reference_url) || '',
        image_url: image.imageUrl,
        drive_file_id: image.driveFileId,
        image_hash: image.imageHash,
        category: clean(inputItem.category || batch.metadata?.category || parseJson(batch.metadata_json).category),
        plazas: clean(inputItem.plazas || batch.metadata?.plazas || parseJson(batch.metadata_json).plazas),
        decision: imported.decision,
        feedback: imported.feedback,
        reviewer_name: imported.reviewer_name,
        reviewer_email: imported.reviewer_email,
        decided_at: imported.decided_at,
        publication_status: 'not_published',
        creative_id: '',
        publication_error: '',
        published_at: '',
        source_sheet_id: sourceSheetId,
        source_tab: sourceTab,
        source_row: sourceRow,
        source_cell: sourceCell,
        source_output: sourceOutput,
        created_at: timestamp,
        updated_at: timestamp,
        superseded_at: '',
        metadata: {
          ...(inputItem.metadata || {}),
          imageResolution: image.imageResolution,
        },
      });
      appended.push(hydrateItem(item));
      batchItems.push(hydrateItem(item));
      lineageItems.push(hydrateItem(item));
    }

    await updateRows(
      sheets,
      spreadsheetId,
      CREATIVE_REVIEW_ITEMS_SHEET,
      CREATIVE_REVIEW_ITEM_HEADERS,
      superseded.map(prepareItemForWrite),
    );
    const newRows = appended.filter((item) => !item.__rowNumber);
    await appendRows(
      sheets,
      spreadsheetId,
      CREATIVE_REVIEW_ITEMS_SHEET,
      CREATIVE_REVIEW_ITEM_HEADERS,
      newRows.map(prepareItemForWrite),
    );
    const allBatchItems = batchItems.map((item) =>
      superseded.find((candidate) => candidate.review_item_id === item.review_item_id) || item,
    );
    const allLineageItems = lineageItems.map((item) =>
      superseded.find((candidate) => candidate.review_item_id === item.review_item_id) || item,
    );
    batch = updateBatchSummary(batch, allBatchItems, timestamp);
    batch.version = Math.max(1, cleanInteger(batch.version, 1)) + 1;
    const batchPatches = [{
      rowNumber: batch.__rowNumber,
      patch: {
        updated_at: batch.updated_at,
        version: batch.version,
        item_count: batch.item_count,
        approved_count: batch.approved_count,
        rejected_count: batch.rejected_count,
        pending_count: batch.pending_count,
      },
    }];
    const supersededBatchIds = [...new Set(
      superseded
        .map((item) => item.review_batch_id)
        .filter((candidateBatchId) => candidateBatchId && candidateBatchId !== batchId),
    )];
    const supersededBatches = [];
    for (const supersededBatchId of supersededBatchIds) {
      const previousBatch = findBatch(batches, supersededBatchId);
      if (!previousBatch) continue;
      const previousItems = getBatchItems(allLineageItems, supersededBatchId);
      const reconciled = updateBatchSummary(previousBatch, previousItems, timestamp);
      reconciled.version = Math.max(1, cleanInteger(previousBatch.version, 1)) + 1;
      supersededBatches.push({ batch: reconciled, items: previousItems });
      batchPatches.push({
        rowNumber: reconciled.__rowNumber,
        patch: {
          updated_at: reconciled.updated_at,
          version: reconciled.version,
          item_count: reconciled.item_count,
          approved_count: reconciled.approved_count,
          rejected_count: reconciled.rejected_count,
          pending_count: reconciled.pending_count,
        },
      });
    }
    await updateRowPatches(
      sheets,
      spreadsheetId,
      CREATIVE_REVIEW_BATCHES_SHEET,
      CREATIVE_REVIEW_BATCH_HEADERS,
      batchPatches,
    );
    const mirrorWarnings = [];
    for (const previous of supersededBatches) {
      mirrorWarnings.push(...await mirrorSourceDecisions({
        spreadsheetId,
        batchId: previous.batch.review_batch_id,
        batchStatus: previous.batch.status,
        updatedItems: previous.items,
        allItems: previous.items,
        config,
      }));
    }
    mirrorWarnings.push(...await mirrorSourceDecisions({
      spreadsheetId,
      batchId,
      batchStatus: batch.status,
      updatedItems: allBatchItems,
      allItems: allBatchItems,
      config,
    }));
    return {
      batch: hydrateBatch(batch, spreadsheetId),
      items: appended.map(hydrateItem),
      supersededItemIds: superseded.map((item) => item.review_item_id),
      warnings: mirrorWarnings,
    };
  });
};

const assertBatchReadyForReview = (items, batch, config) => {
  const batchId = batch.review_batch_id;
  const active = items.filter((item) => item.decision !== 'superseded');
  if (!active.length) {
    throw new CreativeReviewError(`Review batch ${batchId} has no creatives.`, 'REVIEW_BATCH_EMPTY');
  }
  const batchMetadata = parseJson(batch.metadata_json);
  const expectedItemCount = cleanInteger(
    batchMetadata.expectedItemCount ?? batchMetadata.expected_item_count,
    0,
  );
  if (expectedItemCount > 0 && active.length !== expectedItemCount) {
    throw new CreativeReviewError(
      `Review batch ${batchId} expected ${expectedItemCount} creatives but has ${active.length}.`,
      'REVIEW_BATCH_PARTIAL',
      409,
      { expectedItemCount, actualItemCount: active.length },
    );
  }
  const allowedCategories = new Set((config.categories || []).map((category) => clean(category).toLowerCase()));
  const invalidCategories = active.filter((item) => !allowedCategories.has(clean(item.category).toLowerCase()));
  if (invalidCategories.length) {
    throw new CreativeReviewError(
      `Review batch ${batchId} contains noncanonical categories.`,
      'REVIEW_CATEGORY_INVALID',
      400,
      {
        itemIds: invalidCategories.map((item) => item.review_item_id),
        allowedCategories: config.categories || [],
      },
    );
  }
  const invalid = active.filter((item) =>
    !item.image_url || !item.aspect_ratio || !item.creative_family_id || !item.variant || !item.category || !item.plazas,
  );
  if (invalid.length) {
    throw new CreativeReviewError(
      `Review batch ${batchId} has ${invalid.length} incomplete creative(s).`,
      'REVIEW_BATCH_INCOMPLETE',
      400,
      {
        itemIds: invalid.map((item) => item.review_item_id),
        requiredFields: ['image_url', 'aspect_ratio', 'creative_family_id', 'variant', 'category', 'plazas'],
      },
    );
  }
};

const buildReviewUrl = (baseUrl, token) => {
  const configured = clean(baseUrl);
  if (!configured) return `/review#token=${encodeURIComponent(token)}`;
  const url = new URL(configured);
  if (!/\/review\/?$/.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/review`;
  }
  url.search = '';
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
};

export const issueReviewLink = async (input = {}) => {
  const remote = await runReviewWriterMutation('issueReviewLink', input);
  if (remote) return remote;
  const { args, config, spreadsheetId, sheetsUrl } = resolveSpreadsheetContext(input);
  const batchId = getBatchId(args);
  if (!batchId) throw new CreativeReviewError('batchId is required.', 'REVIEW_BATCH_ID_REQUIRED');
  return withReviewLock(spreadsheetId, async () => {
    const sheets = await getReviewSheetsClient();
    const { batches, items } = await readReviewRows(sheets, spreadsheetId);
    let batch = assertBatch(findBatch(batches, batchId), batchId);
    const batchItems = getBatchItems(items, batchId).map(hydrateItem);
    assertBatchReadyForReview(batchItems, batch, config);
    if (!['draft', 'in_review'].includes(clean(batch.status).toLowerCase())) {
      throw new CreativeReviewError(`Review link cannot be issued while batch is ${batch.status}.`, 'REVIEW_BATCH_LOCKED', 409);
    }
    const token = createReviewToken(spreadsheetId);
    const timestamp = nowIso();
    batch = clean(batch.status).toLowerCase() === 'draft'
      ? transitionReviewBatch(batch, 'in_review', timestamp)
      : { ...batch, version: cleanInteger(batch.version, 1) + 1, updated_at: timestamp };
    batch.token_hash = hashReviewToken(token);
    batch.issued_at = timestamp;
    batch.expires_at = getReviewExpiry(timestamp, args.expiresInDays || args.ttlDays || config.reviewLinkDays);
    batch.revoked_at = '';
    await updateRowPatches(
      sheets,
      spreadsheetId,
      CREATIVE_REVIEW_BATCHES_SHEET,
      CREATIVE_REVIEW_BATCH_HEADERS,
      [{
        rowNumber: batch.__rowNumber,
        patch: {
          status: batch.status,
          updated_at: batch.updated_at,
          issued_at: batch.issued_at,
          version: batch.version,
          token_hash: batch.token_hash,
          expires_at: batch.expires_at,
          revoked_at: batch.revoked_at,
        },
      }],
    );
    const mirrorWarnings = await mirrorSourceDecisions({
      spreadsheetId,
      batchId,
      batchStatus: batch.status,
      updatedItems: batchItems,
      allItems: batchItems,
      config,
    });
    return {
      batchId,
      reviewBatchId: batchId,
      sheetsUrl,
      token,
      reviewUrl: buildReviewUrl(args.baseUrl || config.reviewBaseUrl, token),
      privateUrl: buildReviewUrl(args.baseUrl || config.reviewBaseUrl, token),
      expiresAt: batch.expires_at,
      batch: hydrateBatch(batch, spreadsheetId),
      warnings: mirrorWarnings,
    };
  });
};

export const revokeReviewBatch = async (input = {}) => {
  const remote = await runReviewWriterMutation('revokeReviewBatch', input);
  if (remote) return remote;
  const { args, config, spreadsheetId } = resolveSpreadsheetContext(input);
  const batchId = getBatchId(args);
  if (!batchId) throw new CreativeReviewError('batchId is required.', 'REVIEW_BATCH_ID_REQUIRED');
  return withReviewLock(spreadsheetId, async () => {
    const sheets = await getReviewSheetsClient();
    const { batches, items } = await readReviewRows(sheets, spreadsheetId);
    let batch = assertBatch(findBatch(batches, batchId), batchId);
    if (batch.status !== 'revoked') batch = transitionReviewBatch(batch, 'revoked');
    batch.token_hash = '';
    batch.expires_at = '';
    await updateRowPatches(
      sheets,
      spreadsheetId,
      CREATIVE_REVIEW_BATCHES_SHEET,
      CREATIVE_REVIEW_BATCH_HEADERS,
      [{
        rowNumber: batch.__rowNumber,
        patch: {
          status: batch.status,
          updated_at: batch.updated_at,
          version: batch.version,
          token_hash: batch.token_hash,
          expires_at: batch.expires_at,
          revoked_at: batch.revoked_at,
        },
      }],
    );
    const batchItems = getBatchItems(items, batchId).map(hydrateItem);
    const mirrorWarnings = await mirrorSourceDecisions({
      spreadsheetId,
      batchId,
      batchStatus: batch.status,
      updatedItems: batchItems,
      allItems: batchItems,
      config,
    });
    return { ...hydrateBatch(batch, spreadsheetId), warnings: mirrorWarnings };
  });
};

const loadTokenBatch = async (token) => {
  const parsed = parseReviewToken(token);
  const sheets = await getReviewSheetsClient();
  // Public token validation is strictly read-only. Never create or migrate
  // tabs based on an unauthenticated spreadsheet id embedded in a token.
  let batches;
  let items;
  try {
    ({ batches, items } = await readExistingReviewRows(sheets, parsed.spreadsheetId));
  } catch (error) {
    if (error instanceof CreativeReviewError) throw error;
    throw new CreativeReviewError('Review link is invalid.', 'REVIEW_TOKEN_INVALID', 401);
  }
  const batch = batches.find((candidate) => candidate.token_hash === parsed.tokenHash);
  if (!batch) throw new CreativeReviewError('Review link is invalid or revoked.', 'REVIEW_TOKEN_INVALID', 401);
  const expiry = Date.parse(batch.expires_at || '');
  if (Number.isFinite(expiry) && expiry <= Date.now()) {
    throw new CreativeReviewError('Review link has expired.', 'REVIEW_TOKEN_EXPIRED', 410);
  }
  if (!isReviewLinkActive(batch, token)) {
    throw new CreativeReviewError('Review link is not active.', 'REVIEW_TOKEN_INACTIVE', 403);
  }
  return { sheets, spreadsheetId: parsed.spreadsheetId, batch, items: getBatchItems(items, batch.review_batch_id) };
};

export const exchangeReviewToken = async (input = {}) => {
  const args = typeof input === 'string' ? { token: input } : input || {};
  const token = clean(args.token || args.reviewToken || args.sessionToken);
  if (!token) throw new CreativeReviewError('token is required.', 'REVIEW_TOKEN_REQUIRED', 401);
  const initial = await loadTokenBatch(token);
  return withReviewLock(initial.spreadsheetId, async () => {
    // Re-read after acquiring the mutation lock. This prevents a concurrent
    // finalize from being overwritten by a stale in_review batch snapshot.
    const loaded = await loadTokenBatch(token);
    if (!loaded.batch.review_started_at && loaded.batch.status === 'in_review') {
      loaded.batch.review_started_at = nowIso();
      loaded.batch.updated_at = loaded.batch.review_started_at;
      loaded.batch.version = Math.max(1, cleanInteger(loaded.batch.version, 1)) + 1;
      await updateRowPatches(
        loaded.sheets,
        loaded.spreadsheetId,
        CREATIVE_REVIEW_BATCHES_SHEET,
        CREATIVE_REVIEW_BATCH_HEADERS,
        [{
          rowNumber: loaded.batch.__rowNumber,
          patch: {
            review_started_at: loaded.batch.review_started_at,
            updated_at: loaded.batch.updated_at,
            version: loaded.batch.version,
          },
        }],
      );
    }
    return {
      spreadsheetId: loaded.spreadsheetId,
      batchId: loaded.batch.review_batch_id,
      reviewBatchId: loaded.batch.review_batch_id,
      sessionToken: token,
      cookieToken: token,
      expiresAt: loaded.batch.expires_at,
      maxAgeMs: Math.max(0, Date.parse(loaded.batch.expires_at) - Date.now()),
    };
  });
};

const sanitizePublicBatch = (batch, spreadsheetId) => {
  const hydrated = hydrateBatch(batch, spreadsheetId);
  return {
    review_batch_id: hydrated.review_batch_id,
    batchId: hydrated.batchId,
    reviewBatchId: hydrated.reviewBatchId,
    title: hydrated.title,
    source_type: hydrated.source_type,
    sourceType: hydrated.sourceType,
    status: hydrated.status,
    category: hydrated.category,
    plazas: hydrated.plazas,
    plaza: hydrated.plaza,
    reviewer_name: hydrated.reviewer_name,
    expires_at: hydrated.expires_at,
    created_at: hydrated.created_at,
    updated_at: hydrated.updated_at,
    issued_at: hydrated.issued_at,
    finalized_at: hydrated.finalized_at,
    published_at: hydrated.published_at,
    version: hydrated.version,
    item_count: hydrated.item_count,
    approved_count: hydrated.approved_count,
    rejected_count: hydrated.rejected_count,
    pending_count: hydrated.pending_count,
  };
};

const sanitizePublicItem = (item) => {
  const hydrated = hydrateItem(item);
  return {
    review_item_id: hydrated.review_item_id,
    reviewItemId: hydrated.reviewItemId,
    itemId: hydrated.itemId,
    review_batch_id: hydrated.review_batch_id,
    batchId: hydrated.batchId,
    creative_family_id: hydrated.creative_family_id,
    familyId: hydrated.familyId,
    creative_version: hydrated.creative_version,
    version: hydrated.version,
    aspect_ratio: hydrated.aspect_ratio,
    ratio: hydrated.ratio,
    variant: hydrated.variant,
    reference_url: hydrated.reference_url,
    referenceUrl: hydrated.referenceUrl,
    image_url: hydrated.image_url,
    imageUrl: hydrated.imageUrl,
    category: hydrated.category,
    plazas: hydrated.plazas,
    decision: hydrated.decision,
    feedback: hydrated.feedback,
    reviewer_name: hydrated.reviewer_name,
    decided_at: hydrated.decided_at,
    publication_status: hydrated.publication_status,
    creative_id: hydrated.creative_id,
    created_at: hydrated.created_at,
    updated_at: hydrated.updated_at,
  };
};

export const getPublicReviewBatch = async (input = {}) => {
  const args = typeof input === 'string' ? { token: input } : input || {};
  const token = clean(args.token || args.reviewToken || args.sessionToken || args.cookieToken);
  if (!token) throw new CreativeReviewError('token is required.', 'REVIEW_TOKEN_REQUIRED', 401);
  const { spreadsheetId, batch, items } = await loadTokenBatch(token);
  const publicItems = items.filter((item) => item.decision !== 'superseded').map(sanitizePublicItem);
  return {
    ...sanitizePublicBatch(updateBatchSummary(batch, publicItems), spreadsheetId),
    items: publicItems,
    summary: summarizeReviewItems(publicItems),
    warnings: buildPartialFamilyWarnings(publicItems),
    locked: batch.status !== 'in_review',
  };
};

const parseCellAddress = (address) => {
  const match = clean(address).replace(/\$/g, '').match(/^([A-Za-z]+)(\d+)$/);
  if (!match) return null;
  let columnIndex = 0;
  for (const character of match[1].toUpperCase()) {
    columnIndex = columnIndex * 26 + character.charCodeAt(0) - 64;
  }
  return { columnIndex: columnIndex - 1, rowIndex: Number(match[2]) - 1, rowNumber: Number(match[2]) };
};

const hexToGoogleColor = (hex, fallback) => {
  const match = clean(hex).replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!match) return fallback;
  return {
    red: Number.parseInt(match[1], 16) / 255,
    green: Number.parseInt(match[2], 16) / 255,
    blue: Number.parseInt(match[3], 16) / 255,
  };
};

const replaceReviewFeedbackLine = (existing, batchId, nextLine) => {
  const prefix = `[Creative review ${batchId}]`;
  const lines = String(existing || '').split(/\r?\n/).filter((line) => !line.startsWith(prefix));
  if (nextLine) lines.push(`${prefix} ${nextLine}`);
  return lines.filter(Boolean).join('\n');
};

const mirrorSourceDecisions = async ({
  spreadsheetId,
  batchId,
  batchStatus = 'in_review',
  updatedItems,
  allItems,
  config,
}) => {
  const warnings = [];
  const grouped = new Map();
  for (const item of updatedItems) {
    const sourceSpreadsheetId = clean(item.source_sheet_id || spreadsheetId);
    const tab = clean(item.source_tab);
    const cell = parseCellAddress(item.source_cell);
    if (!sourceSpreadsheetId || !tab || !cell) continue;
    const key = `${sourceSpreadsheetId}::${tab}`;
    if (!grouped.has(key)) grouped.set(key, { sourceSpreadsheetId, tab, entries: [] });
    grouped.get(key).entries.push({ item, cell });
  }

  for (const group of grouped.values()) {
    try {
      const sheets = await getReviewSheetsClient();
      const metadata = await getSheetMetadata(sheets, group.sourceSpreadsheetId);
      const sourceSheet = metadata.find((sheet) => sheet.properties?.title === group.tab);
      if (!sourceSheet) throw new Error(`Source tab "${group.tab}" was not found.`);
      const approvedColor = hexToGoogleColor(config.acceptedColor, { red: 0, green: 1, blue: 0 });
      const rejectedColor = hexToGoogleColor(config.rejectedColor, { red: 1, green: 0, blue: 0 });
      const white = { red: 1, green: 1, blue: 1 };
      const requests = [];
      for (const { item, cell } of group.entries) {
        const color = item.decision === 'approved'
          ? approvedColor
          : item.decision === 'rejected'
            ? rejectedColor
            : white;
        const range = {
          sheetId: sourceSheet.properties.sheetId,
          startRowIndex: cell.rowIndex,
          endRowIndex: cell.rowIndex + 1,
          startColumnIndex: cell.columnIndex,
          endColumnIndex: cell.columnIndex + 1,
        };
        requests.push(item.decision === 'pending'
          ? {
              repeatCell: {
                range,
                cell: { userEnteredFormat: {} },
                fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.backgroundColorStyle',
              },
            }
          : {
              repeatCell: {
                range,
                cell: { userEnteredFormat: { backgroundColorStyle: { rgbColor: color } } },
                fields: 'userEnteredFormat.backgroundColorStyle',
              },
            });
        requests.push({
          updateCells: {
            range,
            rows: [{ values: [{ note: item.decision === 'rejected'
              ? `${item.feedback} · Review ${batchId}`
              : item.decision === 'approved'
                ? `Approved by client · Review ${batchId}`
                : `Pending client review · Review ${batchId}` }] }],
            fields: 'note',
          },
        });
      }
      if (requests.length) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: group.sourceSpreadsheetId,
          requestBody: { requests },
        });
      }

      const headerResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: group.sourceSpreadsheetId,
        range: buildRange(group.tab, 'A1:ZZ20'),
        valueRenderOption: 'FORMULA',
      });
      const headerRows = headerResponse.data.values || [];
      let feedbackColumn = -1;
      let headerRowIndex = 0;
      let bestHeaderScore = -1;
      for (let index = 0; index < headerRows.length; index += 1) {
        const row = headerRows[index] || [];
        const score = row.reduce((total, value) => {
          const header = normalizeHeader(value);
          if (!header) return total;
          return total + 1 + (/image|imagen|creative|creativo|1:1|9:16|16[.:]9|1[.,]91/.test(header) ? 3 : 0);
        }, 0);
        if (score > bestHeaderScore) {
          bestHeaderScore = score;
          headerRowIndex = index;
        }
        feedbackColumn = row.findIndex((value) =>
          ['review_feedback', 'feedback', 'notes', 'notas', 'comentarios'].includes(normalizeHeader(value)),
        );
        if (feedbackColumn >= 0) break;
      }
      if (feedbackColumn < 0) {
        const currentColumnCount = sourceSheet.properties?.gridProperties?.columnCount || 0;
        // Values API trims trailing blank/merged headers, so headerRow.length
        // is not a safe free column (it can point at an output variant). Append
        // one new grid column and use that exact index instead.
        feedbackColumn = currentColumnCount;
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: group.sourceSpreadsheetId,
          requestBody: {
            requests: [{
              appendDimension: {
                sheetId: sourceSheet.properties.sheetId,
                dimension: 'COLUMNS',
                length: 1,
              },
            }],
          },
        });
        const headerAddress = `${columnIndexToLetter(feedbackColumn)}${headerRowIndex + 1}`;
        await sheets.spreadsheets.values.update({
          spreadsheetId: group.sourceSpreadsheetId,
          range: buildRange(group.tab, headerAddress),
          valueInputOption: 'RAW',
          requestBody: { values: [['review_feedback']] },
        });
      }

      const affectedRows = [...new Set(group.entries.map((entry) => entry.cell.rowNumber))];
      const feedbackUpdates = [];
      for (const rowNumber of affectedRows) {
        const targetAddress = `${columnIndexToLetter(feedbackColumn)}${rowNumber}`;
        const current = await sheets.spreadsheets.values.get({
          spreadsheetId: group.sourceSpreadsheetId,
          range: buildRange(group.tab, targetAddress),
          valueRenderOption: 'FORMULA',
        });
        const rowItems = allItems.filter((item) =>
          item.decision !== 'superseded' &&
          clean(item.source_sheet_id || spreadsheetId) === group.sourceSpreadsheetId &&
          item.source_tab === group.tab &&
          cleanInteger(item.source_row || parseCellAddress(item.source_cell)?.rowNumber) === rowNumber,
        );
        const rejected = rowItems
          .filter((item) =>
            item.decision === 'rejected',
          )
          .map((item) => `${item.source_cell}: ${item.feedback}`);
        const counts = summarizeReviewItems(rowItems);
        const studioBaseUrl = clean(process.env.CREATIVE_REVIEW_STUDIO_BASE_URL || process.env.APP_BASE_URL);
        const internalQuery = new URLSearchParams({
          tab: 'review',
          sheetsUrl: canonicalSheetsUrl(group.sourceSpreadsheetId),
          batchId,
        }).toString();
        const internalLink = studioBaseUrl
          ? `${studioBaseUrl.replace(/\/$/, '')}/?${internalQuery}`
          : `?${internalQuery}`;
        const statusSummary = [
          `status=${batchStatus}`,
          `approved=${counts.approved}`,
          `rejected=${counts.rejected}`,
          `pending=${counts.pending}`,
          internalLink,
          rejected.length ? `feedback: ${rejected.join(' | ')}` : '',
        ].filter(Boolean).join(' · ');
        feedbackUpdates.push({
          range: buildRange(group.tab, targetAddress),
          values: [[replaceReviewFeedbackLine(current.data.values?.[0]?.[0], batchId, statusSummary)]],
        });
      }
      if (feedbackUpdates.length) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: group.sourceSpreadsheetId,
          requestBody: { valueInputOption: 'RAW', data: feedbackUpdates },
        });
      }
    } catch (error) {
      warnings.push({
        code: 'SOURCE_MIRROR_FAILED',
        spreadsheetId: group.sourceSpreadsheetId,
        sheetName: group.tab,
        message: error.message,
      });
    }
  }
  return warnings;
};

const resolveDecisionContext = async (input) => {
  const args = typeof input === 'string' ? { token: input } : input || {};
  const token = clean(args.token || args.reviewToken || args.sessionToken || args.cookieToken);
  if (token) {
    const loaded = await loadTokenBatch(token);
    return { ...loaded, args, config: getCreativeLibraryConfig(), token };
  }
  const context = resolveSpreadsheetContext(args);
  const sheets = await getReviewSheetsClient();
  const rows = await readReviewRows(sheets, context.spreadsheetId);
  const batchId = getBatchId(args);
  return {
    args,
    config: context.config,
    sheets,
    spreadsheetId: context.spreadsheetId,
    batch: assertBatch(findBatch(rows.batches, batchId), batchId),
    items: getBatchItems(rows.items, batchId),
    token: '',
  };
};

const startInternalReviewIfDraft = async ({ batch, sheets, spreadsheetId }) => {
  if (clean(batch.status).toLowerCase() !== 'draft') return batch;
  const timestamp = nowIso();
  const started = transitionReviewBatch(batch, 'in_review', timestamp);
  started.review_started_at = clean(started.review_started_at) || timestamp;
  await updateRowPatches(
    sheets,
    spreadsheetId,
    CREATIVE_REVIEW_BATCHES_SHEET,
    CREATIVE_REVIEW_BATCH_HEADERS,
    [{
      rowNumber: started.__rowNumber,
      patch: {
        status: started.status,
        updated_at: started.updated_at,
        issued_at: started.issued_at,
        review_started_at: started.review_started_at,
        version: started.version,
      },
    }],
  );
  return started;
};

export const saveReviewDecisions = async (input = {}) => {
  const remote = await runReviewWriterMutation('saveReviewDecisions', input);
  if (remote) return remote;
  const initial = await resolveDecisionContext(input);
  return withReviewLock(initial.spreadsheetId, async () => {
    // Re-read under the lock so optimistic version checks use current Sheet values.
    const context = initial.token
      ? await resolveDecisionContext({ ...initial.args, token: initial.token })
      : await resolveDecisionContext(initial.args);
    const { args, config, sheets, spreadsheetId } = context;
    let batch = context.batch;
    const batchStatus = clean(batch.status).toLowerCase();
    const canStartInternalDraft = !context.token && batchStatus === 'draft';
    if (batchStatus !== 'in_review' && !canStartInternalDraft) {
      throw new CreativeReviewError('This review is locked and no longer accepts decisions.', 'REVIEW_BATCH_LOCKED', 409);
    }
    const decisions = Array.isArray(args.decisions)
      ? args.decisions
      : args.itemId || args.reviewItemId
        ? [args]
        : [];
    const missingVersions = decisions.filter((decision) =>
      decision.expectedVersion === undefined &&
      decision.expected_version === undefined &&
      decision.version === undefined,
    );
    if (missingVersions.length) {
      throw new CreativeReviewError(
        'Every review decision requires the current item version.',
        'REVIEW_VERSION_REQUIRED',
        409,
        { itemIds: missingVersions.map((decision) => decision.reviewItemId || decision.itemId || '') },
      );
    }
    const hydratedItems = context.items.map(hydrateItem);
    const applied = applyReviewDecisions(hydratedItems, decisions, {
      reviewerName: args.reviewerName,
      reviewerEmail: args.reviewerEmail,
      // Only the internal (token-less) Studio surface may discard a piece.
      // The public client portal can approve or reject, never supersede.
      allowSuperseded: !context.token,
    });
    if (canStartInternalDraft) {
      // Studio can begin reviewing an imported draft without minting a public
      // token. Validation above runs first, so an invalid decision never changes
      // the batch lifecycle.
      batch = await startInternalReviewIfDraft({ batch, sheets, spreadsheetId });
    }
    await updateRowPatches(
      sheets,
      spreadsheetId,
      CREATIVE_REVIEW_ITEMS_SHEET,
      CREATIVE_REVIEW_ITEM_HEADERS,
      applied.updated.map((item) => ({
        rowNumber: item.__rowNumber,
        patch: {
          decision: item.decision,
          feedback: item.feedback,
          reviewer_name: item.reviewer_name,
          reviewer_email: item.reviewer_email,
          decided_at: item.decided_at,
          updated_at: item.updated_at,
          version: item.version,
        },
      })),
    );
    const timestamp = nowIso();
    const requestedReviewerName = clean(args.reviewerName);
    const requestedReviewerEmail = clean(args.reviewerEmail);
    const reviewerChanged = (
      (requestedReviewerName && requestedReviewerName !== clean(batch.reviewer_name))
      || (requestedReviewerEmail && requestedReviewerEmail !== clean(batch.reviewer_email))
    );
    const desiredSummary = summarizeReviewItems(applied.items);
    const summaryChanged = (
      cleanInteger(batch.item_count) !== desiredSummary.total
      || cleanInteger(batch.approved_count) !== desiredSummary.approved
      || cleanInteger(batch.rejected_count) !== desiredSummary.rejected
      || cleanInteger(batch.pending_count) !== desiredSummary.pending
    );
    let updatedBatch = batch;
    if (applied.updated.length || reviewerChanged || summaryChanged) {
      updatedBatch = updateBatchSummary(batch, applied.items, timestamp);
      updatedBatch.reviewer_name = requestedReviewerName || clean(updatedBatch.reviewer_name);
      updatedBatch.reviewer_email = requestedReviewerEmail || clean(updatedBatch.reviewer_email);
      updatedBatch.version = Math.max(1, cleanInteger(updatedBatch.version, 1)) + 1;
      await updateRowPatches(
        sheets,
        spreadsheetId,
        CREATIVE_REVIEW_BATCHES_SHEET,
        CREATIVE_REVIEW_BATCH_HEADERS,
        [{
          rowNumber: updatedBatch.__rowNumber,
          patch: {
            updated_at: updatedBatch.updated_at,
            reviewer_name: updatedBatch.reviewer_name,
            reviewer_email: updatedBatch.reviewer_email,
            version: updatedBatch.version,
            item_count: updatedBatch.item_count,
            approved_count: updatedBatch.approved_count,
            rejected_count: updatedBatch.rejected_count,
            pending_count: updatedBatch.pending_count,
          },
        }],
      );
    }
    // Re-mirror idempotent retries too. The item write may have succeeded while
    // a later Sheet color/summary write failed on the original request.
    const responseItems = [...applied.updated, ...applied.unchanged];
    const mirrorWarnings = await mirrorSourceDecisions({
      spreadsheetId,
      batchId: batch.review_batch_id,
      batchStatus: batch.status,
      updatedItems: responseItems,
      allItems: applied.items,
      config,
    });
    const publicWarnings = [...buildPartialFamilyWarnings(applied.items), ...mirrorWarnings]
      .map((warning) => ({ code: warning.code, message: warning.message }));
    // Include idempotent (unchanged) decisions in the response. A client may be
    // retrying after the first response was lost; returning the current item
    // version lets it continue editing without an artificial 409 conflict.
    return {
      batch: context.token
        ? sanitizePublicBatch(updatedBatch, spreadsheetId)
        : hydrateBatch(updatedBatch, spreadsheetId),
      items: responseItems.map(sanitizePublicItem),
      summary: applied.summary,
      warnings: context.token
        ? publicWarnings
        : [...buildPartialFamilyWarnings(applied.items), ...mirrorWarnings],
    };
  });
};

// Studio-only: reclassifies every active (non-superseded) item in a family at
// once, since category/plazas are chosen per source row (= per family), not
// per individual ratio/variant. Never exposed on the public client portal.
export const saveReviewItemMetadata = async (input = {}) => {
  const remote = await runReviewWriterMutation('saveReviewItemMetadata', input);
  if (remote) return remote;
  const { args, config, spreadsheetId } = resolveSpreadsheetContext(input);
  const batchId = getBatchId(args);
  if (!batchId) throw new CreativeReviewError('batchId is required.', 'REVIEW_BATCH_ID_REQUIRED');
  const familyId = clean(args.familyId || args.family_id);
  if (!familyId) throw new CreativeReviewError('familyId is required.', 'REVIEW_FAMILY_ID_REQUIRED', 400);

  const allowedCategories = new Map(
    (config.categories || []).map((value) => [clean(value).toLowerCase(), value]),
  );
  const canonicalCategory = allowedCategories.get(clean(args.category).toLowerCase());
  if (!canonicalCategory) {
    throw new CreativeReviewError(
      `Category must be one of: ${(config.categories || []).join(', ')}.`,
      'REVIEW_CATEGORY_INVALID',
      400,
      { allowedCategories: config.categories || [] },
    );
  }
  const plazas = clean(Array.isArray(args.plazas) ? args.plazas.join(',') : args.plazas);
  if (!plazas) throw new CreativeReviewError('plazas is required.', 'REVIEW_PLAZAS_REQUIRED', 400);

  return withReviewLock(spreadsheetId, async () => {
    const sheets = await getReviewSheetsClient();
    const { batches, items } = await readReviewRows(sheets, spreadsheetId);
    let batch = assertBatch(findBatch(batches, batchId), batchId);
    const batchStatus = clean(batch.status).toLowerCase();
    if (!['draft', 'in_review'].includes(batchStatus)) {
      throw new CreativeReviewError('This review is locked and no longer accepts edits.', 'REVIEW_BATCH_LOCKED', 409);
    }

    const batchItems = getBatchItems(items, batchId).map(hydrateItem);
    const familyItems = batchItems.filter((item) =>
      item.creative_family_id === familyId && item.decision !== 'superseded');
    if (!familyItems.length) {
      throw new CreativeReviewError(`Family ${familyId} was not found in this batch.`, 'REVIEW_FAMILY_NOT_FOUND', 404);
    }

    const timestamp = nowIso();
    const updated = familyItems.map((item) => ({
      ...item,
      category: canonicalCategory,
      plazas,
      version: Math.max(1, cleanInteger(item.version, 1)) + 1,
      updated_at: timestamp,
    }));
    await updateRowPatches(
      sheets,
      spreadsheetId,
      CREATIVE_REVIEW_ITEMS_SHEET,
      CREATIVE_REVIEW_ITEM_HEADERS,
      updated.map((item) => ({
        rowNumber: item.__rowNumber,
        patch: {
          category: item.category,
          plazas: item.plazas,
          version: item.version,
          updated_at: item.updated_at,
        },
      })),
    );

    const updatedById = new Map(updated.map((item) => [item.review_item_id, item]));
    const allBatchItems = batchItems.map((item) => updatedById.get(item.review_item_id) || item);
    batch = updateBatchSummary(batch, allBatchItems, timestamp);
    batch.version = Math.max(1, cleanInteger(batch.version, 1)) + 1;
    await updateRowPatches(
      sheets,
      spreadsheetId,
      CREATIVE_REVIEW_BATCHES_SHEET,
      CREATIVE_REVIEW_BATCH_HEADERS,
      [{
        rowNumber: batch.__rowNumber,
        patch: { updated_at: batch.updated_at, version: batch.version },
      }],
    );

    return {
      batch: hydrateBatch(batch, spreadsheetId),
      items: updated.map(hydrateItem),
    };
  });
};

const publishApprovedItems = async ({ sheets, spreadsheetId, batch, items }) => {
  const results = [];
  const nextItems = [...items];
  const publicationPlan = planReviewPublication(nextItems);
  const publishableIds = new Set(publicationPlan.publishable.map((item) => item.review_item_id));
  const alreadyStoredIds = new Set(publicationPlan.alreadyStored.map((item) => item.review_item_id));

  for (let index = 0; index < nextItems.length; index += 1) {
    const item = nextItems[index];
    if (alreadyStoredIds.has(item.review_item_id)) {
      results.push({ itemId: item.review_item_id, status: 'already_stored', creativeId: item.creative_id });
      continue;
    }
    if (!publishableIds.has(item.review_item_id)) continue;

    let next;
    try {
      const published = await ingestReviewCreative({
        spreadsheetId,
        item: { ...item, review_batch_id: batch.review_batch_id },
      });
      next = {
        ...item,
        image_hash: published.imageHash || item.image_hash,
        publication_status: 'stored',
        creative_id: published.creativeId,
        publication_error: '',
        published_at: nowIso(),
        updated_at: nowIso(),
        version: Math.max(1, cleanInteger(item.version, 1)) + 1,
      };
      results.push({
        itemId: item.review_item_id,
        status: published.status,
        creativeId: published.creativeId,
      });
    } catch (error) {
      next = {
        ...item,
        publication_status: 'failed',
        publication_error: error.message,
        updated_at: nowIso(),
        version: Math.max(1, cleanInteger(item.version, 1)) + 1,
      };
      results.push({ itemId: item.review_item_id, status: 'failed', error: error.message });
    }
    nextItems[index] = next;
    // Persist after each item. A process crash can be retried safely through the
    // review_item_id + image_hash idempotency key in Creative Library.
    await updateRowPatches(
      sheets,
      spreadsheetId,
      CREATIVE_REVIEW_ITEMS_SHEET,
      CREATIVE_REVIEW_ITEM_HEADERS,
      [{
        rowNumber: next.__rowNumber,
        patch: {
          image_hash: next.image_hash,
          publication_status: next.publication_status,
          creative_id: next.creative_id,
          publication_error: next.publication_error,
          published_at: next.published_at,
          updated_at: next.updated_at,
          version: next.version,
        },
      }],
    );
  }
  return { items: nextItems, results, failures: results.filter((result) => result.status === 'failed') };
};

const completePublication = async ({ sheets, spreadsheetId, batch, items, publicResponse = false }) => {
  const publishingBatch = batch;
  let workingBatch = batch;
  try {
    const publication = await publishApprovedItems({ sheets, spreadsheetId, batch: workingBatch, items });
    const nextStatus = publication.failures.length ? 'publish_failed' : 'published';
    workingBatch = transitionReviewBatch(workingBatch, nextStatus);
    workingBatch = updateBatchSummary(workingBatch, publication.items);
    workingBatch.publish_error = publication.failures.length
      ? stringifyJson(publication.failures)
      : '';
    const latestBatch = await readLatestBatch(sheets, spreadsheetId, workingBatch.review_batch_id);
    workingBatch = preserveLatestAccessState(workingBatch, latestBatch);
    await updateRowPatches(
      sheets,
      spreadsheetId,
      CREATIVE_REVIEW_BATCHES_SHEET,
      CREATIVE_REVIEW_BATCH_HEADERS,
      [{
        rowNumber: latestBatch.__rowNumber,
        patch: {
          status: workingBatch.status,
          updated_at: workingBatch.updated_at,
          published_at: workingBatch.published_at,
          version: workingBatch.version,
          item_count: workingBatch.item_count,
          approved_count: workingBatch.approved_count,
          rejected_count: workingBatch.rejected_count,
          pending_count: workingBatch.pending_count,
          publish_error: workingBatch.publish_error,
          token_hash: workingBatch.token_hash,
          expires_at: workingBatch.expires_at,
          revoked_at: workingBatch.revoked_at,
        },
      }],
    );
    const mirrorWarnings = await mirrorSourceDecisions({
      spreadsheetId,
      batchId: workingBatch.review_batch_id,
      batchStatus: workingBatch.status,
      updatedItems: publication.items,
      allItems: publication.items,
      config: getCreativeLibraryConfig(),
    });
    const combinedWarnings = [...buildPartialFamilyWarnings(publication.items), ...mirrorWarnings];
    return {
      batch: publicResponse
        ? sanitizePublicBatch(workingBatch, spreadsheetId)
        : hydrateBatch(workingBatch, spreadsheetId),
      items: publicResponse
        ? publication.items.map(sanitizePublicItem)
        : publication.items.map(hydrateItem),
      summary: summarizeReviewItems(publication.items),
      warnings: publicResponse
        ? combinedWarnings.map((warning) => ({ code: warning.code, message: warning.message }))
        : combinedWarnings,
      publication: publication.results,
    };
  } catch (error) {
    if (publishingBatch.status === 'publishing') {
      workingBatch = transitionReviewBatch(publishingBatch, 'publish_failed');
      workingBatch.publish_error = error.message;
      try {
        const latestBatch = await readLatestBatch(sheets, spreadsheetId, publishingBatch.review_batch_id);
        workingBatch = preserveLatestAccessState(workingBatch, latestBatch);
        await updateRowPatches(
          sheets,
          spreadsheetId,
          CREATIVE_REVIEW_BATCHES_SHEET,
          CREATIVE_REVIEW_BATCH_HEADERS,
          [{
            rowNumber: latestBatch.__rowNumber,
            patch: {
              status: workingBatch.status,
              updated_at: workingBatch.updated_at,
              version: workingBatch.version,
              publish_error: workingBatch.publish_error,
              token_hash: workingBatch.token_hash,
              expires_at: workingBatch.expires_at,
              revoked_at: workingBatch.revoked_at,
            },
          }],
        );
      } catch {
        // Preserve the original publication error. A stale publishing lease can
        // still be recovered through retryReviewPublication.
      }
    }
    throw error;
  }
};

export const finalizeReviewBatch = async (input = {}) => {
  const remote = await runReviewWriterMutation('finalizeReviewBatch', input);
  if (remote) return remote;
  const initial = await resolveDecisionContext(input);
  return withReviewLock(initial.spreadsheetId, async () => {
    const context = initial.token
      ? await resolveDecisionContext({ ...initial.args, token: initial.token })
      : await resolveDecisionContext(initial.args);
    const { args, sheets, spreadsheetId } = context;
    let batch = context.batch;
    let items = context.items.map(hydrateItem);
    if (batch.status === 'published') {
      return {
        batch: context.token
          ? sanitizePublicBatch(batch, spreadsheetId)
          : hydrateBatch(batch, spreadsheetId),
        items: context.token ? items.map(sanitizePublicItem) : items,
        summary: summarizeReviewItems(items),
        warnings: buildPartialFamilyWarnings(items),
        publication: [],
      };
    }
    const batchStatus = clean(batch.status).toLowerCase();
    const canStartInternalDraft = !context.token && batchStatus === 'draft';
    if (batchStatus !== 'in_review' && !canStartInternalDraft) {
      throw new CreativeReviewError(`Review batch cannot be finalized while ${batch.status}.`, 'REVIEW_BATCH_LOCKED', 409);
    }
    const summary = summarizeReviewItems(items);
    if (!summary.total || summary.pending > 0) {
      throw new CreativeReviewError(
        `Review batch still has ${summary.pending} pending creative(s).`,
        'REVIEW_PENDING_ITEMS',
        409,
        summary,
      );
    }
    const reviewerName = clean(args.reviewerName || batch.reviewer_name);
    const reviewerEmail = clean(args.reviewerEmail || batch.reviewer_email);
    if (!reviewerName || !reviewerEmail) {
      throw new CreativeReviewError(
        'reviewerName and reviewerEmail are required to finalize the review.',
        'REVIEWER_IDENTITY_REQUIRED',
      );
    }
    if (canStartInternalDraft) {
      // A fully decided legacy draft can be finalized directly from Studio.
      // Pending/identity checks above remain identical to the public flow.
      batch = await startInternalReviewIfDraft({ batch, sheets, spreadsheetId });
    }
    const audited = backfillReviewDecisionAudit(items, { reviewerName, reviewerEmail });
    if (audited.updated.length) {
      await updateRowPatches(
        sheets,
        spreadsheetId,
        CREATIVE_REVIEW_ITEMS_SHEET,
        CREATIVE_REVIEW_ITEM_HEADERS,
        audited.updated.map((item) => ({
          rowNumber: item.__rowNumber,
          patch: {
            reviewer_name: item.reviewer_name,
            reviewer_email: item.reviewer_email,
            decided_at: item.decided_at,
            updated_at: item.updated_at,
            version: item.version,
          },
        })),
      );
      items = audited.items;
    }
    const latestBeforePublish = await readLatestBatch(sheets, spreadsheetId, batch.review_batch_id);
    if (latestBeforePublish.status !== 'in_review' || (context.token && !latestBeforePublish.token_hash)) {
      throw new CreativeReviewError(
        `Review batch cannot be finalized while ${latestBeforePublish.status}.`,
        'REVIEW_BATCH_LOCKED',
        409,
      );
    }
    batch = {
      ...batch,
      ...latestBeforePublish,
      reviewer_name: reviewerName,
      reviewer_email: reviewerEmail,
    };
    const timestamp = nowIso();
    batch = transitionReviewBatch(batch, 'publishing', timestamp);
    batch.finalized_at = timestamp;
    batch.reviewer_name = reviewerName;
    batch.reviewer_email = reviewerEmail;
    batch.publish_error = '';
    batch = updateBatchSummary(batch, items, timestamp);
    await updateRowPatches(
      sheets,
      spreadsheetId,
      CREATIVE_REVIEW_BATCHES_SHEET,
      CREATIVE_REVIEW_BATCH_HEADERS,
      [{
        rowNumber: latestBeforePublish.__rowNumber,
        patch: {
          status: batch.status,
          updated_at: batch.updated_at,
          finalized_at: batch.finalized_at,
          reviewer_name: batch.reviewer_name,
          reviewer_email: batch.reviewer_email,
          version: batch.version,
          item_count: batch.item_count,
          approved_count: batch.approved_count,
          rejected_count: batch.rejected_count,
          pending_count: batch.pending_count,
          publish_error: batch.publish_error,
        },
      }],
    );
    return completePublication({
      sheets,
      spreadsheetId,
      batch,
      items,
      publicResponse: Boolean(context.token),
    });
  });
};

export const retryReviewPublication = async (input = {}) => {
  const remote = await runReviewWriterMutation('retryReviewPublication', input);
  if (remote) return remote;
  const { args, spreadsheetId } = resolveSpreadsheetContext(input);
  const batchId = getBatchId(args);
  if (!batchId) throw new CreativeReviewError('batchId is required.', 'REVIEW_BATCH_ID_REQUIRED');
  return withReviewLock(spreadsheetId, async () => {
    const sheets = await getReviewSheetsClient();
    const rows = await readReviewRows(sheets, spreadsheetId);
    let batch = assertBatch(findBatch(rows.batches, batchId), batchId);
    const items = getBatchItems(rows.items, batchId).map(hydrateItem);
    if (batch.status === 'published') {
      return {
        batch: hydrateBatch(batch, spreadsheetId),
        items,
        summary: summarizeReviewItems(items),
        warnings: buildPartialFamilyWarnings(items),
        publication: [],
      };
    }
    const leaseMs = Math.max(30, Number(process.env.CREATIVE_REVIEW_PUBLISH_LEASE_SECONDS || 300)) * 1000;
    const publishingAge = Date.now() - Date.parse(batch.updated_at || batch.finalized_at || '');
    const stalePublishing = batch.status === 'publishing' &&
      (!Number.isFinite(publishingAge) || publishingAge >= leaseMs);
    if (batch.status !== 'publish_failed' && !stalePublishing) {
      throw new CreativeReviewError(
        `Review batch cannot retry publication while ${batch.status}.`,
        'REVIEW_BATCH_NOT_RETRYABLE',
        409,
      );
    }
    batch = await readLatestBatch(sheets, spreadsheetId, batchId);
    if (batch.status === 'revoked' || !batch.token_hash) {
      throw new CreativeReviewError('Revoked review batches cannot be retried.', 'REVIEW_BATCH_LOCKED', 409);
    }
    const latestPublishingAge = Date.now() - Date.parse(batch.updated_at || batch.finalized_at || '');
    const latestIsStalePublishing = batch.status === 'publishing' &&
      (!Number.isFinite(latestPublishingAge) || latestPublishingAge >= leaseMs);
    if (batch.status !== 'publish_failed' && !latestIsStalePublishing) {
      throw new CreativeReviewError(
        `Review batch cannot retry publication while ${batch.status}.`,
        'REVIEW_BATCH_NOT_RETRYABLE',
        409,
      );
    }
    batch = batch.status === 'publish_failed'
      ? transitionReviewBatch(batch, 'publishing')
      : {
          ...batch,
          version: Math.max(1, cleanInteger(batch.version, 1)) + 1,
          updated_at: nowIso(),
        };
    batch.publish_error = '';
    await updateRowPatches(
      sheets,
      spreadsheetId,
      CREATIVE_REVIEW_BATCHES_SHEET,
      CREATIVE_REVIEW_BATCH_HEADERS,
      [{
        rowNumber: batch.__rowNumber,
        patch: {
          status: batch.status,
          updated_at: batch.updated_at,
          version: batch.version,
          publish_error: batch.publish_error,
        },
      }],
    );
    return completePublication({ sheets, spreadsheetId, batch, items });
  });
};

const findLegacyHeaderRow = (rowData) => {
  let bestIndex = -1;
  let bestScore = 0;
  for (let index = 0; index < Math.min(20, rowData.length); index += 1) {
    const headers = (rowData[index]?.values || []).map(getCellText);
    const score = headers.reduce((total, header) => {
      const normalized = normalizeHeader(header);
      return total + (normalized ? 1 : 0) + (/1:1|9:16|16[.:]9|1[.,]91|1200x628|image|imagen|img/.test(normalized) ? 3 : 0);
    }, 0);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
};

const isLegacyOutputHeader = (header) =>
  /(^|_)(1:1|9:16|16[.:]9|1[.,]91(?::1)?|1200x628|1080x1080|1080x1920|1920x1080|landscape)(_|$)/i
    .test(normalizeHeader(header));

const ratioFromLegacyHeader = (header) => {
  const normalized = normalizeHeader(header);
  if (/9:16|1080x1920|portrait|vertical/.test(normalized)) return '9:16';
  if (/16[.:]9|1[.,]91|1200x628|1920x1080|landscape/.test(normalized)) return '16:9';
  if (/1:1|1080x1080|square/.test(normalized)) return '1:1';
  return '';
};

const createLegacyBackup = async (spreadsheetId, title, config) => {
  const drive = await getReviewDriveClient();
  const timestamp = nowIso().replace(/[:.]/g, '-');
  // Service accounts have no usable personal Drive quota. Keep the mandatory
  // backup in the configured Shared Drive, next to the persisted review assets.
  const backupFolder = await findReviewDriveFolder(
    'Creative Review Backups',
    config.driveRootFolderId,
  );
  const response = await drive.files.copy({
    fileId: spreadsheetId,
    supportsAllDrives: true,
    requestBody: {
      name: `${clean(title) || 'Creative review'} backup ${timestamp}`,
      parents: [backupFolder.folderId],
    },
    fields: 'id,name,webViewLink',
  });
  return {
    fileId: response.data.id,
    name: response.data.name,
    url: response.data.webViewLink || canonicalSheetsUrl(response.data.id),
  };
};

const importLegacyReviewBatchLocked = async (input, context) => {
  const { args, config, spreadsheetId, sheetsUrl } = context;
  const sheets = await getReviewSheetsClient();
  const metadata = await getSheetMetadata(sheets, spreadsheetId);
  const requestedTab = clean(args.sheetName || args.sourceTab || args.tabName);
  const sourceSheet = requestedTab
    ? metadata.find((sheet) => sheet.properties?.title === requestedTab)
    : metadata.find((sheet) =>
        config.sourceSheets.some((name) => normalizeHeader(name) === normalizeHeader(sheet.properties?.title)),
      ) || metadata.find((sheet) => ![
        CREATIVE_REVIEW_BATCHES_SHEET,
        CREATIVE_REVIEW_ITEMS_SHEET,
      ].includes(sheet.properties?.title));
  if (!sourceSheet) {
    throw new CreativeReviewError(`Source tab ${requestedTab || '(default)'} was not found.`, 'LEGACY_SOURCE_TAB_NOT_FOUND', 404);
  }
  const sourceTab = sourceSheet.properties.title;
  const migrationKey = crypto
    .createHash('sha256')
    .update(`${spreadsheetId}::${normalizeHeader(sourceTab)}`, 'utf8')
    .digest('hex')
    .slice(0, 24);
  const deterministicBatchId = `legacy_${migrationKey}`;
  let resumableBatch = null;
  let resumableBackup = null;
  if (args.force !== true) {
    // This idempotency check is intentionally read-only. For a new import the
    // native Drive backup below must be created before any normalized tabs or
    // headers are added to the source spreadsheet.
    const existingRows = await readReviewRowsIfPresent(sheets, spreadsheetId, metadata);
    const existingBatch = existingRows?.batches.find((candidate) =>
      normalizeReviewSourceType(candidate.source_type) === 'legacy_import' &&
      clean(candidate.source_sheet_id) === spreadsheetId &&
      normalizeHeader(candidate.source_tab) === normalizeHeader(sourceTab),
    );
    const existingItems = existingBatch
      ? getBatchItems(existingRows.items, existingBatch.review_batch_id).map(hydrateItem)
      : [];
    if (existingBatch) {
      const existingMetadata = parseJson(existingBatch.metadata_json);
      resumableBackup = existingMetadata.legacyBackup || null;
      if (existingItems.length === 0) {
        resumableBatch = hydrateBatch(existingBatch, spreadsheetId);
      } else {
      return {
        batch: hydrateBatch(updateBatchSummary(existingBatch, existingItems), spreadsheetId),
        items: existingItems,
        backup: resumableBackup,
        importedCount: existingItems.length,
        existingLibraryMatches: existingItems.filter((item) => item.publication_status === 'stored').length,
        alreadyImported: true,
        warnings: [{
          code: 'LEGACY_ALREADY_IMPORTED',
          message: `Legacy creatives from ${sourceTab} were already imported in batch ${existingBatch.review_batch_id}.`,
        }],
        summary: summarizeReviewItems(existingItems),
      };
      }
    }
  }
  const maxRows = Math.min(
    sourceSheet.properties?.gridProperties?.rowCount || 500,
    Math.max(1, cleanInteger(args.maxRows, 1000)),
  );
  const grid = await sheets.spreadsheets.get({
    spreadsheetId,
    includeGridData: true,
    ranges: [buildRange(sourceTab, `A1:ZZ${maxRows}`)],
    fields: 'sheets(data(rowData(values(userEnteredValue,formattedValue,hyperlink,textFormatRuns,effectiveFormat(backgroundColor),userEnteredFormat(backgroundColor)))))',
  });
  const rowData = grid.data.sheets?.[0]?.data?.[0]?.rowData || [];
  const headerRowIndex = findLegacyHeaderRow(rowData);
  if (headerRowIndex < 0) {
    throw new CreativeReviewError('Could not find the legacy header row.', 'LEGACY_HEADER_NOT_FOUND');
  }
  const usedColumnCount = rowData.reduce(
    (max, row) => Math.max(max, row?.values?.length || 0),
    rowData[headerRowIndex]?.values?.length || 0,
  );
  const headers = Array.from(
    { length: usedColumnCount },
    (_, index) => getCellText(rowData[headerRowIndex]?.values?.[index]),
  );
  const outputColumns = [];
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    if (!isLegacyOutputHeader(header)) continue;
    outputColumns.push({ header, index, variantIndex: 1 });
    let variantIndex = 2;
    for (let adjacent = index + 1; adjacent < headers.length; adjacent += 1) {
      const adjacentHeader = clean(headers[adjacent]);
      if (adjacentHeader && !/^column[a-z]+$/i.test(adjacentHeader)) break;
      outputColumns.push({ header, index: adjacent, variantIndex });
      variantIndex += 1;
    }
  }
  if (!outputColumns.length) {
    throw new CreativeReviewError('No legacy creative output columns were found.', 'LEGACY_OUTPUT_COLUMNS_NOT_FOUND');
  }
  const feedbackColumn = headers.findIndex((header) => {
    const normalized = normalizeHeader(header);
    return ['review_feedback', 'feedback', 'notes', 'notas', 'comentarios'].some((term) => (
      normalized === term || normalized.startsWith(`${term}_`) || normalized.endsWith(`_${term}`)
    ));
  });
  const categoryColumn = headers.findIndex((header) =>
    ['category', 'categoria', 'categoría'].includes(normalizeHeader(header)),
  );
  const plazasColumn = headers.findIndex((header) =>
    ['plazas', 'plaza', 'ciudad', 'city', 'market'].includes(normalizeHeader(header)),
  );
  const familyColumn = headers.findIndex((header) =>
    ['creative_family_id', 'family_id', 'familia', 'set_id'].includes(normalizeHeader(header)),
  );
  const referenceColumn = headers.findIndex((header) =>
    ['reference', 'referencia', 'original', 'input_image', 'imagen_original'].some((term) => normalizeHeader(header).includes(term)),
  );
  const legacyItems = [];
  for (let rowIndex = headerRowIndex + 1; rowIndex < rowData.length; rowIndex += 1) {
    const cells = rowData[rowIndex]?.values || [];
    const rowNumber = rowIndex + 1;
    const feedback = feedbackColumn >= 0 ? getCellText(cells[feedbackColumn]) : '';
    const category = clean(args.category || (categoryColumn >= 0 ? getCellText(cells[categoryColumn]) : ''))
      || config.categories[0] || '';
    const plazas = clean(args.plazas || (plazasColumn >= 0 ? getCellText(cells[plazasColumn]) : '')) || 'ALL';
    const explicitFamily = familyColumn >= 0 ? getCellText(cells[familyColumn]) : '';
    for (const { header, index: columnIndex, variantIndex } of outputColumns) {
      const cell = cells[columnIndex];
      const imageUrl = getCellUrl(cell);
      if (!imageUrl) continue;
      const legacyStatus = classifyBackgroundColor(cell, config);
      const decision = legacyReviewStatusToDecision(legacyStatus);
      const sourceCell = `${columnIndexToLetter(columnIndex)}${rowNumber}`;
      legacyItems.push({
        itemId: createReviewId('legacy_item'),
        familyId: clean(explicitFamily) || `${sanitizeFileName(sourceTab)}::row-${rowNumber}`,
        ratio: ratioFromLegacyHeader(header),
        variantIndex,
        imageUrl,
        referenceUrl: referenceColumn >= 0 ? getCellUrl(cells[referenceColumn]) || '' : '',
        category,
        plazas,
        decision,
        feedback: decision === 'rejected'
          ? feedback || 'Imported legacy rejection (no feedback provided).'
          : '',
        sourceSpreadsheetId: spreadsheetId,
        sourceTab,
        sourceRowNumber: rowNumber,
        sourceCell,
        sourceOutput: header,
        metadata: { legacyStatus, importedFromColor: true },
      });
    }
  }
  if (!legacyItems.length) {
    throw new CreativeReviewError('The legacy tab contains no linked creatives.', 'LEGACY_CREATIVES_NOT_FOUND');
  }

  // A native backup is mandatory for every new legacy import and is the last
  // operation before normalized review writes begin.
  const backup = resumableBackup || await createLegacyBackup(
    spreadsheetId,
    args.title || sourceTab,
    config,
  );
  const batch = resumableBatch || await createReviewBatch({
    sheetsUrl,
    batchId: args.force === true
      ? clean(args.batchId || args.reviewBatchId) || createReviewId('legacy_batch')
      : deterministicBatchId,
    sourceType: 'legacy_import',
    title: args.title || `Legacy import: ${sourceTab}`,
    context: args.context || `Imported from ${sourceTab}`,
    createdBy: args.createdBy || 'Legacy migration',
    sourceSpreadsheetId: spreadsheetId,
    sourceTab,
    category: args.category,
    plazas: args.plazas,
    metadata: { ...(args.metadata || {}), migrationKey, legacyBackup: backup },
  });
  const registration = await registerReviewItems({
    sheetsUrl,
    batchId: batch.batchId,
    items: legacyItems,
    allowImportedDecision: true,
    reviewerName: args.reviewerName || 'Legacy import',
    reviewerEmail: args.reviewerEmail || '',
  });

  let existingLibraryMatches = 0;
  const warnings = [];
  try {
    const library = await listReviewLibrary({ sheetsUrl });
    const byHash = new Map(library.creatives.filter((creative) => creative.image_hash).map((creative) => [creative.image_hash, creative]));
    const byUrl = new Map(library.creatives.flatMap((creative) =>
      [creative.resized_image_url, creative.drive_url]
        .filter(Boolean)
        .map((url) => [normalizeUrl(url), creative]),
    ));
    const current = await readReviewRows(sheets, spreadsheetId);
    const importedRows = getBatchItems(current.items, batch.batchId).map(hydrateItem);
    const matches = [];
    for (const item of importedRows) {
      const creative = byHash.get(item.image_hash) || byUrl.get(normalizeUrl(item.image_url));
      if (!creative) continue;
      item.publication_status = 'stored';
      item.creative_id = creative.creative_id;
      item.published_at = creative.created_at || nowIso();
      item.updated_at = nowIso();
      item.version += 1;
      matches.push(item);
    }
    await updateRows(
      sheets,
      spreadsheetId,
      CREATIVE_REVIEW_ITEMS_SHEET,
      CREATIVE_REVIEW_ITEM_HEADERS,
      matches.map(prepareItemForWrite),
    );
    existingLibraryMatches = matches.length;
  } catch (error) {
    // Import remains valid even if the optional historical library match cannot
    // be completed. Finalization will still be idempotent by image hash.
    warnings.push({
      code: 'LEGACY_LIBRARY_MATCH_FAILED',
      message: error?.message || String(error),
    });
  }

  return {
    batch: registration.batch,
    items: registration.items,
    backup,
    importedCount: legacyItems.length,
    existingLibraryMatches,
    alreadyImported: false,
    warnings,
    summary: summarizeReviewItems(registration.items),
  };
};

export const importLegacyReviewBatch = async (input = {}) => {
  const remote = await runReviewWriterMutation('importLegacyReviewBatch', input);
  if (remote) return remote;
  const context = resolveSpreadsheetContext(input);
  return withLegacyImportLock(
    context.spreadsheetId,
    () => importLegacyReviewBatchLocked(input, context),
  );
};
