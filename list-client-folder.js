import { getDriveClient } from './server/services/googleAuth.js';

async function listFilesInFolder() {
  try {
    const drive = await getDriveClient();
    const folderId = '1mi4buJlOnllbrmBW3mJJPVc9B5h0JoBp';
    
    console.log(`📂 Listing files in folder: ${folderId}\n`);
    
    // Get folder info
    try {
      const folderRes = await drive.files.get({
        fileId: folderId,
        fields: 'name, owners, permissions',
      });
      
      console.log(`✅ Folder name: ${folderRes.data.name}`);
      console.log(`   Owner: ${folderRes.data.owners?.[0]?.emailAddress || 'N/A'}`);
      console.log(`   Permissions: ${folderRes.data.permissions?.map(p => `${p.role} (${p.emailAddress || p.type})`).join(', ')}\n`);
    } catch (error) {
      console.error('❌ Cannot access folder:', error.message);
      return;
    }
    
    // List files in folder
    let pageToken = null;
    let imageCount = 0;
    
    do {
      const response = await drive.files.list({
        q: `'${folderId}' in parents`,
        fields: 'nextPageToken, files(id, name, mimeType, size, createdTime)',
        pageSize: 100,
        pageToken: pageToken,
      });
      
      const files = response.data.files || [];
      
      files.forEach((file) => {
        if (file.mimeType.includes('image')) {
          imageCount++;
          console.log(`🖼️  ${imageCount}. ${file.name}`);
          console.log(`   ID: ${file.id}`);
          console.log(`   Type: ${file.mimeType}`);
          console.log(`   Size: ${file.size ? (file.size / (1024*1024)).toFixed(2) + ' MB' : 'N/A'}`);
          console.log(`   Created: ${new Date(file.createdTime).toLocaleDateString()}\n`);
        }
      });
      
      pageToken = response.data.nextPageToken;
    } while (pageToken);
    
    console.log(`✅ Total images found: ${imageCount}`);
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

listFilesInFolder();
