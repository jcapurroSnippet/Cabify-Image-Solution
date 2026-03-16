#!/usr/bin/env node

import sharp from 'sharp';

/**
 * Resize and compress image buffer
 * Reduces size to ~500x500 with 80% quality for better API performance
 */
export const optimizeImageBuffer = async (imageBuffer) => {
  try {
    console.log(`[OPTIMIZE] Input size: ${imageBuffer.length} bytes`);
    
    const optimized = await sharp(imageBuffer)
      .resize(1024, 1024, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 75, progressive: true })
      .toBuffer();
    
    console.log(`[OPTIMIZE] Output size: ${optimized.length} bytes`);
    console.log(`[OPTIMIZE] Reduction: ${((1 - optimized.length / imageBuffer.length) * 100).toFixed(1)}%`);
    
    return optimized;
  } catch (error) {
    console.warn(`[OPTIMIZE] Could not optimize with sharp, using original:`, error.message);
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

    console.log(`[DOWNLOAD] Fetching: ${downloadUrl.substring(0, 60)}...`);
    const response = await axios.get(downloadUrl, { 
      responseType: 'arraybuffer',
      maxRedirects: 5,
      timeout: 30000,
    });

    console.log(`[DOWNLOAD] Downloaded ${response.data.byteLength} bytes`);
    
    // Optimize
    const optimized = await optimizeImageBuffer(response.data);
    
    // Convert to data URL
    const dataUrl = bufferToDataUrl(optimized, 'image/jpeg');
    
    return dataUrl;
  } catch (error) {
    console.error(`[ERROR]`, error.message);
    throw error;
  }
};

export default downloadAndOptimizeImage;
