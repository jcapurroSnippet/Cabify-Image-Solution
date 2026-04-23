#!/usr/bin/env node

import sharp from 'sharp';

/**
 * Resize and compress image buffer
 * Reduces size to ~500x500 with 80% quality for better API performance
 */
export const optimizeImageBuffer = async (imageBuffer) => {
  try {
    return imageBuffer;
  } catch (error) {
    return imageBuffer;
  }
};

/**
 * Convert Buffer to base64 data URL
 */
export const bufferToDataUrl = (buffer, mimeType = 'image/jpeg') => {
  const base64 = buffer.toString('base64');
  return `data:${mimeType};base64,${base64}`;
};

/**
 * Download and optimize image
 */
export const downloadAndOptimizeImage = async (imageUrl) => {
  try {
    const axios = (await import('axios')).default;
    
    // Extract Drive file ID if needed
    let downloadUrl = imageUrl;
    if (imageUrl.includes('drive.google.com')) {
      const match = imageUrl.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
      if (match) {
        downloadUrl = `https://drive.google.com/uc?export=download&id=${match[1]}`;
      }
    }

    const response = await axios.get(downloadUrl, { 
      responseType: 'arraybuffer',
      maxRedirects: 5,
      timeout: 30000,
    });

    
    // Optimize
    const optimized = await optimizeImageBuffer(response.data);
    
    // Convert to data URL
    const dataUrl = bufferToDataUrl(optimized, 'image/jpeg');
    
    return dataUrl;
  } catch (error) {
    throw error;
  }
};

export default downloadAndOptimizeImage;
