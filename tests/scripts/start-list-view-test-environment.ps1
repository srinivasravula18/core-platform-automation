param(
  [int]$Port = 5372,
  [switch]$SkipStart,
  [switch]$NoOpen,
  [string]$AppRoot = $env:CORE_PLATFORM_ROOT
)

$ErrorActionPreference = "Stop"
$automationRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
if ([string]::IsNullOrWhiteSpace($AppRoot)) {
  $AppRoot = "D:\core-platform"
}
$appRootPath = Resolve-Path $AppRoot
$env:CORE_PLATFORM_ROOT = $appRootPath

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

  Push-Location $automationRoot
  try {
    Write-Host "Starting dedicated list-view E2E test environment from $automationRoot..."
    & ".\tests\scripts\start-list-view-report.ps1" -AllowMissing -Foreground -Port $Port -NoOpen:$NoOpen
  } finally {
    Pop-Location
  }
} finally {
  # Foreground dashboard exits when this terminal is stopped.
}
