import axios from 'axios';
import { getAuthClient } from './googleAuth.js';

const PHOTOS_UPLOAD_URL = 'https://photoslibrary.googleapis.com/v1/uploads';
const PHOTOS_CREATE_URL = 'https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate';
const PHOTOS_ALBUMS_URL = 'https://photoslibrary.googleapis.com/v1/albums';

let cachedAlbumId = null;

const getAccessToken = async () => {
  const auth = await getAuthClient();
  const tokenResponse = await auth.getAccessToken();
  return tokenResponse.token || tokenResponse;
};

export const resolveAlbumIdFromShareUrl = async (shareUrl) => {
  if (cachedAlbumId) return cachedAlbumId;

  try {
    const response = await axios.get(shareUrl, {
      maxRedirects: 10,
      validateStatus: s => s < 400,
    });
    const finalUrl = response.request?.res?.responseUrl || response.config?.url || shareUrl;
    const match = finalUrl.match(/\/album\/([a-zA-Z0-9_-]+)/);
    if (match) {
      cachedAlbumId = match[1];
      return cachedAlbumId;
    }
  } catch (e) {
    console.warn('[PHOTOS] Could not resolve album from share URL redirect:', e.message);
  }

  // Fallback: list albums and find by shareableUrl
  try {
    const token = await getAccessToken();
    let pageToken;
    do {
      const res = await axios.get(PHOTOS_ALBUMS_URL, {
        headers: { Authorization: `Bearer ${token}` },
        params: { pageSize: 50, ...(pageToken ? { pageToken } : {}) },
      });
      for (const album of res.data.albums || []) {
        if (album.shareInfo?.shareableUrl?.includes(shareUrl.split('/').pop())) {
          cachedAlbumId = album.id;
          return cachedAlbumId;
        }
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  } catch (e) {
    console.warn('[PHOTOS] Could not find album via API list:', e.message);
  }

  throw new Error(`Could not resolve Google Photos album ID from: ${shareUrl}`);
};

export const uploadImageToPhotos = async (imageDataUrl, filename, albumId) => {
  const token = await getAccessToken();
  const base64 = imageDataUrl.replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(base64, 'base64');

  // Step 1: upload bytes, get upload token
  const uploadRes = await axios.post(PHOTOS_UPLOAD_URL, buffer, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'X-Goog-Upload-File-Name': filename,
      'X-Goog-Upload-Protocol': 'raw',
    },
  });

  const uploadToken = uploadRes.data;

  // Step 2: create media item in album
  const createRes = await axios.post(
    PHOTOS_CREATE_URL,
    {
      albumId,
      newMediaItems: [{ simpleMediaItem: { fileName: filename, uploadToken } }],
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );

  const result = createRes.data.newMediaItemResults?.[0];
  const status = result?.status;
  if (status?.code && status.code !== 0) {
    throw new Error(`Google Photos upload failed: ${status.message}`);
  }

  const productUrl = result?.mediaItem?.productUrl;
  if (!productUrl) throw new Error('No productUrl returned from Google Photos');

  return productUrl;
};
