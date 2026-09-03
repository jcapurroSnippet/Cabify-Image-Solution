# Cabify Image Suite

Single Vite + React app. The primary surface is **Ciclo**, the five-step creative
replacement funnel; the individual tools stay available under **Herramientas** for
one-off work:

- `Nano Editor`: prompt-driven image editing with strict Cabify constraints.
- `Aspect Ratio`: generates `1:1` and `9:16` variants from one source image,
  or in bulk from a Google Sheet (`Batch from Sheets`).
- `Editor Batch`: bulk scene transformation for 3-20 uploaded images.
- `Creative Library`: Google Ads + Meta low-performer detection and creative replacement.
- `Creative Review`: review batches and the tokenized client approval portal.

## The funnel (Ciclo)

A **run** spans all five steps and is what ties the tools together — before it,
each tool ran alone and nothing linked a failing creative to the piece generated
to replace it.

1. **Detección** — `getAdsLowPerformers` finds low performers in the selected campaigns.
2. **Generación** — three variants in each of the three ratios per target, via the
   existing `generateAspectRatioImages` pipeline. The source image is the low
   performer's own creative, falling back to the Drive bank in
   `CREATIVE_SOURCE_BANK_FOLDER_ID` when it cannot be downloaded.
3. **Pre-aprobación Snippet** — discard pieces the client should not see. A discard
   marks the item `superseded`; only the Studio (token-less) endpoint may do this.
4. **Aprobación Cabify** — the app does **not** send mail. It shows the private link
   and a ready-to-paste message; the sender marks it as sent.
5. **Ubicación** — the replacement plan is pre-built from each creative's detected
   category; confirm or override the destination, then execute.

State lives in two Sheets tabs, created and migrated automatically:

- `creative_runs` — one row per run.
- `creative_run_targets` — one row per detected low performer. Carries the
  `target_id → creative_family_id → review_item_ids → creative_id` chain, so every
  shipped creative is traceable back to the one it replaced.

`Batch from Sheets` adds a third, created and migrated the same way:

- `batch_variations` — one row per generated variation, linked to the review
  portal through `review_item_id`.

## Batch from Sheets

Point it at a Google Sheet URL whose `gid` identifies the source tab (including
the `.../edit?gid=NNN#gid=NNN` form). In that tab, Batch explicitly selects the
`16:9` image column and generates exactly three `1:1` variants plus three `9:16`
variants for every row that carries a source image URL.

**The source tab is read-only.** Output goes to a dedicated `batch_variations` tab
in the same spreadsheet, which the app creates and migrates itself — one row per
generated variation, carrying the `review_batch_id → review_item_id` pair that
ties it to Creative Review plus a direct `creative_review_url`. You do not
prepare output columns, and nothing in
your source tab is overwritten. The output tab is highlighted in Cabify purple,
has a frozen header and filters, and the UI links directly to both the tab and
the completed review batch.

The `16:9` source cells may contain plain text URLs, `HYPERLINK()` formulas,
native hyperlinks or rich-text links. A row with no URL is skipped, not failed.
Header detection first looks for an explicit image header such as `16.9 IMG`,
`16:9 IMAGE`, or `16x9 IMG` and rejects similarly named video columns. The
familiar `categoria`, `ciudad`, `copy`, and `preview` labels are only used to
locate the header row before reporting that the required image column is absent.

A row's variations are appended only after its review items are registered, so
the tab never advertises pieces the review portal does not know about. The browser
processes three source rows per request and continues with the same
`reviewBatchId`, keeping the run below Cloud Run's request deadline. Persisted
rows are skipped on continuation; if a chunk fails, the UI offers to resume the
same batch instead of creating a duplicate. `POST /api/batch-status` can rebuild
progress from the persisted output. The tab is append-only and accumulative
across batches; pass `reviewBatchId` to scope a status read, otherwise the most
recent batch for that source tab is used.

Steps 1 and 2 chain without user input; the funnel only stops at the approval
gates. Generation streams NDJSON and is **resumable** — targets in a terminal
state are skipped, so reopening a run after a closed tab continues where it left
off rather than regenerating. There is no worker or cron: the browser drives
`POST /api/runs/:runId/advance`. These routes are Studio-only and return 404 when
`APP_MODE=review`.

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
