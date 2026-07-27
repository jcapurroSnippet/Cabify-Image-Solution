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
   Copy `.env.example` to `.env` and complete the credentials required by the enabled integrations.
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
- `npm test` - run the automated test suite

## Google Ads APP_AD image replacement

The replacement planner analyzes enabled campaigns, ad groups, and ads over a configurable period. Defaults are 30 days, 100 impressions, and at most one LOW image per ad. A dry run only builds the proposed final `app_ad.images` list; it does not reserve creatives, create assets, or mutate ads.

APP_AD mutation is guarded by `GOOGLE_APP_AD_REPLACEMENT_ENABLED=0`. Before enabling it in production, set the flag to `1` in a test environment and successfully validate a non-legacy APP_AD. Every apply first runs Google Ads `validate_only`, then updates the same ad while preserving unrelated image assets. Google-rejected legacy or unsupported ads are skipped and recorded in `creative_audit_log`.

Creative reservations expire after `CREATIVE_RESERVATION_TTL_MINUTES` (30 by default). Successful use remains blocked only for the same platform, account, and campaign. Uploaded Google assets are cached by customer and creative hash in `google_asset_cache`; campaign reservations and uses remain in `creative_campaign_usage`.

Replacement history is available through `GET /api/ads-replacements/history?sheetsUrl=...`, with optional `accountId`, `campaignId`, `status`, and `from` filters. In an `APPLIED_UNVERIFIED` result, inspect the ad in Google Ads before retrying: the creative is deliberately kept as used to avoid duplication. Failed validation or mutation releases the reservation so it can be retried safely.

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
