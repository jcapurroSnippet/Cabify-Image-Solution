import axios from 'axios';
import crypto from 'node:crypto';
import {
  appendRows,
  ensureSheetWithHeaders,
  extractSpreadsheetId,
  extractSheetId,
  readRowsIfPresent,
  columnIndexToLetter,
  getFirstSheetName,
  getSheetMetadata,
  getSheetByTitle,
  buildRange,
} from './sheetsService.js';
import { uploadImageToDrive, makeFilePublic, getShareableLink, extractFolderId } from './driveService.js';
import { getSheetsClient, getDriveClient } from './googleAuth.js';
import { uploadImageToPhotos, resolveAlbumIdFromShareUrl } from './photosService.js';
import { ASPECT_RATIO_PROMPT_PROFILE, generateAspectRatioImages } from './imageGenerator.js';
import { optimizeImageBuffer, bufferToDataUrl, detectImageMimeType } from './imageOptimizer.js';
import {
  BATCH_VARIATIONS_SHEET,
  BATCH_VARIATION_HEADERS,
  getCreativeLibraryConfig,
} from './creativeLibraryConfig.js';
import { createReviewBatch, getReviewBatch, registerReviewItems } from './creativeReviewService.js';

// A zero default means "read the populated grid". Operators may set an
// explicit limit, but the application no longer truncates wide Sheets merely
// to stay under an arbitrary cell count.
const DEFAULT_MAX_SCAN_ROWS = Math.max(0, Number(process.env.SHEET_MAX_SCAN_ROWS || 0));
const DEFAULT_URL_SCAN_ROWS = Math.max(0, Number(process.env.SHEET_URL_SCAN_ROWS || 0));
const EXPECTED_VARIATIONS_PER_RATIO = 3;
const DEFAULT_BATCH_ROWS_PER_REQUEST = Math.max(
  1,
  Number.parseInt(process.env.BATCH_ROWS_PER_REQUEST || '3', 10) || 3,
);

/**
 * Ratios covered by Batch from Sheets. Output no longer depends on which
 * columns the operator happened to create in their own sheet — it goes to the
 * batch_variations tab instead.
 *
 * Landscape (1.91:1) is deliberately excluded here: the batch only ships the
 * square and vertical ratios. The ciclo keeps its own RUN_TARGET_RATIOS, which
 * still covers landscape, so the two lists are intentionally out of sync.
 */
const BATCH_ASPECT_RATIOS = ['1:1', '9:16'];
const EXPECTED_VARIATIONS_PER_ROW = BATCH_ASPECT_RATIOS.length * EXPECTED_VARIATIONS_PER_RATIO;

const createEmptyRatioLinks = () =>
  Object.fromEntries(BATCH_ASPECT_RATIOS.map((ratio) => [ratio, []]));

const normalizeHeaderText = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim();

const isVideoHeader = (header) => /(^|\W)(video|vid)(\W|$)/.test(header);

const isImageHeader = (header) =>
  /(^|\W)(img|image|imagen|foto|creative|creatividad|pieza)(\W|$)/.test(header);

const hasSixteenNineMarker = (header) =>
  /(^|\D)16\s*[.:/x-]\s*9(\D|$)/.test(header)
  || /(^|\D)1\s*[.,]\s*91\s*(?::\s*1)?(\D|$)/.test(header)
  || /(^|\D)(1200\s*x\s*628|1920\s*x\s*1080)(\D|$)/.test(header);

/**
 * Locate the explicit landscape-image input column used by Batch from Sheets.
 * Video columns are intentionally rejected even when they carry the same ratio.
 * The semantic header wins; URL counts are only used to break ties between
 * equally valid 16:9 image columns.
 */
export const findSixteenNineImageColumn = (headers = [], urlCounts = {}) => {
  const candidates = headers
    .map((value, index) => {
      const header = normalizeHeaderText(value);
      if (!header || isVideoHeader(header) || !hasSixteenNineMarker(header)) return null;

      const exact = /^(16\s*[.:/x-]\s*9|1\s*[.,]\s*91(?::\s*1)?)\s+(img|image|imagen)$/.test(header);
      const score = (exact ? 200 : 100) + (isImageHeader(header) ? 50 : 0);
      return { index, score, urlCount: Number(urlCounts[index] || 0) };
    })
    .filter(Boolean)
    .sort((left, right) =>
      right.score - left.score || right.urlCount - left.urlCount || left.index - right.index,
    );

  return candidates[0]?.index ?? -1;
};

export const assertCompleteRatioVariations = ({ images, ratio, rowNumber, errors = [] }) => {
  const count = Array.isArray(images) ? images.length : 0;
  if (count !== EXPECTED_VARIATIONS_PER_RATIO) {
    const detail = errors.length ? ` Underlying errors: ${errors.join(' | ')}` : '';
    throw new Error(
      `Expected exactly ${EXPECTED_VARIATIONS_PER_RATIO} ${ratio} variants for row ${rowNumber}, but generated ${count}.${detail}`,
    );
  }
  return images;
};

export const orderRegisteredReviewItemIds = (expectedItems = [], registeredItems = []) => {
  const byGenerationId = new Map(
    registeredItems
      .map((item) => [
        String(item?.generation_id || item?.generationId || '').trim(),
        String(item?.review_item_id || item?.reviewItemId || '').trim(),
      ])
      .filter(([generationId, itemId]) => generationId && itemId),
  );

  const hasGenerationIds = byGenerationId.size > 0;
  const ordered = expectedItems.map((expected, index) => {
    const generationId = String(expected?.generationId || expected?.generation_id || '').trim();
    if (generationId && byGenerationId.has(generationId)) return byGenerationId.get(generationId);
    if (hasGenerationIds) return '';
    const positional = registeredItems[index];
    return String(positional?.review_item_id || positional?.reviewItemId || '').trim();
  });

  if (
    expectedItems.length !== EXPECTED_VARIATIONS_PER_ROW
    || registeredItems.length !== EXPECTED_VARIATIONS_PER_ROW
    || ordered.length !== EXPECTED_VARIATIONS_PER_ROW
    || ordered.some((itemId) => !itemId)
    || new Set(ordered).size !== EXPECTED_VARIATIONS_PER_ROW
  ) {
    throw new Error(
      `Creative Review registration must return ${EXPECTED_VARIATIONS_PER_ROW} item IDs before the row is published to the output sheet.`,
    );
  }

  return ordered;
};

const getRatioFileSlug = (ratio) => ratio.replace(/\./g, '-').replace(/:/g, '-');

const nowIso = () => new Date().toISOString();

const canonicalSheetsUrl = (spreadsheetId, sheetId) =>
  `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit${
    Number.isInteger(sheetId) ? `#gid=${sheetId}` : ''
  }`;

const buildCreativeReviewUrl = (baseUrl, sheetsUrl, reviewBatchId) => {
  if (!reviewBatchId) return '';
  try {
    const url = new URL('/', baseUrl);
    url.searchParams.set('tab', 'review');
    url.searchParams.set('sheetsUrl', sheetsUrl);
    url.searchParams.set('batchId', reviewBatchId);
    return url.toString();
  } catch {
    return '';
  }
};

export const buildBatchVariationSheetFormatRequests = (sheetId, rowCount = 1000) => {
  const lastColumnIndex = BATCH_VARIATION_HEADERS.length;
  const gridRowCount = Math.max(2, Number(rowCount) || 1000);
  const columnWidth = (startIndex, endIndex, pixelSize) => ({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex, endIndex },
      properties: { pixelSize },
      fields: 'pixelSize',
    },
  });

  return [
    {
      updateSheetProperties: {
        properties: {
          sheetId,
          gridProperties: { frozenRowCount: 1 },
          tabColorStyle: { rgbColor: { red: 0.435, green: 0.286, blue: 0.91 } },
        },
        fields: 'gridProperties.frozenRowCount,tabColorStyle',
      },
    },
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: lastColumnIndex,
        },
        cell: {
          userEnteredFormat: {
            backgroundColorStyle: { rgbColor: { red: 0.435, green: 0.286, blue: 0.91 } },
            horizontalAlignment: 'CENTER',
            verticalAlignment: 'MIDDLE',
            wrapStrategy: 'WRAP',
            textFormat: {
              bold: true,
              foregroundColorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } },
            },
          },
        },
        fields: [
          'userEnteredFormat.backgroundColorStyle',
          'userEnteredFormat.horizontalAlignment',
          'userEnteredFormat.verticalAlignment',
          'userEnteredFormat.wrapStrategy',
          'userEnteredFormat.textFormat',
        ].join(','),
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 34 },
        fields: 'pixelSize',
      },
    },
    {
      setBasicFilter: {
        filter: {
          range: {
            sheetId,
            startRowIndex: 0,
            endRowIndex: gridRowCount,
            startColumnIndex: 0,
            endColumnIndex: lastColumnIndex,
          },
        },
      },
    },
    columnWidth(0, 3, 190),
    columnWidth(3, 4, 300),
    columnWidth(4, 6, 190),
    columnWidth(6, 9, 130),
    columnWidth(9, 10, 280),
    columnWidth(10, 12, 90),
    columnWidth(12, 13, 280),
    columnWidth(13, 19, 150),
  ];
};

const formatBatchVariationsSheet = async (sheets, spreadsheetId, sheetId) => {
  const metadata = await getSheetMetadata(sheets, spreadsheetId);
  const sheet = getSheetByTitle(metadata, BATCH_VARIATIONS_SHEET);
  const rowCount = sheet?.properties?.gridProperties?.rowCount || 1000;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: buildBatchVariationSheetFormatRequests(sheetId, rowCount),
    },
  });
};

const normalizePlazas = (value) => {
  const candidates = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(candidates.map((entry) => String(entry || '').trim()).filter(Boolean))];
};

const getReviewMetadata = (options) => {
  const nested = options.reviewMetadata && typeof options.reviewMetadata === 'object'
    ? options.reviewMetadata
    : {};
  const metadata = {
    title: String(nested.title ?? options.title ?? '').trim(),
    category: String(nested.category ?? options.category ?? '').trim(),
    plazas: normalizePlazas(nested.plazas ?? options.plazas),
    createdBy: String(nested.createdBy ?? options.createdBy ?? '').trim(),
  };
  const wasProvided = Boolean(
    metadata.title || metadata.category || metadata.plazas.length || metadata.createdBy
  );

  if (!wasProvided) return null;

  const missingFields = [
    !metadata.title && 'title',
    !metadata.category && 'category',
    metadata.plazas.length === 0 && 'plazas',
    !metadata.createdBy && 'createdBy',
  ].filter(Boolean);
  if (missingFields.length > 0) {
    throw new Error(`Incomplete review metadata. Missing: ${missingFields.join(', ')}.`);
  }

  return metadata;
};

const getCreatedReviewBatchId = (batch) =>
  String(batch?.reviewBatchId || batch?.batchId || batch?.id || '').trim();

const getRowValue = (row, candidateNames) => {
  for (const name of candidateNames) {
    const value = row?.[name];
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return '';
};

/**
 * Stable identity for one generated variation, keyed on the SOURCE row rather
 * than on the batch.
 *
 * This matters: with no output cell in the source sheet, `source_cell` is empty
 * and `buildReviewItemSourceKey` falls back to `source_output` to decide what
 * supersedes what. Keying on the source row keeps the old guarantee that
 * regenerating a row invalidates that row's items in any other draft batch, so
 * old and new bytes can never both be approved.
 */
export const buildBatchVariationSourceOutput = ({
  spreadsheetId,
  sourceTab,
  rowNumber,
  ratio,
  variant,
}) => `batch:${spreadsheetId}:${sourceTab}:${rowNumber}:${ratio}:${variant}`;

/**
 * Convert the uploaded outputs for one source row into normalized review items.
 * Kept pure and exported so the exact row/ratio/variant mapping can be tested.
 *
 * `sourceTab` and `sourceRowNumber` deliberately point at the ORIGINAL sheet:
 * creativeLibraryService re-reads that row to infer category, plazas and family
 * when they are missing. Only the output pointer moved to batch_variations.
 */
export const buildBatchReviewItems = ({
  batchId,
  spreadsheetId,
  sheetName,
  row,
  rowNumber,
  referenceUrl,
  uploadedLinks,
  category,
  plazas,
}) => {
  const resolvedCategory = String(category || '').trim()
    || getRowValue(row, ['Categoria', 'Categoría', 'Category']);
  const resolvedPlazas = normalizePlazas(plazas);
  const rowPlaza = getRowValue(row, ['Ciudad', 'Plaza', 'City']);
  const resolvedItemPlazas = resolvedPlazas.length > 0
    ? resolvedPlazas
    : normalizePlazas(rowPlaza);
  const familyId = `${batchId}:row:${rowNumber}`;

  return BATCH_ASPECT_RATIOS.flatMap((ratio) =>
    (uploadedLinks?.[ratio] || []).map((imageUrl, index) => {
      const variant = index + 1;
      const sourceOutput = buildBatchVariationSourceOutput({
        spreadsheetId,
        sourceTab: sheetName,
        rowNumber,
        ratio,
        variant,
      });
      return {
        familyId,
        version: 1,
        // The source slot is stable, while this artifact suffix changes when a
        // retry genuinely produced new bytes and therefore a new Drive file.
        // That lets Creative Review supersede a partially registered attempt
        // instead of rejecting it as the same generation with different bytes.
        generationId: `${batchId}:${rowNumber}:${ratio}:${variant}:${crypto
          .createHash('sha256')
          .update(String(imageUrl || ''))
          .digest('hex')
          .slice(0, 16)}`,
        ratio,
        variantIndex: variant,
        sourceTab: sheetName,
        sourceSpreadsheetId: spreadsheetId,
        sourceRowNumber: rowNumber,
        // The source sheet is read-only now, so there is no output cell in it.
        sourceCell: '',
        sourceOutput,
        imageUrl,
        referenceUrl,
        category: resolvedCategory,
        plazas: resolvedItemPlazas,
        decision: 'pending',
      };
    })
  );
};

/**
 * Build the batch_variations rows for one source row. Pure so the ordering of
 * ratios/variants and the review_item_id mapping can be asserted in tests.
 */
export const buildBatchVariationRows = ({
  batchId,
  batchTitle,
  creativeReviewUrl,
  spreadsheetId,
  sourceTab,
  rowNumber,
  sourceImageUrl,
  familyId,
  uploadedLinks,
  driveFileIds,
  reviewItemIds,
  category,
  plazas,
  createdAt,
}) => {
  const timestamp = createdAt || nowIso();
  const plazasText = normalizePlazas(plazas).join(', ');
  let flatIndex = 0;

  return BATCH_ASPECT_RATIOS.flatMap((ratio) =>
    (uploadedLinks?.[ratio] || []).map((imageUrl, index) => {
      const variant = index + 1;
      // review_item_ids come back from registerReviewItems in the same flat
      // order buildBatchReviewItems emitted them: ratio-major, variant-minor.
      const reviewItemId = reviewItemIds?.[flatIndex] || '';
      flatIndex += 1;

      return {
        variation_id: buildBatchVariationSourceOutput({
          spreadsheetId,
          sourceTab,
          rowNumber,
          ratio,
          variant,
        }),
        review_batch_id: batchId || '',
        review_item_id: reviewItemId,
        creative_review_url: creativeReviewUrl || '',
        creative_family_id: familyId || '',
        batch_title: batchTitle || '',
        source_sheet_id: spreadsheetId || '',
        source_tab: sourceTab || '',
        source_row: rowNumber,
        source_image_url: sourceImageUrl || '',
        aspect_ratio: ratio,
        variant,
        image_url: imageUrl,
        drive_file_id: driveFileIds?.[ratio]?.[index] || '',
        category: String(category || '').trim(),
        plazas: plazasText,
        status: 'generated',
        error: '',
        created_at: timestamp,
      };
    })
  );
};

/**
 * Rebuild per-source-row progress from the batch_variations tab. This is what
 * makes the batch resumable: state lives in the sheet, not in the browser.
 *
 * The tab is append-only and accumulative, so a re-run leaves more than one
 * batch per source row. Callers pass the batch they care about; without one we
 * take the most recent batch present for that tab.
 */
export const summarizeBatchVariations = (
  variationRows,
  { spreadsheetId, sourceTab, reviewBatchId, sourceImageUrlsByRow = {} } = {},
) => {
  const scoped = (variationRows || []).filter((row) =>
    String(row?.source_sheet_id || '').trim() === String(spreadsheetId || '').trim()
    && String(row?.source_tab || '').trim() === String(sourceTab || '').trim()
    && String(row?.image_url || '').trim()
  );

  let targetBatchId = String(reviewBatchId || '').trim();
  let hasTargetBatch = Boolean(targetBatchId);
  if (!hasTargetBatch) {
    // Latest wins. created_at is ISO, so lexical order is chronological.
    let latestCreatedAt = '';
    for (const row of scoped) {
      const createdAt = String(row.created_at || '');
      if (createdAt >= latestCreatedAt) {
        latestCreatedAt = createdAt;
        targetBatchId = String(row.review_batch_id || '').trim();
        hasTargetBatch = true;
      }
    }
  }

  const rows = {};
  for (const row of scoped) {
    if (hasTargetBatch && String(row.review_batch_id || '').trim() !== targetBatchId) continue;

    const rowNumber = Number(row.source_row);
    if (!Number.isFinite(rowNumber)) continue;
    const expectedSourceUrl = normalizeUrl(sourceImageUrlsByRow[rowNumber]);
    const persistedSourceUrl = normalizeUrl(row.source_image_url);
    if (expectedSourceUrl && expectedSourceUrl !== persistedSourceUrl) continue;

    const ratio = String(row.aspect_ratio || '').trim();
    if (!BATCH_ASPECT_RATIOS.includes(ratio)) continue;

    if (!rows[rowNumber]) {
      rows[rowNumber] = { status: 'generating', links: createEmptyRatioLinks() };
    }
    const variant = Number(row.variant) || rows[rowNumber].links[ratio].length + 1;
    if (variant < 1 || variant > EXPECTED_VARIATIONS_PER_RATIO) continue;
    rows[rowNumber].links[ratio][variant - 1] = String(row.image_url).trim();
  }

  let completedRows = 0;
  for (const entry of Object.values(rows)) {
    const isComplete = BATCH_ASPECT_RATIOS.every((ratio) =>
      Array.from({ length: EXPECTED_VARIATIONS_PER_RATIO }, (_, index) =>
        Boolean(entry.links[ratio]?.[index]),
      ).every(Boolean),
    );
    if (isComplete) {
      entry.status = 'completed';
      completedRows += 1;
    }
  }

  return { rows, completedRows, reviewBatchId: targetBatchId };
};

const extractUrlFromFormula = (formula) => {
  if (typeof formula !== 'string') return null;
  const match = formula.match(/HYPERLINK\(\s*["']([^"']+)["']/i);
  return match ? match[1] : null;
};

const normalizeUrl = (value) => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;

  if (text.startsWith('http://') || text.startsWith('https://')) {
    return text;
  }

  if (text.startsWith('drive.google.com') || text.startsWith('docs.google.com') || text.startsWith('www.')) {
    return `https://${text}`;
  }

  const match = text.match(/https?:\/\/\S+/i);
  if (match) {
    return match[0].replace(/[),.]+$/g, '');
  }

  const googleMatch = text.match(/(?:drive|docs)\.google\.com\/\S+/i);
  if (googleMatch) {
    return `https://${googleMatch[0].replace(/[),.]+$/g, '')}`;
  }

  return null;
};

const resolveSheetName = async (sheetsUrl, providedSheetName) => {
  let sheetName = providedSheetName;
  if (sheetName) {
    return sheetName;
  }

  const spreadsheetId = extractSpreadsheetId(sheetsUrl);
  const gid = extractSheetId(sheetsUrl);
  if (gid !== null) {
    const sheetsClient = await getSheetsClient();
    const meta = await sheetsClient.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets(properties(sheetId,title))',
    });
    const match = meta.data.sheets?.find((s) => s.properties?.sheetId === gid);
    if (match?.properties?.title) {
      sheetName = match.properties.title;
    }
  }

  if (!sheetName) {
    sheetName = await findFirstSheetWithData(spreadsheetId);
  }

  return sheetName;
};

const logLine = (message) => {
  try {
    process.stdout.write(`${message}\n`);
  } catch {
  }
};

const extractUrlFromCell = (cell) => {
  if (!cell) return null;

  if (cell.hyperlink) return cell.hyperlink;

  const formulaUrl = extractUrlFromFormula(cell.userEnteredValue?.formulaValue);
  if (formulaUrl) return formulaUrl;

  const runs = cell.textFormatRuns || [];
  for (const run of runs) {
    const uri = run?.format?.link?.uri;
    if (uri) return uri;
  }

  const str = cell.userEnteredValue?.stringValue || cell.formattedValue;
  const normalized = normalizeUrl(str);
  if (normalized) return normalized;

  return null;
};

const findHeaderRowIndex = (rowData, maxScan = 20) => {
  if (!rowData || rowData.length === 0) return -1;

  const headerKeywords = ['categoria', 'ciudad', 'copy', 'preview'];

  // First pass: an explicit 16:9 image header identifies the batch schema even
  // when the rest of the columns use names we have never seen before.
  for (let i = 0; i < Math.min(maxScan, rowData.length); i++) {
    const texts = (rowData[i]?.values || []).map((cell) =>
      cell?.userEnteredValue?.stringValue || cell?.formattedValue || '',
    );
    if (findSixteenNineImageColumn(texts) >= 0) return i;
  }

  // Second pass: look for a row that contains at least 2 familiar headers.
  for (let i = 0; i < Math.min(maxScan, rowData.length); i++) {
    const row = rowData[i];
    if (!row?.values) continue;
    const texts = row.values
      .map((cell) => cell?.userEnteredValue?.stringValue || cell?.formattedValue || '')
      .map((t) => t.toLowerCase());

    const matches = headerKeywords.filter((kw) => texts.some((t) => t.includes(kw)));
    if (matches.length >= 2) {
      return i;
    }
  }

  // Fallback: row with most non-empty cells
  let headerRowIndex = -1;
  let maxCells = 0;
  for (let i = 0; i < Math.min(maxScan, rowData.length); i++) {
    const row = rowData[i];
    if (!row?.values) continue;
    const nonEmptyCells = row.values.filter(
      (v) => v && (v.userEnteredValue?.stringValue || v.userEnteredValue?.numberValue)
    ).length;
    if (nonEmptyCells > maxCells) {
      maxCells = nonEmptyCells;
      headerRowIndex = i;
    }
  }

  return headerRowIndex;
};

const buildSheetRange = async (sheets, spreadsheetId, sheetName, maxRows = DEFAULT_MAX_SCAN_ROWS) => {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties(title,gridProperties(columnCount,rowCount)))',
  });

  const sheet = meta.data.sheets?.find((candidate) => candidate.properties?.title === sheetName);
  if (!sheet) {
    throw new Error(`Sheet "${sheetName}" was not found.`);
  }
  const columnCount = sheet.properties?.gridProperties?.columnCount || 26;
  const rowCount = sheet.properties?.gridProperties?.rowCount || 1;
  const lastCol = columnIndexToLetter(Math.max(0, columnCount - 1));
  const lastRow = maxRows > 0 ? Math.min(rowCount, maxRows) : rowCount;

  return buildRange(sheetName, `A1:${lastCol}${Math.max(1, lastRow)}`);
};

const extractDriveFileId = (url) => {
  if (typeof url !== 'string') return null;

  // https://drive.google.com/file/d/{fileId}/view
  let match = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];

  // https://drive.google.com/open?id={fileId}
  match = url.match(/[\?&]id=([a-zA-Z0-9_-]+)/);
  if (match) return match[1];

  // https://drive.google.com/uc?id={fileId}
  match = url.match(/\/uc\?id=([a-zA-Z0-9_-]+)/);
  if (match) return match[1];

  return null;
};

/**
 * Download and optimize image for API calls
 */
const buildImageDownloadError = (imageUrl, error) => {
  const status = error?.status || error?.response?.status || null;
  const statusLabel = status ? ` (status ${status})` : '';
  const wrapped = new Error(`Failed to download image from ${imageUrl}${statusLabel}: ${error.message}`);
  wrapped.name = error?.name || 'Error';
  wrapped.code = error?.code || null;
  wrapped.status = status;
  wrapped.details = error?.response?.statusText || error?.details || null;
  wrapped.response = error?.response || null;
  return wrapped;
};

export const downloadImageAsDataUrl = async (imageUrl) => {
  try {
    let buffer;
    const normalizeBuffer = (data) => (Buffer.isBuffer(data) ? data : Buffer.from(data));
    
    // For Drive URLs, use Drive API alt=media with auth
    if (imageUrl.includes('drive.google.com')) {
      const fileId = extractDriveFileId(imageUrl);
      if (!fileId) throw new Error('Could not extract Drive file ID');
      
      const drive = await getDriveClient();
      
      try {
        // Use Drive API with supportsAllDrives for shared drives + shared folders
        const response = await drive.files.get(
          { 
            fileId, 
            alt: 'media',
            supportsAllDrives: true,
          },
          { responseType: 'arraybuffer' }
        );
        
        buffer = normalizeBuffer(response.data);
      } catch (apiError) {
        // If API fails, try direct HTTP with auth header
        
        const auth = await getAuthClient();
        let headers = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        };
        
        // Add auth token if available
        if (auth.credentials && auth.credentials.access_token) {
          headers['Authorization'] = `Bearer ${auth.credentials.access_token}`;
        }
        
        const response = await axios.get(
          `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
          {
            responseType: 'arraybuffer',
            headers: headers,
            timeout: 30000,
          }
        );
        
        buffer = normalizeBuffer(response.data);
      }
    } else {
      // Use HTTP for other URLs
      
      const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        maxRedirects: 10,
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      
      buffer = normalizeBuffer(response.data);
    }

    
    // Optimize the image
    const optimized = await optimizeImageBuffer(buffer);

    // Convert to data URL
    const mimeType = await detectImageMimeType(optimized);
    const dataUrl = bufferToDataUrl(optimized, mimeType);
    
    return dataUrl;
  } catch (error) {
    throw buildImageDownloadError(imageUrl, error);
  }
};

/**
 * Import getAuthClient for token access
 */
import { getAuthClient } from './googleAuth.js';

/**
 * Call the /api/aspect-ratio endpoint to generate variations
 * baseUrl: e.g. "http://localhost:8080"
 * Returns: { images: string[] } (array of 3 base64 data URLs)
 */
export const generateAspectRatioVariations = async (imageDataUrl, targetRatio, baseUrl) => {
  try {
    const response = await axios.post(`${baseUrl}/api/aspect-ratio`, {
      imageDataUrl,
      targetRatio,
    });

    return response.data.images || [];
  } catch (error) {
    throw new Error(`Failed to generate ${targetRatio} variations: ${error.message}`);
  }
};

/**
 * Find the first sheet with data and image columns
 * Scans all sheets and returns the first one with actual image-related columns
 */
export const findFirstSheetWithData = async (spreadsheetId) => {
  try {
    const sheets = await getSheetsClient();

    // Get list of all sheets
    const response = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets(properties(title))',
    });

    const sheetNames = response.data.sheets?.map((s) => s.properties.title) || [];

    // Column keywords to search for
    const imageKeywords = ['preview', 'imagen', 'image', 'creative', 'creativo', 'piezas'];

    // Try each sheet to find one with image columns
    for (const sheetName of sheetNames) {
      try {
        const dataResponse = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range: buildRange(sheetName, '1:1'),
        });

        const headers = dataResponse.data.values?.[0] || [];
        
        // Check if sheet has meaningful headers (at least 3) with image-related keywords
        if (headers.length >= 3) {
          const hasImageColumn = headers.some((h) =>
            imageKeywords.some((kw) => h?.toLowerCase().includes(kw))
          );
          
          if (hasImageColumn) {
            return sheetName;
          }
        }
      } catch (error) {
        // Skip sheets that have errors
        continue;
      }
    }

    // If no sheet with image columns found, look for any sheet with decent amount of data
    for (const sheetName of sheetNames) {
      try {
        const dataResponse = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range: buildRange(sheetName, '1:5'),
        });

        const allRows = dataResponse.data.values || [];
        const hasHeaders = allRows.length > 0 && allRows[0].length >= 3;
        const hasData = allRows.length > 1;

        if (hasHeaders && hasData) {
          return sheetName;
        }
      } catch (error) {
        continue;
      }
    }

    // Fallback to first sheet if all are empty
    const fallbackSheet = sheetNames[0] || 'Sheet1';
    return fallbackSheet;
  } catch (error) {
    throw error;
  }
};

/**
 * Read all rows from sheet, extracting URLs from cells and hyperlinks
 * Returns array of row objects with cell values
 */
export const readSheetRowsWithHyperlinks = async (spreadsheetId, sheetName) => {
  try {
    const sheets = await getSheetsClient();

    const range = await buildSheetRange(sheets, spreadsheetId, sheetName, DEFAULT_MAX_SCAN_ROWS);

    // Read with grid data to include hyperlinks
    const response = await sheets.spreadsheets.get({
      spreadsheetId,
      ranges: [range],
      includeGridData: true,
    });

    const sheet = response.data.sheets?.[0];
    if (!sheet) return [];

    const gridData = sheet.data?.[0];
    if (!gridData || !gridData.rowData) return [];

    const rows = [];
    let headerRow = null;
    let headerRowIndex = -1;

    // First, find the header row
    headerRowIndex = findHeaderRowIndex(gridData.rowData);
    headerRow = headerRowIndex >= 0 ? gridData.rowData[headerRowIndex] : null;

    if (headerRowIndex === -1 || !headerRow || !headerRow.values) {
      return [];
    }

    // Parse header
    const headers = headerRow.values.map((cell, idx) => {
      if (!cell) return `Column${columnIndexToLetter(idx)}`;
      return cell.userEnteredValue?.stringValue || `Column${columnIndexToLetter(idx)}`;
    });

    // Parse data rows (skip header row)
    for (let rowIdx = headerRowIndex + 1; rowIdx < gridData.rowData.length; rowIdx++) {
      const row = gridData.rowData[rowIdx];
      if (!row.values) continue;

      // Skip completely empty rows
      const hasData = row.values.some(v => v && (v.userEnteredValue?.stringValue || v.hyperlink));
      if (!hasData) continue;

      const rowObj = { __rowNumber: rowIdx + 1 };

      for (let colIdx = 0; colIdx < row.values.length && colIdx < headers.length; colIdx++) {
        const cell = row.values[colIdx];
        const header = headers[colIdx];

        if (!cell) {
          rowObj[header] = '';
          continue;
        }

        // Priority: hyperlink URL > cell text value
        const cellUrl = extractUrlFromCell(cell);

        if (cellUrl) {
          rowObj[header] = cellUrl;
        } else if (cell.userEnteredValue?.stringValue) {
          rowObj[header] = cell.userEnteredValue.stringValue;
        } else if (cell.userEnteredValue?.numberValue) {
          rowObj[header] = String(cell.userEnteredValue.numberValue);
        } else {
          rowObj[header] = '';
        }
      }

      rows.push(rowObj);
    }

    return rows;
  } catch (error) {
    throw error;
  }
};

/**
 * Find which column index contains image URLs by scanning the first few data rows
 * Checks both cell values and hyperlinks
 * Returns the column index or -1 if not found
 */
export const detectImageUrlColumn = async (spreadsheetId, sheetName, onDebug) => {
  try {
    const debug = (message, data) => {
      if (typeof onDebug === 'function') {
        onDebug(message, data);
      }
    };

    logLine(`[URL DETECTION] Starting URL column detection for sheet: "${sheetName}"`);
    const sheets = await getSheetsClient();

    const range = await buildSheetRange(sheets, spreadsheetId, sheetName, DEFAULT_MAX_SCAN_ROWS);
    logLine(`[URL DETECTION] Using range: ${range}`);
    debug('Using range', { range });

    // Read with grid data to include hyperlinks
    const response = await sheets.spreadsheets.get({
      spreadsheetId,
      ranges: [range],
      includeGridData: true,
    });

    const sheet = response.data.sheets?.[0];
    if (!sheet) {
      return -1;
    }

    const gridData = sheet.data?.[0];
    if (!gridData || !gridData.rowData) {
      return -1;
    }

    logLine(`[URL DETECTION] Total rows in gridData: ${gridData.rowData.length}`);
    debug('Grid rows', { count: gridData.rowData.length });

    // Find header row first
    let headerRowIndex = findHeaderRowIndex(gridData.rowData);
    for (let i = 0; i < Math.min(10, gridData.rowData.length); i++) {
      const row = gridData.rowData[i];
      if (!row?.values) {
      logLine(`[URL DETECTION] Row ${i}: No values`);
      continue;
    }
      const nonEmptyCells = row.values.filter(
        (v) => v && (v.userEnteredValue?.stringValue || v.userEnteredValue?.numberValue)
      ).length;
      logLine(`[URL DETECTION] Row ${i}: ${nonEmptyCells} non-empty cells`);
    }

    if (headerRowIndex === -1) {
      logLine('[URL DETECTION] ERROR: Could not find header row');
      debug('Header row not found');
      return -1;
    }

    logLine(`[URL DETECTION] Header row detected at index ${headerRowIndex}`);
    debug('Header row index', { headerRowIndex });

    // Log headers
    const headerRow = gridData.rowData[headerRowIndex];
    if (headerRow && headerRow.values) {
      logLine('[URL DETECTION] Headers found:');
      const headerSample = [];
      for (let i = 0; i < Math.min(20, headerRow.values.length); i++) {
        const header = headerRow.values[i];
        const headerText = header?.userEnteredValue?.stringValue || `[empty]`;
        headerSample.push(headerText);
        logLine(`  Column ${i}: "${headerText}"`);
      }
      debug('Header sample', { headers: headerSample });
    }

    // Scan data rows for URLs (in hyperlinks or cell values)
    // Increased from 15 to 50 rows to handle varied data
    const availableRows = Math.max(0, gridData.rowData.length - headerRowIndex - 1);
    const rowsToScan = DEFAULT_URL_SCAN_ROWS > 0
      ? Math.min(DEFAULT_URL_SCAN_ROWS, availableRows)
      : availableRows;
    logLine(`[URL DETECTION] Scanning ${rowsToScan} data rows for URLs...`);

    let urlsFoundPerColumn = {};

    for (let rowIdx = headerRowIndex + 1; rowIdx < headerRowIndex + 1 + rowsToScan; rowIdx++) {
      const row = gridData.rowData[rowIdx];
      if (!row.values) {
        continue;
      }

      for (let colIdx = 0; colIdx < row.values.length; colIdx++) {
        const cell = row.values[colIdx];
        if (!cell) continue;

        const cellValue = extractUrlFromCell(cell);

        // Initialize counter for this column
        if (!urlsFoundPerColumn[colIdx]) {
          urlsFoundPerColumn[colIdx] = 0;
        }

        if (cellValue && (cellValue.startsWith('http://') || cellValue.startsWith('https://'))) {
          urlsFoundPerColumn[colIdx]++;
          logLine(`[URL DETECTION] Row ${rowIdx}, Col ${colIdx}: Found URL`);
        }
      }
    }

    logLine('[URL DETECTION] URL count per column:');
    for (const [colIdx, count] of Object.entries(urlsFoundPerColumn)) {
      if (count > 0) {
        logLine(`  Column ${colIdx}: ${count} URLs found`);
      }
    }
    debug('URL counts', { urlsFoundPerColumn });

    const headerTexts = (headerRow?.values || []).map((cell) =>
      cell?.userEnteredValue?.stringValue || cell?.formattedValue || '',
    );
    const sourceColumnIdx = findSixteenNineImageColumn(headerTexts, urlsFoundPerColumn);
    const sourceUrlCount = Number(urlsFoundPerColumn[sourceColumnIdx] || 0);

    if (sourceColumnIdx !== -1 && sourceUrlCount > 0) {
      const sourceHeader = headerTexts[sourceColumnIdx] || `Column ${sourceColumnIdx + 1}`;
      logLine(
        `[URL DETECTION] SUCCESS: Using explicit 16:9 image column ${sourceColumnIdx} `
        + `("${sourceHeader}") with ${sourceUrlCount} URLs`,
      );
      debug('16:9 source column', {
        sourceColumnIdx,
        sourceHeader,
        sourceUrlCount,
      });
      return sourceColumnIdx;
    }

    if (sourceColumnIdx !== -1) {
      logLine('[URL DETECTION] ERROR: The 16:9 image column contains no URLs');
      debug('16:9 source column empty', { sourceColumnIdx, sourceHeader: headerTexts[sourceColumnIdx] });
      return -1;
    }

    logLine('[URL DETECTION] ERROR: No explicit 16:9 image header was found');
    logLine(`[URL DETECTION] Debug: Header row index = ${headerRowIndex}`);

    try {
      const headerTexts = (headerRow?.values || []).map((cell) =>
        (cell?.userEnteredValue?.stringValue || '').toLowerCase()
      );
      const candidateCols = [];
      headerTexts.forEach((text, idx) => {
        if (
          text.includes('url') ||
          text.includes('link') ||
          text.includes('imagen') ||
          text.includes('image') ||
          text.includes('preview') ||
          text.includes('pieza')
        ) {
          candidateCols.push(idx);
        }
      });

      if (candidateCols.length > 0) {
        logLine(`[URL DETECTION] Debug: Sampling candidate columns ${candidateCols.join(', ')}`);
        const sampleRows = Math.min(5, rowsToScan);
        for (let i = 0; i < sampleRows; i++) {
          const rowIdx = headerRowIndex + 1 + i;
          const row = gridData.rowData[rowIdx];
          if (!row?.values) continue;
          for (const colIdx of candidateCols) {
            const cell = row.values[colIdx];
            const raw =
              cell?.userEnteredValue?.stringValue ||
              cell?.formattedValue ||
              '';
            const formula = cell?.userEnteredValue?.formulaValue || '';
            const hyperlink = cell?.hyperlink || '';
            const runLink =
              cell?.textFormatRuns?.find((r) => r?.format?.link?.uri)?.format?.link?.uri || '';
            logLine(
              `[URL DETECTION] Sample r${rowIdx} c${colIdx}: raw="${raw}" formula="${formula}" hyperlink="${hyperlink}" runLink="${runLink}"`
            );
          }
        }
      }
    } catch (error) {
      logLine(`[URL DETECTION] Debug sampling failed: ${error.message}`);
    }

    debug('No URL column found', { headerRowIndex });
    return -1;
  } catch (error) {
    const detail = String(error?.message || error || 'Unknown Google Sheets error.');
    const wrapped = new Error(`Failed to inspect the 16:9 image column in "${sheetName}": ${detail}`);
    wrapped.status = error?.status || error?.response?.status || error?.code;
    wrapped.cause = error;
    throw wrapped;
  }
};

/**
 * Rebuild batch progress from the sheet, so a closed tab does not lose a run.
 *
 * Rows come from the source tab (that is what defines "how many"), completion
 * comes from batch_variations. The source tab is never written to any more, so
 * there is nothing there to infer progress from.
 */
export const getBatchStatus = async (options) => {
  const { sheetsUrl, sheetName: providedSheetName, reviewBatchId } = options;

  if (typeof sheetsUrl !== 'string' || sheetsUrl.trim().length === 0) {
    throw new Error('sheetsUrl is required.');
  }

  const spreadsheetId = extractSpreadsheetId(sheetsUrl);
  const sheetName = await resolveSheetName(sheetsUrl, providedSheetName);

  const imageUrlColumnIndex = await detectImageUrlColumn(spreadsheetId, sheetName);
  if (imageUrlColumnIndex === -1) {
    throw new Error(
      'Could not find a populated 16:9 image column. Expected a header such as "16.9 IMG" or "16:9 IMG".',
    );
  }

  const sheetsClient = await getSheetsClient();
  const headerRange = await buildSheetRange(sheetsClient, spreadsheetId, sheetName, 20);
  const headerResponse = await sheetsClient.spreadsheets.get({
    spreadsheetId,
    ranges: [headerRange],
    includeGridData: true,
  });

  let headerRowIndex = 0;
  let headerNames = [];
  const gridData = headerResponse.data.sheets?.[0]?.data?.[0];
  if (gridData && gridData.rowData) {
    headerRowIndex = findHeaderRowIndex(gridData.rowData);
    const headerRow = gridData.rowData[headerRowIndex]?.values || [];
    headerNames = headerRow.map((cell, idx) => {
      const text = cell?.userEnteredValue?.stringValue;
      return text || `Column${columnIndexToLetter(idx)}`;
    });
  }

  const imageUrlColumnName =
    headerNames[imageUrlColumnIndex] || `Column${columnIndexToLetter(imageUrlColumnIndex)}`;

  const rows = await readSheetRowsWithHyperlinks(spreadsheetId, sheetName);
  const sourceRows = rows
    .map((row, rowIndex) => ({
      row,
      rowNumber: row.__rowNumber || (headerRowIndex + 2 + rowIndex),
      imageUrl: normalizeUrl(row[imageUrlColumnName]),
    }))
    .filter((entry) => entry.imageUrl);
  const totalRows = sourceRows.length;

  // Read-only: never create the tab from a status poll.
  const variationRows = await readRowsIfPresent(
    sheetsClient,
    spreadsheetId,
    BATCH_VARIATIONS_SHEET,
    BATCH_VARIATION_HEADERS,
  );
  const summary = summarizeBatchVariations(variationRows || [], {
    spreadsheetId,
    sourceTab: sheetName,
    reviewBatchId,
    sourceImageUrlsByRow: Object.fromEntries(
      sourceRows.map((entry) => [entry.rowNumber, entry.imageUrl]),
    ),
  });

  let completedRows = 0;
  const completedMap = {};

  for (const { rowNumber } of sourceRows) {
    const variation = summary.rows[rowNumber];
    if (variation?.status === 'completed') {
      completedRows += 1;
      completedMap[rowNumber] = {
        status: 'completed',
        links: variation.links,
      };
    }
  }

  return {
    totalRows,
    completedRows,
    remainingRows: Math.max(0, totalRows - completedRows),
    batchComplete: totalRows > 0 && completedRows === totalRows,
    rows: completedMap,
    ...(summary.reviewBatchId && { reviewBatchId: summary.reviewBatchId }),
  };
};

/**
 * Main batch processing function
 * Processes all rows in a Google Sheet, generates variations, uploads to Drive,
 * and updates the sheet with links
 *
 * Uses a FIXED Drive folder for all uploads: 0APcMUrimfyziUk9PVA
 *
 * Options: {
 *   sheetsUrl: string,
 *   baseUrl: string (e.g., "http://localhost:8080"),
 *   onProgress: (progress) => void callback
 * }
 *
 * Progress object: {
 *   totalRows: number,
 *   currentRow: number,
 *   rowIndex: number,
 *   status: 'downloading' | 'generating' | 'uploading' | 'completed' | 'error',
 *   imageUrl: string,
 *   rowData: object,
 *   error?: string,
 *   results?: { ratio: '1:1' | '9:16', links: string[] }
 * }
 */
export const processBatch = async (options) => {
  const {
    sheetsUrl,
    sheetName: providedSheetName,
    driveFolderUrl,
    driveFolderId,
    reviewBatchId: providedReviewBatchId,
    rowsPerRequest: providedRowsPerRequest,
    baseUrl = process.env.API_BASE_URL || 'http://localhost:8080',
    onProgress,
  } = options;
  let reviewMetadata = getReviewMetadata(options);
  let reviewBatchId = String(providedReviewBatchId || '').trim() || null;
  const rowsPerRequest = Math.min(
    10,
    Math.max(1, Number.parseInt(providedRowsPerRequest, 10) || DEFAULT_BATCH_ROWS_PER_REQUEST),
  );

  // FIXED Drive folder ID for all uploads (fallback if Photos fails)
  const FIXED_DRIVE_FOLDER_ID = '0APcMUrimfyziUk9PVA';
  const runtimeConfig = getCreativeLibraryConfig();
  // Review assets must stay in private Drive storage. Google Photos is kept
  // only for the legacy non-review batch workflow.
  const isReviewBatch = Boolean(reviewMetadata || reviewBatchId);
  const useGooglePhotos = runtimeConfig.preferGooglePhotosForBatch && !isReviewBatch;
  const PHOTOS_ALBUM_SHARE_URL =
    process.env.PHOTOS_ALBUM_SHARE_URL?.trim() || 'https://photos.app.goo.gl/RRWkcPWwPApyi5y6A';

  if (useGooglePhotos && !process.env.PHOTOS_ALBUM_SHARE_URL?.trim()) {
    console.warn(
      '[BATCH] PHOTOS_ALBUM_SHARE_URL is not set. If you want the album to stay public, share it manually in Google Photos and put that public link in .env.'
    );
  }

  let photosAlbumId = null;
  if (useGooglePhotos) {
    try {
      photosAlbumId = await resolveAlbumIdFromShareUrl(PHOTOS_ALBUM_SHARE_URL);
      console.log(`[BATCH] Google Photos album resolved: ${photosAlbumId}`);
    } catch (e) {
      console.warn(`[BATCH] Could not resolve Photos album, will fallback to Drive: ${e.message}`);
    }
  } else {
    console.log(isReviewBatch
      ? '[BATCH] Using private Drive links for review assets.'
      : '[BATCH] Using Drive for batch output links by default.');
  }

  try {
    console.log('[BATCH PROCESSOR] Starting batch process');
    console.log(`[BATCH] Input sheetsUrl: ${sheetsUrl}`);
    console.log(`[BATCH] Provided sheetName: ${providedSheetName || 'AUTO'}`);
    console.log(`[BATCH] Base URL: ${baseUrl}`);

    // Step 1: Validate inputs
    let spreadsheetId = '';
    try {
      spreadsheetId = extractSpreadsheetId(sheetsUrl);
      console.log(`[BATCH] Extracted spreadsheetId: ${spreadsheetId}`);
    } catch (error) {
      console.log(`[BATCH] ERROR extracting spreadsheetId: ${error.message}`);
      throw error;
    }

    let folderId = FIXED_DRIVE_FOLDER_ID;
    if (driveFolderId) {
      folderId = driveFolderId;
    } else if (driveFolderUrl) {
      folderId = extractFolderId(driveFolderUrl);
    }
    console.log(`[BATCH] Using Drive folder: ${folderId}`);

    // Step 2: Detect sheet name (use provided, URL gid, or find automatically)
    onProgress?.({
      state: 'detecting-sheet',
      message: 'Detecting sheet name...',
    });

    let sheetName = providedSheetName;
    if (!sheetName) {
      // If URL has gid, use it to find the sheet name
      const gid = extractSheetId(sheetsUrl);
      if (gid !== null) {
        console.log(`[BATCH] GID detected in URL: ${gid}. Resolving sheet name...`);
        const sheetsClient = await getSheetsClient();
        const meta = await sheetsClient.spreadsheets.get({
          spreadsheetId,
          fields: 'sheets(properties(sheetId,title))',
        });
        const match = meta.data.sheets?.find((s) => s.properties?.sheetId === gid);
        if (match?.properties?.title) {
          sheetName = match.properties.title;
          console.log(`[BATCH] Resolved sheet name from gid: "${sheetName}"`);
        }
      }

      if (!sheetName) {
        console.log('[BATCH] No sheet name provided, auto-detecting...');
        // Auto-detect: find first sheet with data
        sheetName = await findFirstSheetWithData(spreadsheetId);
        console.log(`[BATCH] Auto-detected sheet: "${sheetName}"`);
      }
    } else {
      console.log(`[BATCH] Using provided sheet: "${sheetName}"`);
    }

    if (reviewBatchId) {
      const existingReviewBatch = await getReviewBatch({
        sheetsUrl,
        batchId: reviewBatchId,
      });
      const sourceSheetId = String(existingReviewBatch?.source_sheet_id || '').trim();
      const sourceTab = String(existingReviewBatch?.source_tab || '').trim();
      const sourceType = String(existingReviewBatch?.source_type || '').trim();
      const status = String(existingReviewBatch?.status || '').trim().toLowerCase();
      if (sourceSheetId !== spreadsheetId) {
        throw new Error(`Review batch ${reviewBatchId} belongs to another spreadsheet.`);
      }
      if (sourceTab !== sheetName) {
        throw new Error(`Review batch ${reviewBatchId} belongs to source tab "${sourceTab}".`);
      }
      if (sourceType !== 'batch_sheets') {
        throw new Error(`Review batch ${reviewBatchId} is not a Batch from Sheets review.`);
      }
      if (!['draft', 'in_review'].includes(status)) {
        throw new Error(`Review batch ${reviewBatchId} cannot be resumed while it is ${status}.`);
      }
      // The existing batch is authoritative on resume. Never let a later
      // request silently change the title, category, plazas, or creator.
      reviewMetadata = {
        title: String(existingReviewBatch?.title || reviewMetadata?.title || '').trim(),
        category: String(existingReviewBatch?.category || reviewMetadata?.category || '').trim(),
        plazas: normalizePlazas(existingReviewBatch?.plazas || reviewMetadata?.plazas),
        createdBy: String(
          existingReviewBatch?.created_by
          || existingReviewBatch?.createdBy
          || reviewMetadata?.createdBy
          || '',
        ).trim(),
      };
    }

    onProgress?.({
      state: 'sheet-detected',
      message: `Using sheet: "${sheetName}"`,
      ...(reviewBatchId && { reviewBatchId }),
    });

    // Step 3: Detect which column contains image URLs (prefer column F)
    onProgress?.({
      state: 'detecting-column',
      message: 'Detecting image URL column...',
    });

    console.log('[BATCH] Running URL column detection...');
    const debugEnabled = process.env.BATCH_DEBUG === '1';
    const emitDebug = (message, data) => {
      if (!debugEnabled) return;
      onProgress?.({
        state: 'debug',
        message,
        ...data,
      });
    };

    const imageUrlColumnIndex = await detectImageUrlColumn(spreadsheetId, sheetName, emitDebug);

    console.log(`[BATCH] URL column detection result: ${imageUrlColumnIndex}`);
    if (imageUrlColumnIndex === -1) {
      console.log('[BATCH] ERROR: Could not find a populated 16:9 image column');
      throw new Error(
        'Could not find a populated 16:9 image column. Expected a header such as "16.9 IMG" or "16:9 IMG".',
      );
    }
    console.log(`[BATCH] SUCCESS: Found image URL column at index ${imageUrlColumnIndex}`);

    const columnLetter = columnIndexToLetter(imageUrlColumnIndex);
    onProgress?.({
      state: 'column-detected',
      message: `Using column ${columnLetter} for image URLs`,
      imageUrlColumnIndex,
    });

    // Step 3.5: Get column header name for the detected column
    console.log('[BATCH] Reading header row...');
    const sheetsClient = await getSheetsClient();
    const headerRange = await buildSheetRange(sheetsClient, spreadsheetId, sheetName, 20);
    const headerResponse = await sheetsClient.spreadsheets.get({
      spreadsheetId,
      ranges: [headerRange],
      includeGridData: true,
    });

    let imageUrlColumnName = columnLetter;
    let headerRowIndex = 0;
    const gridData = headerResponse.data.sheets?.[0]?.data?.[0];
    if (gridData && gridData.rowData) {
      // Find header row (keyword-aware)
      headerRowIndex = findHeaderRowIndex(gridData.rowData);

      const headerRow = gridData.rowData[headerRowIndex]?.values || [];
      const headerCell = headerRow[imageUrlColumnIndex];
      if (headerCell?.userEnteredValue?.stringValue) {
        imageUrlColumnName = headerCell.userEnteredValue.stringValue;
      }
    }

    const targetRatios = BATCH_ASPECT_RATIOS;

    // Step 4: Read all rows from sheet
    onProgress?.({
      state: 'reading-sheet',
      message: 'Reading Google Sheet...',
    });

    console.log('[BATCH] Reading sheet rows...');
    const rows = await readSheetRowsWithHyperlinks(spreadsheetId, sheetName);
    const sourceRows = rows
      .map((row, sourceIndex) => ({
        row,
        rowNumber: row.__rowNumber || (headerRowIndex + 2 + sourceIndex),
        imageUrl: normalizeUrl(row[imageUrlColumnName]),
      }))
      .filter((entry) => entry.imageUrl);
    const totalRows = sourceRows.length;
    console.log(`[BATCH] Read ${rows.length} data rows; ${totalRows} contain 16:9 source images`);

    if (totalRows === 0) {
      throw new Error(`No source image URLs found under "${imageUrlColumnName}".`);
    }

    if (reviewMetadata && !reviewBatchId) {
      const expectedSourceRows = totalRows;
      const expectedItemCount = expectedSourceRows * targetRatios.length * EXPECTED_VARIATIONS_PER_RATIO;
      const reviewBatch = await createReviewBatch({
        sheetsUrl,
        title: reviewMetadata.title,
        sourceType: 'batch_sheets',
        sourceSheetName: sheetName,
        sourceTab: sheetName,
        sourceSpreadsheetId: spreadsheetId,
        createdBy: reviewMetadata.createdBy,
        category: reviewMetadata.category,
        plazas: reviewMetadata.plazas,
        metadata: {
          expectedItemCount,
          expectedSourceRows,
          targetRatios,
          expectedVariantsPerRatio: EXPECTED_VARIATIONS_PER_RATIO,
        },
      });
      reviewBatchId = getCreatedReviewBatchId(reviewBatch);
      if (!reviewBatchId) {
        throw new Error('Review batch was created without an identifier.');
      }

      onProgress?.({
        state: 'review-batch-created',
        message: `Review batch ${reviewBatchId} created`,
        reviewBatchId,
      });
    }

    // Step 5: Prepare the output tab. The source sheet is read-only from here
    // on, so this is the only place batch output ever lands.
    const variationsSheetId = await ensureSheetWithHeaders(
      sheetsClient,
      spreadsheetId,
      BATCH_VARIATIONS_SHEET,
      BATCH_VARIATION_HEADERS,
    );
    await formatBatchVariationsSheet(sheetsClient, spreadsheetId, variationsSheetId);
    const variationsSheetUrl = canonicalSheetsUrl(spreadsheetId, variationsSheetId);
    const studioBaseUrl = process.env.CREATIVE_REVIEW_STUDIO_BASE_URL?.trim()
      || process.env.APP_BASE_URL?.trim()
      || baseUrl;
    const creativeReviewUrl = buildCreativeReviewUrl(studioBaseUrl, sheetsUrl, reviewBatchId);
    onProgress?.({
      state: 'variations-sheet-ready',
      message: `Writing variations to "${BATCH_VARIATIONS_SHEET}"`,
      variationsSheetUrl,
      ...(reviewBatchId && { reviewBatchId }),
    });

    const existingVariationRows = await readRowsIfPresent(
      sheetsClient,
      spreadsheetId,
      BATCH_VARIATIONS_SHEET,
      BATCH_VARIATION_HEADERS,
    );
    const existingSummary = summarizeBatchVariations(existingVariationRows || [], {
      spreadsheetId,
      sourceTab: sheetName,
      reviewBatchId,
      sourceImageUrlsByRow: Object.fromEntries(
        sourceRows.map((entry) => [entry.rowNumber, entry.imageUrl]),
      ),
    });
    const pendingSourceRows = sourceRows.filter(
      (entry) => existingSummary.rows[entry.rowNumber]?.status !== 'completed',
    );
    const rowsForRequest = pendingSourceRows.slice(0, rowsPerRequest);

    // Step 6: Process a bounded chunk. The browser opens the next request with
    // the same reviewBatchId until the persisted output says the batch is done.
    let failedRows = 0;

    console.log(
      `[BATCH] Processing ${rowsForRequest.length}/${pendingSourceRows.length} pending rows. `
      + `imageUrlColumnName="${imageUrlColumnName}", targetRatios=${targetRatios.join(',')}`,
    );

    for (let chunkIndex = 0; chunkIndex < rowsForRequest.length; chunkIndex++) {
      const { row, rowNumber, imageUrl } = rowsForRequest[chunkIndex];
      const currentRow = totalRows - pendingSourceRows.length + chunkIndex + 1;
      let uploadedLinks = createEmptyRatioLinks();
      let driveFileIds = createEmptyRatioLinks();
      let reviewRegistrationAttempted = false;

      try {
        console.log(`[BATCH] Row ${rowNumber}: imageUrl=${imageUrl ? imageUrl.substring(0, 60) : 'EMPTY'}`);

        // Download image
        onProgress?.({
          rowNumber,
          currentRow,
          totalRows,
          status: 'downloading',
          imageUrl,
          rowData: row,
        });

        console.log(`[BATCH] Row ${rowNumber}: downloading image...`);
        const imageDataUrl = await downloadImageAsDataUrl(imageUrl);
        console.log(`[BATCH] Row ${rowNumber}: download complete, size=${imageDataUrl?.length ?? 0}`);

        const generatedImagesByRatio = {};
        for (const ratio of targetRatios) {
          onProgress?.({
            rowNumber,
            currentRow,
            totalRows,
            status: 'generating',
            ratio,
            rowData: row,
          });

          const { images, errors: generationErrors } = await generateAspectRatioImages(
            imageDataUrl,
            ratio,
            {
              profile: ASPECT_RATIO_PROMPT_PROFILE,
              maxAttemptsPerVariation: 2,
            },
          );
          generatedImagesByRatio[ratio] = assertCompleteRatioVariations({
            images,
            ratio,
            rowNumber,
            errors: generationErrors,
          });
        }

        // Upload all variations to Drive
        onProgress?.({
          rowNumber,
          currentRow,
          totalRows,
          status: 'uploading',
          rowData: row,
        });

        for (const ratio of targetRatios) {
          const images = generatedImagesByRatio[ratio] || [];
          for (let i = 0; i < images.length; i++) {
            const fileName = `${row.Categoria || 'image'}_${row.Ciudad || 'city'}_${getRatioFileSlug(ratio)}_var${i + 1}.png`;
            let link;
            let fileId = '';
            if (photosAlbumId) {
              link = await uploadImageToPhotos(images[i], fileName, photosAlbumId);
            } else {
              const upload = await uploadImageToDrive(images[i], fileName, folderId);
              fileId = upload.fileId;
              link = isReviewBatch
                ? await getShareableLink(upload.fileId)
                : await makeFilePublic(upload.fileId);
            }
            uploadedLinks[ratio].push(link);
            driveFileIds[ratio].push(fileId);
          }
        }

        let reviewItemIds = [];
        if (reviewBatchId) {
          const reviewItems = buildBatchReviewItems({
            batchId: reviewBatchId,
            spreadsheetId,
            sheetName,
            row,
            rowNumber,
            referenceUrl: imageUrl,
            uploadedLinks,
            category: reviewMetadata?.category,
            plazas: reviewMetadata?.plazas,
          });
          reviewRegistrationAttempted = true;
          const registration = await registerReviewItems({
            sheetsUrl,
            batchId: reviewBatchId,
            items: reviewItems,
          });
          reviewItemIds = orderRegisteredReviewItemIds(reviewItems, registration?.items || []);
        }

        // Write the row's variations only once its review items exist, so the
        // tab never advertises pieces the review portal does not know about.
        await appendRows(
          sheetsClient,
          spreadsheetId,
          BATCH_VARIATIONS_SHEET,
          BATCH_VARIATION_HEADERS,
          buildBatchVariationRows({
            batchId: reviewBatchId,
            batchTitle: reviewMetadata?.title || '',
            creativeReviewUrl,
            spreadsheetId,
            sourceTab: sheetName,
            rowNumber,
            sourceImageUrl: imageUrl,
            familyId: reviewBatchId ? `${reviewBatchId}:row:${rowNumber}` : '',
            uploadedLinks,
            driveFileIds,
            reviewItemIds,
            category: reviewMetadata?.category || row.Categoria || '',
            plazas: reviewMetadata?.plazas || row.Ciudad || '',
          }),
        );

        onProgress?.({
          rowNumber,
          currentRow,
          totalRows,
          status: 'completed',
          links: uploadedLinks,
          rowData: row,
          ...(reviewBatchId && { reviewBatchId }),
        });
      } catch (error) {
        failedRows += 1;
        // Nothing was appended for this row, so batch_variations stays clean.
        // Still register whatever was uploaded so orphan Drive files remain
        // traceable in the review tab.
        if (reviewBatchId && !reviewRegistrationAttempted) {
          const partiallyUploadedItems = buildBatchReviewItems({
            batchId: reviewBatchId,
            spreadsheetId,
            sheetName,
            row,
            rowNumber,
            referenceUrl: imageUrl,
            uploadedLinks,
            category: reviewMetadata?.category,
            plazas: reviewMetadata?.plazas,
          });
          if (partiallyUploadedItems.length > 0) {
            try {
              await registerReviewItems({
                sheetsUrl,
                batchId: reviewBatchId,
                items: partiallyUploadedItems,
              });
            } catch (registrationError) {
              console.error(
                `[BATCH] Could not register partially uploaded row ${rowNumber}: ${registrationError.message}`
              );
            }
          }
        }
        onProgress?.({
          rowNumber,
          currentRow,
          totalRows,
          status: 'error',
          error: error.message,
          rowData: row,
          ...(reviewBatchId && { reviewBatchId }),
        });
      }
    }

    if (failedRows > 0) {
      throw new Error(
        `Batch${reviewBatchId ? ` review ${reviewBatchId}` : ''} is incomplete: ${failedRows} source row(s) failed.`,
      );
    }

    const finalVariationRows = await readRowsIfPresent(
      sheetsClient,
      spreadsheetId,
      BATCH_VARIATIONS_SHEET,
      BATCH_VARIATION_HEADERS,
    );
    const finalSummary = summarizeBatchVariations(finalVariationRows || [], {
      spreadsheetId,
      sourceTab: sheetName,
      reviewBatchId,
      sourceImageUrlsByRow: Object.fromEntries(
        sourceRows.map((entry) => [entry.rowNumber, entry.imageUrl]),
      ),
    });
    const completedRows = sourceRows.filter(
      (entry) => finalSummary.rows[entry.rowNumber]?.status === 'completed',
    ).length;
    const remainingRows = Math.max(0, totalRows - completedRows);
    const batchComplete = remainingRows === 0;

    onProgress?.({
      state: batchComplete ? 'batch-completed' : 'chunk-completed',
      message: batchComplete
        ? 'Batch processing completed successfully'
        : `Chunk completed. ${remainingRows} source row(s) remain.`,
      totalRows,
      completedRows,
      remainingRows,
      batchComplete,
      variationsSheetUrl,
      ...(reviewBatchId && { reviewBatchId }),
    });

    return {
      success: true,
      totalRows,
      processedRows: completedRows,
      completedRows,
      remainingRows,
      batchComplete,
      variationsSheetUrl,
      ...(reviewBatchId && { reviewBatchId }),
    };
  } catch (error) {
    console.error('Batch processing error:', error);
    onProgress?.({
      state: 'error',
      error: error.message,
    });

    throw error;
  }
};
