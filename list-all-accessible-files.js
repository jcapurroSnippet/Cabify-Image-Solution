import { getDriveClient } from './server/services/googleAuth.js';

async function listAllFiles() {
  try {
    const drive = await getDriveClient();
    
    console.log('🔍 Listing ALL files accessible to service account...\n');
    
    let pageToken = null;
    let fileCount = 0;
    let imageCount = 0;
    
    do {
      const response = await drive.files.list({
        fields: 'nextPageToken, files(id, name, mimeType, size, parents)',
        pageSize: 100,
        pageToken: pageToken,
        spaces: 'drive',
      });
      
      const files = response.data.files || [];
      fileCount += files.length;
      
      if (files.length > 0) {
        files.forEach((file) => {
          // Count images
          if (file.mimeType.includes('image')) {
            imageCount++;
            console.log(`🖼️  ${file.name}`);
            console.log(`   ID: ${file.id}`);
            console.log(`   Type: ${file.mimeType}`);
            console.log(`   Size: ${file.size ? (file.size / (1024*1024)).toFixed(2) + ' MB' : 'N/A'}\n`);
          }
        });
      }
      
      pageToken = response.data.nextPageToken;
    } while (pageToken);
    
    console.log(`\n✅ Total files: ${fileCount}`);
    console.log(`🖼️  Total images: ${imageCount}`);
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

listAllFiles();
