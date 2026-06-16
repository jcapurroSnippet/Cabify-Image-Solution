import { Readable } from 'node:stream';
import { getDriveClient } from './googleAuth.js';

const getApiErrorDetails = (error) => {
  const status = error?.response?.status || error?.code;
  const statusText = error?.response?.statusText;
  const responseData = error?.response?.data;
  const apiMessage =
    responseData?.error?.message ||
    responseData?.error_description ||
    responseData?.message ||
    (typeof responseData === 'string' ? responseData : '');

  return [status ? `status ${status}` : '', statusText, apiMessage || error?.message]
    .filter(Boolean)
    .join(' - ');
};

export const uploadBufferToDrive = async (buffer, fileName, mimeType = 'image/png', folderId) => {
  try {
    const drive = await getDriveClient();

    const fileMetadata = {
      name: fileName,
      mimeType,
      parents: folderId ? [folderId] : undefined,
    };

    const response = await drive.files.create({
      resource: fileMetadata,
      requestBody: fileMetadata,
      media: {
        mimeType,
        body: Readable.from(buffer),
      },
      fields: 'id, name, webViewLink, webContentLink, mimeType',
      supportsAllDrives: true,
    });

    return {
      fileId: response.data.id,
      name: response.data.name,
      webViewLink: response.data.webViewLink,
      webContentLink: response.data.webContentLink,
      mimeType: response.data.mimeType,
    };
  } catch (error) {
    throw new Error(`Failed to upload file to Drive: ${getApiErrorDetails(error)}`);
  }
};

/**
 * Upload a base64 image to Google Drive
 * Returns: { fileId, name, webViewLink, webContentLink }
 */
export const uploadImageToDrive = async (imageBase64, fileName, folderId) => {
  try {
    // Remove data URL prefix if present
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    return await uploadBufferToDrive(buffer, fileName, 'image/png', folderId);
  } catch (error) {
    throw new Error(`Failed to upload image to Drive: ${getApiErrorDetails(error)}`);
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
    throw new Error(`Failed to share file: ${getApiErrorDetails(error)}`);
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
    throw new Error(`Failed to generate shareable link: ${getApiErrorDetails(error)}`);
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

export const findOrCreateDriveFolder = async (folderName, parentFolderId) => {
  try {
    const drive = await getDriveClient();
    const escapedName = String(folderName).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const parentClause = parentFolderId ? ` and '${parentFolderId}' in parents` : '';

    const existing = await drive.files.list({
      q: `mimeType = 'application/vnd.google-apps.folder' and trashed = false and name = '${escapedName}'${parentClause}`,
      fields: 'files(id, name)',
      pageSize: 1,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const match = existing.data.files?.[0];
    if (match?.id) {
      return { folderId: match.id, name: match.name, created: false };
    }

    const createResponse = await drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentFolderId ? [parentFolderId] : undefined,
      },
      fields: 'id, name',
      supportsAllDrives: true,
    });

    return {
      folderId: createResponse.data.id,
      name: createResponse.data.name,
      created: true,
    };
  } catch (error) {
    throw new Error(`Failed to find or create Drive folder: ${getApiErrorDetails(error)}`);
  }
};
