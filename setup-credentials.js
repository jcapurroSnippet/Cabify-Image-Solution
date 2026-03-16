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

const question = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

console.log('\n🔐 Google Service Account Credentials Setup\n');
console.log('This will help you configure authentication for Google APIs.\n');

console.log('You have two options:\n');
console.log('1. Paste your service account JSON (from Google Cloud Console)');
console.log('2. Set environment variable GOOGLE_SERVICE_ACCOUNT_KEY_B64 with base64-encoded JSON\n');

(async () => {
  const choice = await question('Which option? (1/2): ');

  if (choice === '1') {
    console.log('\n📝 Paste your service account JSON below.');
    console.log('(It should start with { and look like this:)');
    console.log('  {"type": "service_account", "project_id": "...", ...}');
    console.log('\nWhen done, press Enter twice:\n');

    let json = '';
    let emptyCount = 0;

    for (let i = 0; i < 100; i++) {
      const line = await question('');
      if (line === '' && json) {
        emptyCount++;
        if (emptyCount === 2) break;
      } else {
        emptyCount = 0;
      }
      if (line) json += line + '\n';
    }

    try {
      const credentials = JSON.parse(json);
      
      // Validate structure
      if (!credentials.client_email || !credentials.private_key || !credentials.project_id) {
        console.error('\n❌ Invalid service account JSON. Missing required fields.');
        console.error('Required: client_email, private_key, project_id\n');
        rl.close();
        process.exit(1);
      }

      fs.writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2));
      console.log(`\n✓ Credentials saved to: ${credentialsPath}`);
      console.log(`✓ Service Account: ${credentials.client_email}`);
      console.log(`✓ Project ID: ${credentials.project_id}`);
    } catch (error) {
      console.error('\n❌ Invalid JSON:', error.message);
      rl.close();
      process.exit(1);
    }
  } else if (choice === '2') {
    const envVar = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64;
    if (!envVar) {
      console.error('\n❌ GOOGLE_SERVICE_ACCOUNT_KEY_B64 environment variable not set.');
      rl.close();
      process.exit(1);
    }

    try {
      const decoded = Buffer.from(envVar, 'base64').toString('utf-8');
      const credentials = JSON.parse(decoded);

      if (!credentials.client_email || !credentials.private_key || !credentials.project_id) {
        console.error('\n❌ Invalid service account JSON. Missing required fields.');
        rl.close();
        process.exit(1);
      }

      fs.writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2));
      console.log(`\n✓ Credentials saved to: ${credentialsPath}`);
      console.log(`✓ Service Account: ${credentials.client_email}`);
    } catch (error) {
      console.error('\n❌ Error processing base64 credentials:', error.message);
      rl.close();
      process.exit(1);
    }
  } else {
    console.error('\n❌ Invalid choice');
    rl.close();
    process.exit(1);
  }

  console.log('\n✅ Setup complete!\n');
  rl.close();
})();
