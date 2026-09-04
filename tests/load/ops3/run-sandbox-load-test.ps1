[CmdletBinding()]
param(
  [ValidateSet(100, 200, 300)]
  [int]$Users,
  [string]$ApiBase = "https://bulkseed01.bcp.acchindra.com",
  [ValidatePattern("^\d+(s|m|h)$")]
  [string]$Duration = "15m"
)

$ErrorActionPreference = "Stop"
$scriptDirectory = Split-Path -Parent $PSCommandPath
Set-Location $scriptDirectory

if (-not (Get-Command k6 -ErrorAction SilentlyContinue)) {
  throw "k6 is not on PATH. Install k6 before running this test."
}
if ([string]::IsNullOrWhiteSpace($env:ADMIN_USERNAME) -or [string]::IsNullOrWhiteSpace($env:ADMIN_PASSWORD)) {
  throw "Set ADMIN_USERNAME and ADMIN_PASSWORD in your current shell before running the test."
}

$poolDefinition = Get-Content "user-pool-300.cmd" | Where-Object { $_ -like "set USER_POOL=*" } | Select-Object -First 1
if (-not $poolDefinition) {
  throw "The seeded-user pool could not be loaded from user-pool-300.cmd."
}
$env:USER_POOL = $poolDefinition.Substring("set USER_POOL=".Length)
$env:API_BASE = $ApiBase.TrimEnd("/")
$env:AUTH_API_BASE = $env:API_BASE
$env:DURATION = $Duration
$env:SETUP_WAIT_SECONDS = "2"
$env:INITIAL_LOGIN_SPREAD_MS = "60000"
$env:LOGIN_MAX_ATTEMPTS = "3"
$env:LOGIN_RETRY_BASE_MS = "1000"
$env:SETUP_DESCRIBE = "1"
$env:FAILURE_LOG_LIMIT = "50"
$env:SEEDED_USER_POOL_LIMIT = "300"
$env:REQUIRE_UNIQUE_USERS = "1"
$env:SKIP_LIST_TABS = "1"
$env:QUERY_LIST_VIEW_EVERY = "3"
$env:SKIP_QUERY_LIST_VIEW = "0"
$env:SKIP_FILE_OPS = "1"
$env:MIN_ITERATION_MS = "200"
$env:CRM_OBJECT_API = "account"
$env:HR_OBJECT_API = "department"

switch ($Users) {
  100 { $env:ADMIN_APP_VUS = "2"; $env:SHOCKWAVE_ADMIN_VUS = "5"; $env:CRM_VUS = "83"; $env:HR_VUS = "10" }
  200 { $env:ADMIN_APP_VUS = "4"; $env:SHOCKWAVE_ADMIN_VUS = "10"; $env:CRM_VUS = "176"; $env:HR_VUS = "10" }
  300 { $env:ADMIN_APP_VUS = "6"; $env:SHOCKWAVE_ADMIN_VUS = "15"; $env:CRM_VUS = "269"; $env:HR_VUS = "10" }
}

New-Item -ItemType Directory -Force -Path "reports" | Out-Null
k6 run "real-time-ops3-test.js"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Copy-Item "ops3-summary.html" "reports/ops3-$Users-users-summary.html" -Force
Copy-Item "ops3-summary.json" "reports/ops3-$Users-users-summary.json" -Force
Write-Host "Reports written to tests/load/ops3/reports/ops3-$Users-users-summary.{html,json}"
