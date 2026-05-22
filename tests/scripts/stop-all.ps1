param(
  [string]$AppRoot = $env:CORE_PLATFORM_ROOT
)

$ErrorActionPreference = "Stop"
$automationRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
if ([string]::IsNullOrWhiteSpace($AppRoot)) {
  $AppRoot = "D:\core-platform"
}
$appRootPath = Resolve-Path $AppRoot

Push-Location $appRootPath
try {
  Write-Host "Stopping Core Platform app stack from $appRootPath..."
  & ".\scripts\stop-all.ps1"
} finally {
  Pop-Location
}

$runtimeRoot = Join-Path $automationRoot ".runtime"
$pidFile = Join-Path $runtimeRoot "list-view-report.pid"
$portFile = Join-Path $runtimeRoot "list-view-report.port"
if (Test-Path $pidFile) {
  $pidValue = Get-Content $pidFile | Select-Object -First 1
  if ($pidValue) {
    Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped list-view dashboard PID $pidValue"
  }
  Remove-Item $pidFile -ErrorAction SilentlyContinue
}
if (Test-Path $portFile) {
  Remove-Item $portFile -ErrorAction SilentlyContinue
}

foreach ($port in @(5372)) {
  $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped dashboard listener on port $port PID $($listener.OwningProcess)"
  }
}

Write-Host "Standalone automation stop complete."
