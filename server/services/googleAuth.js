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
const oauthTokenPath = path.join(__dirname, '../../.oauth-token.json');

/**
 * Get OAuth2 credentials from saved tokens
 */
const getOAuthClient = async () => {
  if (!fs.existsSync(oauthTokenPath)) {
    return null;
  }
  
  try {
    const tokens = JSON.parse(fs.readFileSync(oauthTokenPath, 'utf-8'));
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_OAUTH_CLIENT_ID || 'YOUR_CLIENT_ID',
      process.env.GOOGLE_OAUTH_CLIENT_SECRET || 'YOUR_CLIENT_SECRET',
      'http://localhost:8888/oauth-callback'
    );
    
    oauth2Client.setCredentials(tokens);
    
    // Refresh if expired
    if (tokens.expiry_date && tokens.expiry_date < Date.now()) {
      const { credentials } = await oauth2Client.refreshAccessToken();
      fs.writeFileSync(oauthTokenPath, JSON.stringify(credentials, null, 2));
      oauth2Client.setCredentials(credentials);
    }
    
    return oauth2Client;
  } catch (error) {
    console.warn('⚠️  Could not load OAuth tokens:', error.message);
    return null;
  }
};

/**
 * Returns an auth client configured with service account credentials or OAuth
 * Tries OAuth first (for user authorization), falls back to service account
 */
export const getAuthClient = async () => {
  // Return cached client if available
  if (cachedAuthClient) {
    return cachedAuthClient;
  }

  // Try OAuth first (if tokens exist)
  console.log('📍 Checking for OAuth tokens...');
  const oauthClient = await getOAuthClient();
  if (oauthClient) {
    console.log('✓ Using OAuth credentials (user account)');
    cachedAuthClient = oauthClient;
    return oauthClient;
  }

  console.log('⚠️  No OAuth tokens found');

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
  if (!credentials) {
    console.log(`📍 Development mode: Looking for .credentials.json at: ${credentialsPath}`);
    if (fs.existsSync(credentialsPath)) {
      try {
        console.log('📍 Found .credentials.json, attempting to load...');
        const credentialsFile = fs.readFileSync(credentialsPath, 'utf-8');
        credentials = JSON.parse(credentialsFile);
        console.log('✓ Successfully loaded credentials from .credentials.json');
      } catch (error) {
        console.warn('⚠️  Error reading .credentials.json:', error.message);
      }
    } else {
      console.log('⚠️  .credentials.json NOT FOUND at:', credentialsPath);
      console.log('⚠️  This is required for local development authentication!');
    }
  }

  // Try explicit service account env var
  if (!credentials && process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    try {
      console.log('📍 Found GOOGLE_SERVICE_ACCOUNT_KEY environment variable');
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
      console.log('✓ Successfully parsed GOOGLE_SERVICE_ACCOUNT_KEY');
    } catch (error) {
      console.warn('⚠️  Could not parse GOOGLE_SERVICE_ACCOUNT_KEY:', error.message);
    }
  }

  // Try base64-encoded env var
  if (!credentials && process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64) {
    try {
      console.log('📍 Found GOOGLE_SERVICE_ACCOUNT_KEY_B64 environment variable');
      const decoded = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64, 'base64').toString('utf-8');
      credentials = JSON.parse(decoded);
      console.log('✓ Successfully decoded GOOGLE_SERVICE_ACCOUNT_KEY_B64');
    } catch (error) {
      console.warn('⚠️  Could not decode GOOGLE_SERVICE_ACCOUNT_KEY_B64:', error.message);
    }
  }

  // If we found credentials, create JWT client
  if (credentials && credentials.type === 'service_account') {
    try {
      const jwtClient = new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: [
          'https://www.googleapis.com/auth/spreadsheets',
          'https://www.googleapis.com/auth/drive.file',
          'https://www.googleapis.com/auth/drive',
        ],
      });
      console.log('✓ JWT client created with service account (development)');
      cachedAuthClient = jwtClient;
      return jwtClient;
    } catch (error) {
      console.error('❌ Could not create JWT client:', error.message);
      throw new Error('Failed to create JWT auth client: ' + error.message);
    }
  }

  // Last resort: try GoogleAuth with no explicit key
  try {
    console.log('📍 Attempting GoogleAuth (gcloud configured)...');
    const auth = new GoogleAuth({
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive',
      ],
    });

    const client = await auth.getClient();
    console.log('✓ GoogleAuth client created');
    cachedAuthClient = client;
    return client;
  } catch (error) {
    console.warn('⚠️  GoogleAuth failed:', error.message);
  }

  // If we got here, all auth methods failed
  throw new Error(
    `Failed to initialize authentication client.\n\n` +
    `Available options:\n` +
    `1. Create .credentials.json at: ${credentialsPath}\n` +
    `2. Set GOOGLE_SERVICE_ACCOUNT_KEY env var\n` +
    `3. Set GOOGLE_SERVICE_ACCOUNT_KEY_B64 env var\n` +
    `4. Configure gcloud (gcloud auth application-default login)\n` +
    `5. Place service account in production (Cloud Run/App Engine with proper IAM)\n`
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
