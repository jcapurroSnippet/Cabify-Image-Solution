import axios from 'axios';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PHOTOS_UPLOAD_URL = 'https://photoslibrary.googleapis.com/v1/uploads';
const PHOTOS_CREATE_URL = 'https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate';
const PHOTOS_ALBUMS_URL = 'https://photoslibrary.googleapis.com/v1/albums';
const PHOTOS_MEDIA_ITEMS_URL = 'https://photoslibrary.googleapis.com/v1/mediaItems';
const DEFAULT_PHOTOS_DIRECT_IMAGE_PARAMS = 'w16383-h16383';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const oauthTokenPath = path.join(__dirname, '../../.oauth-token.json');

let cachedAlbumId = null;
let cachedOAuthClient = null;

const getPhotosOAuthClient = async () => {
  if (cachedOAuthClient) return cachedOAuthClient;

  let tokens = null;

  console.log('[PHOTOS] getPhotosOAuthClient called');
  const rawEnvToken = process.env.GOOGLE_OAUTH_TOKEN_JSON;
  console.log('[PHOTOS] GOOGLE_OAUTH_TOKEN_JSON present:', !!rawEnvToken, '| length:', rawEnvToken?.length ?? 0);
  if (rawEnvToken) {
    try {
      tokens = JSON.parse(rawEnvToken.trim());
      console.log('[PHOTOS] OAuth tokens parsed from env var OK, keys:', Object.keys(tokens).join(','));
    } catch (e) {
      console.warn('[PHOTOS] Could not parse GOOGLE_OAUTH_TOKEN_JSON:', e.message, '| first 50 chars:', rawEnvToken.slice(0, 50));
    }
  }

  if (!tokens && fs.existsSync(oauthTokenPath)) {
    tokens = JSON.parse(fs.readFileSync(oauthTokenPath, 'utf-8'));
    console.log('[PHOTOS] OAuth tokens loaded from file');
  }

  if (!tokens) {
    console.error('[PHOTOS] No tokens found. GOOGLE_OAUTH_TOKEN_JSON present:', !!process.env.GOOGLE_OAUTH_TOKEN_JSON, '| file exists:', fs.existsSync(oauthTokenPath));
    throw new Error('No OAuth tokens available for Google Photos');
  }

  if (!tokens.refresh_token) {
    console.error('[PHOTOS] OAuth token has no refresh_token — long operations will 401 after expiry');
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    'http://localhost:8888/oauth-callback'
  );
  oauth2Client.setCredentials(tokens);

  oauth2Client.on('tokens', (newTokens) => {
    console.log('[PHOTOS] OAuth auto-refresh fired. Has new refresh_token:', !!newTokens.refresh_token);
  });

  cachedOAuthClient = oauth2Client;
  return oauth2Client;
};

const getAccessToken = async () => {
  const client = await getPhotosOAuthClient();
  const tokenResponse = await client.getAccessToken();
  const token = tokenResponse?.token ?? tokenResponse;
  if (!token) throw new Error('Could not get OAuth access token for Google Photos');
  return token;
};

const withFreshPhotosToken = async (operation) => {
  try {
    const token = await getAccessToken();
    return await operation(token);
  } catch (error) {
    if (error.response?.status === 401) {
      console.warn('[PHOTOS] Got 401, invalidating token cache and retrying...');
      cachedOAuthClient = null;
      const token = await getAccessToken();
      return operation(token);
    }

    throw error;
  }
};

const getPhotosDirectImageUrl = (mediaItem) => {
  const baseUrl = mediaItem?.baseUrl?.trim();
  if (!baseUrl) {
    return null;
  }

  const params =
    process.env.PHOTOS_DIRECT_IMAGE_PARAMS?.trim().replace(/^=+/, '') ||
    DEFAULT_PHOTOS_DIRECT_IMAGE_PARAMS;

  return `${baseUrl}=${params}`;
};

const getMediaItemOnce = async (token, mediaItemId) => {
  const response = await axios.get(`${PHOTOS_MEDIA_ITEMS_URL}/${encodeURIComponent(mediaItemId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  return response.data;
};

const resolveRedirectedImageUrl = async (url, token) => {
  if (!url) {
    return null;
  }

  const controller = new AbortController();

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: token
        ? {
            Authorization: `Bearer ${token}`,
          }
        : undefined,
    });

    const finalUrl = response.url || url;

    try {
      await response.body?.cancel();
    } catch {
    }

    return finalUrl;
  } catch (error) {
    console.warn('[PHOTOS] Could not resolve redirected image URL, using original direct URL:', error.message);
    return url;
  } finally {
    controller.abort();
  }
};

export const resolveAlbumIdFromShareUrl = async (shareUrl) => {
  if (cachedAlbumId) return cachedAlbumId;

  console.log('[PHOTOS] resolveAlbumIdFromShareUrl called, PHOTOS_ALBUM_ID env:', !!process.env.PHOTOS_ALBUM_ID);
  // Primary: read from env var (most reliable)
  if (process.env.PHOTOS_ALBUM_ID) {
    cachedAlbumId = process.env.PHOTOS_ALBUM_ID.trim();
    console.log(`[PHOTOS] Using album ID from env: ${cachedAlbumId}`);
    return cachedAlbumId;
  }

  // Fallback: follow share URL redirect
  try {
    const response = await axios.get(shareUrl, {
      maxRedirects: 10,
      timeout: 5000,
      validateStatus: s => s < 400,
    });
    // Try multiple ways to get the final URL
    const finalUrl =
      response.request?._redirectable?._currentUrl ||
      response.request?.res?.responseUrl ||
      response.request?.path ||
      '';
    console.log(`[PHOTOS] Redirect resolved to: ${finalUrl}`);
    const match = finalUrl.match(/\/(?:album|share)\/([a-zA-Z0-9_-]{10,})/);
    if (match) {
      cachedAlbumId = match[1];
      console.log(`[PHOTOS] Extracted album ID from redirect: ${cachedAlbumId}`);
      return cachedAlbumId;
    }
    console.warn(`[PHOTOS] No album ID found in final URL: ${finalUrl}`);
  } catch (e) {
    console.warn('[PHOTOS] Redirect resolution failed:', e.message);
  }

  // Fallback: list albums via API
  try {
    const token = await getAccessToken();
    let pageToken;
    do {
      const res = await axios.get(PHOTOS_ALBUMS_URL, {
        headers: { Authorization: `Bearer ${token}` },
        params: { pageSize: 50, ...(pageToken ? { pageToken } : {}) },
      });
      for (const album of res.data.albums || []) {
        const shareToken = shareUrl.split('/').pop();
        if (
          album.shareInfo?.shareableUrl?.includes(shareToken) ||
          album.title?.toLowerCase().includes('cabify')
        ) {
          cachedAlbumId = album.id;
          console.log(`[PHOTOS] Found album via API list: ${album.title} → ${cachedAlbumId}`);
          return cachedAlbumId;
        }
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
    console.warn('[PHOTOS] Album not found in API list');
  } catch (e) {
    console.warn('[PHOTOS] API album list failed:', e.message);
  }

  throw new Error(
    `Could not resolve Google Photos album ID. Set PHOTOS_ALBUM_ID in .env to skip resolution.`
  );
};

const uploadOnce = async (token, buffer, filename, albumId) => {
  const uploadRes = await axios.post(PHOTOS_UPLOAD_URL, buffer, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'X-Goog-Upload-File-Name': filename,
      'X-Goog-Upload-Protocol': 'raw',
    },
  });

  const uploadToken = uploadRes.data;

  const createRes = await axios.post(
    PHOTOS_CREATE_URL,
    { albumId, newMediaItems: [{ simpleMediaItem: { fileName: filename, uploadToken } }] },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );

  return createRes.data.newMediaItemResults?.[0];
};

export const uploadImageToPhotos = async (imageDataUrl, filename, albumId) => {
  const base64 = imageDataUrl.replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(base64, 'base64');

  console.log(`[PHOTOS] Uploading ${filename} to album ${albumId}...`);

  let result;
  try {
    result = await withFreshPhotosToken((token) => uploadOnce(token, buffer, filename, albumId));
  } catch (error) {
    console.error('[PHOTOS] Upload failed:', error.response?.status, JSON.stringify(error.response?.data));
    throw error;
  }

  const status = result?.status;
  if (status?.code && status.code !== 0) {
    throw new Error(`Google Photos upload failed: ${status.message}`);
  }

  let mediaItem = result?.mediaItem || null;

  if (mediaItem?.id) {
    try {
      mediaItem = await withFreshPhotosToken((token) => getMediaItemOnce(token, mediaItem.id));
    } catch (error) {
      console.warn('[PHOTOS] Could not fetch media item details after upload:', error.message);
    }
  }

  const directImageUrl = getPhotosDirectImageUrl(mediaItem);
  const redirectedImageUrl = directImageUrl
    ? await withFreshPhotosToken((token) => resolveRedirectedImageUrl(directImageUrl, token))
    : null;
  const productUrl = mediaItem?.productUrl || result?.mediaItem?.productUrl;
  const finalUrl = redirectedImageUrl || directImageUrl || productUrl;
  if (!finalUrl) throw new Error('No usable URL returned from Google Photos');

  if (redirectedImageUrl) {
    console.log(`[PHOTOS] Uploaded successfully with redirected image URL for sheet output: ${redirectedImageUrl}`);
    console.log('[PHOTOS] Note: redirected Google Photos image URLs are temporary and may expire.');
  } else if (directImageUrl) {
    console.log(`[PHOTOS] Uploaded successfully with direct base URL for sheet output: ${directImageUrl}`);
    console.log('[PHOTOS] Note: Google Photos base URLs are temporary and may expire after about 60 minutes.');
  } else {
    console.log('[PHOTOS] Uploaded successfully, falling back to Google Photos product URL.');
  }

  return finalUrl;
};
