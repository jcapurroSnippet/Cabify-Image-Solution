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

  // Step 1: Try explicit service account env vars (higher priority)
  // Try base64 encoded first
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64) {
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

  // Step 2: Try Application Default Credentials if no env var credentials found
  if (!credentials) {
    try {
      console.log('Attempting to use Application Default Credentials (ADC)...');
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
  }

  // Step 3: If we have credentials from env vars, create JWT client
  if (credentials && typeof credentials === 'object') {
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
  }

  // No credentials found
  throw new Error(
    'No authentication credentials found. Tried:\n' +
    '1. GOOGLE_SERVICE_ACCOUNT_KEY_B64 environment variable\n' +
    '2. GOOGLE_SERVICE_ACCOUNT_KEY environment variable\n' +
    '3. Application Default Credentials (ADC)\n\n' +
    'For local development, set GOOGLE_SERVICE_ACCOUNT_KEY with your service account JSON.\n' +
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
