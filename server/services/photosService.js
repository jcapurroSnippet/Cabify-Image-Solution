import axios from 'axios';
import { getAuthClient } from './googleAuth.js';

const PHOTOS_UPLOAD_URL = 'https://photoslibrary.googleapis.com/v1/uploads';
const PHOTOS_CREATE_URL = 'https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate';
const PHOTOS_ALBUMS_URL = 'https://photoslibrary.googleapis.com/v1/albums';

let cachedAlbumId = null;

const getAccessToken = async () => {
  const auth = await getAuthClient();
  console.log('[PHOTOS] Auth client type:', auth?.constructor?.name);
  const tokenResponse = await auth.getAccessToken();
  const token = tokenResponse?.token ?? tokenResponse;
  console.log('[PHOTOS] Access token present:', !!token);
  if (!token) throw new Error('Could not get OAuth access token for Google Photos');
  return token;
};

export const resolveAlbumIdFromShareUrl = async (shareUrl) => {
  if (cachedAlbumId) return cachedAlbumId;

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

export const uploadImageToPhotos = async (imageDataUrl, filename, albumId) => {
  const token = await getAccessToken();
  const base64 = imageDataUrl.replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(base64, 'base64');

  console.log(`[PHOTOS] Uploading ${filename} to album ${albumId}...`);

  const uploadRes = await axios.post(PHOTOS_UPLOAD_URL, buffer, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'X-Goog-Upload-File-Name': filename,
      'X-Goog-Upload-Protocol': 'raw',
    },
  }).catch(e => {
    console.error('[PHOTOS] Upload bytes failed:', e.response?.status, JSON.stringify(e.response?.data));
    throw e;
  });

  const uploadToken = uploadRes.data;
  console.log(`[PHOTOS] Got upload token, creating media item...`);

  const createRes = await axios.post(
    PHOTOS_CREATE_URL,
    { albumId, newMediaItems: [{ simpleMediaItem: { fileName: filename, uploadToken } }] },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );

  const result = createRes.data.newMediaItemResults?.[0];
  const status = result?.status;
  if (status?.code && status.code !== 0) {
    throw new Error(`Google Photos upload failed: ${status.message}`);
  }

  const productUrl = result?.mediaItem?.productUrl;
  if (!productUrl) throw new Error('No productUrl returned from Google Photos');

  console.log(`[PHOTOS] Uploaded successfully: ${productUrl}`);
  return productUrl;
};
