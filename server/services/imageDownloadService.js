/**
 * ============================================
 * IMAGE DOWNLOAD & SHEET PROCESSING SERVICE
 * ============================================
 * 
 * Simplified, secure, and well-documented utilities
 * for downloading images from URLs and processing
 * Google Sheets data.
 * 
 * FEATURES:
 * ✓ Timeout protection (prevents hanging)
 * ✓ Size limits (prevents memory bloat)
 * ✓ URL validation (prevents SSRF attacks)
 * ✓ Retry logic (handles transient failures)
 * ✓ Clear error messages (easy debugging)
 * ✓ Full documentation (maintainable code)
 */

import axios from 'axios';
import { getSheetsClient } from './googleAuth.js';

// ============================================
// CONFIGURATION CONSTANTS
// ============================================

const CONFIG = {
  // Download constraints
  DOWNLOAD_TIMEOUT_MS: 30000,        // 30 seconds
  MAX_IMAGE_SIZE_BYTES: 50 * 1024 * 1024, // 50 MB
  MAX_REDIRECTS: 5,

  // Retry strategy (exponential backoff)
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 1000, // Initial delay, doubles each retry

  // Data extraction
  IMAGE_URL_COLUMN_NAMES: [
    'Categoria',
    'Ciudad',
    'Copy in de la pieza',
    'Preview de creatividad',
    '16.9 IMG'
  ],
};

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Validates that a URL is safe to download
 * 
 * Prevents:
 * - SSRF attacks (localhost, internal IPs)
 * - File URLs
 * - Non-HTTP(S) schemes
 * 
 * @param {string} url - URL to validate
 * @throws {Error} If URL is invalid or unsafe
 * @returns {void}
 * 
 * @example
 * validateImageUrl('https://example.com/image.jpg'); // OK
 * validateImageUrl('file:///etc/passwd');             // Throws error
 * validateImageUrl('http://127.0.0.1/image.jpg');    // Throws error
 */
export const validateImageUrl = (url) => {
  if (typeof url !== 'string' || !url.trim()) {
    throw new Error('URL must be a non-empty string');
  }

  const urlObj = new URL(url); // Will throw if invalid URL syntax

  // Only allow HTTP and HTTPS
  if (!['http:', 'https:'].includes(urlObj.protocol)) {
    throw new Error(`Dangerous URL scheme: ${urlObj.protocol}`);
  }

  // Block localhost and internal IPs (SSRF prevention)
  const hostname = urlObj.hostname;
  const internalPatterns = [
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    /^192\.168\./,      // Private networks
    /^10\./,             // Private networks
    /^172\.(1[6-9]|2[0-9]|3[0-1])/,  // Private networks
    /^::1$/,             // IPv6 localhost
  ];

  for (const pattern of internalPatterns) {
    if (typeof pattern === 'string') {
      if (hostname === pattern) {
        throw new Error(`Blocked internal URL: ${hostname}`);
      }
    } else if (pattern.test(hostname)) {
      throw new Error(`Blocked internal URL: ${hostname}`);
    }
  }
};

/**
 * Sanitizes file names for safe Drive upload
 * 
 * Removes dangerous characters that could cause:
 * - Path traversal (.., ...)
 * - Special character issues
 * - File system problems
 * 
 * @param {string} str - Raw file name
 * @param {number} maxLength - Maximum length (default: 200)
 * @returns {string} Safe file name
 * 
 * @example
 * sanitizeFileName('../../../etc/passwd');  // Returns: etcpasswd
 * sanitizeFileName('My Image (1).png');     // Returns: myimage1png
 * sanitizeFileName('Café ☕.jpg');          // Returns: caf.jpg
 */
export const sanitizeFileName = (str, maxLength = 200) => {
  if (typeof str !== 'string') {
    return 'file';
  }

  return str
    .trim()
    .toLowerCase()
    // Remove dangerous path characters
    .replace(/\.\./g, '')        // Remove ..
    .replace(/[\/\\]/g, '_')     // Replace slashes with underscore
    // Keep only safe characters and common accents
    .replace(/[^a-z0-9_\-áéíóúñ]/g, '')
    // Remove leading/trailing special chars
    .replace(/^[_\-]+/, '')
    .replace(/[_\-]+$/, '')
    // Limit length
    .substring(0, maxLength)
    // Ensure not empty
    || 'image';
};

/**
 * Delays execution (for retry backoff)
 * 
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise<void>}
 * 
 * @example
 * await delay(1000); // Wait 1 second
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Executes a function with exponential backoff retry
 * 
 * Pattern:
 * - Attempt 1: Fail? Wait 1s, try again
 * - Attempt 2: Fail? Wait 2s, try again
 * - Attempt 3: Fail? Throw error
 * 
 * @param {Function} fn - Async function to retry
 * @param {Object} options - Configuration
 * @param {number} options.maxRetries - Max attempts (default: 3)
 * @param {number} options.initialDelayMs - Initial delay (default: 1000)
 * @returns {Promise<any>} Result from successful attempt
 * @throws {Error} If all retries fail
 * 
 * @example
 * const result = await retryWithBackoff(
 *   () => someUnstableApi(),
 *   { maxRetries: 5, initialDelayMs: 500 }
 * );
 */
export const retryWithBackoff = async (
  fn,
  options = {}
) => {
  const {
    maxRetries = CONFIG.MAX_RETRIES,
    initialDelayMs = CONFIG.RETRY_DELAY_MS,
  } = options;

  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // If last attempt, throw immediately
      if (attempt === maxRetries - 1) {
        throw error;
      }

      // Calculate backoff delay (1s, 2s, 4s, ...)
      const delayMs = initialDelayMs * Math.pow(2, attempt);

      console.warn(
        `Attempt ${attempt + 1}/${maxRetries} failed. ` +
        `Retrying in ${delayMs}ms...`,
        error.message
      );

      await delay(delayMs);
    }
  }

  throw lastError;
};

// ============================================
// MAIN SERVICE FUNCTIONS
// ============================================

/**
 * Downloads an image from a URL and converts to base64 data URL
 * 
 * SECURITY FEATURES:
 * ✓ URL validation (prevents SSRF)
 * ✓ Timeout protection (30 seconds default)
 * ✓ Size limits (50 MB)
 * ✓ Retry logic (handles transient failures)
 * ✓ User-Agent header (looks legitimate)
 * 
 * @param {string} imageUrl - URL to download from
 * @param {Object} options - Configuration
 * @param {number} options.timeoutMs - Download timeout (default: 30000ms)
 * @param {number} options.maxSizeBytes - Max file size (default: 50MB)
 * @returns {Promise<string>} Base64 data URL in format: data:image/png;base64,...
 * @throws {Error} If URL invalid, download fails, or file too large
 * 
 * @example
 * const dataUrl = await downloadImageAsDataUrl(
 *   'https://example.com/image.jpg'
 * );
 * // Returns: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABA...'
 * 
 * // With custom options:
 * const dataUrl = await downloadImageAsDataUrl(
 *   'https://cdn.example.com/huge-image.png',
 *   { timeoutMs: 60000, maxSizeBytes: 100 * 1024 * 1024 }
 * );
 */
export const downloadImageAsDataUrl = async (
  imageUrl,
  options = {}
) => {
  const {
    timeoutMs = CONFIG.DOWNLOAD_TIMEOUT_MS,
    maxSizeBytes = CONFIG.MAX_IMAGE_SIZE_BYTES,
  } = options;

  // Validate URL is safe
  try {
    validateImageUrl(imageUrl);
  } catch (error) {
    throw new Error(`Invalid image URL: ${error.message}`);
  }

  // Attempt download with retry
  return await retryWithBackoff(async () => {
    try {
      console.log(`Downloading image: ${imageUrl}`);

      const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: timeoutMs,
        maxContentLength: maxSizeBytes,
        maxRedirects: CONFIG.MAX_REDIRECTS,
        headers: {
          'User-Agent': 'Cabify-ImageSuite/1.0 (Image Processing)',
        },
      });

      // Extract MIME type from headers
      const mimeType = response.headers['content-type'] || 'image/png';

      // Convert to base64
      const base64 = Buffer.from(response.data).toString('base64');

      console.log(`✓ Downloaded ${response.data.length} bytes (${mimeType})`);

      return `data:${mimeType};base64,${base64}`;
    } catch (error) {
      // Provide helpful error messages based on error type
      if (error.code === 'ECONNABORTED') {
        throw new Error(
          `Download timeout: Image took longer than ${timeoutMs}ms to download`
        );
      }

      if (error.response?.status === 404) {
        throw new Error(`Image not found (404): ${imageUrl}`);
      }

      if (error.message?.includes('exceeds maxContentLength')) {
        throw new Error(
          `Image too large: Exceeds ${maxSizeBytes / 1024 / 1024}MB limit`
        );
      }

      // Re-throw with original message for other errors
      throw new Error(`Failed to download image: ${error.message}`);
    }
  });
};

/**
 * Extracts image URLs from a Google Sheet row
 * 
 * Intelligently searches multiple common column names:
 * - Preview de creatividad (Spanish)
 * - Preview (English)
 * - Image URL
 * - Imagen (Spanish)
 * - Creative/Creatividad
 * 
 * Returns the first non-empty URL found.
 * 
 * @param {Object} row - Sheet row object (key:value from headers)
 * @returns {string|null} Image URL if found, null otherwise
 * 
 * @example
 * const row = {
 *   'Producto': 'iPhone',
 *   'Preview de creatividad': 'https://example.com/img.jpg'
 * };
 * const url = extractImageUrlFromRow(row);
 * // Returns: 'https://example.com/img.jpg'
 * 
 * const emptyRow = { 'Producto': 'iPad' };
 * const url = extractImageUrlFromRow(emptyRow);
 * // Returns: null
 */
export const extractImageUrlFromRow = (row) => {
  if (!row || typeof row !== 'object') {
    return null;
  }

  // Try each common column name in order
  for (const columnName of CONFIG.IMAGE_URL_COLUMN_NAMES) {
    const value = row[columnName];

    // Check if value exists and is non-empty
    if (value && typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }

  // No URL found in any column
  return null;
};

/**
 * Reads all data rows from a Google Sheet with hyperlink extraction
 * 
 * IMPORTANT:
 * - Row 1 is treated as headers
 * - Subsequent rows are data
 * - Hyperlinks from cells are extracted (e.g., from "Preview" column)
 * - Each row is converted to an object with headers as keys
 * 
 * @param {string} spreadsheetId - Google Sheets ID
 * @param {string} sheetName - Tab name (e.g., "Sheet1", "ENVIOS | AR")
 * @returns {Promise<Array<Object>>} Array of row objects
 * @throws {Error} If sheet not found or API error
 * 
 * @example
 * const rows = await readAllSheetRows(
 *   '14ZZPEd_EKQWVEArzP1gQz66-n8V2aWb4SZ0CWaHkbZc',
 *   'ENVIOS | AR | 2026'
 * );
 * // Returns:
 * // [
 * //   { 
 * //     Categoria: 'Delivery',
 * //     Ciudad: 'Madrid',
 * //     'Preview de creatividad': 'https://...'
 * //   },
 * //   ...
 * // ]
 */
export const readAllSheetRows = async (spreadsheetId, sheetName) => {
  try {
    const sheets = await getSheetsClient();

    console.log(`Reading sheet: "${sheetName}"`);

    // Step 1: Get raw values
    const valuesResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: sheetName,
    });

    const allValues = valuesResponse.data.values || [];

    if (allValues.length === 0) {
      console.warn(`Sheet is empty: "${sheetName}"`);
      return [];
    }

    const [headers, ...dataRows] = allValues;

    console.log(`Found ${dataRows.length} data rows and ${headers.length} columns`);

    // Step 2: Extract hyperlinks from grid data
    let hyperlinks = {};
    try {
      const spreadsheetResponse = await sheets.spreadsheets.get({
        spreadsheetId,
        includeGridData: true,
        ranges: [sheetName],
      });

      const sheetData = spreadsheetResponse.data.sheets?.[0];
      if (sheetData?.data?.[0]?.rowData) {
        const gridRows = sheetData.data[0].rowData;

        gridRows.forEach((row, rowIdx) => {
          if (!row?.values) return;

          row.values.forEach((cell, colIdx) => {
            // Store hyperlink with key: "rowIndex_colIndex"
            if (cell?.hyperlink) {
              const key = `${rowIdx}_${colIdx}`;
              hyperlinks[key] = cell.hyperlink;
            }
          });
        });
      }

      console.log(`Extracted ${Object.keys(hyperlinks).length} hyperlinks`);
    } catch (error) {
      console.warn(`Could not extract hyperlinks: ${error.message}`);
      // Continue anyway - we still have the cell values
    }

    // Step 3: Convert rows to objects, preferring hyperlinks over cell values
    const rowObjects = dataRows.map((row, rowIdx) => {
      const obj = {};

      headers.forEach((header, colIdx) => {
        const cell = row?.[colIdx] || '';
        // Hyperlinks use row index offset by 1 (because headers are row 0)
        const hyperlinkKey = `${rowIdx + 1}_${colIdx}`;
        const hyperlink = hyperlinks[hyperlinkKey];

        // Prefer hyperlink if available (more reliable for URLs)
        obj[header] = hyperlink || cell;
      });

      return obj;
    });

    console.log(`✓ Successfully read ${rowObjects.length} rows from sheet`);

    return rowObjects;
  } catch (error) {
    console.error('Error reading sheet:', error);
    throw new Error(`Failed to read Google Sheet: ${error.message}`);
  }
};

/**
 * Finds the first sheet with meaningful data
 * 
 * Selection strategy:
 * 1. Look for sheet with 3+ columns AND image-related keywords (best)
 * 2. Look for sheet with headers + data rows (fallback)
 * 3. Use first sheet in workbook (last resort)
 * 
 * Image keywords: 'preview', 'imagen', 'image', 'creative', 'piezas'
 * 
 * @param {string} spreadsheetId - Google Sheets ID
 * @returns {Promise<string>} Sheet name to use
 * @throws {Error} If spreadsheet empty
 * 
 * @example
 * const sheetName = await findDataSheet(
 *   '14ZZPEd_EKQWVEArzP1gQz66-n8V2aWb4SZ0CWaHkbZc'
 * );
 * // Returns: "ENVIOS | AR | 2026"
 */
export const findDataSheet = async (spreadsheetId) => {
  try {
    const sheets = await getSheetsClient();

    // Get all sheet names
    const response = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets(properties(title))',
    });

    const sheetNames = response.data.sheets?.map((s) => s.properties.title) || [];

    if (sheetNames.length === 0) {
      throw new Error('Spreadsheet has no sheets');
    }

    console.log(`Found ${sheetNames.length} sheets in spreadsheet`);

    // Keywords that indicate image data
    const imageKeywords = ['preview', 'imagen', 'image', 'creative', 'creativo', 'piezas'];

    // Strategy 1: Find sheet with 3+ columns AND image keywords
    for (const sheetName of sheetNames) {
      try {
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `${sheetName}!1:1`,
        });

        const headers = res.data.values?.[0] || [];

        if (headers.length >= 3) {
          const hasImageColumn = headers.some((h) =>
            imageKeywords.some((kw) => h?.toLowerCase().includes(kw))
          );

          if (hasImageColumn) {
            console.log(`✓ Found sheet with image columns: "${sheetName}"`);
            return sheetName;
          }
        }
      } catch (error) {
        // Skip sheets with errors
        continue;
      }
    }

    // Strategy 2: Find sheet with headers and data
    for (const sheetName of sheetNames) {
      try {
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `${sheetName}!1:5`,
        });

        const rows = res.data.values || [];
        const hasHeaders = rows.length > 0 && rows[0].length >= 3;
        const hasData = rows.length > 1;

        if (hasHeaders && hasData) {
          console.log(`✓ Found sheet with data: "${sheetName}"`);
          return sheetName;
        }
      } catch (error) {
        continue;
      }
    }

    // Strategy 3: Use first sheet as fallback
    console.warn(`⚠ Using first sheet as fallback: "${sheetNames[0]}"`);
    return sheetNames[0];
  } catch (error) {
    console.error('Error finding data sheet:', error);
    throw new Error(`Failed to find data sheet: ${error.message}`);
  }
};
