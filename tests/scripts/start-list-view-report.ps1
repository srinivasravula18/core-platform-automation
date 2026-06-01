param(
  [int]$Port = 5372,
  [switch]$AllowMissing,
  [switch]$NoOpen,
  [switch]$Foreground
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$runtimeRoot = Join-Path $repoRoot ".runtime"
$pidFile = Join-Path $runtimeRoot "list-view-report.pid"
$portFile = Join-Path $runtimeRoot "list-view-report.port"
$stdoutLog = Join-Path $runtimeRoot "list-view-report.out.log"
$stderrLog = Join-Path $runtimeRoot "list-view-report.err.log"
$reportPath = Join-Path $repoRoot "tests\e2e\reports\list-view-regression\list-view-regression-results.html"
$reportFolder = Split-Path $reportPath -Parent

. "$repoRoot\scripts\process-utils.ps1"

if (-not (Test-Path $runtimeRoot)) {
  New-Item -ItemType Directory -Path $runtimeRoot | Out-Null
}

if (-not (Test-Path $reportPath) -and -not $AllowMissing) {
  throw "List-view report was not found. Run npm run test:ui:list-view:admin or npm run test:ui:list-view:full first."
}

if (-not (Test-Path $reportFolder)) {
  New-Item -ItemType Directory -Path $reportFolder -Force | Out-Null
}

if (-not (Test-Path $reportPath)) {
  Set-Content -Path $reportPath -Value "<!doctype html><html><head><title>List-view report</title></head><body><h1>Waiting for list-view test run...</h1><p>The report will update when Playwright starts.</p></body></html>"
}

$defaultUrl = "http://127.0.0.1:$Port/"
try {
  $existingHealth = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/api/status" -TimeoutSec 2
  if ($existingHealth.StatusCode -eq 200) {
    $hasCurrentApi = $false
    try {
      $featureHealth = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/api/test-data/datasets" -TimeoutSec 2
      $hasCurrentApi = $featureHealth.StatusCode -eq 200
    } catch {
      $hasCurrentApi = $false
    }

    if ($hasCurrentApi) {
      Write-Host "List-view test environment already running."
      Write-Host "Open: $defaultUrl"
      if (-not $NoOpen -and -not $env:CI) {
        Start-Process $defaultUrl
      }
      exit 0
    }

    Write-Host "Existing dashboard on port $Port is stale. Restarting it..."
    foreach ($processId in Get-ListeningProcessIdsByPort -Port $Port) {
      if (Test-ProcessCommandLineMatch -ProcessId $processId -Patterns @("serve-list-view-report.mjs")) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
      }
    }
  }
} catch {
  # No dashboard is responding on the preferred port yet.
}

if (Test-Path $pidFile) {
  $existingPid = Get-Content $pidFile | Select-Object -First 1
  if (
    $existingPid -and
    (Get-Process -Id $existingPid -ErrorAction SilentlyContinue) -and
    (Test-ProcessCommandLineMatch -ProcessId $existingPid -Patterns @("serve-list-view-report.mjs"))
  ) {
    $existingPort = $Port
    if (Test-Path $portFile) {
      $existingPort = Get-Content $portFile | Select-Object -First 1
    }
    Write-Host "List-view test environment already running."
    $url = "http://127.0.0.1:$existingPort/"
    Write-Host "Open: $url"
    if (-not $NoOpen -and -not $env:CI) {
      Start-Process $url
    }
    exit 0
  }
  Remove-Item $pidFile -ErrorAction SilentlyContinue
  Remove-Item $portFile -ErrorAction SilentlyContinue
}

$selectedPort = $Port
while ((Get-ListeningProcessIdsByPort -Port $selectedPort).Count -gt 0) {
  $selectedPort += 1
}

Push-Location $repoRoot
try {
  if (Test-Path (Join-Path $repoRoot "tests\e2e\dashboard-src\index.html")) {
    Write-Host "Building modular React test dashboard..."
    npm.cmd run build:dashboard
    if ($LASTEXITCODE -ne 0) {
      throw "Dashboard build failed with exit code $LASTEXITCODE."
    }
  }

  $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
  if ($Foreground) {
    $url = "http://127.0.0.1:$selectedPort/"
    Write-Host "Starting list-view test environment in this terminal."
    Write-Host "Open: $url"
    if (-not $NoOpen -and -not $env:CI) {
      Start-Process $url
    }
    & $nodePath "tests/scripts/serve-list-view-report.mjs" "$selectedPort"
    exit $LASTEXITCODE
  }

  $process = Start-Process `
    -FilePath $nodePath `
    -ArgumentList @("tests/scripts/serve-list-view-report.mjs", "$selectedPort") `
    -WorkingDirectory $repoRoot `
    -PassThru `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog

  Set-Content -Path $pidFile -Value $process.Id
  Set-Content -Path $portFile -Value $selectedPort
  $started = $false
  for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    Start-Sleep -Milliseconds 250
    try {
      $health = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$selectedPort/api/status" -TimeoutSec 2
      if ($health.StatusCode -eq 200) {
        $started = $true
        break
      }
    } catch {
      $started = $false
    }
  }
  if (-not $started) {
    $stderr = if (Test-Path $stderrLog) { Get-Content $stderrLog -Raw } else { "" }
    throw "List-view test environment did not start on port $selectedPort. $stderr"
  }
  Write-Host "List-view test environment started. PID: $($process.Id)"
  $url = "http://127.0.0.1:$selectedPort/"
  Write-Host "Open: $url"
  if (-not $NoOpen -and -not $env:CI) {
    Start-Process $url
  }
} finally {
  Pop-Location
}
