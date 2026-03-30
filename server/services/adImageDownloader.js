import axios from 'axios';

/**
 * Download an image from a URL and return it as a data URL (base64).
 * Works for both Google Ads and Meta image URLs.
 */
export const downloadAdImage = async (imageUrl) => {
  if (!imageUrl || typeof imageUrl !== 'string') {
    throw new Error('imageUrl is required.');
  }

  try {
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'User-Agent': 'CabifyImageSuite/1.0',
      },
    });

    const mimeType = response.headers['content-type'] || 'image/png';
    const base64 = Buffer.from(response.data).toString('base64');
    return `data:${mimeType};base64,${base64}`;
  } catch (error) {
    throw new Error(`Failed to download ad image: ${error.message}`);
  }
};
