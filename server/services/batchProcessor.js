import axios from 'axios';
import {
  extractSpreadsheetId,
  extractSheetId,
  readSheetRows,
  updateSheetCells,
  columnIndexToLetter,
  getFirstSheetName,
} from './sheetsService.js';
import { uploadImageToDrive, makeFilePublic, extractFolderId } from './driveService.js';
import { getSheetsClient, getDriveClient } from './googleAuth.js';
import { uploadImageToPhotos, resolveAlbumIdFromShareUrl } from './photosService.js';
import { optimizeImageBuffer, bufferToDataUrl } from './imageOptimizer.js';

const DEFAULT_MAX_SCAN_ROWS = Number(process.env.SHEET_MAX_SCAN_ROWS || 200);
const DEFAULT_URL_SCAN_ROWS = Number(process.env.SHEET_URL_SCAN_ROWS || 200);
const EXPECTED_VARIATIONS_PER_RATIO = 3;

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

const collectLinksFromColumns = (row, headerNames, columnIndexes) => {
  const links = [];
  for (const colIdx of columnIndexes) {
    const header = headerNames[colIdx];
    if (!header) continue;
    const raw = row[header];
    const normalized = normalizeUrl(raw);
    if (normalized) {
      links.push(normalized);
    }
  }
  return links;
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
    console.log(message);
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

  // First pass: look for a row that contains at least 2 header keywords
  for (let i = 0; i < Math.min(maxScan, rowData.length); i++) {
    const row = rowData[i];
    if (!row?.values) continue;
    const texts = row.values
      .map((cell) => cell?.userEnteredValue?.stringValue || '')
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
  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets(properties(title,gridProperties(columnCount,rowCount)))',
    });

    const sheet = meta.data.sheets?.find((s) => s.properties?.title === sheetName);
    const columnCount = sheet?.properties?.gridProperties?.columnCount || 26;
    const rowCount = sheet?.properties?.gridProperties?.rowCount || maxRows;
    const lastCol = columnIndexToLetter(Math.max(0, columnCount - 1));
    const lastRow = Math.min(rowCount, maxRows);

    return `${sheetName}!A1:${lastCol}${lastRow}`;
  } catch (error) {
    console.warn('[BATCH] Could not fetch sheet grid properties, falling back to A1:Z200');
    return `${sheetName}!A1:Z${maxRows}`;
  }
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
export const downloadImageAsDataUrl = async (imageUrl) => {
  try {
    let buffer;
    const normalizeBuffer = (data) => (Buffer.isBuffer(data) ? data : Buffer.from(data));
    
    // For Drive URLs, use Drive API alt=media with auth
    if (imageUrl.includes('drive.google.com')) {
      const fileId = extractDriveFileId(imageUrl);
      if (!fileId) throw new Error('Could not extract Drive file ID');
      console.log(`[IMAGE] Downloading via API: ${fileId.substring(0, 20)}...`);
      
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
        console.log('[IMAGE] API failed, trying direct download...');
        
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
      console.log(`[IMAGE] Downloading from: ${imageUrl.substring(0, 70)}...`);
      
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

    console.log(`[IMAGE] Downloaded: ${buffer.byteLength} bytes`);
    
    // Optimize the image
    const optimized = await optimizeImageBuffer(buffer);
    
    // Convert to data URL
    const dataUrl = bufferToDataUrl(optimized, 'image/jpeg');
    
    return dataUrl;
  } catch (error) {
    console.error('Error downloading image:', error.message);
    throw new Error(`Failed to download image from ${imageUrl}: ${error.message}`);
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
    console.error('Error generating aspect ratio variations:', error.message);
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
          range: `${sheetName}!1:1`,
        });

        const headers = dataResponse.data.values?.[0] || [];
        
        // Check if sheet has meaningful headers (at least 3) with image-related keywords
        if (headers.length >= 3) {
          const hasImageColumn = headers.some((h) =>
            imageKeywords.some((kw) => h?.toLowerCase().includes(kw))
          );
          
          if (hasImageColumn) {
            console.log(`Found sheet with image columns: "${sheetName}"`);
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
          range: `${sheetName}!1:5`,
        });

        const allRows = dataResponse.data.values || [];
        const hasHeaders = allRows.length > 0 && allRows[0].length >= 3;
        const hasData = allRows.length > 1;

        if (hasHeaders && hasData) {
          console.log(`Found sheet with data: "${sheetName}"`);
          return sheetName;
        }
      } catch (error) {
        continue;
      }
    }

    // Fallback to first sheet if all are empty
    const fallbackSheet = sheetNames[0] || 'Sheet1';
    console.log(`No suitable sheets found. Using fallback: "${fallbackSheet}"`);
    return fallbackSheet;
  } catch (error) {
    console.error('Error finding sheet with data:', error.message);
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
      if (!cell) return `Column${String.fromCharCode(65 + idx)}`;
      return cell.userEnteredValue?.stringValue || `Column${String.fromCharCode(65 + idx)}`;
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
    console.error('Error reading sheet rows with hyperlinks:', error.message);
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
      console.log('[URL DETECTION] ERROR: Could not find sheet in response');
      return -1;
    }

    const gridData = sheet.data?.[0];
    if (!gridData || !gridData.rowData) {
      console.log('[URL DETECTION] ERROR: No grid data or row data found');
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
    const rowsToScan = Math.min(
      DEFAULT_URL_SCAN_ROWS,
      Math.max(0, gridData.rowData.length - headerRowIndex - 1)
    );
    logLine(`[URL DETECTION] Scanning ${rowsToScan} data rows for URLs...`);

    let urlsFoundPerColumn = {};

    for (let rowIdx = headerRowIndex + 1; rowIdx < headerRowIndex + 1 + rowsToScan; rowIdx++) {
      const row = gridData.rowData[rowIdx];
      if (!row.values) {
        console.log(`[URL DETECTION] Row ${rowIdx}: No values`);
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

    // Find column with most URLs
    let bestColumnIdx = -1;
    let maxUrls = 0;
    for (const [colIdx, count] of Object.entries(urlsFoundPerColumn)) {
      if (count > maxUrls) {
        maxUrls = count;
        bestColumnIdx = parseInt(colIdx);
      }
    }

    if (bestColumnIdx !== -1) {
      logLine(`[URL DETECTION] SUCCESS: Found image URL column at index ${bestColumnIdx} with ${maxUrls} URLs`);
      debug('Best column', { bestColumnIdx, maxUrls });
      return bestColumnIdx;
    }

    logLine('[URL DETECTION] ERROR: No column with URLs found in scanned rows');
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
    console.error('[URL DETECTION] ERROR:', error.message);
    console.error('[URL DETECTION] Stack:', error.stack);
    return -1;
  }
};

/**
 * Read sheet and infer completion based on output URLs.
 * Returns only rows that are completed or skipped, plus totals.
 */
export const getBatchStatus = async (options) => {
  const { sheetsUrl, sheetName: providedSheetName } = options;

  if (typeof sheetsUrl !== 'string' || sheetsUrl.trim().length === 0) {
    throw new Error('sheetsUrl is required.');
  }

  const spreadsheetId = extractSpreadsheetId(sheetsUrl);
  const sheetName = await resolveSheetName(sheetsUrl, providedSheetName);

  const imageUrlColumnIndex = await detectImageUrlColumn(spreadsheetId, sheetName);
  if (imageUrlColumnIndex === -1) {
    throw new Error('Could not find any column with image URLs in the sheet');
  }

  const sheetsClient = await getSheetsClient();
  const headerResponse = await sheetsClient.spreadsheets.get({
    spreadsheetId,
    ranges: [`${sheetName}!A:Z`],
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
      return text || `Column${String.fromCharCode(65 + idx)}`;
    });
  }

  const imageUrlColumnName =
    headerNames[imageUrlColumnIndex] || `Column${String.fromCharCode(65 + imageUrlColumnIndex)}`;

  const findRatioColumns = (headers, ratio) => {
    const token = String(ratio).toLowerCase();
    return headers
      .map((h, idx) => ({ h: String(h || '').toLowerCase(), idx }))
      .filter((item) => item.h.includes(token))
      .map((item) => item.idx);
  };

  const ratioColumns = {
    '1:1': findRatioColumns(headerNames, '1:1'),
    '9:16': findRatioColumns(headerNames, '9:16'),
  };

  const rows = await readSheetRowsWithHyperlinks(spreadsheetId, sheetName);
  const totalRows = rows.length;

  let completedRows = 0;
  const completedMap = {};

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    const rowNumber = row.__rowNumber || (headerRowIndex + 2 + rowIndex);
    const imageUrlRaw = row[imageUrlColumnName];
    const imageUrl = normalizeUrl(imageUrlRaw);

    if (!imageUrl) {
      completedRows += 1;
      completedMap[rowNumber] = {
        status: 'skipped',
      };
      continue;
    }

    let links11 = [];
    let links916 = [];
    let expectedCount = 0;

    if (ratioColumns['1:1'].length > 0 || ratioColumns['9:16'].length > 0) {
      links11 = collectLinksFromColumns(row, headerNames, ratioColumns['1:1']);
      links916 = collectLinksFromColumns(row, headerNames, ratioColumns['9:16']);
      expectedCount = ratioColumns['1:1'].length + ratioColumns['9:16'].length;
    } else {
      const start = imageUrlColumnIndex + 1;
      const cols11 = [start, start + 1, start + 2];
      const cols916 = [start + 3, start + 4, start + 5];
      links11 = collectLinksFromColumns(row, headerNames, cols11);
      links916 = collectLinksFromColumns(row, headerNames, cols916);
      expectedCount = EXPECTED_VARIATIONS_PER_RATIO * 2;
    }

    const foundCount = links11.length + links916.length;
    if (expectedCount === 0) {
      expectedCount = foundCount > 0 ? foundCount : 0;
    }

    if (expectedCount > 0 && foundCount >= expectedCount) {
      completedRows += 1;
      completedMap[rowNumber] = {
        status: 'completed',
        links: {
          '1:1': links11,
          '9:16': links916,
        },
      };
    }
  }

  return {
    totalRows,
    completedRows,
    rows: completedMap,
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
    baseUrl = process.env.API_BASE_URL || 'http://localhost:8080',
    onProgress,
  } = options;

  // FIXED Drive folder ID for all uploads (fallback if Photos fails)
  const FIXED_DRIVE_FOLDER_ID = '0APcMUrimfyziUk9PVA';
  const PHOTOS_ALBUM_SHARE_URL = 'https://photos.app.goo.gl/RRWkcPWwPApyi5y6A';

  let photosAlbumId = null;
  try {
    photosAlbumId = await resolveAlbumIdFromShareUrl(PHOTOS_ALBUM_SHARE_URL);
    console.log(`[BATCH] Google Photos album resolved: ${photosAlbumId}`);
  } catch (e) {
    console.warn(`[BATCH] Could not resolve Photos album, will fallback to Drive: ${e.message}`);
  }

  try {
    console.log('\n========================================');
    console.log('[BATCH PROCESSOR] Starting batch process');
    console.log('========================================');
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
    
    onProgress?.({
      state: 'sheet-detected',
      message: `Using sheet: "${sheetName}"`,
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
      console.log('[BATCH] ERROR: Could not find any column with image URLs');
      throw new Error('Could not find any column with image URLs in the sheet');
    }
    console.log(`[BATCH] SUCCESS: Found image URL column at index ${imageUrlColumnIndex}`);

    const columnLetter = String.fromCharCode(65 + imageUrlColumnIndex);
    onProgress?.({
      state: 'column-detected',
      message: `Using column ${columnLetter} for image URLs`,
      imageUrlColumnIndex,
    });

    // Step 3.5: Get column header name for the detected column
    // We'll need to read the header row to know the exact column name
    const sheetsClient = await getSheetsClient();
    const headerResponse = await sheetsClient.spreadsheets.get({
      spreadsheetId,
      ranges: [`${sheetName}!A:Z`],
      includeGridData: true,
    });

    let imageUrlColumnName = columnLetter;
    let headerRowIndex = 0;
    let headerNames = [];
    const sheetMerges = headerResponse.data.sheets?.[0]?.merges || [];
    const gridData = headerResponse.data.sheets?.[0]?.data?.[0];
    if (gridData && gridData.rowData) {
      // Find header row (keyword-aware)
      headerRowIndex = findHeaderRowIndex(gridData.rowData);

      const headerRow = gridData.rowData[headerRowIndex]?.values || [];
      headerNames = headerRow.map((cell, idx) => {
        const text = cell?.userEnteredValue?.stringValue;
        return text || `Column${String.fromCharCode(65 + idx)}`;
      });

      // Expand merged header cells: if a merge spans the header row, propagate
      // the value from its first column across the full span. Google Sheets
      // returns the value only in the top-left cell of the merge.
      for (const merge of sheetMerges) {
        if (
          merge.startRowIndex <= headerRowIndex &&
          merge.endRowIndex > headerRowIndex
        ) {
          const sourceCell = headerRow[merge.startColumnIndex];
          const sourceText = sourceCell?.userEnteredValue?.stringValue;
          if (!sourceText) continue;
          for (let c = merge.startColumnIndex + 1; c < merge.endColumnIndex; c++) {
            headerNames[c] = sourceText;
          }
        }
      }

      const headerCell = headerRow[imageUrlColumnIndex];
      if (headerCell?.userEnteredValue?.stringValue) {
        imageUrlColumnName = headerCell.userEnteredValue.stringValue;
      }
    }

    const findRatioColumns = (headers, ratio) => {
      const token = String(ratio).toLowerCase();
      return headers
        .map((h, idx) => ({ h: String(h || '').toLowerCase(), idx }))
        .filter((item) => item.h.includes(token))
        .map((item) => item.idx);
    };

    const ratioColumns = {
      '1:1': findRatioColumns(headerNames, '1:1'),
      '9:16': findRatioColumns(headerNames, '9:16'),
    };

    // Step 4: Read all rows from sheet
    onProgress?.({
      state: 'reading-sheet',
      message: 'Reading Google Sheet...',
    });

    const rows = await readSheetRowsWithHyperlinks(spreadsheetId, sheetName);
    const totalRows = rows.length;

    if (totalRows === 0) {
      throw new Error('No data rows found in the sheet');
    }

    // Step 5: Process each row
    const updates = [];

    for (let rowIndex = 0; rowIndex < totalRows; rowIndex++) {
      const row = rows[rowIndex];
      const rowNumber = row.__rowNumber || (headerRowIndex + 2 + rowIndex); // Prefer real sheet row

      try {
        // Get image URL from the detected column (now using column name as key)
        const imageUrl = row[imageUrlColumnName]?.trim();

        if (!imageUrl || imageUrl === '') {
          onProgress?.({
            rowNumber,
            currentRow: rowIndex + 1,
            totalRows,
            status: 'skipped',
            reason: `No image URL in column "${imageUrlColumnName}"`,
            rowData: row,
          });
          continue;
        }

        // Download image
        onProgress?.({
          rowNumber,
          currentRow: rowIndex + 1,
          totalRows,
          status: 'downloading',
          imageUrl,
          rowData: row,
        });

        const imageDataUrl = await downloadImageAsDataUrl(imageUrl);

        // Generate 1:1 variations
        onProgress?.({
          rowNumber,
          currentRow: rowIndex + 1,
          totalRows,
          status: 'generating',
          ratio: '1:1',
          rowData: row,
        });

        const oneToOneImages = await generateAspectRatioVariations(imageDataUrl, '1:1', baseUrl);

        // Generate 9:16 variations
        onProgress?.({
          rowNumber,
          currentRow: rowIndex + 1,
          totalRows,
          status: 'generating',
          ratio: '9:16',
          rowData: row,
        });

        const nineByEditSixteenImages = await generateAspectRatioVariations(imageDataUrl, '9:16', baseUrl);

        // Upload all variations to Drive
        onProgress?.({
          rowNumber,
          currentRow: rowIndex + 1,
          totalRows,
          status: 'uploading',
          rowData: row,
        });

        const uploadedLinks = {
          '1:1': [],
          '9:16': [],
        };

        // Upload 1:1 variations
        for (let i = 0; i < oneToOneImages.length; i++) {
          const fileName = `${row.Categoria || 'image'}_${row.Ciudad || 'city'}_1-1_var${i + 1}.png`;
          let link;
          if (photosAlbumId) {
            link = await uploadImageToPhotos(oneToOneImages[i], fileName, photosAlbumId);
          } else {
            const upload = await uploadImageToDrive(oneToOneImages[i], fileName, folderId);
            link = await makeFilePublic(upload.fileId);
          }
          uploadedLinks['1:1'].push(link);
        }

        // Upload 9:16 variations
        for (let i = 0; i < nineByEditSixteenImages.length; i++) {
          const fileName = `${row.Categoria || 'image'}_${row.Ciudad || 'city'}_9-16_var${i + 1}.png`;
          let link;
          if (photosAlbumId) {
            link = await uploadImageToPhotos(nineByEditSixteenImages[i], fileName, photosAlbumId);
          } else {
            const upload = await uploadImageToDrive(nineByEditSixteenImages[i], fileName, folderId);
            link = await makeFilePublic(upload.fileId);
          }
          uploadedLinks['9:16'].push(link);
        }

        // Prepare sheet updates - place outputs into columns whose headers include the aspect ratio
        const applyLinksToColumns = (ratio, links) => {
          const cols = ratioColumns[ratio] || [];
          if (cols.length === 0) {
            console.warn(`[BATCH] No columns found for ratio ${ratio}. Falling back to adjacent columns.`);
            return false;
          }

          for (let i = 0; i < links.length; i++) {
            const colIdx = cols[i];
            if (colIdx === undefined) continue;
            updates.push({
              range: `${sheetName}!${columnIndexToLetter(colIdx)}${rowNumber}`,
              values: [[links[i]]],
            });
          }

          return true;
        };

        const used11 = applyLinksToColumns('1:1', uploadedLinks['1:1']);
        const used916 = applyLinksToColumns('9:16', uploadedLinks['9:16']);

        // Fallback: if no ratio columns detected, write after image URL column as before
        if (!used11 && !used916) {
          const outputColumnStart = imageUrlColumnIndex + 1;
          const fallbackLinks = [...uploadedLinks['1:1'], ...uploadedLinks['9:16']];
          for (let i = 0; i < fallbackLinks.length; i++) {
            updates.push({
              range: `${sheetName}!${columnIndexToLetter(outputColumnStart + i)}${rowNumber}`,
              values: [[fallbackLinks[i]]],
            });
          }
        }

        onProgress?.({
          rowNumber,
          currentRow: rowIndex + 1,
          totalRows,
          status: 'completed',
          links: uploadedLinks,
          rowData: row,
        });
      } catch (error) {
        console.error(`Error processing row ${rowNumber}:`, error.message);
        onProgress?.({
          rowNumber,
          currentRow: rowIndex + 1,
          totalRows,
          status: 'error',
          error: error.message,
          rowData: row,
        });
      }
    }

    // Step 5: Batch update the sheet with all links
    if (updates.length > 0) {
      onProgress?.({
        state: 'updating-sheet',
        message: 'Updating Google Sheet with links...',
      });

      await updateSheetCells(spreadsheetId, updates);
    }

    onProgress?.({
      state: 'completed',
      message: 'Batch processing completed successfully',
      totalRows,
    });

    return {
      success: true,
      totalRows,
      processedRows: totalRows,
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
