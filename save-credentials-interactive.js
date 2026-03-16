#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const credentialsPath = path.join(__dirname, '.credentials.json');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('\n📋 SERVICE ACCOUNT CREDENTIALS SETUP\n');
console.log('Paste your service account JSON below.');
console.log('When you\'re done, press Enter twice.\n');
console.log('Example format:');
console.log('{"type":"service_account","project_id":"...", ... }\n');

let jsonBuffer = '';
let emptyLineCount = 0;

const readLine = () => {
  rl.question('', (line) => {
    if (line === '') {
      emptyLineCount++;
      if (emptyLineCount >= 2) {
        rl.close();
        processInput();
        return;
      }
    } else {
      emptyLineCount = 0;
      jsonBuffer += line + '\n';
    }
    readLine();
  });
};

function processInput() {
  const json = jsonBuffer.trim();
  
  if (!json) {
    console.error('\n❌ No input provided\n');
    process.exit(1);
  }

  try {
    const credentials = JSON.parse(json);
    
    // Validate required fields
    const required = ['type', 'project_id', 'private_key_id', 'private_key', 'client_email', 'client_id', 'auth_uri', 'token_uri'];
    const missing = required.filter(field => !credentials[field]);
    
    if (missing.length > 0) {
      console.error(`\n❌ Missing required fields: ${missing.join(', ')}\n`);
      process.exit(1);
    }

    // Save to file
    fs.writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2));
    
    console.log('\n✅ SUCCESS!\n');
    console.log(`📁 Saved to: ${credentialsPath}`);
    console.log(`🔐 Service Account: ${credentials.client_email}`);
    console.log(`📦 Project: ${credentials.project_id}\n`);
    
  } catch (error) {
    console.error(`\n❌ Invalid JSON: ${error.message}\n`);
    process.exit(1);
  }
}

readLine();
