#!/usr/bin/env node
/**
 * Extract All URLs from User Sheet
 * Shows exactly how URLs are obtained and stores them in a JSON file
 */

import { readSheetRowsWithHyperlinks } from './server/services/batchProcessor.js';
import { getSheetsClient } from './server/services/googleAuth.js';
import fs from 'fs';

const SPREADSHEET_ID = '14ZZPEd_EKQWVEArzP1gQz66-n8V2aWb4SZ0CWaHkbZc';
const TARGET_SHEET = 'AR | UY | DRIVERS H: FB + IG SINGLE IMAGE';

async function extractAllUrls() {
  console.log('\n📋 Extracting All URLs from Sheet\n');
  console.log('═'.repeat(70));
  
  try {
    console.log('\n1️⃣  Connecting to Google Sheets...');
    const sheets = await getSheetsClient();
    console.log('✅ Connected\n');

    console.log('2️⃣  Reading all rows with URLs...');
    const rows = await readSheetRowsWithHyperlinks(SPREADSHEET_ID, TARGET_SHEET);
    console.log(`✅ Read ${rows.length} rows\n`);

    // Extract URLs
    console.log('3️⃣  Extracting URLs...\n');
    const urls = [];
    
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const url = row['Link'] || row['link'] || row['URL'] || row['url'];
      
      if (url && (url.includes('http://') || url.includes('https://'))) {
        urls.push({
          row: i + 1,
          url: url,
          // Also capture other useful data
          data: {
            'FB + IG': row['FB + IG'] || '',
            '1080x1080': row['1080x1080'] || '',
            'ColumnA': row['ColumnA'] || '',
          }
        });
      }
    }

    console.log(`Found ${urls.length} valid URLs\n`);
    console.log('First 10 URLs:\n');
    
    for (let i = 0; i < Math.min(10, urls.length); i++) {
      const item = urls[i];
      console.log(`${i + 1}. Row ${item.row}:`);
      console.log(`   ${item.url}\n`);
    }

    // Save to file
    const outputFile = 'extracted-urls.json';
    fs.writeFileSync(outputFile, JSON.stringify({
      timestamp: new Date().toISOString(),
      spreadsheet_id: SPREADSHEET_ID,
      sheet_name: TARGET_SHEET,
      total_urls: urls.length,
      urls: urls
    }, null, 2));

    console.log(`✅ Saved all URLs to ${outputFile}`);

    // Show code example
    console.log('\n' + '═'.repeat(70));
    console.log('\n📝 HOW TO GET URLs IN YOUR CODE:\n');
    console.log(`// Method 1: Using readSheetRowsWithHyperlinks (Recommended)`);
    console.log(`import { readSheetRowsWithHyperlinks } from './server/services/batchProcessor.js';\n`);
    console.log(`async function getUrls() {`);
    console.log(`  const rows = await readSheetRowsWithHyperlinks(spreadsheetId, sheetName);`);
    console.log(`  const urls = rows.map(row => row['Link']).filter(u => u?.startsWith('http'));`);
    console.log(`  return urls;`);
    console.log(`}\n`);

    console.log(`// Method 2: Using detectImageUrlColumn + getValue`);
    console.log(`import { detectImageUrlColumn } from './server/services/batchProcessor.js';\n`);
    console.log(`async function getUrlsFromColumn(spreadsheetId, sheetName) {`);
    console.log(`  const columnIndex = await detectImageUrlColumn(spreadsheetId, sheetName);`);
    console.log(`  if (columnIndex === -1) throw new Error('No URL column found');`);
    console.log(`  `);
    console.log(`  const sheets = await getSheetsClient();`);
    console.log(`  const response = await sheets.spreadsheets.get({`);
    console.log(`    spreadsheetId,`);
    console.log(`    ranges: [sheetName],`);
    console.log(`    includeGridData: true,`);
    console.log(`  });`);
    console.log(`  `);
    console.log(`  const gridData = response.data.sheets[0].data[0];`);
    console.log(`  const urls = [];`);
    console.log(`  `);
    console.log(`  for (const row of gridData.rowData) {`);
    console.log(`    const cell = row.values[columnIndex];`);
    console.log(`    if (cell?.hyperlink) {`);
    console.log(`      urls.push(cell.hyperlink);`);
    console.log(`    } else if (cell?.userEnteredValue?.stringValue?.includes('http')) {`);
    console.log(`      urls.push(cell.userEnteredValue.stringValue);`);
    console.log(`    }`);
    console.log(`  }`);
    console.log(`  `);
    console.log(`  return urls;`);
    console.log(`}\n`);

    console.log('═'.repeat(70) + '\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

extractAllUrls().catch(console.error);
