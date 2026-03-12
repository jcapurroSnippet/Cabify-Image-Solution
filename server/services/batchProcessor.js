import axios from 'axios';
import {
  extractSpreadsheetId,
  readSheetRows,
  updateSheetCells,
  columnIndexToLetter,
  getFirstSheetName,
} from './sheetsService.js';
import { uploadImageToDrive, makeFilePublic, extractFolderId } from './driveService.js';
import { getSheetsClient } from './googleAuth.js';

/**
 * Download image from URL and convert to base64 data URL
 */
export const downloadImageAsDataUrl = async (imageUrl) => {
  try {
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const mimeType = response.headers['content-type'] || 'image/png';
    const base64 = Buffer.from(response.data).toString('base64');
    return `data:${mimeType};base64,${base64}`;
  } catch (error) {
    console.error('Error downloading image:', error.message);
    throw new Error(`Failed to download image from ${imageUrl}: ${error.message}`);
  }
};

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

    // Read with grid data to include hyperlinks
    const response = await sheets.spreadsheets.get({
      spreadsheetId,
      ranges: [`${sheetName}!A:Z`],
      includeGridData: true,
    });

    const sheet = response.data.sheets?.[0];
    if (!sheet) return [];

    const gridData = sheet.data?.[0];
    if (!gridData || !gridData.rowData) return [];

    const rows = [];
    let headerRow = null;
    let headerRowIndex = -1;

    // First, find the header row (row with most non-empty cells)
    let maxCellsInRow = 0;
    for (let i = 0; i < gridData.rowData.length; i++) {
      const row = gridData.rowData[i];
      if (!row.values) continue;
      
      const nonEmptyCells = row.values.filter(v => v && (v.userEnteredValue?.stringValue || v.userEnteredValue?.numberValue)).length;
      if (nonEmptyCells > maxCellsInRow) {
        maxCellsInRow = nonEmptyCells;
        headerRowIndex = i;
        headerRow = row;
      }
    }

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

      const rowObj = {};

      for (let colIdx = 0; colIdx < row.values.length && colIdx < headers.length; colIdx++) {
        const cell = row.values[colIdx];
        const header = headers[colIdx];

        if (!cell) {
          rowObj[header] = '';
          continue;
        }

        // Priority: hyperlink URL > cell text value
        if (cell.hyperlink) {
          rowObj[header] = cell.hyperlink;
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
export const detectImageUrlColumn = async (spreadsheetId, sheetName) => {
  try {
    const sheets = await getSheetsClient();

    // Read with grid data to include hyperlinks
    const response = await sheets.spreadsheets.get({
      spreadsheetId,
      ranges: [`${sheetName}!A:Z`],
      includeGridData: true,
    });

    const sheet = response.data.sheets?.[0];
    if (!sheet) return -1;

    const gridData = sheet.data?.[0];
    if (!gridData || !gridData.rowData) return -1;

    // Find header row first
    let headerRowIndex = -1;
    let maxCellsInRow = 0;
    for (let i = 0; i < Math.min(10, gridData.rowData.length); i++) {
      const row = gridData.rowData[i];
      if (!row.values) continue;
      const nonEmptyCells = row.values.filter(v => v && (v.userEnteredValue?.stringValue || v.userEnteredValue?.numberValue)).length;
      if (nonEmptyCells > maxCellsInRow) {
        maxCellsInRow = nonEmptyCells;
        headerRowIndex = i;
      }
    }

    if (headerRowIndex === -1) return -1;

    // Scan data rows for URLs (in hyperlinks or cell values)
    for (let rowIdx = headerRowIndex + 1; rowIdx < Math.min(headerRowIndex + 15, gridData.rowData.length); rowIdx++) {
      const row = gridData.rowData[rowIdx];
      if (!row.values) continue;

      for (let colIdx = 0; colIdx < row.values.length; colIdx++) {
        const cell = row.values[colIdx];
        if (!cell) continue;

        let cellValue = '';
        
        // Check hyperlink first
        if (cell.hyperlink) {
          cellValue = cell.hyperlink;
        } else if (cell.userEnteredValue?.stringValue) {
          cellValue = cell.userEnteredValue.stringValue;
        }

        if (cellValue && (cellValue.startsWith('http://') || cellValue.startsWith('https://'))) {
          console.log(`Found image URL column at index ${colIdx}`);
          return colIdx;
        }
      }
    }

    return -1;
  } catch (error) {
    console.error('Error detecting image URL column:', error.message);
    return -1;
  }
};

/**
 * Main batch processing function
 * Processes all rows in a Google Sheet, generates variations, uploads to Drive,
 * and updates the sheet with links
 *
 * Uses a FIXED Drive folder for all uploads: 1gWY-ZEMbWBcM_lwSKzc5HD89Pa_SiBWO
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
    baseUrl = process.env.API_BASE_URL || 'http://localhost:8080',
    onProgress,
  } = options;

  // FIXED Drive folder ID for all uploads
  const FIXED_DRIVE_FOLDER_ID = '1gWY-ZEMbWBcM_lwSKzc5HD89Pa_SiBWO';

  try {
    // Step 1: Validate inputs
    const spreadsheetId = extractSpreadsheetId(sheetsUrl);
    const folderId = FIXED_DRIVE_FOLDER_ID;

    // Step 2: Detect sheet name (use provided or find automatically)
    onProgress?.({
      state: 'detecting-sheet',
      message: 'Detecting sheet name...',
    });

    let sheetName = providedSheetName;
    if (!sheetName) {
      // Auto-detect: find first sheet with data
      sheetName = await findFirstSheetWithData(spreadsheetId);
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

    const imageUrlColumnIndex = await detectImageUrlColumn(spreadsheetId, sheetName);

    if (imageUrlColumnIndex === -1) {
      throw new Error('Could not find any column with image URLs in the sheet');
    }

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
    const gridData = headerResponse.data.sheets?.[0]?.data?.[0];
    if (gridData && gridData.rowData && gridData.rowData[0] && gridData.rowData[0].values) {
      // Find header row
      let headerRowIndex = 0;
      let maxCells = 0;
      for (let i = 0; i < Math.min(10, gridData.rowData.length); i++) {
        const cells = gridData.rowData[i].values?.filter(v => v && (v.userEnteredValue?.stringValue || v.userEnteredValue?.numberValue)).length || 0;
        if (cells > maxCells) {
          maxCells = cells;
          headerRowIndex = i;
        }
      }
      
      const headerCell = gridData.rowData[headerRowIndex]?.values?.[imageUrlColumnIndex];
      if (headerCell?.userEnteredValue?.stringValue) {
        imageUrlColumnName = headerCell.userEnteredValue.stringValue;
      }
    }

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
      const rowNumber = rowIndex + 2; // +2 because row 1 is headers and we're 0-indexed

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
          const upload = await uploadImageToDrive(oneToOneImages[i], fileName, folderId);
          const link = await makeFilePublic(upload.fileId);
          uploadedLinks['1:1'].push(link);
        }

        // Upload 9:16 variations
        for (let i = 0; i < nineByEditSixteenImages.length; i++) {
          const fileName = `${row.Categoria || 'image'}_${row.Ciudad || 'city'}_9-16_var${i + 1}.png`;
          const upload = await uploadImageToDrive(nineByEditSixteenImages[i], fileName, folderId);
          const link = await makeFilePublic(upload.fileId);
          uploadedLinks['9:16'].push(link);
        }

        // Prepare sheet updates - store outputs in columns after the image URL column
        const outputColumnStart = imageUrlColumnIndex + 1;

        if (uploadedLinks['1:1'][0]) {
          updates.push({
            range: `${sheetName}!${columnIndexToLetter(outputColumnStart)}${rowNumber}`,
            values: [[uploadedLinks['1:1'][0]]],
          });
        }

        if (uploadedLinks['1:1'][1]) {
          updates.push({
            range: `${sheetName}!${columnIndexToLetter(outputColumnStart + 1)}${rowNumber}`,
            values: [[uploadedLinks['1:1'][1]]],
          });
        }

        if (uploadedLinks['1:1'][2]) {
          updates.push({
            range: `${sheetName}!${columnIndexToLetter(outputColumnStart + 2)}${rowNumber}`,
            values: [[uploadedLinks['1:1'][2]]],
          });
        }

        if (uploadedLinks['9:16'][0]) {
          updates.push({
            range: `${sheetName}!${columnIndexToLetter(outputColumnStart + 3)}${rowNumber}`,
            values: [[uploadedLinks['9:16'][0]]],
          });
        }

        if (uploadedLinks['9:16'][1]) {
          updates.push({
            range: `${sheetName}!${columnIndexToLetter(outputColumnStart + 4)}${rowNumber}`,
            values: [[uploadedLinks['9:16'][1]]],
          });
        }

        if (uploadedLinks['9:16'][2]) {
          updates.push({
            range: `${sheetName}!${columnIndexToLetter(outputColumnStart + 5)}${rowNumber}`,
            values: [[uploadedLinks['9:16'][2]]],
          });
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
