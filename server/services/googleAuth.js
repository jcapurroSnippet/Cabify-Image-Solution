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
 * 
 * PRODUCTION FLOW (NODE_ENV=production):
 * 1. Application Default Credentials (ADC) - Service account in Cloud Run/App Engine
 * 
 * DEVELOPMENT FLOW:
 * 1. .credentials.json local file
 * 2. GOOGLE_SERVICE_ACCOUNT_KEY env var
 * 3. GOOGLE_SERVICE_ACCOUNT_KEY_B64 env var
 * 4. GoogleAuth (gcloud configured)
 * 5. Application Default Credentials (ADC)
 */
export const getAuthClient = async () => {
  // Return cached client if available
  if (cachedAuthClient) {
    return cachedAuthClient;
  }

  const isProduction = process.env.NODE_ENV === 'production';
  let credentials = null;

  // PRODUCTION: Try ADC first (this is the service account in Cloud Run/App Engine)
  if (isProduction) {
    try {
      console.log('📍 Production mode: Attempting Application Default Credentials (service account)...');
      const auth = new GoogleAuth({
        scopes: [
          'https://www.googleapis.com/auth/spreadsheets',
          'https://www.googleapis.com/auth/drive.file',
          'https://www.googleapis.com/auth/drive',
        ],
      });
    
      const client = await auth.getClient();
      console.log('✓ Production service account loaded via ADC');
      cachedAuthClient = client;
      return client;
    } catch (error) {
      console.error('❌ Production mode ADC failed:', error.message);
      throw new Error(
        'Failed to load service account credentials in production.\n' +
        'Ensure the service account has proper IAM roles in your GCP project.\n' +
        'Error: ' + error.message
      );
    }
  }

  // DEVELOPMENT: Try local .credentials.json file first
  if (!credentials && fs.existsSync(credentialsPath)) {
    try {
      console.log('📍 Development mode: Attempting to use .credentials.json file...');
      const credentialsFile = fs.readFileSync(credentialsPath, 'utf-8');
      credentials = JSON.parse(credentialsFile);
      console.log('✓ Successfully loaded credentials from .credentials.json');
    } catch (error) {
      console.warn('⚠️  Error reading .credentials.json:', error.message);
    }
  }

  // Try explicit service account env var
  if (!credentials && process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    try {
      console.log('📍 Attempting to use GOOGLE_SERVICE_ACCOUNT_KEY env var...');
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
      console.log('✓ Successfully parsed GOOGLE_SERVICE_ACCOUNT_KEY');
    } catch (error) {
      console.warn('⚠️  Error parsing GOOGLE_SERVICE_ACCOUNT_KEY:', error.message);
    }
  }

  // Try base64 encoded service account env var
  if (!credentials && process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64) {
    try {
      console.log('📍 Attempting to use GOOGLE_SERVICE_ACCOUNT_KEY_B64 env var...');
      const decoded = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64, 'base64').toString('utf-8');
      credentials = JSON.parse(decoded);
      console.log('✓ Successfully decoded and parsed GOOGLE_SERVICE_ACCOUNT_KEY_B64');
    } catch (error) {
      console.warn('⚠️  Error parsing GOOGLE_SERVICE_ACCOUNT_KEY_B64:', error.message);
    }
  }

  // If we have credentials from file or env vars, create JWT client
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

      console.log('✓ JWT client created with service account (development)');
      cachedAuthClient = jwtClient;
      return jwtClient;
    } catch (jwtError) {
      console.warn('⚠️  Error creating JWT client:', jwtError.message);
      console.log('📍 Fallback: Trying GoogleAuth (gcloud configured)...');
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
        console.warn('⚠️  GoogleAuth also failed:', fallbackError.message);
        
        // Final fallback: Try ADC
        try {
          console.log('📍 Final fallback: Trying Application Default Credentials...');
          const auth = new GoogleAuth({
            scopes: [
              'https://www.googleapis.com/auth/spreadsheets',
              'https://www.googleapis.com/auth/drive.file',
              'https://www.googleapis.com/auth/drive',
            ],
          });
          const client = await auth.getClient();
          console.log('✓ ADC fallback successful');
          cachedAuthClient = client;
          return client;
        } catch (adcError) {
          console.error('❌ All authentication methods failed');
          throw jwtError; // Throw the original error
        }
      }
    }
  }

  // No credentials found - try ADC as final fallback
  try {
    console.log('📍 No explicit credentials found, trying GoogleAuth (ADC)...');
    const auth = new GoogleAuth({
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive',
      ],
    });
    const client = await auth.getClient();
    console.log('✓ ADC client loaded');
    cachedAuthClient = client;
    return client;
  } catch (error) {
    throw new Error(
      'No authentication credentials found. Please configure one of the following:\n\n' +
      'FOR PRODUCTION (Cloud Run, App Engine, Compute Engine):\n' +
      '  - Service account will be automatically available via ADC\n\n' +
      'FOR LOCAL DEVELOPMENT:\n' +
      '  1. Place valid .credentials.json in project root, OR\n' +
      '  2. Set GOOGLE_SERVICE_ACCOUNT_KEY environment variable with JSON, OR\n' +
      '  3. Set GOOGLE_SERVICE_ACCOUNT_KEY_B64 with base64-encoded JSON, OR\n' +
      '  4. Run: gcloud auth application-default login\n\n' +
      'Original error: ' + error.message
    );
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
