param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,

  [string]$Region = "us-central1",
  [string]$Service = "cabify-image-suite",
  [string]$SecretName = "gemini-api-key",
  [string]$EnvFile = ".env",
  [switch]$CreateSecretsFromEnvFile,
  [switch]$RequireAuthentication
)

$ErrorActionPreference = "Stop"

$allowUnauthenticatedFlag = if ($RequireAuthentication) { "" } else { "--allow-unauthenticated" }
$secretEnvNames = @(
  "GEMINI_API_KEY",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_TOKEN_JSON",
  "GOOGLE_SERVICE_ACCOUNT_KEY",
  "GOOGLE_SERVICE_ACCOUNT_KEY_B64",
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_REFRESH_TOKEN",
  "META_ACCESS_TOKEN",
  "META_APP_SECRET"
)

function Convert-ToSecretName {
  param([string]$Name)
  return ("cabify-" + $Name.ToLowerInvariant().Replace("_", "-"))
}

function Read-DotEnvFile {
  param([string]$Path)

  $values = [ordered]@{}
  if (-not (Test-Path -LiteralPath $Path)) {
    return $values
  }

  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
      continue
    }

    $key = $matches[1]
    $value = $matches[2].Trim()
    if ($value.StartsWith('"') -and $value.EndsWith('"')) {
      $value = $value.Substring(1, $value.Length - 2).Replace('\"', '"')
    } elseif ($value.StartsWith("'") -and $value.EndsWith("'")) {
      $value = $value.Substring(1, $value.Length - 2)
    }

    $values[$key] = $value
  }

  return $values
}

function Add-SecretVersion {
  param(
    [string]$ProjectId,
    [string]$SecretName,
    [string]$Value
  )

  $existing = & gcloud.cmd secrets describe $SecretName --project $ProjectId --format "value(name)" 2>$null
  if (-not $existing) {
    & gcloud.cmd secrets create $SecretName --replication-policy="automatic" --project $ProjectId | Out-Null
  }

  $tempFile = New-TemporaryFile
  try {
    [System.IO.File]::WriteAllText($tempFile.FullName, $Value, [System.Text.UTF8Encoding]::new($false))
    & gcloud.cmd secrets versions add $SecretName --data-file=$tempFile.FullName --project $ProjectId | Out-Null
  } finally {
    Remove-Item -LiteralPath $tempFile.FullName -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "Using project: $ProjectId"
gcloud.cmd services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com --project $ProjectId

$envValues = Read-DotEnvFile -Path $EnvFile
$setEnvPairs = @()
$setSecretPairs = @()

foreach ($key in $envValues.Keys) {
  if ($key -like "VITE_*") {
    continue
  }

  $value = [string]$envValues[$key]
  if ([string]::IsNullOrWhiteSpace($value)) {
    continue
  }

  if ($CreateSecretsFromEnvFile -and $secretEnvNames -contains $key) {
    $cloudSecretName = if ($key -eq "GEMINI_API_KEY") { $SecretName } else { Convert-ToSecretName -Name $key }
    Write-Host "Creating/updating Secret Manager secret for $key -> $cloudSecretName"
    Add-SecretVersion -ProjectId $ProjectId -SecretName $cloudSecretName -Value $value
    $setSecretPairs += "$key=${cloudSecretName}:latest"
  } else {
    $setEnvPairs += "$key=$value"
  }
}

$deployArgs = @(
  "run", "deploy", $Service,
  "--source", ".",
  "--region", $Region,
  "--project", $ProjectId
)

if ($setSecretPairs.Count -gt 0) {
  $deployArgs += "--set-secrets"
  $deployArgs += ("^~^" + ($setSecretPairs -join "~"))
}

if ($setEnvPairs.Count -gt 0) {
  $deployArgs += "--set-env-vars"
  $deployArgs += ("^~^" + ($setEnvPairs -join "~"))
}

if ($allowUnauthenticatedFlag) {
  $deployArgs += $allowUnauthenticatedFlag
}

Write-Host "Deploying service '$Service' in region '$Region'..."
gcloud.cmd @deployArgs

Write-Host "Deployment finished."
