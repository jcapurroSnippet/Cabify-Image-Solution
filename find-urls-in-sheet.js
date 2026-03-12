/**
 * Search for URLs in Google Sheet (including hyperlinks)
 * Shows all cells containing http:// or https://
 * Also extracts URLs from hyperlinked text
 */

import { extractSpreadsheetId } from './server/services/sheetsService.js';
import { getSheetsClient } from './server/services/googleAuth.js';

const args = process.argv.slice(2);

if (args.length === 0) {
  console.log('Usage: node find-urls-in-sheet.js <sheets-url> [sheet-name]');
  process.exit(1);
}

const sheetsUrl = args[0];
const specifiedSheetName = args[1];

console.log('🔗 Searching for URLs in Google Sheet...');

try {
  const spreadsheetId = extractSpreadsheetId(sheetsUrl);
  const sheets = await getSheetsClient();

  // Get sheet names if not specified
  let sheetToAnalyze = specifiedSheetName;
  
  if (!sheetToAnalyze) {
    const metadata = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets(properties(title))',
    });
    const allSheets = metadata.data.sheets?.map(s => s.properties.title) || [];
    
    // Try common sheet names
    const commonNames = ['Data', 'Datos', 'Imágenes', 'Preview', 'Links'];
    for (const name of commonNames) {
      if (allSheets.includes(name)) {
        sheetToAnalyze = name;
        break;
      }
    }
    
    if (!sheetToAnalyze) {
      sheetToAnalyze = allSheets[0];
    }
  }

  console.log(`📊 Sheet: "${sheetToAnalyze}"`);
  console.log('');

  // Read with grid data to get hyperlinks
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    ranges: [`${sheetToAnalyze}!A1:AX100`],
    includeGridData: true,
  });

  const sheet = response.data.sheets?.[0];
  if (!sheet) {
    console.log('No data found');
    process.exit(0);
  }

  const rowData = sheet.data?.[0]?.rowData || [];
  const gridData = response.data.sheets?.[0]?.data?.[0];

  const urlCells = [];

  // Parse rows and extract URLs from hyperlinks
  if (gridData && gridData.rowData) {
    for (let rowIdx = 0; rowIdx < gridData.rowData.length; rowIdx++) {
      const row = gridData.rowData[rowIdx];
      if (!row.values) continue;

      for (let colIdx = 0; colIdx < row.values.length; colIdx++) {
        const cell = row.values[colIdx];
        if (!cell) continue;

        let url = null;
        let cellText = '';

        // Check for hyperlink
        if (cell.hyperlink) {
          url = cell.hyperlink;
          cellText = cell.userEnteredValue?.stringValue || 'hyperlink';
        }
        // Check for URL in cell text
        else if (cell.userEnteredValue?.stringValue) {
          const text = cell.userEnteredValue.stringValue;
          if (text.includes('http://') || text.includes('https://')) {
            url = text;
            cellText = text;
          }
        }

        if (url) {
          const colLetter = String.fromCharCode(65 + colIdx);
          urlCells.push({
            row: rowIdx + 1,
            col: colLetter,
            colIdx,
            url,
            text: cellText.substring(0, 30),
          });
        }
      }
    }
  }

  if (urlCells.length === 0) {
    console.log('❌ No URLs found in sheet');
  } else {
    console.log(`✓ Found ${urlCells.length} URLs\n`);
    console.log('🔗 URL Locations:');
    
    // Group by column
    const byColumn = {};
    urlCells.forEach(cell => {
      if (!byColumn[cell.col]) {
        byColumn[cell.col] = [];
      }
      byColumn[cell.col].push(cell);
    });

    for (const [col, cells] of Object.entries(byColumn)) {
      console.log(`\n   Column ${col} (${cells.length} URLs):`);
      cells.slice(0, 5).forEach(cell => {
        console.log(`      Row ${cell.row}: "${cell.text}" → ${cell.url.substring(0, 80)}`);
      });
      if (cells.length > 5) {
        console.log(`      ... and ${cells.length - 5} more`);
      }
    }

    console.log('');
    const mostCommon = Object.keys(byColumn).sort((a, b) => byColumn[b].length - byColumn[a].length)[0];
    console.log('📍 Most common column: ' + mostCommon);
    console.log(`✓ First URL: ${urlCells[0].url}`);
  }

  console.log('');

} catch (error) {
  console.error('❌ Error:', error.message);
  process.exit(1);
}
