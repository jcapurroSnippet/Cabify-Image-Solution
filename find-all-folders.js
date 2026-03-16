import { getDriveClient } from './server/services/googleAuth.js';

async function findAllFolders() {
  try {
    const drive = await getDriveClient();
    
    console.log('🔍 Searching for ALL accessible folders...\n');
    
    let pageToken = null;
    let count = 0;
    
    do {
      const response = await drive.files.list({
        q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        fields: 'nextPageToken, files(id, name, owners, modifiedTime)',
        pageSize: 50,
        pageToken: pageToken,
      });
      
      const files = response.data.files || [];
      count += files.length;
      
      files.forEach((folder) => {
        console.log(`📁 ${folder.name}`);
        console.log(`   ID: ${folder.id}`);
        console.log(`   Owner: ${folder.owners?.[0]?.displayName || folder.owners?.[0]?.emailAddress || 'Unknown'}`);
        console.log(`   Updated: ${new Date(folder.modifiedTime).toLocaleDateString()}\n`);
      });
      
      pageToken = response.data.nextPageToken;
      if (!pageToken) break;
    } while (pageToken);
    
    console.log(`✅ Total folders: ${count}`);
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

findAllFolders();
