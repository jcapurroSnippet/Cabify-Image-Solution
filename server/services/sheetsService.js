import { getSheetsClient } from './googleAuth.js';
import { normalizeHeader } from './creativeLibraryCore.js';

/**
 * Extract spreadsheet ID from various Google Sheets URL formats
 * Handles:
 * - https://docs.google.com/spreadsheets/d/{id}/edit...
 * - https://docs.google.com/spreadsheets/d/{id}/edit#gid=...
 * - etc.
 */
export const extractSpreadsheetId = (sheetsUrl) => {
  const match = sheetsUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!match || !match[1]) {
    throw new Error('Invalid Google Sheets URL. Expected format: https://docs.google.com/spreadsheets/d/{id}/...');
  }
  return match[1];
};

/**
 * Extract sheet ID (gid) from URL if provided
 * Returns null if not found (will use the first sheet by default)
 */
export const extractSheetId = (sheetsUrl) => {
  const match = sheetsUrl.match(/[#?]gid=(\d+)/);
  return match ? parseInt(match[1], 10) : null;
};

/**
 * Get the name of the first sheet in a spreadsheet
 * Automatically detects the sheet name instead of hardcoding "Sheet1"
 */
export const getFirstSheetName = async (spreadsheetId) => {
  try {
    const sheets = await getSheetsClient();
    
    const response = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets(properties(title))',
    });

    const sheetName = response.data.sheets?.[0]?.properties?.title;
    if (!sheetName) {
      throw new Error('No sheets found in spreadsheet');
    }

    return sheetName;
  } catch (error) {
    throw new Error(`Failed to get sheet name: ${error.message}`);
  }
};

/**
 * Read all rows from a Google Sheet
 * Returns array of row objects with column headers as keys
 * Includes hyperlink extraction for cells with links
 */
export const readSheetRows = async (spreadsheetId, sheetName = 'Sheet1') => {
  try {
    const sheets = await getSheetsClient();

    // Get the sheet data as values first
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: sheetName,
    });

    const values = response.data.values || [];
    if (values.length === 0) {
      return [];
    }

    // First row is headers
    const [headers, ...rows] = values;

    // Also get grid data to extract hyperlinks
    let hyperlinks = {};
    try {
      const spreadsheet = await sheets.spreadsheets.get({
        spreadsheetId,
        includeGridData: true,
        ranges: [sheetName],
      });

      const sheetData = spreadsheet.data.sheets[0];
      if (sheetData && sheetData.data && sheetData.data[0]) {
        const gridData = sheetData.data[0];
        const gridRows = gridData.rowData || [];

        // Extract hyperlinks with cell references
        gridRows.forEach((row, rowIdx) => {
          if (!row || !row.values) return;
          row.values.forEach((cell, colIdx) => {
            if (cell && cell.hyperlink) {
              const key = `${rowIdx}_${colIdx}`;
              hyperlinks[key] = cell.hyperlink;
            }
          });
        });
      }
    } catch (error) {
    }

    // Convert to array of objects, using hyperlinks when available
    return rows.map((row, rowIdx) => {
      const obj = {};
      headers.forEach((header, colIdx) => {
        // Check if this cell has a hyperlink (rowIdx + 1 because headers are row 0)
        const hyperlinkKey = `${rowIdx + 1}_${colIdx}`;
        const value = row[colIdx] || '';
        
        // Use hyperlink if available, otherwise use the cell value
        obj[header] = hyperlinks[hyperlinkKey] || value;
      });
      return obj;
    });
  } catch (error) {
    throw new Error(`Failed to read Google Sheet: ${error.message}`);
  }
};

/**
 * Update specific cells in a Google Sheet
 * data: array of { range: "Sheet1!A1", values: [[value]] } or similar
 */
export const updateSheetCells = async (spreadsheetId, updates) => {
  try {
    const sheets = await getSheetsClient();

    const response = await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        data: updates.map((update) => ({
          range: update.range,
          values: update.values,
          majorDimension: 'ROWS',
        })),
        valueInputOption: 'RAW',
      },
    });

    return response.data;
  } catch (error) {
    throw new Error(`Failed to update Google Sheet: ${error.message}`);
  }
};

/**
 * Find the column index for a given header name
 */
export const findColumnIndex = async (spreadsheetId, sheetName, headerName) => {
  try {
    const sheets = await getSheetsClient();

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!1:1`,
    });

    const headers = response.data.values?.[0] || [];
    const index = headers.findIndex((h) => h.toLowerCase().includes(headerName.toLowerCase()));

    if (index === -1) {
      throw new Error(`Column "${headerName}" not found in sheet`);
    }

    return index; // 0-based index
  } catch (error) {
    throw new Error(`Failed to find column: ${error.message}`);
  }
};

/**
 * Convert column index to letter (0 => 'A', 1 => 'B', 26 => 'AA', etc.)
 */
export const columnIndexToLetter = (index) => {
  let letter = '';
  let num = index + 1; // Convert to 1-based

  while (num > 0) {
    num -= 1;
    letter = String.fromCharCode((num % 26) + 65) + letter;
    num = Math.floor(num / 26);
  }

  return letter;
};

// ---------------------------------------------------------------------------
// Generic tab helpers
//
// These used to live privately inside creativeLibraryService, creativeReviewService
// and runOrchestratorService, in three identical copies. They belong here: this
// module only depends on googleAuth, so any service can import them without
// creating a cycle (creativeLibraryService already imports from batchProcessor,
// which is why batchProcessor cannot import from it).
// ---------------------------------------------------------------------------

export const quoteSheetName = (sheetName) => `'${String(sheetName).replace(/'/g, "''")}'`;

export const buildRange = (sheetName, a1) => `${quoteSheetName(sheetName)}!${a1}`;

export const objectToRow = (headers, object) => headers.map((header) => object?.[header] ?? '');

export const rowToObject = (headers, row, rowNumber) => {
  const object = { __rowNumber: rowNumber };
  headers.forEach((header, index) => {
    object[header] = row?.[index] ?? '';
  });
  return object;
};

export const valuesToObjects = (values = []) => {
  if (!Array.isArray(values) || values.length === 0) return [];
  const headers = values[0] || [];
  return values.slice(1).map((row, index) => rowToObject(headers, row, index + 2));
};

export const getSheetMetadata = async (sheets, spreadsheetId) => {
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),merges)',
  });

  return response.data.sheets || [];
};

export const getSheetByTitle = (metadata, title) =>
  metadata.find((sheet) => sheet.properties?.title === title);

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

export const ensureSheetWithHeaders = async (sheets, spreadsheetId, sheetName, headers) => {
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

export const appendRows = async (sheets, spreadsheetId, sheetName, headers, rows) => {
  if (!rows.length) return;
  const lastColumn = columnIndexToLetter(headers.length - 1);
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: buildRange(sheetName, `A:${lastColumn}`),
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows.map((row) => objectToRow(headers, row)) },
  });
};

/**
 * Read a tab without creating it. Returns null when the tab does not exist yet,
 * so callers can distinguish "nothing written yet" from "no rows".
 */
export const readRowsIfPresent = async (sheets, spreadsheetId, sheetName, headers) => {
  const metadata = await getSheetMetadata(sheets, spreadsheetId);
  if (!getSheetByTitle(metadata, sheetName)) return null;

  const lastColumn = columnIndexToLetter(headers.length - 1);
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: buildRange(sheetName, `A:${lastColumn}`),
    valueRenderOption: 'FORMULA',
  });
  const values = response.data.values || [];
  // Status reads must tolerate a tab that still has the previous schema. Use
  // the headers physically present in row 1; ensureSheetWithHeaders performs
  // the canonical migration when the next write begins.
  const storedHeaders = (values[0] || []).map((header) => String(header || '').trim());
  const rowHeaders = storedHeaders.some(Boolean) ? storedHeaders : headers;
  return values.slice(1).map((row, index) => rowToObject(rowHeaders, row, index + 2));
};
