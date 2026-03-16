import { Readable } from 'node:stream';
import { getDriveClient } from './googleAuth.js';

/**
 * Upload a base64 image to Google Drive
 * Returns: { fileId, name, webViewLink, webContentLink }
 */
export const uploadImageToDrive = async (imageBase64, fileName, folderId) => {
  try {
    const drive = await getDriveClient();

    // Remove data URL prefix if present
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    const fileMetadata = {
      name: fileName,
      mimeType: 'image/png',
      parents: folderId ? [folderId] : undefined,
    };

    const media = {
      mimeType: 'image/png',
      body: Readable.from(buffer),
    };

    const response = await drive.files.create({
      resource: fileMetadata,
      media,
      fields: 'id, name, webViewLink, webContentLink, mimeType',
      requestBody: fileMetadata,
      supportsAllDrives: true,
    });

    return {
      fileId: response.data.id,
      name: response.data.name,
      webViewLink: response.data.webViewLink,
      webContentLink: response.data.webContentLink,
    };
  } catch (error) {
    console.error('Error uploading to Drive:', error);
    throw new Error(`Failed to upload image to Drive: ${error.message}`);
  }
};

/**
 * Make a file publicly viewable on Drive
 * Returns the shared link
 */
export const makeFilePublic = async (fileId) => {
  try {
    const drive = await getDriveClient();

    await drive.permissions.create({
      fileId,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
      supportsAllDrives: true,
    });

    // Construct the standard shared link
    return `https://drive.google.com/file/d/${fileId}/view`;
  } catch (error) {
    console.error('Error making file public:', error);
    throw new Error(`Failed to share file: ${error.message}`);
  }
};

/**
 * Generate a shareable link for a Drive file
 * If already public, returns the standard URL
 */
export const getShareableLink = async (fileId) => {
  try {
    // Always return the standard shareable format
    return `https://drive.google.com/file/d/${fileId}/view`;
  } catch (error) {
    console.error('Error generating shareable link:', error);
    throw new Error(`Failed to generate shareable link: ${error.message}`);
  }
};

/**
 * Extract folder ID from a Google Drive folder URL
 * Handles: https://drive.google.com/drive/folders/{id}
 */
export const extractFolderId = (folderUrl) => {
  const match = folderUrl.match(/folders\/([a-zA-Z0-9-_]+)/);
  if (!match || !match[1]) {
    throw new Error('Invalid Google Drive folder URL. Expected format: https://drive.google.com/drive/folders/{id}');
  }
  return match[1];
};
