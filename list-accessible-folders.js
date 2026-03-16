import { getDriveClient } from './server/services/googleAuth.js';

async function listAllFolders() {
  try {
    const drive = await getDriveClient();
    
    console.log('🔍 Listing all folders accessible to service account...\n');
    
    let pageToken = null;
    let folderCount = 0;
    
    do {
      const response = await drive.files.list({
        q: "mimeType = 'application/vnd.google-apps.folder'",
        fields: 'nextPageToken, files(id, name, owners, permissions(role,type,emailAddress))',
        pageSize: 50,
        pageToken: pageToken,
        spaces: 'drive',
      });
      
      const files = response.data.files || [];
      folderCount += files.length;
      
      if (files.length > 0) {
        files.forEach((folder) => {
          console.log(`\n📁 ${folder.name}`);
          console.log(`   ID: ${folder.id}`);
          console.log(`   Owner: ${folder.owners?.[0]?.emailAddress || 'N/A'}`);
          if (folder.permissions && folder.permissions.length > 0) {
            console.log(`   Permissions: ${folder.permissions.map(p => `${p.role} (${p.emailAddress || p.type})`).join(', ')}`);
          }
        });
      }
      
      pageToken = response.data.nextPageToken;
    } while (pageToken);
    
    console.log(`\n\n✅ Total folders: ${folderCount}`);
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

listAllFolders();
