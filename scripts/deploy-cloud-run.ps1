param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,

  [string]$Region = "us-central1",
  [string]$Service = "cabify-image-suite",
  [string]$SecretName = "gemini-api-key",
  [switch]$RequireAuthentication
)

$ErrorActionPreference = "Stop"

$allowUnauthenticatedFlag = if ($RequireAuthentication) { "" } else { "--allow-unauthenticated" }

Write-Host "Using project: $ProjectId"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com --project $ProjectId

$deployArgs = @(
  "run", "deploy", $Service,
  "--source", ".",
  "--region", $Region,
  "--project", $ProjectId,
  "--set-secrets", "GEMINI_API_KEY=${SecretName}:latest"
)

if ($allowUnauthenticatedFlag) {
  $deployArgs += $allowUnauthenticatedFlag
}

Write-Host "Deploying service '$Service' in region '$Region'..."
gcloud @deployArgs

Write-Host "Deployment finished."
