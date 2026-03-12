import { google } from 'googleapis';
import { JWT, GoogleAuth } from 'google-auth-library';

let cachedAuthClient = null;

/**
 * Returns an auth client configured with service account credentials
 * Tries multiple approaches:
 * 1. Application Default Credentials (ADC) - automatically available in GCP environments
 * 2. GOOGLE_SERVICE_ACCOUNT_KEY env var (JSON parsed)
 * 3. GOOGLE_SERVICE_ACCOUNT_KEY_B64 env var (base64 encoded JSON)
 */
export const getAuthClient = async () => {
  // Return cached client if available
  if (cachedAuthClient) {
    return cachedAuthClient;
  }

  let credentials = null;

  // Step 1: Try Application Default Credentials (works in Cloud Run, App Engine, GCE, etc.)
  try {
    console.log('Attempting to use Application Default Credentials...');
    const auth = new GoogleAuth({
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive',
      ],
    });
    
    const client = await auth.getClient();
    console.log('✓ Application Default Credentials loaded successfully');
    cachedAuthClient = client;
    return client;
  } catch (error) {
    console.log('ADC not available (expected in local development):', error.message);
  }

  // Step 2: Try environment variable directly (JSON)
  const credentialsStr = process.env.GOOGLE_SERVICE_ACCOUNT_KEY?.trim();
  if (credentialsStr) {
    try {
      console.log('Attempting to parse GOOGLE_SERVICE_ACCOUNT_KEY from environment...');
      credentials = JSON.parse(credentialsStr);
      console.log('✓ Successfully parsed GOOGLE_SERVICE_ACCOUNT_KEY');
    } catch (error) {
      console.error('Failed to parse GOOGLE_SERVICE_ACCOUNT_KEY as JSON:', error.message);
    }
  }

  // Step 3: Try base64 encoded version if direct parse failed
  if (!credentials) {
    const credentialsB64 = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64?.trim();
    if (credentialsB64) {
      try {
        console.log('Attempting to decode GOOGLE_SERVICE_ACCOUNT_KEY_B64 from environment...');
        const decoded = Buffer.from(credentialsB64, 'base64').toString('utf-8');
        credentials = JSON.parse(decoded);
        console.log('✓ Successfully decoded and parsed GOOGLE_SERVICE_ACCOUNT_KEY_B64');
      } catch (error) {
        console.error('Failed to decode and parse GOOGLE_SERVICE_ACCOUNT_KEY_B64:', error.message);
      }
    }
  }

  if (!credentials || typeof credentials !== 'object') {
    throw new Error(
      'No credentials found. Tried:\n' +
      '1. Application Default Credentials (ADC) - expected in GCP environments\n' +
      '2. GOOGLE_SERVICE_ACCOUNT_KEY environment variable\n' +
      '3. GOOGLE_SERVICE_ACCOUNT_KEY_B64 environment variable\n\n' +
      'For local development, set GOOGLE_SERVICE_ACCOUNT_KEY with your service account JSON.\n' +
      'For GCP environments (Cloud Run, App Engine), use ADC.'
    );
  }

  const jwtClient = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive',
    ],
  });

  console.log('✓ JWT client created with service account');
  cachedAuthClient = jwtClient;
  return jwtClient;
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
