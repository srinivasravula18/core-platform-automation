param(
  [switch]$SkipReset,
  [switch]$SkipStart,
  [switch]$Headed,
  [ValidateSet("all", "admin", "keystone", "api")]
  [string]$Surface = "all",
  [string]$Scenario = "",
  [string]$AppRoot = $env:CORE_PLATFORM_ROOT
)

$ErrorActionPreference = "Stop"
$automationRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
if ([string]::IsNullOrWhiteSpace($AppRoot)) {
  $AppRoot = "D:\core-platform"
}
$appRootPath = Resolve-Path $AppRoot
$env:CORE_PLATFORM_ROOT = $appRootPath
$testExitCode = 0

if ([string]::IsNullOrWhiteSpace($env:TEST_ADMIN_USERNAME) -and [string]::IsNullOrWhiteSpace($env:ADMIN_USERNAME)) {
  $env:TEST_ADMIN_USERNAME = "admin"
}
if ([string]::IsNullOrWhiteSpace($env:TEST_ADMIN_PASSWORD) -and [string]::IsNullOrWhiteSpace($env:ADMIN_PASSWORD)) {
  $env:TEST_ADMIN_PASSWORD = "admin"
}
if ([string]::IsNullOrWhiteSpace($env:AUTH_RATE_LIMIT_LOGIN_MAX_IP)) {
  $env:AUTH_RATE_LIMIT_LOGIN_MAX_IP = "5000"
}
if ([string]::IsNullOrWhiteSpace($env:AUTH_RATE_LIMIT_WINDOW_MS)) {
  $env:AUTH_RATE_LIMIT_WINDOW_MS = "60000"
}

function Test-LocalHttpPort {
  param(
    [int]$Port,
    [string]$Path = "/"
  )

  try {
    $response = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port$Path" -TimeoutSec 3
    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500)
  } catch {
    return $false
  }
}

try {
  if (-not $SkipReset) {
    Push-Location $appRootPath
    try {
      Write-Host "Resetting local database and loading seeded list-view regression data from $appRootPath..."
      & ".\scripts\stop-all.ps1"
      & ".\scripts\reset-db.ps1" -SkipSeedAdmin -SkipMetadataLoad -SkipSeedTestRolesGroups
      npm.cmd run seed:industry-suite
    } finally {
      Pop-Location
    }
  }

  if (-not $SkipStart) {
    $serviceRunning = Test-LocalHttpPort -Port 5001 -Path "/health"
    $adminRunning = Test-LocalHttpPort -Port 5002
    $keystoneRunning = Test-LocalHttpPort -Port 5003

    Write-Host "Port check before starting application stack:"
    Write-Host "  Service API 5001:        $(if ($serviceRunning) { 'running' } else { 'not running' })"
    Write-Host "  Admin 5002:              $(if ($adminRunning) { 'running' } else { 'not running' })"
    Write-Host "  Keystone/Shockwave 5003: $(if ($keystoneRunning) { 'running' } else { 'not running' })"

    if ($serviceRunning -and $adminRunning -and $keystoneRunning) {
      Write-Host "Application stack is already running. Skipping start-all."
    } else {
      Push-Location $appRootPath
      try {
        Write-Host "One or more application services are missing. Starting local Service, Admin, Keystone, and worker stack from $appRootPath..."
        & ".\scripts\start-all.ps1"
      } finally {
        Pop-Location
      }
    }
  }

  $authBucketReset = Join-Path $appRootPath "tests\load\ops3\reset-auth-rate-limit-buckets.bat"
  if (Test-Path $authBucketReset) {
    Push-Location $appRootPath
    try {
      Write-Host "Clearing auth rate-limit buckets for list-view regression login..."
      & $authBucketReset
      if ($LASTEXITCODE -ne 0) {
        Write-Warning "Auth rate-limit bucket cleanup failed. Continuing; login setup may still be rate-limited."
      }
    } finally {
      Pop-Location
    }
  }

  $env:ALLOW_DATA_WRITE = "true"
  if ($Headed) {
    $env:LIST_VIEW_REGRESSION_HEADED = "1"
  } else {
    $env:LIST_VIEW_REGRESSION_HEADED = "0"
  }

  Push-Location $automationRoot
  try {
    & ".\tests\scripts\start-list-view-report.ps1" -AllowMissing
    Write-Host "List-view test environment is available while tests run."

    $config = "tests/e2e/playwright.list-view-regression.config.ts"
    $adminSpec = "tests/e2e/list-view-regression/admin-list-view.spec.ts"
    $keystoneSpec = "tests/e2e/list-view-regression/keystone-list-view.spec.ts"
    $apiSpec = "tests/e2e/list-view-regression/list-view-api.spec.ts"
    $scenarioArgs = @()
    if (-not [string]::IsNullOrWhiteSpace($Scenario)) {
      $scenarioArgs = @("--grep", $Scenario)
      Write-Host "Applying list-view scenario filter: $Scenario"
    }
    if ($Surface -eq "admin") {
      npx.cmd playwright test $adminSpec -c $config --workers=1 @scenarioArgs
      $testExitCode = $LASTEXITCODE
    } elseif ($Surface -eq "keystone") {
      npx.cmd playwright test $keystoneSpec -c $config --workers=1 @scenarioArgs
      $testExitCode = $LASTEXITCODE
    } elseif ($Surface -eq "api") {
      npx.cmd playwright test $apiSpec -c $config --workers=1 @scenarioArgs
      $testExitCode = $LASTEXITCODE
    } else {
      npx.cmd playwright test -c $config --workers=1 @scenarioArgs
      $testExitCode = $LASTEXITCODE
    }
  } finally {
    Pop-Location
  }
} finally {
  # Keep application services running for developer inspection; use the app repo stop command when done.
}

exit $testExitCode
