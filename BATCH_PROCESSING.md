# Batch Processing - Google Sheets to Aspect Ratio Conversion

This guide explains how to use the batch processing feature to convert multiple images from a Google Sheets document to different aspect ratios and upload them to Google Drive.

## Overview

The batch processing feature allows you to:

1. **Read images** from a Google Sheets document (column: "Preview de creatividad")
2. **Generate variations** for each image in two aspect ratios:
   - 1:1 (3 variations: A, B, C)
   - 9:16 (3 variations: A, B, C)
3. **Upload all variations** to a specified Google Drive folder
4. **Update the Google Sheets** with direct links to each variation

## Prerequisites

### 1. Google Cloud Project Setup

Before using batch processing, you need to set up a Google Cloud project:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Enable these APIs:
   - Google Sheets API
   - Google Drive API
4. Create a Service Account:
   - Navigate to **IAM & Admin** > **Service Accounts**
   - Click **Create Service Account**
   - Fill in the details and click **Create and Continue**
   - Skip optional steps and click **Done**
5. Create a JSON Key (for local development):
   - Click on the service account you just created
   - Go to **Keys** tab
   - Click **Add Key** > **Create new key**
   - Select **JSON** and click **Create**
   - A JSON file will be downloaded
6. Share resources with the service account:
   - Get the `client_email` value from the JSON file (e.g., `SERVICE_ACCOUNT_EMAIL@PROJECT_ID.iam.gserviceaccount.com`)
   - Share your Google Sheets document with this email address (Editor role)
   - Share your Google Drive folder with this email address (Editor role)

### 2. Environment Configuration

The application automatically handles authentication in the following order:

#### For GCP Environments (Cloud Run, App Engine, GCE, Cloud Functions)
✅ **No configuration needed!** Application Default Credentials (ADC) are automatically available.

The application will detect and use the service account associated with your GCP resource.

#### For Local Development
Add the service account credentials to your environment:

**Option A: Direct JSON (simplest)**
```bash
export GOOGLE_SERVICE_ACCOUNT_KEY='{"type":"service_account","project_id":"...","private_key":"...","client_email":"..."}'
```

**Option B: Base64 Encoded (useful for Docker/Cloud environments)**
```bash
# Encode the JSON file as base64
cat service-account-key.json | base64 -w 0 > encoded.txt

# Use the base64 string
export GOOGLE_SERVICE_ACCOUNT_KEY_B64='base64_string_here'
```

Or add to `.env` file:
```env
GOOGLE_SERVICE_ACCOUNT_KEY={"type":"service_account",...}
```

## Google Sheets Format

Your Google Sheets document should have these columns:

| Categoria | Ciudad | Copy in de la pieza | Preview de creatividad | 1:1 IMG A | 1:1 IMG B | 1:1 IMG | 9:16 IMG A | 9:16 IMG B | 9:16 IMG C |
|-----------|--------|---------------------|------------------------|-----------|-----------|---------|-----------|-----------|-----------|
| Category  | City   | Copy text           | **Image URL**           | (output)  | (output)  | (output)| (output)  | (output)  | (output)  |

**Important**: 
- The "Preview de creatividad" column should contain direct URLs to images (e.g., from Google Drive, CDN, etc.)
- The "1:1 IMG" columns (A, B, C) and "9:16 IMG" columns (A, B, C) will be populated with links by the batch processor

## How to Use

### Step 1: Prepare Your Data

Create a Google Sheets document with your image URLs in the "Preview de creatividad" column. Example:

```
https://drive.google.com/uc?export=view&id=FILE_ID
https://example.com/images/image2.jpg
```

### Step 2: Open the Application

1. Navigate to the Cabify Image Suite application
2. Click the **"Batch from Sheets"** tab (instead of "Single Image")

### Step 3: Enter URLs

1. **Google Sheets URL**: Paste the full URL of your shared Google Sheets document
   - Example: `https://docs.google.com/spreadsheets/d/14ZZPEd_EKQWVEArzP1gQz66-n8V2aWb4SZ0CWaHkbZc/edit?gid=110672966#gid=110672966`

2. **Google Drive Folder URL**: Paste the URL of the Drive folder where images should be uploaded
   - Example: `https://drive.google.com/drive/u/0/folders/1gWY-ZEMbWBcM_lwSKzc5HD89Pa_SiBWO`

### Step 4: Start Processing

Click **"Start Batch Processing"** and wait for completion.

### Step 5: Monitor Progress

The UI will show:
- Overall progress bar (0% to 100%)
- Real-time table with status for each row:
  - **Downloading**: Fetching the image from URL
  - **Generating**: Creating variations using AI
  - **Uploading**: Uploading to Google Drive
  - **Completed**: ✓ with count of uploaded images
  - **Error**: ✗ with error message
  - **Skipped**: No image URL in that row

## Example Workflow

1. **Create Sheets Document**
   ```
   Categoria | Ciudad | Preview de creatividad
   ----------|--------|----------------------
   Category1 | Madrid | https://...image1.jpg
   Category2 | Madrid | https://...image2.jpg
   ```

2. **Share with Service Account**
   - Share the Sheets with `your-sa@project.iam.gserviceaccount.com` (Editor)
   - Share the Drive folder with the same email (Editor)

3. **Run Batch**
   - Go to "Batch from Sheets" tab
   - Enter Sheets URL and Drive folder URL
   - Click "Start Batch Processing"

4. **Check Results**
   - Monitor progress in real-time
   - Once complete, go back to your Google Sheets
   - The 1:1 IMG and 9:16 IMG columns will be populated with links

## Troubleshooting

### Authentication Issues

#### "Missing or invalid GOOGLE_SERVICE_ACCOUNT_KEY environment variable"

This means the application couldn't find valid credentials. Check in this order:

**1. If running on GCP (Cloud Run, App Engine, etc.):**
   - Ensure the service account associated with your resource has these roles:
     - `roles/editor` or roles with permissions for Google Sheets and Drive APIs
   - Check that the APIs are enabled in your GCP project:
     - Google Sheets API
     - Google Drive API
   - Server logs should show: `✓ Application Default Credentials loaded successfully`

**2. If running locally:**
   - Set the environment variable before starting the app:
     ```powershell
     # Windows PowerShell
     $key = Get-Content "path/to/service-account.json" -Raw
     $env:GOOGLE_SERVICE_ACCOUNT_KEY = $key
     npm run dev:server
     ```
   - Or add to `.env` file:
     ```env
     GOOGLE_SERVICE_ACCOUNT_KEY={"type":"service_account",...}
     ```
   - Server logs should show: `✓ Successfully parsed GOOGLE_SERVICE_ACCOUNT_KEY`

**3. Check server logs for authentication debugging:**
   The application logs which authentication method is being used:
   ```
   Attempting to use Application Default Credentials...
   ✓ Application Default Credentials loaded successfully
   
   OR
   
   ADC not available (expected in local development)
   Attempting to parse GOOGLE_SERVICE_ACCOUNT_KEY from environment...
   ✓ Successfully parsed GOOGLE_SERVICE_ACCOUNT_KEY
   ```

### "Permission denied" error

- Make sure the service account email has been shared with:
  - The Google Sheets document (Editor role)
  - The Google Drive folder (Editor role)
- Re-share if necessary and wait a moment for permissions to propagate
- Verify the email in the error matches your service account email

### "Invalid Google Sheets URL format"
- Make sure you're copying the full URL from your browser
- The URL should contain `/spreadsheets/d/` followed by the sheet ID

### "Invalid Google Drive folder URL format"
- Make sure you're copying a folder URL, not a file URL
- The URL should contain `/drive/folders/` followed by the folder ID

### "Failed to download image from URL"
- The image URL in the Sheets might be incorrect
- Try opening the URL directly in your browser
- For Google Drive links, use sharing link or use `?export=view&id=` parameter

### "Permission denied" error
- Make sure the service account email has been shared with:
  - The Google Sheets document (Editor role)
  - The Google Drive folder (Editor role)
- Re-share if necessary and wait a moment for permissions to propagate

### "Batch processing failed"
- Check browser console for detailed errors
- Verify all URLs are correct
- Check that the service account key is properly configured

## Performance Notes

- Processing time depends on:
  - Number of rows in the sheet
  - Size of images
  - Gemini API response time
  - Network speed
- **Estimated time**: ~30-60 seconds per image (3-6 minutes for 10 rows)
- Each row generates 6 images (3× 1:1 + 3× 9:16)

## API Details

### Endpoint: `/api/batch-aspect-ratio`

**Request:**
```json
{
  "sheetsUrl": "https://docs.google.com/spreadsheets/d/{id}/edit...",
  "driveFolderUrl": "https://drive.google.com/drive/folders/{id}"
}
```

**Response Stream (NDJSON):**
```json
{"state":"reading-sheet","message":"Reading Google Sheet..."}
{"rowNumber":2,"currentRow":1,"totalRows":10,"status":"downloading","imageUrl":"..."}
{"rowNumber":2,"currentRow":1,"totalRows":10,"status":"generating","ratio":"1:1"}
{"rowNumber":2,"currentRow":1,"totalRows":10,"status":"uploading"}
{"rowNumber":2,"currentRow":1,"totalRows":10,"status":"completed","links":{"1:1":["..."],"9:16":["..."]}}
```

## Advanced Configuration

### Custom API Base URL

If the backend is hosted on a different domain, set:
```bash
export API_BASE_URL=https://your-api-domain.com
```

### Parallel Processing (Future)

Currently processes rows sequentially. Can be optimized to process 2-3 rows in parallel if needed.
