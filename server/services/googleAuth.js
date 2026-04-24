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
 * Get OAuth2 credentials from saved tokens (file or env var)
 */
const getOAuthClient = async () => {
  let tokens = null;

  // Try env var first (production / Cloud Run)
  if (process.env.GOOGLE_OAUTH_TOKEN_JSON) {
    try {
      tokens = JSON.parse(process.env.GOOGLE_OAUTH_TOKEN_JSON);
    } catch (e) {
    }
  }

  // Fallback: local file (development)
  if (!tokens && fs.existsSync(oauthTokenPath)) {
    try {
      tokens = JSON.parse(fs.readFileSync(oauthTokenPath, 'utf-8'));
    } catch (e) {
    }
  }

  if (!tokens) return null;

  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_OAUTH_CLIENT_ID || 'YOUR_CLIENT_ID',
      process.env.GOOGLE_OAUTH_CLIENT_SECRET || 'YOUR_CLIENT_SECRET',
      'http://localhost:8888/oauth-callback'
    );

    oauth2Client.setCredentials(tokens);

    oauth2Client.on('tokens', (newTokens) => {
      const merged = { ...tokens, ...newTokens };
      if (!merged.refresh_token && tokens.refresh_token) {
        merged.refresh_token = tokens.refresh_token;
      }
      if (fs.existsSync(oauthTokenPath)) {
        try {
          fs.writeFileSync(oauthTokenPath, JSON.stringify(merged, null, 2));
        } catch { /* ignore */ }
      }
    });

    return oauth2Client;
  } catch (error) {
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
  const oauthClient = await getOAuthClient();
  if (oauthClient) {
    cachedAuthClient = oauthClient;
    return oauthClient;
  }


  const isProduction = process.env.NODE_ENV === 'production';
  let credentials = null;

  // PRODUCTION: Try ADC first (this is the service account in Cloud Run/App Engine)
  if (isProduction) {
    try {
      const auth = new GoogleAuth({
        scopes: [
          'https://www.googleapis.com/auth/spreadsheets',
          'https://www.googleapis.com/auth/drive.file',
          'https://www.googleapis.com/auth/drive',
        ],
      });
    
      const client = await auth.getClient();
      cachedAuthClient = client;
      return client;
    } catch (error) {
      throw new Error(
        'Failed to load service account credentials in production.\n' +
        'Ensure the service account has proper IAM roles in your GCP project.\n' +
        'Error: ' + error.message
      );
    }
  }

  // DEVELOPMENT: Try local .credentials.json file first
  if (!credentials) {
    if (fs.existsSync(credentialsPath)) {
      try {
        const credentialsFile = fs.readFileSync(credentialsPath, 'utf-8');
        credentials = JSON.parse(credentialsFile);
      } catch (error) {
      }
    } else {
    }
  }

  // Try explicit service account env var
  if (!credentials && process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    try {
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    } catch (error) {
    }
  }

  // Try base64-encoded env var
  if (!credentials && process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64) {
    try {
      const decoded = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64, 'base64').toString('utf-8');
      credentials = JSON.parse(decoded);
    } catch (error) {
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
      cachedAuthClient = jwtClient;
      return jwtClient;
    } catch (error) {
      throw new Error('Failed to create JWT auth client: ' + error.message);
    }
  }

  // Last resort: try GoogleAuth with no explicit key
  try {
    const auth = new GoogleAuth({
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive',
      ],
    });

    const client = await auth.getClient();
    cachedAuthClient = client;
    return client;
  } catch (error) {
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
