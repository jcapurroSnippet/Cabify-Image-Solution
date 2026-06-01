param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,

  [string]$Region = "us-central1",
  [string]$Service = "cabify-image-suite",
  [string]$EnvFile = ".env"
)

$ErrorActionPreference = "Stop"

function Read-DotEnvFile {
  param([string]$Path)

  $values = [ordered]@{}
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Env file not found: $Path"
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

    if (-not [string]::IsNullOrWhiteSpace($value) -and $key -notlike "VITE_*") {
      $values[$key] = $value
    }
  }

  return $values
}

$envValues = Read-DotEnvFile -Path $EnvFile
$setEnvPairs = @()

foreach ($key in $envValues.Keys) {
  $setEnvPairs += "$key=$($envValues[$key])"
}

if ($setEnvPairs.Count -eq 0) {
  throw "No environment variables found in $EnvFile"
}

$updateArgs = @(
  "run", "services", "update", $Service,
  "--region", $Region,
  "--project", $ProjectId,
  "--set-env-vars", ("^~^" + ($setEnvPairs -join "~"))
)

Write-Host "Updating Cloud Run env vars for service '$Service' in region '$Region'..."
gcloud.cmd @updateArgs
Write-Host "Cloud Run environment variables updated."
