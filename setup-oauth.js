#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env manually before any other imports
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}

const { performOAuthFlow } = await import('./server/services/oauthAuth.js');

console.log('\n🔐 OAuth Setup — Google Drive + Sheets + Photos\n');
console.log('This will open a browser window to authorize the app.\n');

try {
  await performOAuthFlow();
  console.log('\n✅ OAuth tokens saved successfully.');
  console.log('   Scopes include: Drive, Sheets, Google Photos\n');
  process.exit(0);
} catch (error) {
  console.error('\n❌ OAuth flow failed:', error.message);
  process.exit(1);
}
