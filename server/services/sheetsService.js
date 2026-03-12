import { getSheetsClient } from './googleAuth.js';

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
 * Read all rows from a Google Sheet
 * Returns array of row objects with column headers as keys
 */
export const readSheetRows = async (spreadsheetId, sheetName = 'Sheet1') => {
  try {
    const sheets = getSheetsClient();

    // Get the sheet data including headers
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

    // Convert to array of objects
    return rows.map((row) => {
      const obj = {};
      headers.forEach((header, index) => {
        obj[header] = row[index] || '';
      });
      return obj;
    });
  } catch (error) {
    console.error('Error reading sheet rows:', error);
    throw new Error(`Failed to read Google Sheet: ${error.message}`);
  }
};

/**
 * Update specific cells in a Google Sheet
 * data: array of { range: "Sheet1!A1", values: [[value]] } or similar
 */
export const updateSheetCells = async (spreadsheetId, updates) => {
  try {
    const sheets = getSheetsClient();

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
    console.error('Error updating sheet cells:', error);
    throw new Error(`Failed to update Google Sheet: ${error.message}`);
  }
};

/**
 * Find the column index for a given header name
 */
export const findColumnIndex = async (spreadsheetId, sheetName, headerName) => {
  try {
    const sheets = getSheetsClient();

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
    console.error('Error finding column index:', error);
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
