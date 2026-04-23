import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import url from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OAUTH_TOKEN_FILE = path.join(__dirname, '../../.oauth-token.json');
const OAUTH_CONFIG = {
  clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
  clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
  redirectUrl: process.env.GOOGLE_OAUTH_REDIRECT_URL || 'http://localhost:8888/oauth-callback',
};

/**
 * Create an OAuth2Client instance
 */
export function createOAuth2Client() {
  if (!OAUTH_CONFIG.clientId || !OAUTH_CONFIG.clientSecret) {
    throw new Error(
      'Missing GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET. ' +
      'Set them in your environment to run the OAuth flow.'
    );
  }
  return new OAuth2Client(
    OAUTH_CONFIG.clientId,
    OAUTH_CONFIG.clientSecret,
    OAUTH_CONFIG.redirectUrl
  );
}

/**
 * Get the authorization URL for user to visit
 */
export function getAuthorizationUrl(oauth2Client) {
  const scopes = [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/photoslibrary.appendonly',
    'https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata',
  ];
  
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
  });
  
  return authUrl;
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(oauth2Client, code) {
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  return tokens;
}

/**
 * Save OAuth tokens to file
 */
export function saveOAuthTokens(tokens) {
  fs.writeFileSync(OAUTH_TOKEN_FILE, JSON.stringify(tokens, null, 2));
  console.log('✅ OAuth tokens saved to .oauth-token.json');
}

/**
 * Load OAuth tokens from file
 */
export function loadOAuthTokens() {
  if (!fs.existsSync(OAUTH_TOKEN_FILE)) {
    return null;
  }
  
  try {
    return JSON.parse(fs.readFileSync(OAUTH_TOKEN_FILE, 'utf-8'));
  } catch (error) {
    console.error('Error loading OAuth tokens:', error.message);
    return null;
  }
}

/**
 * Start OAuth flow with local callback server
 */
export async function performOAuthFlow() {
  const oauth2Client = createOAuth2Client();
  const authUrl = getAuthorizationUrl(oauth2Client);
  
  console.log('\n🔐 OAuth Authentication Required\n');
  console.log('Opening browser... If it does not open, visit this URL manually:');
  console.log('\n' + authUrl + '\n');
  console.log('Waiting for authorization...\n');

  // Auto-open browser
  try {
    const { exec } = await import('child_process');
    const cmd = process.platform === 'win32'
      ? `start "" "${authUrl}"`
      : process.platform === 'darwin'
        ? `open "${authUrl}"`
        : `xdg-open "${authUrl}"`;
    exec(cmd);
  } catch (_) {}
  
  return new Promise((resolve, reject) => {
    // Start a local server to handle the callback
    const server = http.createServer(async (req, res) => {
      try {
        const parsedUrl = url.parse(req.url, true);
        
        if (parsedUrl.pathname === '/oauth-callback') {
          const code = parsedUrl.query.code;
          
          if (code) {
            // Exchange code for tokens
            const tokens = await exchangeCodeForTokens(oauth2Client, code);
            saveOAuthTokens(tokens);
            
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
              <html>
                <body style="font-family: Arial; text-align: center; padding: 50px;">
                  <h1>✅ Authorization Successful!</h1>
                  <p>You can close this window and return to the terminal.</p>
                </body>
              </html>
            `);
            
            server.close();
            resolve(tokens);
          } else {
            const error = parsedUrl.query.error;
            res.writeHead(400);
            res.end(`Authorization failed: ${error}`);
            server.close();
            reject(new Error(`Authorization failed: ${error}`));
          }
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      } catch (error) {
        res.writeHead(500);
        res.end('Server error');
        server.close();
        reject(error);
      }
    });
    
    server.listen(8888, () => {
      console.log('Callback server listening on http://localhost:8888\n');
    });
  });
}

/**
 * Get authenticated OAuth client (either from saved tokens or perform new flow)
 */
export async function getOAuthClient() {
  const oauth2Client = createOAuth2Client();
  
  // Try to load saved tokens
  const savedTokens = loadOAuthTokens();
  if (savedTokens) {
    console.log('📍 Using saved OAuth tokens');
    oauth2Client.setCredentials(savedTokens);
    
    // Refresh token if needed
    if (savedTokens.expiry_date && savedTokens.expiry_date < Date.now()) {
      console.log('🔄 Refreshing expired token...');
      const { credentials } = await oauth2Client.refreshAccessToken();
      saveOAuthTokens(credentials);
      oauth2Client.setCredentials(credentials);
    }
    
    return oauth2Client;
  }
  
  // Perform OAuth flow
  const tokens = await performOAuthFlow();
  oauth2Client.setCredentials(tokens);
  return oauth2Client;
}
