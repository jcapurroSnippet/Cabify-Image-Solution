import { google } from 'googleapis';
import { JWT } from 'google-auth-library';

/**
 * Returns a JWT client configured with service account credentials
 * Credentials can come from:
 * 1. GOOGLE_SERVICE_ACCOUNT_KEY env var (JSON parsed)
 * 2. GOOGLE_SERVICE_ACCOUNT_KEY_B64 env var (base64 encoded JSON)
 */
export const getAuthClient = () => {
  let credentials = null;

  // Try to get from env var directly (JSON)
  const credentialsStr = process.env.GOOGLE_SERVICE_ACCOUNT_KEY?.trim();
  if (credentialsStr) {
    try {
      credentials = JSON.parse(credentialsStr);
    } catch (error) {
      console.error('Failed to parse GOOGLE_SERVICE_ACCOUNT_KEY as JSON:', error.message);
    }
  }

  // Try base64 encoded version if direct parse failed
  if (!credentials) {
    const credentialsB64 = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64?.trim();
    if (credentialsB64) {
      try {
        const decoded = Buffer.from(credentialsB64, 'base64').toString('utf-8');
        credentials = JSON.parse(decoded);
      } catch (error) {
        console.error('Failed to decode and parse GOOGLE_SERVICE_ACCOUNT_KEY_B64:', error.message);
      }
    }
  }

  if (!credentials || typeof credentials !== 'object') {
    throw new Error(
      'Missing or invalid GOOGLE_SERVICE_ACCOUNT_KEY environment variable. ' +
      'Provide JSON (direct or base64 encoded) with service account credentials.'
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

  return jwtClient;
};

/**
 * Create an authorized Sheets client
 */
export const getSheetsClient = () => {
  const auth = getAuthClient();
  return google.sheets({ version: 'v4', auth });
};

/**
 * Create an authorized Drive client
 */
export const getDriveClient = () => {
  const auth = getAuthClient();
  return google.drive({ version: 'v3', auth });
};
