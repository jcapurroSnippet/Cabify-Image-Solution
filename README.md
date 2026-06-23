# Cabify Image Suite

Single Vite + React app that combines two image workflows in separate tabs:

- `Nano Editor`: prompt-driven image editing with strict Cabify constraints.
- `Aspect Ratio`: generates `1:1`, `9:16`, and `1.91:1` variants from one source image.

## Requirements

- Node.js 20+
- Gemini API key

## Setup

1. Install dependencies:
   `npm install`
2. Configure environment variable in `.env`:
   `GEMINI_API_KEY=YOUR_GEMINI_API_KEY`
3. Start backend API (terminal 1):
   `npm run dev:server`
4. Start frontend dev server (terminal 2):
   `npm run dev`

## Scripts

- `npm run dev` - start local development server
- `npm run dev:server` - start API server on `http://localhost:8080`
- `npm run build` - production build
- `npm run start` - start production server (serves API + `dist/`)
- `npm run preview` - preview frontend build only
- `npm run lint` - type check

## Docker

Build image:
`docker build -t cabify-image-suite .`

Run container:
`docker run --rm -p 8080:8080 cabify-image-suite`

The Docker image does not include `.env`. Runtime values are configured on Cloud Run as environment variables.

## Deploy to Google Cloud Run

1. Set variables:
   ```bash
   export PROJECT_ID="your-gcp-project"
   export REGION="us-central1"
   export SERVICE="cabify-image-suite"
   ```
   PowerShell:
   ```powershell
   $env:PROJECT_ID="your-gcp-project"
   $env:REGION="us-central1"
   $env:SERVICE="cabify-image-suite"
   ```
2. Enable required services:
   ```bash
   gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com --project "$PROJECT_ID"
   ```
3. Deploy from PowerShell. The script reads local `.env` and sends its values to Cloud Run with `--set-env-vars`:
   ```powershell
   .\scripts\deploy-cloud-run.ps1 -ProjectId $env:PROJECT_ID -Region $env:REGION -Service $env:SERVICE
   ```
   If a GitHub/Cloud Build trigger already deployed the image, sync local `.env` into the Cloud Run service:
   ```powershell
   .\scripts\sync-cloud-run-env.ps1 -ProjectId $env:PROJECT_ID -Region $env:REGION -Service $env:SERVICE
   ```
4. Health check:
   ```bash
   curl "https://YOUR_SERVICE_URL/healthz"
   ```
