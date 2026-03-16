import { google } from 'googleapis';
import { getAuthClient } from './googleAuth.js';
import axios from 'axios';

/**
 * Extract file ID from Google Drive sharing URL
 * Handles: /file/d/{fileId}/ or open?id={fileId} formats
 */
export const extractDriveFileId = (url) => {
  // Format: https://drive.google.com/file/d/{fileId}/view?usp=sharing
  let match = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];

  // Format: https://drive.google.com/open?id={fileId}
  match = url.match(/[\?&]id=([a-zA-Z0-9_-]+)/);
  if (match) return match[1];

  return null;
};

/**
 * Convert Google Drive sharing URL to direct download URL
 * This works for publicly shared files
 */
export const getDriveDirectDownloadUrl = (fileId) => {
  // Direct download URL for shared Google Drive files
  return `https://drive.google.com/uc?export=download&id=${fileId}`;
};

/**
 * Download image from URL using HTTP (works for public sharing links)
 */
export const downloadImageAsDataUrlV2 = async (imageUrl) => {
  try {
    console.log(`[IMAGE DOWNLOAD] Processing URL...`);

    let downloadUrl = imageUrl;

    // Check if it's a Google Drive URL
    if (imageUrl.includes('drive.google.com')) {
      const fileId = extractDriveFileId(imageUrl);
      if (fileId) {
        console.log(`[IMAGE DOWNLOAD] ✓ Detected Google Drive URL`);
        console.log(`[IMAGE DOWNLOAD] File ID: ${fileId}`);
        // Convert to direct download URL
        downloadUrl = getDriveDirectDownloadUrl(fileId);
        console.log(`[IMAGE DOWNLOAD] Using direct download endpoint`);
      }
    }

    // Download with HTTP
    console.log(`[IMAGE DOWNLOAD] Fetching from: ${downloadUrl.substring(0, 80)}...`);
    
    const response = await axios.get(downloadUrl, { 
      responseType: 'arraybuffer',
      maxRedirects: 5,
      timeout: 30000,
    });
    
    const mimeType = response.headers['content-type'] || 'image/png';
    const base64 = Buffer.from(response.data).toString('base64');
    const dataUrl = `data:${mimeType};base64,${base64}`;
    
    console.log(`[IMAGE DOWNLOAD] ✓ Downloaded successfully (${response.data.byteLength} bytes)`);
    return dataUrl;

  } catch (error) {
    console.error(`[IMAGE DOWNLOAD] Error: ${error.message}`);
    throw new Error(`Failed to download image from ${imageUrl}: ${error.message}`);
  }
};

/**
 * Download file from Google Drive using authenticated API
 * (Fallback for non-public files)
 */
export const downloadDriveFileAsDataUrl = async (fileId) => {
  try {
    console.log(`[DRIVE API] Downloading file ID: ${fileId}`);
    
    const auth = await getAuthClient();
    const drive = google.drive({ version: 'v3', auth });

    // Get file metadata to determine MIME type
    const fileMetadata = await drive.files.get({
      fileId,
      fields: 'mimeType, webContentLink',
    });

    const mimeType = fileMetadata.data.mimeType || 'image/png';
    console.log(`[DRIVE API] File MIME type: ${mimeType}`);

    // Download file content
    const response = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'arraybuffer' }
    );

    const base64 = Buffer.from(response.data).toString('base64');
    const dataUrl = `data:${mimeType};base64,${base64}`;
    
    console.log(`[DRIVE API] ✓ Downloaded successfully (${response.data.byteLength} bytes)`);
    return dataUrl;

  } catch (error) {
    console.error(`[DRIVE API] Error:`, error.message);
    throw new Error(`Failed to download from Drive: ${error.message}`);
  }
};

export default downloadImageAsDataUrlV2;
