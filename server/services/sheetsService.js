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
