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
 * Find column indices for output columns in the sheet
 * Looks for columns containing keywords like "1:1 IMG A", "1:1 IMG B", etc.
 */
export const findOutputColumnIndices = async (spreadsheetId, sheetName) => {
  try {
    const sheets = await getSheetsClient();

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!1:1`,
    });

    const headers = response.data.values?.[0] || [];
    const indices = {};

    // Map of column names to search for
    const patterns = {
      '1:1_A': '1:1  IMG A',
      '1:1_B': '1:1  IMG B',
      '1:1_C': '1:1  IMG',
      '9:16_A': '9:16  IMG A',
      '9:16_B': '9:16 IMG B',
      '9:16_C': '9:16 IMG C',
    };

    for (const [key, pattern] of Object.entries(patterns)) {
      const index = headers.findIndex((h) => h.includes(pattern));
      if (index !== -1) {
        indices[key] = index;
      }
    }

    return indices;
  } catch (error) {
    console.error('Error finding output column indices:', error.message);
    throw error;
  }
};

/**
 * Main batch processing function
 * Processes all rows in a Google Sheet, generates variations, uploads to Drive,
 * and updates the sheet with links
 *
 * Options: {
 *   sheetsUrl: string,
 *   driveFolderUrl: string,
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
    driveFolderUrl,
    sheetName: providedSheetName,
    baseUrl = process.env.API_BASE_URL || 'http://localhost:8080',
    onProgress,
  } = options;

  try {
    // Step 1: Validate inputs
    const spreadsheetId = extractSpreadsheetId(sheetsUrl);
    let folderId = null;

    try {
      folderId = extractFolderId(driveFolderUrl);
    } catch (error) {
      console.warn('Warning: Invalid Drive folder URL, will upload to root:', error.message);
    }

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

    // Step 3: Read all rows from sheet
    onProgress?.({
      state: 'reading-sheet',
      message: 'Reading Google Sheet...',
    });

    const rows = await readSheetRows(spreadsheetId, sheetName);
    const totalRows = rows.length;

    if (totalRows === 0) {
      throw new Error('No data rows found in the sheet');
    }

    // Step 4: Find output column indices
    const columnIndices = await findOutputColumnIndices(spreadsheetId, sheetName);

    // Step 4: Process each row
    const updates = [];

    for (let rowIndex = 0; rowIndex < totalRows; rowIndex++) {
      const row = rows[rowIndex];
      const rowNumber = rowIndex + 2; // +2 because row 1 is headers and we're 0-indexed

      try {
        // Find image URL from common column names (try multiple variations for flexibility)
        let imageUrl = null;
        
        // List of common column name variations to try
        const imageColumnNames = [
          'Preview de creatividad',
          'Preview',
          'Image URL',
          'Imagen',
          'Creative',
          '16.9 IMG',
        ];

        // Find the first non-empty image URL
        for (const colName of imageColumnNames) {
          if (row[colName] && row[colName].trim() !== '') {
            imageUrl = row[colName];
            break;
          }
        }

        if (!imageUrl || imageUrl.trim() === '') {
          onProgress?.({
            rowNumber,
            currentRow: rowIndex + 1,
            totalRows,
            status: 'skipped',
            reason: 'No image URL found in columns: ' + imageColumnNames.join(', '),
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

        // Prepare sheet updates
        if (columnIndices['1:1_A'] !== undefined) {
          updates.push({
            range: `${sheetName}!${columnIndexToLetter(columnIndices['1:1_A'])}${rowNumber}`,
            values: [[uploadedLinks['1:1'][0] || '']],
          });
        }

        if (columnIndices['1:1_B'] !== undefined) {
          updates.push({
            range: `${sheetName}!${columnIndexToLetter(columnIndices['1:1_B'])}${rowNumber}`,
            values: [[uploadedLinks['1:1'][1] || '']],
          });
        }

        if (columnIndices['1:1_C'] !== undefined) {
          updates.push({
            range: `${sheetName}!${columnIndexToLetter(columnIndices['1:1_C'])}${rowNumber}`,
            values: [[uploadedLinks['1:1'][2] || '']],
          });
        }

        if (columnIndices['9:16_A'] !== undefined) {
          updates.push({
            range: `${sheetName}!${columnIndexToLetter(columnIndices['9:16_A'])}${rowNumber}`,
            values: [[uploadedLinks['9:16'][0] || '']],
          });
        }

        if (columnIndices['9:16_B'] !== undefined) {
          updates.push({
            range: `${sheetName}!${columnIndexToLetter(columnIndices['9:16_B'])}${rowNumber}`,
            values: [[uploadedLinks['9:16'][1] || '']],
          });
        }

        if (columnIndices['9:16_C'] !== undefined) {
          updates.push({
            range: `${sheetName}!${columnIndexToLetter(columnIndices['9:16_C'])}${rowNumber}`,
            values: [[uploadedLinks['9:16'][2] || '']],
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
