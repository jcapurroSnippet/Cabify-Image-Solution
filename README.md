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

APP_AD mutation is enabled by default and can be stopped immediately with `GOOGLE_APP_AD_REPLACEMENT_ENABLED=0`. Every apply first runs Google Ads `validate_only`, then updates the same ad while preserving unrelated image assets. Google-rejected legacy or unsupported ads are skipped and recorded in `creative_audit_log`.

Creative reservations expire after `CREATIVE_RESERVATION_TTL_MINUTES` (30 by default). Successful use remains blocked only for the same platform, account, and campaign. Uploaded Google assets are cached by customer and creative hash in `google_asset_cache`; campaign reservations and uses remain in `creative_campaign_usage`.

Replacement history is available through `GET /api/ads-replacements/history?sheetsUrl=...`, with optional `accountId`, `campaignId`, `status`, and `from` filters. In an `APPLIED_UNVERIFIED` result, inspect the ad in Google Ads before retrying: the creative is deliberately kept as used to avoid duplication. Failed validation or mutation releases the reservation so it can be retried safely.

## Docker

Build image:
`docker build -t cabify-image-suite .`

Run container:
`docker run --rm -p 8080:8080 cabify-image-suite`

The Docker image does not include `.env`. Runtime values are configured on Cloud Run as environment variables.

## Creative review portal

The creative review workflow uses the same Google Sheet as the operational source of truth and adds two normalized tabs: `creative_review_batches` and `creative_review_items`. Internal users prepare batches in the studio; clients receive a private, expiring link and can approve or reject each creative without opening the Sheet. Rejections require feedback, and only explicitly approved creatives are published to `creative_library`.

Two runtime modes are built from the same image:

- `studio`: the full internal application. Deploy it with Cloud Run authentication.
- `review`: the public client surface. It exposes only review, preview, and health endpoints; batch links are protected by revocable bearer tokens stored only as hashes.

The deployment helper keeps both the private Studio and public review service at one instance with concurrency 1 while state is persisted in Sheets. This serializes generation, migration, decisions and publication retries across each writer runtime; keep this setting until the workflow moves to a datastore with distributed compare-and-set semantics.

Run the legacy migration from the authenticated Studio API after configuring credentials:

```bash
curl -X POST "https://STUDIO_URL/api/creative-reviews/import-legacy" \
  -H "Content-Type: application/json" \
  -d '{"sheetsUrl":"https://docs.google.com/spreadsheets/d/SHEET_ID/edit","sheetName":"RIDERS | AR"}'
```

The importer creates a native backup by default, maps each cell color independently, preserves rejection feedback, marks existing Creative Library matches, and returns the existing migration on retries unless `force: true` is supplied.

Configure `CREATIVE_REVIEW_SHEETS_URL` with the operational Google Sheet, `CREATIVE_REVIEW_PUBLIC_BASE_URL` with the public review service URL, and `CREATIVE_REVIEW_STUDIO_BASE_URL` with the private Studio URL used by token-free links mirrored into the Sheet. Keep the default 30-day expiry or override `CREATIVE_REVIEW_TOKEN_TTL_DAYS`. Preview authorization is coalesced and cached for 10 seconds by default; stale `publishing` batches become retryable after 300 seconds.

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
   .\scripts\deploy-cloud-run.ps1 -ProjectId $env:PROJECT_ID -Region $env:REGION -Service $env:SERVICE -AppMode studio -RequireAuthentication
   ```
   Deploy the client review surface separately from the same source:
   ```powershell
   .\scripts\deploy-cloud-run.ps1 -ProjectId $env:PROJECT_ID -Region $env:REGION -Service "cabify-creative-review" -AppMode review
   ```
   If a GitHub/Cloud Build trigger already deployed the image, sync local `.env` into the Cloud Run service:
   ```powershell
   .\scripts\sync-cloud-run-env.ps1 -ProjectId $env:PROJECT_ID -Region $env:REGION -Service $env:SERVICE
   ```
4. Health check:
   ```bash
   curl "https://YOUR_SERVICE_URL/healthz"
   ```
