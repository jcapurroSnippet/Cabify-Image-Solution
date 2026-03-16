import { getDriveClient } from './server/services/googleAuth.js';

async function listAllFilesInFolder() {
  try {
    const drive = await getDriveClient();
    
    // The folder ID
    const folderId = '1gWY-ZEMbWBcM_lwSKzc5HD89Pa_SiBWO';
    
    console.log('📂 Listing all files in folder (with pagination)...\n');
    
    let pageToken = null;
    let fileCount = 0;
    
    do {
      const response = await drive.files.list({
        q: `'${folderId}' in parents`,
        fields: 'nextPageToken, files(id, name, mimeType, size, createdTime)',
        pageSize: 100,
        pageToken: pageToken,
      });
      
      const files = response.data.files || [];
      fileCount += files.length;
      
      console.log(`Got ${files.length} files (Total so far: ${fileCount})`);
      
      if (files.length > 0) {
        files.forEach((file, idx) => {
          console.log(`\n${fileCount - files.length + idx + 1}. ${file.name}`);
          console.log(`   ID: ${file.id}`);
          console.log(`   Size: ${file.size ? (file.size / (1024*1024)).toFixed(2) + ' MB' : 'N/A'}`);
          console.log(`   Created: ${file.createdTime}`);
        });
      }
      
      pageToken = response.data.nextPageToken;
    } while (pageToken);
    
    console.log(`\n✅ Total files: ${fileCount}`);
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

listAllFilesInFolder();
