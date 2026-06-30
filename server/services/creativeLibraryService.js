import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  CREATIVE_AUDIT_HEADERS,
  CREATIVE_AUDIT_SHEET,
  CREATIVE_CATEGORIES_HEADERS,
  CREATIVE_CATEGORIES_SHEET,
  CREATIVE_LIBRARY_HEADERS,
  CREATIVE_LIBRARY_SHEET,
  SOURCE_STATUS_COLUMNS,
  getCreativeLibraryConfig,
} from './creativeLibraryConfig.js';
import {
  classifyBackgroundColor,
  dataUrlToBuffer,
  detectCategoryFromName,
  detectPlazasFromName,
  extractUrlFromFormula,
  getCellText,
  getCellUrl,
  hashBuffer,
  isCreativeAvailableForPlatform,
  normalizeCategory,
  normalizeHeader,
  normalizeUrl,
  sanitizeFileName,
} from './creativeLibraryCore.js';
import {
  columnIndexToLetter,
  extractSheetId,
  extractSpreadsheetId,
} from './sheetsService.js';
import { getSheetsClient } from './googleAuth.js';
import { findOrCreateDriveFolder, makeFilePublic, uploadBufferToDrive } from './driveService.js';
import { downloadImageAsDataUrl } from './batchProcessor.js';
import {
  classifyAspectRatio,
  formatResolution,
  getImageResolutionFromBuffer,
  getImageResolutionFromDataUrl,
} from './imageRatio.js';

const DEFAULT_MAX_ROWS = Number(process.env.CREATIVE_LIBRARY_MAX_SCAN_ROWS || 500);
export const CREATIVE_LIBRARY_SYNC_LOG_PATH =
  process.env.CREATIVE_LIBRARY_SYNC_LOG_PATH ||
  path.join(process.env.TMP || process.env.TEMP || 'C:\\tmp', 'cabify-creative-library-sync.log');

const quoteSheetName = (sheetName) => `'${String(sheetName).replace(/'/g, "''")}'`;

const buildRange = (sheetName, a1) => `${quoteSheetName(sheetName)}!${a1}`;

const nowIso = () => new Date().toISOString();

const getErrorLogDetails = (error) => ({
  message: error?.message || String(error),
  status: error?.response?.status || error?.code || null,
  data: error?.response?.data || null,
});

export const writeCreativeLibrarySyncLog = (level, message, details = {}) => {
  const payload = {
    timestamp: nowIso(),
    level,
    message,
    ...details,
  };

  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(`[CREATIVE_LIBRARY] ${message}`, details);
  } else {
    console.log(`[CREATIVE_LIBRARY] ${message}`, details);
  }

  try {
    mkdirSync(path.dirname(CREATIVE_LIBRARY_SYNC_LOG_PATH), { recursive: true });
    appendFileSync(CREATIVE_LIBRARY_SYNC_LOG_PATH, `${line}\n`, 'utf8');
  } catch (error) {
    console.warn('[CREATIVE_LIBRARY] Could not write sync log', error?.message || error);
  }
};

const writeSyncLog = writeCreativeLibrarySyncLog;

const rowToObject = (headers, values, rowNumber) => {
  const object = { __rowNumber: rowNumber };
  headers.forEach((header, index) => {
    object[header] = values[index] ?? '';
  });
  return object;
};

const valuesToObjects = (values) => {
  if (!Array.isArray(values) || values.length === 0) return [];
  const headers = values[0] || [];
  return values.slice(1).map((row, index) => rowToObject(headers, row || [], index + 2));
};

const objectToRow = (headers, object) => headers.map((header) => object[header] ?? '');

const LIBRARY_HYPERLINK_COLUMNS = [
  { header: 'resized_image_url', label: 'Source image' },
  { header: 'drive_url', label: 'Drive file' },
];

const escapeFormulaString = (value) => String(value || '').replace(/"/g, '""');

const buildHyperlinkFormula = (url, label) =>
  `=HYPERLINK("${escapeFormulaString(url)}","${escapeFormulaString(label)}")`;

const getUrlFromSheetValue = (value) =>
  extractUrlFromFormula(value) || normalizeUrl(value) || '';

const objectToLibraryRow = (object) =>
  CREATIVE_LIBRARY_HEADERS.map((header) => {
    const hyperlinkColumn = LIBRARY_HYPERLINK_COLUMNS.find((column) => column.header === header);
    const value = object[header] ?? '';
    if (!hyperlinkColumn) return value;

    const url = getUrlFromSheetValue(value);
    return url ? buildHyperlinkFormula(url, hyperlinkColumn.label) : value;
  });

const normalizeLibraryLinkFields = (row) => {
  for (const { header } of LIBRARY_HYPERLINK_COLUMNS) {
    const url = getUrlFromSheetValue(row[header]);
    if (url) row[header] = url;
  }

  if (!row.used_at_google && row.used_at) {
    row.used_at_google = row.used_at;
  }
  if (row.used_at_meta === undefined) {
    row.used_at_meta = '';
  }

  return row;
};

const findHeaderRowIndex = (rowData) => {
  const maxRows = Math.min(rowData?.length || 0, 20);
  let bestIndex = -1;
  let bestScore = 0;

  for (let rowIndex = 0; rowIndex < maxRows; rowIndex++) {
    const cells = rowData[rowIndex]?.values || [];
    const texts = cells.map(getCellText).filter(Boolean);
    const normalized = texts.map(normalizeHeader);
    const score =
      texts.length +
      normalized.filter((text) =>
        ['campaign', 'campana', 'campaña', 'categoria', 'category', 'plaza', 'plazas', 'ciudad', 'copy', 'preview', 'image', 'imagen', '1:1', '9:16', '1.91', '1200x628', 'landscape'].some((keyword) =>
          text.includes(keyword),
        ),
      ).length * 2;

    if (score > bestScore) {
      bestIndex = rowIndex;
      bestScore = score;
    }
  }

  return bestIndex;
};

const getSheetMetadata = async (sheets, spreadsheetId) => {
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),merges)',
  });

  return response.data.sheets || [];
};

const getSheetByTitle = (metadata, title) =>
  metadata.find((sheet) => sheet.properties?.title === title);

const normalizeSheetTitleForMatch = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s*\|\s*/g, '|')
    .replace(/\s+/g, ' ');

const HEADER_ALIASES = {
  creative_family_id: ['creative_family_id', 'creative_family', 'family_id', 'creative_set_id', 'set_id'],
  used_at_google: ['used_at_google', 'used_at'],
};

export const migrateRowsToHeaders = (values, targetHeaders) => {
  if (!Array.isArray(values) || values.length <= 1) return [];

  const sourceHeaders = values[0] || [];
  const sourceIndexes = new Map();
  sourceHeaders.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    if (normalized && !sourceIndexes.has(normalized)) sourceIndexes.set(normalized, index);
  });

  return values.slice(1).map((row) =>
    targetHeaders.map((header) => {
      const aliases = HEADER_ALIASES[normalizeHeader(header)] || [header];
      const sourceIndex = aliases
        .map((alias) => sourceIndexes.get(normalizeHeader(alias)))
        .find((index) => index !== undefined);
      return sourceIndex === undefined ? '' : row?.[sourceIndex] ?? '';
    }),
  );
};

const findSheetByNormalizedTitle = (metadata, title) => {
  const target = normalizeSheetTitleForMatch(title);
  if (!target) return null;
  return metadata.find((sheet) => normalizeSheetTitleForMatch(sheet.properties?.title) === target) || null;
};

const resolveSourceSheetName = async (sheets, spreadsheetId, sheetsUrl, providedSheetName, config) => {
  const gid = extractSheetId(sheetsUrl);
  const metadata = await getSheetMetadata(sheets, spreadsheetId);

  if (providedSheetName) {
    const exactMatch = getSheetByTitle(metadata, providedSheetName);
    if (exactMatch?.properties?.title) return exactMatch.properties.title;

    const normalizedMatch = findSheetByNormalizedTitle(metadata, providedSheetName);
    if (normalizedMatch?.properties?.title) return normalizedMatch.properties.title;

    return providedSheetName;
  }

  for (const preferredTitle of config.sourceSheets || []) {
    const match = findSheetByNormalizedTitle(metadata, preferredTitle);
    if (match?.properties?.title) return match.properties.title;
  }

  if (gid !== null) {
    const match = metadata.find((sheet) => sheet.properties?.sheetId === gid);
    if (match?.properties?.title) return match.properties.title;
  }

  const sourceCandidate = metadata.find((sheet) => {
    const title = sheet.properties?.title;
    return title && ![CREATIVE_LIBRARY_SHEET, CREATIVE_AUDIT_SHEET, CREATIVE_CATEGORIES_SHEET].includes(title);
  });

  return sourceCandidate?.properties?.title || 'Sheet1';
};

const ensureSheetWithHeaders = async (sheets, spreadsheetId, sheetName, headers) => {
  let metadata = await getSheetMetadata(sheets, spreadsheetId);
  let sheet = getSheetByTitle(metadata, sheetName);

  if (!sheet) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: sheetName,
                gridProperties: {
                  rowCount: 1000,
                  columnCount: Math.max(headers.length, 26),
                },
              },
            },
          },
        ],
      },
    });
    metadata = await getSheetMetadata(sheets, spreadsheetId);
    sheet = getSheetByTitle(metadata, sheetName);
  }

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: buildRange(sheetName, 'A1:ZZ1'),
  });

  const currentHeaders = existing.data.values?.[0] || [];
  const shouldWriteHeaders =
    currentHeaders.length < headers.length ||
    headers.some((header, index) => currentHeaders[index] !== header);

  if (shouldWriteHeaders) {
    const dataColumnCount = Math.max(headers.length, currentHeaders.length || headers.length);
    const existingValues = currentHeaders.length > 0
      ? await sheets.spreadsheets.values.get({
          spreadsheetId,
          range: buildRange(sheetName, `A1:${columnIndexToLetter(dataColumnCount - 1)}`),
          valueRenderOption: 'FORMULA',
        })
      : null;
    const migratedRows = migrateRowsToHeaders(existingValues?.data?.values || [], headers);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: buildRange(sheetName, `A1:${columnIndexToLetter(headers.length - 1)}${Math.max(1, migratedRows.length + 1)}`),
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [headers, ...migratedRows] },
    });
  }

  return sheet?.properties?.sheetId;
};

const splitCategoryKeywords = (value) =>
  String(value || '')
    .split(/[\n,;|]+/)
    .map((keyword) => keyword.trim())
    .filter(Boolean);

const isCategoryRowActive = (value) => {
  const text = String(value ?? '').trim().toLowerCase();
  return !['false', 'no', '0', 'inactive', 'disabled'].includes(text);
};

const getConfigKeywordsForCategory = (config, category) => {
  const categoryKey = String(category).toLowerCase();
  return config.categoryMapping[category] || config.categoryMapping[categoryKey] || [category];
};

const defaultCategoryRows = (config) =>
  config.categories.map((category) => ({
    category,
    keywords: getConfigKeywordsForCategory(config, category).join(', '),
    active: 'TRUE',
    notes: '',
  }));

const appendCategoryRows = async (sheets, spreadsheetId, rows) => {
  if (rows.length === 0) return;

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: buildRange(CREATIVE_CATEGORIES_SHEET, 'A:D'),
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: rows.map((row) => objectToRow(CREATIVE_CATEGORIES_HEADERS, row)),
    },
  });
};

const readCategoryRows = async (sheets, spreadsheetId) => {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: buildRange(CREATIVE_CATEGORIES_SHEET, 'A:D'),
    });

    return valuesToObjects(response.data.values || []);
  } catch {
    return [];
  }
};

const buildConfigFromCategoryRows = (baseConfig, rows) => {
  const activeRows = rows.filter((row) => row.category && isCategoryRowActive(row.active));
  if (activeRows.length === 0) return baseConfig;

  const categories = [...new Set(activeRows.map((row) => String(row.category).trim()).filter(Boolean))];
  const categoryMapping = { ...baseConfig.categoryMapping };

  for (const row of activeRows) {
    const category = String(row.category).trim();
    const keywords = splitCategoryKeywords(row.keywords);
    const finalKeywords = keywords.length > 0 ? keywords : [category];
    categoryMapping[category] = finalKeywords;
    categoryMapping[category.toLowerCase()] = finalKeywords;
  }

  return {
    ...baseConfig,
    categories,
    categoryMapping,
  };
};

const getCreativeConfigForSpreadsheet = async (sheets, spreadsheetId) => {
  const baseConfig = getCreativeLibraryConfig();
  await ensureSheetWithHeaders(sheets, spreadsheetId, CREATIVE_CATEGORIES_SHEET, CREATIVE_CATEGORIES_HEADERS);

  let rows = await readCategoryRows(sheets, spreadsheetId);
  if (rows.length === 0) {
    const defaults = defaultCategoryRows(baseConfig);
    await appendCategoryRows(sheets, spreadsheetId, defaults);
    rows = defaults;
  }

  return buildConfigFromCategoryRows(baseConfig, rows);
};

const getValidationPlazas = (config) =>
  [...new Set((config.plazas || []).map((plaza) => String(plaza).trim().toUpperCase()).filter(Boolean))];

export const getCreativeLibrarySheetConfig = async ({ sheetsUrl }) => {
  if (typeof sheetsUrl !== 'string' || sheetsUrl.trim().length === 0) {
    throw new Error('sheetsUrl is required.');
  }

  const spreadsheetId = extractSpreadsheetId(sheetsUrl.trim());
  const sheets = await getSheetsClient();
  const config = await getCreativeConfigForSpreadsheet(sheets, spreadsheetId);

  return {
    spreadsheetId,
    categories: config.categories,
    plazas: getValidationPlazas(config),
    categoryMapping: config.categoryMapping,
    config,
  };
};

const applyListValidation = async ({
  sheets,
  spreadsheetId,
  sheetId,
  columnIndex,
  headerRowIndex,
  values,
  inputMessage,
  strict = true,
}) => {
  if (columnIndex === undefined || columnIndex === null || columnIndex < 0 || values.length === 0) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          setDataValidation: {
            range: {
              sheetId,
              startRowIndex: headerRowIndex + 1,
              endRowIndex: Math.max(headerRowIndex + 1000, headerRowIndex + 2),
              startColumnIndex: columnIndex,
              endColumnIndex: columnIndex + 1,
            },
            rule: {
              condition: {
                type: 'ONE_OF_LIST',
                values: values.map((value) => ({ userEnteredValue: value })),
              },
              inputMessage,
              strict,
              showCustomUi: true,
            },
          },
        },
      ],
    },
  });
};

const applyCategoryValidation = async (sheets, spreadsheetId, sheetId, categoryColumnIndex, headerRowIndex, config) =>
  applyListValidation({
    sheets,
    spreadsheetId,
    sheetId,
    columnIndex: categoryColumnIndex,
    headerRowIndex,
    values: config.categories,
    inputMessage: 'Select a creative category.',
    strict: true,
  });

const applyPlazasValidation = async (sheets, spreadsheetId, sheetId, plazasColumnIndex, headerRowIndex, config) =>
  applyListValidation({
    sheets,
    spreadsheetId,
    sheetId,
    columnIndex: plazasColumnIndex,
    headerRowIndex,
    values: getValidationPlazas(config),
    inputMessage: 'Select a plaza. Use ALL for general creatives, or enter multiple codes separated by commas.',
    strict: false,
  });

const ensureLibraryAndAuditSheets = async (sheets, spreadsheetId, config) => {
  const librarySheetId = await ensureSheetWithHeaders(
    sheets,
    spreadsheetId,
    CREATIVE_LIBRARY_SHEET,
    CREATIVE_LIBRARY_HEADERS,
  );

  await ensureSheetWithHeaders(sheets, spreadsheetId, CREATIVE_AUDIT_SHEET, CREATIVE_AUDIT_HEADERS);

  if (librarySheetId !== undefined && librarySheetId !== null) {
    await applyCategoryValidation(
      sheets,
      spreadsheetId,
      librarySheetId,
      CREATIVE_LIBRARY_HEADERS.indexOf('category'),
      0,
      config,
    );
    await applyPlazasValidation(
      sheets,
      spreadsheetId,
      librarySheetId,
      CREATIVE_LIBRARY_HEADERS.indexOf('plazas'),
      0,
      config,
    );
  }
};

const SOURCE_COLUMN_ALIASES = {
  creative_family_id: [
    'creative_family_id',
    'creative_family',
    'family_id',
    'familia',
    'id_familia',
    'creative_set_id',
    'set_id',
  ],
  category: ['category', 'categoria', 'categoría'],
  plazas: [
    'plazas',
    'plaza',
    'ciudad',
    'city',
    'cities',
    'mercado',
    'market',
    'markets',
    'geo',
    'geografia',
    'region',
  ],
};

const setSourceColumnIndex = (normalizedToIndex, header, index) => {
  const aliases = SOURCE_COLUMN_ALIASES[normalizeHeader(header)] || [header];
  for (const alias of aliases) {
    normalizedToIndex.set(normalizeHeader(alias), index);
  }
};

const getSourceColumnIndex = (normalizedToIndex, header) => {
  const aliases = SOURCE_COLUMN_ALIASES[normalizeHeader(header)] || [header];
  for (const alias of aliases) {
    const index = normalizedToIndex.get(normalizeHeader(alias));
    if (index !== undefined) return index;
  }
  return undefined;
};

export const buildSourceColumnIndex = (headers) => {
  const normalizedToIndex = new Map();
  headers.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    if (normalized && !normalizedToIndex.has(normalized)) normalizedToIndex.set(normalized, index);

    for (const [canonicalHeader, aliases] of Object.entries(SOURCE_COLUMN_ALIASES)) {
      if (aliases.some((alias) => normalizeHeader(alias) === normalized)) {
        setSourceColumnIndex(normalizedToIndex, canonicalHeader, index);
      }
    }
  });
  return normalizedToIndex;
};

const moveHeaderColumn = (headers, sourceIndex, destinationIndex) => {
  const nextHeaders = [...headers];
  const [header] = nextHeaders.splice(sourceIndex, 1);
  const insertionIndex = sourceIndex < destinationIndex ? destinationIndex - 1 : destinationIndex;
  nextHeaders.splice(insertionIndex, 0, header);
  return nextHeaders;
};

const ensureSourceColumns = async (sheets, spreadsheetId, sourceSheet, headerRowIndex, headers, config) => {
  const sheetId = sourceSheet.properties.sheetId;
  let normalizedToIndex = buildSourceColumnIndex(headers);
  let nextHeaders = [...headers];
  const dimensionRequests = [];
  let shouldWriteHeaders = false;

  let categoryColumnIndex = getSourceColumnIndex(normalizedToIndex, 'category');
  if (categoryColumnIndex === undefined) {
    categoryColumnIndex = nextHeaders.length;
    nextHeaders.push('category');
    shouldWriteHeaders = true;
    normalizedToIndex = buildSourceColumnIndex(nextHeaders);
  }

  let plazasColumnIndex = getSourceColumnIndex(normalizedToIndex, 'plazas');
  const targetPlazasColumnIndex = categoryColumnIndex + 1;
  if (plazasColumnIndex === undefined) {
    plazasColumnIndex = targetPlazasColumnIndex;
    if (targetPlazasColumnIndex < nextHeaders.length) {
      dimensionRequests.push({
        insertDimension: {
          range: {
            sheetId,
            dimension: 'COLUMNS',
            startIndex: targetPlazasColumnIndex,
            endIndex: targetPlazasColumnIndex + 1,
          },
          inheritFromBefore: true,
        },
      });
      nextHeaders.splice(targetPlazasColumnIndex, 0, 'plazas');
    } else {
      nextHeaders.push('plazas');
    }
    shouldWriteHeaders = true;
  } else {
    if (nextHeaders[plazasColumnIndex] !== 'plazas') {
      nextHeaders[plazasColumnIndex] = 'plazas';
      shouldWriteHeaders = true;
    }

    if (plazasColumnIndex !== targetPlazasColumnIndex) {
      dimensionRequests.push({
        moveDimension: {
          source: {
            sheetId,
            dimension: 'COLUMNS',
            startIndex: plazasColumnIndex,
            endIndex: plazasColumnIndex + 1,
          },
          destinationIndex: targetPlazasColumnIndex,
        },
      });
      nextHeaders = moveHeaderColumn(nextHeaders, plazasColumnIndex, targetPlazasColumnIndex);
      shouldWriteHeaders = true;
    }
  }

  normalizedToIndex = buildSourceColumnIndex(nextHeaders);

  for (const header of SOURCE_STATUS_COLUMNS) {
    if (getSourceColumnIndex(normalizedToIndex, header) !== undefined) continue;
    nextHeaders.push(header);
    shouldWriteHeaders = true;
    normalizedToIndex = buildSourceColumnIndex(nextHeaders);
  }

  if (dimensionRequests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: dimensionRequests },
    });
  }

  if (shouldWriteHeaders) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: buildRange(
        sourceSheet.properties.title,
        `A${headerRowIndex + 1}:${columnIndexToLetter(nextHeaders.length - 1)}${headerRowIndex + 1}`,
      ),
      valueInputOption: 'RAW',
      requestBody: { values: [nextHeaders] },
    });
  }

  normalizedToIndex = buildSourceColumnIndex(nextHeaders);
  categoryColumnIndex = normalizedToIndex.get('category');
  plazasColumnIndex = normalizedToIndex.get('plazas');
  await applyCategoryValidation(
    sheets,
    spreadsheetId,
    sheetId,
    categoryColumnIndex,
    headerRowIndex,
    config,
  );
  await applyPlazasValidation(
    sheets,
    spreadsheetId,
    sheetId,
    plazasColumnIndex,
    headerRowIndex,
    config,
  );

  return { headers: nextHeaders, columnIndexes: Object.fromEntries(normalizedToIndex) };
};

const loadSourceGrid = async (sheets, spreadsheetId, sourceSheetName) => {
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    ranges: [buildRange(sourceSheetName, `A1:ZZ${DEFAULT_MAX_ROWS}`)],
    includeGridData: true,
  });

  return response.data.sheets?.[0]?.data?.[0]?.rowData || [];
};

const normalizeOutputHeader = (header) =>
  normalizeHeader(header)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const isRatioOutputHeader = (header, width, height) =>
  new RegExp(`(^|[^0-9])${width}[:.x/_-]+${height}([^0-9]|$)`, 'i').test(normalizeOutputHeader(header));

const isSixteenNineOutputHeader = (header) => {
  const normalized = normalizeOutputHeader(header);
  return (
    isRatioOutputHeader(normalized, 16, 9) ||
    normalized.includes('1920x1080') ||
    normalized.includes('video')
  );
};

const isOutputImageHeader = (header) =>
  isRatioOutputHeader(header, 1, 1) ||
  isRatioOutputHeader(header, 9, 16) ||
  isSixteenNineOutputHeader(header) ||
  header.includes('1.91:1') ||
  header.includes('1.91') ||
  header.includes('1200x628') ||
  header.includes('landscape');

export const findOutputColumns = (headers) => {
  const outputColumns = new Set();
  const normalizedHeaders = headers.map(normalizeHeader);
  const isBlankOrGeneratedHeader = (header) => !header || /^column[a-z]+$/i.test(header);

  normalizedHeaders.forEach((header, index) => {
    if (!isOutputImageHeader(header)) return;

    outputColumns.add(index);
    for (let nextIndex = index + 1; nextIndex < normalizedHeaders.length; nextIndex++) {
      if (!isBlankOrGeneratedHeader(normalizedHeaders[nextIndex])) break;
      outputColumns.add(nextIndex);
    }
  });

  return [...outputColumns].sort((left, right) => left - right);
};

export const resolveOutputReviewStatus = ({ cell, columnHeader, rowHasAcceptedOutput, config }) => {
  const reviewStatus = classifyBackgroundColor(cell, config);
  if (reviewStatus === 'PENDING' && rowHasAcceptedOutput && isSixteenNineOutputHeader(columnHeader)) {
    return 'ACCEPTED';
  }

  return reviewStatus;
};

const readLibraryRows = async (sheets, spreadsheetId) => {
  try {
    const lastColumn = columnIndexToLetter(CREATIVE_LIBRARY_HEADERS.length - 1);
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: buildRange(CREATIVE_LIBRARY_SHEET, `A:${lastColumn}`),
      valueRenderOption: 'FORMULA',
    });

    return valuesToObjects(response.data.values || []).map(normalizeLibraryLinkFields);
  } catch {
    return [];
  }
};

const appendLibraryRows = async (sheets, spreadsheetId, rows) => {
  if (rows.length === 0) return;

  const lastColumn = columnIndexToLetter(CREATIVE_LIBRARY_HEADERS.length - 1);
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: buildRange(CREATIVE_LIBRARY_SHEET, `A:${lastColumn}`),
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: rows.map((row) => objectToLibraryRow(row)),
    },
  });
};

const formatLibraryHyperlinkColumns = async (sheets, spreadsheetId, libraryRows) => {
  const updates = [];

  for (const row of libraryRows) {
    for (const { header, label } of LIBRARY_HYPERLINK_COLUMNS) {
      const columnIndex = CREATIVE_LIBRARY_HEADERS.indexOf(header);
      if (columnIndex < 0) continue;

      const url = getUrlFromSheetValue(row[header]);
      if (!url) continue;

      updates.push({
        range: buildRange(CREATIVE_LIBRARY_SHEET, `${columnIndexToLetter(columnIndex)}${row.__rowNumber}`),
        values: [[buildHyperlinkFormula(url, label)]],
      });
      row[header] = url;
    }
  }

  if (updates.length === 0) return;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: updates,
    },
  });
};

const getCanonicalCreativeCategory = (value, config) =>
  normalizeCategory(value, config.categories) || config.categories[0] || '';

const buildSourceRowCategoryText = (cells, headers = [], sourceSheetName = '') => {
  const parts = [sourceSheetName];
  cells.forEach((cell, index) => {
    const text = getCellText(cell);
    if (!text) return;
    const header = headers[index] || '';
    parts.push(header ? `${header}: ${text}` : text);
  });
  return parts.join(' | ');
};

const normalizeHeaderForMatch = (value) =>
  normalizeHeader(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const isCampaignHeader = (header) => {
  const normalized = normalizeHeaderForMatch(header);
  return normalized.includes('campaign') || normalized.includes('campana');
};

const isPlazasHeader = (header) => {
  const normalized = normalizeHeaderForMatch(header);
  return SOURCE_COLUMN_ALIASES.plazas.some((alias) => normalizeHeaderForMatch(alias) === normalized);
};

const buildSourceRowCampaignText = (cells, headers = []) => {
  const parts = [];
  cells.forEach((cell, index) => {
    if (!isCampaignHeader(headers[index] || '')) return;
    const text = getCellText(cell);
    if (text) parts.push(text);
  });
  return parts.join(' | ');
};

const buildSourceRowPlazasText = (cells, headers = []) => {
  const parts = [];
  cells.forEach((cell, index) => {
    if (!isPlazasHeader(headers[index] || '')) return;
    const text = getCellText(cell);
    if (text) parts.push(text);
  });
  return parts.join(' | ');
};

const inferCategoryFromSourceRow = (cells, headers, sourceSheetName, config) =>
  detectCategoryFromName(buildSourceRowCategoryText(cells, headers, sourceSheetName), config).category;

const inferPlazasFromSourceRow = (cells, headers, sourceSheetName, config) =>
  detectPlazasFromName(
    [
      buildSourceRowPlazasText(cells, headers),
      buildSourceRowCampaignText(cells, headers),
    ]
      .filter(Boolean)
      .join(' | '),
    config,
  ).plazas;

const resolveCreativeCategory = ({
  explicitCategory,
  cells,
  headers,
  sourceSheetName,
  fallbackCategory,
  config,
}) =>
  normalizeCategory(explicitCategory, config.categories) ||
  inferCategoryFromSourceRow(cells || [], headers || [], sourceSheetName, config) ||
  fallbackCategory ||
  null;

export const resolveCreativePlazas = ({
  explicitPlazas,
  cells,
  headers,
  sourceSheetName,
  fallbackPlazas,
  config,
}) =>
  detectPlazasFromName(explicitPlazas, config).plazas ||
  String(explicitPlazas || '').trim() ||
  inferPlazasFromSourceRow(cells || [], headers || [], sourceSheetName, config) ||
  fallbackPlazas ||
  '';

const normalizeLibraryRowCategories = async (sheets, spreadsheetId, libraryRows, config) => {
  const categoryColumnIndex = CREATIVE_LIBRARY_HEADERS.indexOf('category');
  if (categoryColumnIndex < 0) return;

  const updates = [];
  const sourceGridCache = new Map();
  const sourceHeaderCache = new Map();

  const getSourceContext = async (sourceTab) => {
    if (!sourceTab) return { rowData: [], headers: [], headerRowIndex: -1 };
    if (!sourceGridCache.has(sourceTab)) {
      const rowData = await loadSourceGrid(sheets, spreadsheetId, sourceTab);
      const headerRowIndex = findHeaderRowIndex(rowData);
      const headers =
        headerRowIndex >= 0
          ? (rowData[headerRowIndex]?.values || []).map((cell) => getCellText(cell))
          : [];
      sourceGridCache.set(sourceTab, rowData);
      sourceHeaderCache.set(sourceTab, { headers, headerRowIndex });
    }

    return {
      rowData: sourceGridCache.get(sourceTab),
      ...sourceHeaderCache.get(sourceTab),
    };
  };

  for (const row of libraryRows) {
    const currentCategory = normalizeCategory(row.category, config.categories);
    const fallbackCategory = config.categories[0] || '';
    let inferredCategory = null;

    if (row.source_tab && row.source_row) {
      try {
        const { rowData, headers } = await getSourceContext(row.source_tab);
        const sourceRowIndex = Number(row.source_row) - 1;
        const sourceCells = rowData?.[sourceRowIndex]?.values || [];
        inferredCategory = inferCategoryFromSourceRow(sourceCells, headers, row.source_tab, config);
      } catch {
        inferredCategory = null;
      }
    }

    const canonicalCategory =
      currentCategory === fallbackCategory && inferredCategory && inferredCategory !== fallbackCategory
        ? inferredCategory
        : currentCategory || inferredCategory || getCanonicalCreativeCategory(row.category, config);

    if (!canonicalCategory || row.category === canonicalCategory) continue;

    row.category = canonicalCategory;
    updates.push({
      range: buildRange(CREATIVE_LIBRARY_SHEET, `${columnIndexToLetter(categoryColumnIndex)}${row.__rowNumber}`),
      values: [[canonicalCategory]],
    });
  }

  if (updates.length === 0) return;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: updates,
    },
  });
};

const normalizeLibraryRowPlazas = async (sheets, spreadsheetId, libraryRows, config) => {
  const plazasColumnIndex = CREATIVE_LIBRARY_HEADERS.indexOf('plazas');
  if (plazasColumnIndex < 0) return;

  const updates = [];
  const sourceGridCache = new Map();
  const sourceHeaderCache = new Map();

  const getSourceContext = async (sourceTab) => {
    if (!sourceTab) return { rowData: [], headers: [], headerRowIndex: -1 };
    if (!sourceGridCache.has(sourceTab)) {
      const rowData = await loadSourceGrid(sheets, spreadsheetId, sourceTab);
      const headerRowIndex = findHeaderRowIndex(rowData);
      const headers =
        headerRowIndex >= 0
          ? (rowData[headerRowIndex]?.values || []).map((cell) => getCellText(cell))
          : [];
      sourceGridCache.set(sourceTab, rowData);
      sourceHeaderCache.set(sourceTab, { headers, headerRowIndex });
    }

    return {
      rowData: sourceGridCache.get(sourceTab),
      ...sourceHeaderCache.get(sourceTab),
    };
  };

  for (const row of libraryRows) {
    if (String(row.plazas || '').trim()) continue;

    let inferredPlazas = '';
    if (row.source_tab && row.source_row) {
      try {
        const { rowData, headers } = await getSourceContext(row.source_tab);
        const sourceRowIndex = Number(row.source_row) - 1;
        const sourceCells = rowData?.[sourceRowIndex]?.values || [];
        inferredPlazas = inferPlazasFromSourceRow(sourceCells, headers, row.source_tab, config) || inferredPlazas;
      } catch {
        inferredPlazas = inferredPlazas || '';
      }
    }

    if (!inferredPlazas) continue;

    row.plazas = inferredPlazas;
    updates.push({
      range: buildRange(CREATIVE_LIBRARY_SHEET, `${columnIndexToLetter(plazasColumnIndex)}${row.__rowNumber}`),
      values: [[inferredPlazas]],
    });
  }

  if (updates.length === 0) return;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: updates,
    },
  });
};

const normalizeLibraryRowCreativeFamilies = async (sheets, spreadsheetId, libraryRows) => {
  const familyColumnIndex = CREATIVE_LIBRARY_HEADERS.indexOf('creative_family_id');
  if (familyColumnIndex < 0) return;

  const updates = [];
  const sourceGridCache = new Map();
  const sourceHeaderCache = new Map();

  const getSourceContext = async (sourceTab) => {
    if (!sourceTab) return { rowData: [], headers: [], headerRowIndex: -1, columnIndexes: new Map() };
    if (!sourceGridCache.has(sourceTab)) {
      const rowData = await loadSourceGrid(sheets, spreadsheetId, sourceTab);
      const headerRowIndex = findHeaderRowIndex(rowData);
      const headers =
        headerRowIndex >= 0
          ? (rowData[headerRowIndex]?.values || []).map((cell) => getCellText(cell))
          : [];
      sourceGridCache.set(sourceTab, rowData);
      sourceHeaderCache.set(sourceTab, { headers, headerRowIndex, columnIndexes: buildSourceColumnIndex(headers) });
    }

    return {
      rowData: sourceGridCache.get(sourceTab),
      ...sourceHeaderCache.get(sourceTab),
    };
  };

  for (const row of libraryRows) {
    const currentFamilyId = normalizeCreativeFamilyId(row.creative_family_id);
    let explicitFamilyId = currentFamilyId;

    if (!explicitFamilyId && row.source_tab && row.source_row) {
      try {
        const { rowData, columnIndexes } = await getSourceContext(row.source_tab);
        const sourceRowIndex = Number(row.source_row) - 1;
        const sourceCells = rowData?.[sourceRowIndex]?.values || [];
        const sourceFamilyColumnIndex = columnIndexes.get('creative_family_id');
        explicitFamilyId = sourceFamilyColumnIndex !== undefined
          ? getCellText(sourceCells[sourceFamilyColumnIndex])
          : '';
      } catch {
        explicitFamilyId = '';
      }
    }

    const nextFamilyId = buildSourceCreativeFamilyId({
      explicitFamilyId,
      spreadsheetId: row.source_sheet_id || spreadsheetId,
      sourceSheetName: row.source_tab || '',
      rowNumber: row.source_row || row.__rowNumber,
      imageUrl: row.resized_image_url || row.drive_url,
    });

    if (!nextFamilyId || row.creative_family_id === nextFamilyId) continue;

    row.creative_family_id = nextFamilyId;
    updates.push({
      range: buildRange(CREATIVE_LIBRARY_SHEET, `${columnIndexToLetter(familyColumnIndex)}${row.__rowNumber}`),
      values: [[nextFamilyId]],
    });
  }

  if (updates.length === 0) return;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: updates,
    },
  });
};

const normalizeLibraryRowImageMetadata = async (sheets, spreadsheetId, libraryRows) => {
  const aspectRatioColumnIndex = CREATIVE_LIBRARY_HEADERS.indexOf('aspect_ratio');
  const imageResolutionColumnIndex = CREATIVE_LIBRARY_HEADERS.indexOf('image_resolution');
  if (aspectRatioColumnIndex < 0 || imageResolutionColumnIndex < 0) return;

  const updates = [];

  for (const row of libraryRows) {
    const hasAspectRatio = String(row.aspect_ratio || '').trim();
    const hasResolution = String(row.image_resolution || '').trim();
    if (hasAspectRatio && hasResolution) continue;

    const imageUrl = row.drive_url || row.resized_image_url;
    if (!imageUrl) continue;

    try {
      const imageDataUrl = await downloadImageAsDataUrl(imageUrl);
      const imageResolution = await getImageResolutionFromDataUrl(imageDataUrl);
      const imageResolutionText = formatResolution(imageResolution);
      const aspectRatio = classifyAspectRatio(imageResolution);

      if (!hasAspectRatio) {
        row.aspect_ratio = aspectRatio || '';
        updates.push({
          range: buildRange(CREATIVE_LIBRARY_SHEET, `${columnIndexToLetter(aspectRatioColumnIndex)}${row.__rowNumber}`),
          values: [[row.aspect_ratio]],
        });
      }

      if (!hasResolution) {
        row.image_resolution = imageResolutionText;
        updates.push({
          range: buildRange(CREATIVE_LIBRARY_SHEET, `${columnIndexToLetter(imageResolutionColumnIndex)}${row.__rowNumber}`),
          values: [[imageResolutionText]],
        });
      }
    } catch (error) {
      writeSyncLog('warn', 'Image metadata backfill failed', {
        creativeId: row.creative_id || '',
        rowNumber: row.__rowNumber,
        imageUrl,
        error: error.message,
      });
    }
  }

  if (updates.length === 0) return;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: updates,
    },
  });
};

export const appendAuditLog = async (spreadsheetId, entries) => {
  if (!entries || entries.length === 0) return;

  const sheets = await getSheetsClient();
  await ensureSheetWithHeaders(sheets, spreadsheetId, CREATIVE_AUDIT_SHEET, CREATIVE_AUDIT_HEADERS);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: buildRange(CREATIVE_AUDIT_SHEET, 'A:M'),
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: entries.map((entry) =>
        objectToRow(CREATIVE_AUDIT_HEADERS, {
          timestamp: nowIso(),
          ...entry,
          payload_json:
            typeof entry.payload_json === 'string'
              ? entry.payload_json
              : JSON.stringify(entry.payload_json || {}),
        }),
      ),
    },
  });
};

const getExistingLibraryIndexes = (libraryRows) => {
  const byHash = new Map();
  const byUrl = new Map();
  const bySourceCell = new Map();

  for (const row of libraryRows) {
    if (row.image_hash) byHash.set(row.image_hash, row);
    if (row.resized_image_url) byUrl.set(row.resized_image_url, row);
    if (row.source_sheet_id && row.source_tab && row.source_row && row.source_cell) {
      bySourceCell.set(`${row.source_sheet_id}:${row.source_tab}:${row.source_row}:${row.source_cell}`, row);
    }
  }

  return { byHash, byUrl, bySourceCell };
};

const getOrCreateCategoryFolder = async (cache, category, config) => {
  if (cache.has(category)) return cache.get(category);
  const folder = await findOrCreateDriveFolder(category, config.driveRootFolderId);
  cache.set(category, folder.folderId);
  return folder.folderId;
};

const getExtensionForMimeType = (mimeType) => {
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/png') return 'png';
  return 'img';
};

const buildCreativeId = (category) => `${category}_${Date.now()}_${cryptoSafeId()}`;

const cryptoSafeId = () => Math.random().toString(36).slice(2, 8);

const normalizeCreativeFamilyId = (value) =>
  String(value || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_.:-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[_:.-]+|[_:.-]+$/g, '')
    .slice(0, 160);

const getFileNameFromUrl = (value) => {
  const text = String(value || '').trim();
  if (!text) return '';

  try {
    const parsed = new URL(text);
    const pathName = decodeURIComponent(parsed.pathname || '');
    const fileName = pathName.split('/').filter(Boolean).pop() || '';
    return fileName.replace(/\.[a-z0-9]+$/i, '');
  } catch {
    return text.split(/[/?#]/)[0].split(/[\\/]/).filter(Boolean).pop()?.replace(/\.[a-z0-9]+$/i, '') || '';
  }
};

export const inferCreativeFamilyIdFromImageUrl = (imageUrl, sourceSheetName = '') => {
  const fileName = getFileNameFromUrl(imageUrl);
  if (!fileName) return '';

  const ratioTokenPattern = /(?:\d{2,5}\s*[xX]\s*\d{2,5}|1\s*[:._-]\s*1|9\s*[:._-]\s*16|16\s*[:._-]\s*9|1\.91\s*[:._-]\s*1)/i;
  if (!ratioTokenPattern.test(fileName)) return '';

  const familyBase = fileName
    .replace(new RegExp(`^${ratioTokenPattern.source}[\\s._-]*`, 'i'), '')
    .replace(new RegExp(`[\\s._-]*${ratioTokenPattern.source}$`, 'i'), '');
  const normalizedBase = normalizeCreativeFamilyId(familyBase);
  if (!normalizedBase) return '';

  const sourcePrefix = normalizeCreativeFamilyId(sourceSheetName);
  return sourcePrefix ? `${sourcePrefix}::${normalizedBase}` : normalizedBase;
};

export const buildSourceCreativeFamilyId = ({
  explicitFamilyId,
  spreadsheetId,
  sourceSheetName,
  rowNumber,
  imageUrl,
}) =>
  normalizeCreativeFamilyId(explicitFamilyId) ||
  inferCreativeFamilyIdFromImageUrl(imageUrl, sourceSheetName) ||
  normalizeCreativeFamilyId(`${spreadsheetId}::${sourceSheetName}::row-${rowNumber}`);

const buildRowSummary = (counts, creativeIds, notes) => {
  if (counts.stored > 0) return { status: 'Stored', creativeIds: creativeIds.join(', '), notes: notes.join('; ') };
  if (counts.alreadyStored > 0) return { status: 'Already stored', creativeIds: creativeIds.join(', '), notes: notes.join('; ') };
  if (counts.missingCategory > 0) return { status: 'Missing category', creativeIds: '', notes: notes.join('; ') };
  if (counts.invalidUrl > 0) return { status: 'Invalid image URL', creativeIds: '', notes: notes.join('; ') };
  if (counts.storageFailed > 0) return { status: 'Storage failed', creativeIds: '', notes: notes.join('; ') };
  if (counts.rejected > 0 && counts.pending === 0 && counts.unknownColor === 0) {
    return { status: 'Rejected', creativeIds: '', notes: notes.join('; ') };
  }
  if (counts.unknownColor > 0) return { status: 'Pending review', creativeIds: '', notes: notes.join('; ') };
  if (counts.pending > 0) return { status: 'Pending review', creativeIds: '', notes: notes.join('; ') };
  return null;
};

export const listCreativeLibrary = async ({ sheetsUrl }) => {
  if (typeof sheetsUrl !== 'string' || sheetsUrl.trim().length === 0) {
    throw new Error('sheetsUrl is required.');
  }

  const spreadsheetId = extractSpreadsheetId(sheetsUrl.trim());
  const sheets = await getSheetsClient();
  const config = await getCreativeConfigForSpreadsheet(sheets, spreadsheetId);
  await ensureLibraryAndAuditSheets(sheets, spreadsheetId, config);

  const creatives = await readLibraryRows(sheets, spreadsheetId);
  await normalizeLibraryRowCategories(sheets, spreadsheetId, creatives, config);
  await normalizeLibraryRowPlazas(sheets, spreadsheetId, creatives, config);
  await normalizeLibraryRowCreativeFamilies(sheets, spreadsheetId, creatives);
  await normalizeLibraryRowImageMetadata(sheets, spreadsheetId, creatives);
  await formatLibraryHyperlinkColumns(sheets, spreadsheetId, creatives);
  const byCategory = {};
  const byStatus = {};

  for (const creative of creatives) {
    const category = creative.category || 'uncategorized';
    const status = creative.status || 'unknown';
    byCategory[category] ??= { total: 0, available: 0, used: 0, reserved: 0, failed: 0, archived: 0 };
    byCategory[category].total += 1;
    byCategory[category][status] = (byCategory[category][status] || 0) + 1;
    byStatus[status] = (byStatus[status] || 0) + 1;
  }

  return {
    spreadsheetId,
    categories: config.categories,
    creatives,
    summary: {
      total: creatives.length,
      byCategory,
      byStatus,
    },
  };
};

export const syncAcceptedCreatives = async ({ sheetsUrl, sheetName: providedSheetName }) => {
  if (typeof sheetsUrl !== 'string' || sheetsUrl.trim().length === 0) {
    throw new Error('sheetsUrl is required.');
  }

  const spreadsheetId = extractSpreadsheetId(sheetsUrl.trim());
  const sheets = await getSheetsClient();
  const config = await getCreativeConfigForSpreadsheet(sheets, spreadsheetId);
  const sourceSheetName = await resolveSourceSheetName(sheets, spreadsheetId, sheetsUrl, providedSheetName, config);

  writeSyncLog('info', 'Sync started', {
    spreadsheetId,
    sheetName: sourceSheetName,
    providedSheetName: providedSheetName || null,
  });

  await ensureLibraryAndAuditSheets(sheets, spreadsheetId, config);

  const metadata = await getSheetMetadata(sheets, spreadsheetId);
  const sourceSheet = getSheetByTitle(metadata, sourceSheetName);
  if (!sourceSheet) throw new Error(`Sheet "${sourceSheetName}" not found.`);

  let rowData = await loadSourceGrid(sheets, spreadsheetId, sourceSheetName);
  const headerRowIndex = findHeaderRowIndex(rowData);
  if (headerRowIndex < 0) throw new Error(`Could not find a header row in "${sourceSheetName}".`);

  const headerCells = rowData[headerRowIndex]?.values || [];
  const initialHeaders = headerCells.map((cell) => getCellText(cell));
  const { headers, columnIndexes } = await ensureSourceColumns(
    sheets,
    spreadsheetId,
    sourceSheet,
    headerRowIndex,
    initialHeaders,
    config,
  );

  if (headers.length !== initialHeaders.length) {
    rowData = await loadSourceGrid(sheets, spreadsheetId, sourceSheetName);
  }

  const outputColumns = findOutputColumns(headers);
  if (outputColumns.length === 0) {
    throw new Error('No output columns found. Expected headers containing "1:1", "9:16", "16:9", "16.9", or "1.91:1".');
  }
  const inferredCategory = detectCategoryFromName(sourceSheetName, config).category;
  const inferredPlazas = '';

  const libraryRows = await readLibraryRows(sheets, spreadsheetId);
  await normalizeLibraryRowCategories(sheets, spreadsheetId, libraryRows, config);
  await normalizeLibraryRowPlazas(sheets, spreadsheetId, libraryRows, config);
  await normalizeLibraryRowCreativeFamilies(sheets, spreadsheetId, libraryRows);
  await normalizeLibraryRowImageMetadata(sheets, spreadsheetId, libraryRows);
  await formatLibraryHyperlinkColumns(sheets, spreadsheetId, libraryRows);
  const existing = getExistingLibraryIndexes(libraryRows);
  const categoryFolderCache = new Map();
  const sourceUpdates = [];
  const libraryRowsToAppend = [];
  const auditRows = [];
  const rowResults = [];
  const failureDetails = [];
  const totals = {
    scannedRows: 0,
    acceptedCells: 0,
    stored: 0,
    alreadyStored: 0,
    rejected: 0,
    pending: 0,
    unknownColor: 0,
    missingCategory: 0,
    invalidUrl: 0,
    storageFailed: 0,
  };

  for (let gridRowIndex = headerRowIndex + 1; gridRowIndex < rowData.length; gridRowIndex++) {
    const row = rowData[gridRowIndex];
    const cells = row?.values || [];
    const rowNumber = gridRowIndex + 1;
    const categoryRaw = getCellText(cells[columnIndexes.category]);
    const plazasRaw =
      columnIndexes.plazas !== undefined
        ? getCellText(cells[columnIndexes.plazas])
        : '';
    const creativeFamilyRaw =
      columnIndexes.creative_family_id !== undefined
        ? getCellText(cells[columnIndexes.creative_family_id])
        : '';
    const category = resolveCreativeCategory({
      explicitCategory: categoryRaw,
      cells,
      headers,
      sourceSheetName,
      fallbackCategory: inferredCategory,
      config,
    });
    const plazas = resolveCreativePlazas({
      explicitPlazas: plazasRaw,
      cells,
      headers,
      sourceSheetName,
      fallbackPlazas: inferredPlazas,
      config,
    });
    const rowCounts = {
      stored: 0,
      alreadyStored: 0,
      rejected: 0,
      pending: 0,
      unknownColor: 0,
      missingCategory: 0,
      invalidUrl: 0,
      storageFailed: 0,
    };
    const creativeIds = [];
    const notes = [];
    let rowHasOutput = false;
    let rowFamilyUpdateQueued = false;
    let rowCreativeFamilyId = normalizeCreativeFamilyId(creativeFamilyRaw);
    const rowHasAcceptedOutput = outputColumns.some((columnIndex) => {
      const cell = cells[columnIndex];
      return getCellUrl(cell) && classifyBackgroundColor(cell, config) === 'ACCEPTED';
    });

    for (const columnIndex of outputColumns) {
      const cell = cells[columnIndex];
      const resizedImageUrl = getCellUrl(cell);
      if (!resizedImageUrl) continue;

      rowHasOutput = true;
      const creativeFamilyId = rowCreativeFamilyId || buildSourceCreativeFamilyId({
        explicitFamilyId: '',
        spreadsheetId,
        sourceSheetName,
        rowNumber,
        imageUrl: resizedImageUrl,
      });
      if (!rowCreativeFamilyId && creativeFamilyId) rowCreativeFamilyId = creativeFamilyId;
      if (
        columnIndexes.creative_family_id !== undefined &&
        !rowFamilyUpdateQueued &&
        !String(creativeFamilyRaw || '').trim() &&
        creativeFamilyId
      ) {
        sourceUpdates.push({
          range: buildRange(sourceSheetName, `${columnIndexToLetter(columnIndexes.creative_family_id)}${rowNumber}`),
          values: [[creativeFamilyId]],
        });
        rowFamilyUpdateQueued = true;
      }
      const reviewStatus = resolveOutputReviewStatus({
        cell,
        columnHeader: headers[columnIndex],
        rowHasAcceptedOutput,
        config,
      });
      const sourceCell = `${columnIndexToLetter(columnIndex)}${rowNumber}`;

      if (reviewStatus === 'REJECTED') {
        rowCounts.rejected += 1;
        totals.rejected += 1;
        continue;
      }

      if (reviewStatus === 'PENDING') {
        rowCounts.pending += 1;
        totals.pending += 1;
        continue;
      }

      if (reviewStatus === 'UNKNOWN_COLOR') {
        rowCounts.unknownColor += 1;
        totals.unknownColor += 1;
        continue;
      }

      totals.acceptedCells += 1;

      if (!category) {
        rowCounts.missingCategory += 1;
        totals.missingCategory += 1;
        notes.push(`Missing category for ${sourceCell}`);
        continue;
      }

      if (!/^https?:\/\//i.test(resizedImageUrl)) {
        rowCounts.invalidUrl += 1;
        totals.invalidUrl += 1;
        notes.push(`Invalid image URL at ${sourceCell}`);
        continue;
      }

      try {
        const sourceKey = `${spreadsheetId}:${sourceSheetName}:${rowNumber}:${sourceCell}`;
        const duplicateByUrl = existing.byUrl.get(resizedImageUrl);
        const duplicateBySource = existing.bySourceCell.get(sourceKey);

        if (duplicateByUrl || duplicateBySource) {
          const duplicate = duplicateByUrl || duplicateBySource;
          rowCounts.alreadyStored += 1;
          totals.alreadyStored += 1;
          if (duplicate.creative_id) creativeIds.push(duplicate.creative_id);
          continue;
        }

        const imageDataUrl = await downloadImageAsDataUrl(resizedImageUrl);
        const { buffer, mimeType } = dataUrlToBuffer(imageDataUrl);
        const imageHash = hashBuffer(buffer);
        const imageResolution = await getImageResolutionFromBuffer(buffer);
        const imageResolutionText = formatResolution(imageResolution);
        const aspectRatio = classifyAspectRatio(imageResolution);
        const duplicateByHash = existing.byHash.get(imageHash);

        if (duplicateByHash) {
          rowCounts.alreadyStored += 1;
          totals.alreadyStored += 1;
          if (duplicateByHash.creative_id) creativeIds.push(duplicateByHash.creative_id);
          continue;
        }

        const creativeId = buildCreativeId(category);
        const categoryFolderId = await getOrCreateCategoryFolder(categoryFolderCache, category, config);
        const extension = getExtensionForMimeType(mimeType);
        const fileName = `${creativeId}_${sanitizeFileName(sourceSheetName)}_${sourceCell}.${extension}`;
        const upload = await uploadBufferToDrive(buffer, fileName, mimeType, categoryFolderId);
        const driveUrl = await makeFilePublic(upload.fileId);
        const createdAt = nowIso();

        const libraryRow = {
          creative_id: creativeId,
          status: 'available',
          category,
          source_sheet_id: spreadsheetId,
          creative_family_id: creativeFamilyId,
          source_tab: sourceSheetName,
          source_row: String(rowNumber),
          source_cell: sourceCell,
          resized_image_url: resizedImageUrl,
          drive_file_id: upload.fileId,
          drive_url: driveUrl,
          aspect_ratio: aspectRatio || '',
          image_resolution: imageResolutionText,
          image_hash: imageHash,
          created_at: createdAt,
          reserved_at: '',
          used_at_google: '',
          used_at_meta: '',
          google_ads_asset_resource_name: '',
          replacement_operation_id: '',
          notes: '',
          plazas,
        };

        libraryRowsToAppend.push(libraryRow);
        existing.byHash.set(imageHash, libraryRow);
        existing.byUrl.set(resizedImageUrl, libraryRow);
        existing.bySourceCell.set(sourceKey, libraryRow);
        creativeIds.push(creativeId);
        rowCounts.stored += 1;
        totals.stored += 1;

        auditRows.push({
          event: 'CREATIVE_STORED',
          creative_id: creativeId,
          category,
          customer_id: '',
          campaign_id: '',
          ad_group_id: '',
          asset_group_id: '',
          old_asset_resource_name: '',
          new_asset_resource_name: '',
          status: 'success',
          message: `Stored ${sourceSheetName}!${sourceCell}`,
          payload_json: {
            rowNumber,
            sourceCell,
            resizedImageUrl,
            driveUrl,
            aspectRatio,
            imageResolution: imageResolutionText,
            creativeFamilyId,
          },
        });
      } catch (error) {
        rowCounts.storageFailed += 1;
        totals.storageFailed += 1;
        const failure = {
          sheetName: sourceSheetName,
          rowNumber,
          sourceCell,
          category,
          plazas,
          resizedImageUrl,
          error: error.message,
          details: getErrorLogDetails(error),
        };
        failureDetails.push(failure);
        notes.push(`${sourceCell}: ${error.message}`);
        writeSyncLog('error', 'Storage failed', {
          sheet: sourceSheetName,
          rowNumber,
          sourceCell,
          category,
          plazas,
          resizedImageUrl,
          error: error.message,
        });
      }
    }

    if (!rowHasOutput) continue;
    totals.scannedRows += 1;
    const summary = buildRowSummary(rowCounts, [...new Set(creativeIds)], notes);
    if (plazas && columnIndexes.plazas !== undefined && plazasRaw !== plazas) {
      sourceUpdates.push({
        range: buildRange(sourceSheetName, `${columnIndexToLetter(columnIndexes.plazas)}${rowNumber}`),
        values: [[plazas]],
      });
    }

    if (summary) {
      sourceUpdates.push(
        {
          range: buildRange(sourceSheetName, `${columnIndexToLetter(columnIndexes.storage_status)}${rowNumber}`),
          values: [[summary.status]],
        },
        {
          range: buildRange(sourceSheetName, `${columnIndexToLetter(columnIndexes.creative_ids)}${rowNumber}`),
          values: [[summary.creativeIds]],
        },
        {
          range: buildRange(sourceSheetName, `${columnIndexToLetter(columnIndexes.notes)}${rowNumber}`),
          values: [[summary.notes]],
        },
      );
    }

    rowResults.push({
      rowNumber,
      status: summary?.status || 'Skipped',
      creativeIds: [...new Set(creativeIds)],
      counts: rowCounts,
      notes,
    });
  }

  await appendLibraryRows(sheets, spreadsheetId, libraryRowsToAppend);
  await appendAuditLog(spreadsheetId, auditRows);

  if (sourceUpdates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: sourceUpdates,
      },
    });
  }

  writeSyncLog('info', 'Sync completed', {
    spreadsheetId,
    sheetName: sourceSheetName,
    totals,
    failureCount: failureDetails.length,
  });

  return {
    spreadsheetId,
    sheetName: sourceSheetName,
    totals,
    rows: rowResults,
    failureDetails,
    debugLogPath: CREATIVE_LIBRARY_SYNC_LOG_PATH,
  };
};

const updateLibraryRow = async (spreadsheetId, rowNumber, patch) => {
  const sheets = await getSheetsClient();
  const updates = [];

  for (const [key, value] of Object.entries(patch)) {
    const columnIndex = CREATIVE_LIBRARY_HEADERS.indexOf(key);
    if (columnIndex === -1) continue;
    updates.push({
      range: buildRange(CREATIVE_LIBRARY_SHEET, `${columnIndexToLetter(columnIndex)}${rowNumber}`),
      values: [[value ?? '']],
    });
  }

  if (updates.length === 0) return;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: updates,
    },
  });
};

const hasUsageValue = (value) => String(value ?? '').trim().length > 0;

const statusAfterReservationRelease = (creative) =>
  hasUsageValue(creative?.used_at_google) ||
  hasUsageValue(creative?.used_at_meta) ||
  hasUsageValue(creative?.used_at)
    ? 'used'
    : 'available';

export const reserveCreative = async (spreadsheetId, creativeId, operationId, adsPlatform = '') => {
  const sheets = await getSheetsClient();
  const rows = await readLibraryRows(sheets, spreadsheetId);
  const creative = rows.find((row) => row.creative_id === creativeId);

  if (!creative) throw new Error(`Creative ${creativeId} not found.`);
  if (!isCreativeAvailableForPlatform(creative, adsPlatform)) {
    throw new Error(`Creative ${creativeId} is not available.`);
  }

  await updateLibraryRow(spreadsheetId, creative.__rowNumber, {
    status: 'reserved',
    reserved_at: nowIso(),
    replacement_operation_id: operationId,
  });

  return { ...creative, status: 'reserved', replacement_operation_id: operationId };
};

export const markCreativeUsed = async (spreadsheetId, creativeId, data) => {
  const sheets = await getSheetsClient();
  const rows = await readLibraryRows(sheets, spreadsheetId);
  const creative = rows.find((row) => row.creative_id === creativeId);
  if (!creative) throw new Error(`Creative ${creativeId} not found.`);

  const adsResourceName = data.adsResourceName || data.googleAdsAssetResourceName || '';
  const adsPlatform = data.adsPlatform || (data.googleAdsAssetResourceName ? 'google' : '');
  const usageColumn = adsPlatform === 'meta' ? 'used_at_meta' : 'used_at_google';

  await updateLibraryRow(spreadsheetId, creative.__rowNumber, {
    status: 'used',
    [usageColumn]: nowIso(),
    ads_platform: adsPlatform,
    ads_resource_name: adsResourceName,
    google_ads_asset_resource_name:
      adsPlatform === 'google'
        ? data.googleAdsAssetResourceName || adsResourceName
        : creative.google_ads_asset_resource_name || '',
    replacement_operation_id: data.operationId || creative.replacement_operation_id || '',
    notes: data.notes || creative.notes || '',
  });
};

export const releaseCreativeReservation = async (spreadsheetId, creativeId, notes = '') => {
  const sheets = await getSheetsClient();
  const rows = await readLibraryRows(sheets, spreadsheetId);
  const creative = rows.find((row) => row.creative_id === creativeId);
  if (!creative) return;

  await updateLibraryRow(spreadsheetId, creative.__rowNumber, {
    status: statusAfterReservationRelease(creative),
    reserved_at: '',
    replacement_operation_id: '',
    notes: notes || creative.notes || '',
  });
};

export const getSpreadsheetIdFromLibraryInput = (sheetsUrl) => extractSpreadsheetId(sheetsUrl);
