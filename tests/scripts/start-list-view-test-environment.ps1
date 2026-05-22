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

try {
  if (-not $SkipStart) {
    Push-Location $appRootPath
    try {
      Write-Host "Starting local Service, Admin, Keystone, and worker stack from $appRootPath..."
      & ".\scripts\start-all.ps1"
    } finally {
      Pop-Location
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
