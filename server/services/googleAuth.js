import { google } from 'googleapis';
import { JWT, GoogleAuth } from 'google-auth-library';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

let cachedAuthClient = null;

// Get the directory of the current file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const credentialsPath = path.join(__dirname, '../../.credentials.json');

/**
 * Returns an auth client configured with service account credentials
 * Tries multiple approaches:
 * 1. .credentials.json local file (for development)
 * 2. GOOGLE_SERVICE_ACCOUNT_KEY_B64 env var (base64 encoded JSON)
 * 3. GOOGLE_SERVICE_ACCOUNT_KEY env var (JSON parsed)
 * 4. Application Default Credentials (ADC) - automatically available in GCP environments
 */
export const getAuthClient = async () => {
  // Return cached client if available
  if (cachedAuthClient) {
    return cachedAuthClient;
  }

  let credentials = null;

  // Step 0.5: Try ADC/GoogleAuth first (most reliable in local dev with gcloud)
  if (process.env.NODE_ENV !== 'production') {
    try {
      console.log('Attempting to use GoogleAuth (ADC/gcloud)...');
      const auth = new GoogleAuth({
        scopes: [
          'https://www.googleapis.com/auth/spreadsheets',
          'https://www.googleapis.com/auth/drive.file',
          'https://www.googleapis.com/auth/drive',
        ],
      });
    
      const client = await auth.getClient();
      console.log('✓ GoogleAuth client loaded successfully');
      cachedAuthClient = client;
      return client;
    } catch (audiError) {
      console.log('GoogleAuth not available, trying service account credentials...');
    }
  }

  // Step 0: Try local .credentials.json file (for development)
  if (!credentials && fs.existsSync(credentialsPath)) {
    try {
      console.log('Attempting to use .credentials.json file...');
      const credentialsFile = fs.readFileSync(credentialsPath, 'utf-8');
      credentials = JSON.parse(credentialsFile);
      console.log('✓ Successfully loaded credentials from .credentials.json');
    } catch (error) {
      console.warn('Error reading .credentials.json:', error.message);
    }
  }

  // Step 1: Try explicit service account env vars (higher priority)
  // Try base64 encoded first
  if (!credentials && process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64) {
    try {
      console.log('Attempting to use GOOGLE_SERVICE_ACCOUNT_KEY_B64...');
      const decoded = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64, 'base64').toString('utf-8');
      credentials = JSON.parse(decoded);
      console.log('✓ Successfully decoded and parsed GOOGLE_SERVICE_ACCOUNT_KEY_B64');
    } catch (error) {
      console.warn('Error parsing GOOGLE_SERVICE_ACCOUNT_KEY_B64:', error.message);
    }
  }

  // Try direct JSON if base64 didn't work
  if (!credentials && process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    try {
      console.log('Attempting to use GOOGLE_SERVICE_ACCOUNT_KEY...');
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
      console.log('✓ Successfully parsed GOOGLE_SERVICE_ACCOUNT_KEY');
    } catch (error) {
      console.warn('Error parsing GOOGLE_SERVICE_ACCOUNT_KEY:', error.message);
    }
  }

  // Step 2: If we have credentials from env vars or file, create JWT client
  if (credentials && typeof credentials === 'object') {
    try {
      const jwtClient = new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
      });

      // Apply scopes to the JWT client
      jwtClient.scopes = [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive',
      ];

      console.log('✓ JWT client created with service account');
      cachedAuthClient = jwtClient;
      return jwtClient;
    } catch (jwtError) {
      console.warn('Error creating JWT client:', jwtError.message);
      console.log('JWT failed, trying ADC/GoogleAuth as fallback...');
      try {
        const auth = new GoogleAuth({
          scopes: [
            'https://www.googleapis.com/auth/spreadsheets',
            'https://www.googleapis.com/auth/drive.file',
            'https://www.googleapis.com/auth/drive',
          ],
        });
        const client = await auth.getClient();
        console.log('✓ Fallback to GoogleAuth successful');
        cachedAuthClient = client;
        return client;
      } catch (fallbackError) {
        console.warn('Fallback also failed:', fallbackError.message);
        throw jwtError; // Throw the original JWT error
      }
    }
  }

  // No credentials found
  throw new Error(
    'No authentication credentials found. Tried:\n' +
    '1. .credentials.json local file (for development)\n' +
    '2. GOOGLE_SERVICE_ACCOUNT_KEY_B64 environment variable\n' +
    '3. GOOGLE_SERVICE_ACCOUNT_KEY environment variable\n' +
    '4. Application Default Credentials (ADC)\n\n' +
    'For local development, place .credentials.json in the project root or set GOOGLE_SERVICE_ACCOUNT_KEY.\n' +
    'For GCP environments (Cloud Run, App Engine), ADC will be used automatically.'
  );
};

/**
 * Create an authorized Sheets client
 */
export const getSheetsClient = async () => {
  const auth = await getAuthClient();
  return google.sheets({ version: 'v4', auth });
};

/**
 * Create an authorized Drive client
 */
export const getDriveClient = async () => {
  const auth = await getAuthClient();
  return google.drive({ version: 'v3', auth });
};
