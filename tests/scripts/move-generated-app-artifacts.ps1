param(
  [Parameter(Mandatory = $true)]
  [string]$AppRoot,
  [string]$AutomationRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\.."))
)

$ErrorActionPreference = "Stop"

$appRootPath = Resolve-Path $AppRoot
$automationRootPath = Resolve-Path $AutomationRoot

$items = @(
  @{ Source = ".runtime"; Dest = ".runtime"; Kind = "Directory" },
  @{ Source = "seeds\metadata\.generated"; Dest = "seeds\metadata\.generated"; Kind = "Directory" },
  @{ Source = "tests\e2e\.storage"; Dest = "tests\e2e\.storage"; Kind = "Directory" },
  @{ Source = "tests\e2e\permissions"; Dest = "tests\e2e\permissions"; Kind = "Directory" },
  @{ Source = "tests\e2e\rbac\rbac_results.html"; Dest = "tests\e2e\rbac\rbac_results.html"; Kind = "File" },
  @{ Source = "tests\e2e\rbac\rbac_results.pdf"; Dest = "tests\e2e\rbac\rbac_results.pdf"; Kind = "File" },
  @{ Source = "tests\fixtures\rbac_matrix.csv"; Dest = "tests\fixtures\rbac_matrix.csv"; Kind = "File" },
  @{ Source = "tests\screenshots"; Dest = "tests\screenshots"; Kind = "Directory" },
  @{ Source = "tests\e2e\list-view-test-environment\index.html"; Dest = "evidences\app-repo-generated\tests\e2e\list-view-test-environment\index.html"; Kind = "File" }
)

foreach ($item in $items) {
  $source = Join-Path $appRootPath $item.Source
  if (-not (Test-Path -LiteralPath $source)) {
    continue
  }

  $resolvedSource = Resolve-Path -LiteralPath $source
  if (-not ($resolvedSource.Path.StartsWith($appRootPath.Path, [System.StringComparison]::OrdinalIgnoreCase))) {
    throw "Refusing to move outside app root: $($resolvedSource.Path)"
  }

  $destination = Join-Path $automationRootPath $item.Dest
  $destinationParent = Split-Path -Parent $destination
  if (-not (Test-Path -LiteralPath $destinationParent)) {
    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
  }

  if ($item.Kind -eq "Directory") {
    if (Test-Path -LiteralPath $destination) {
      Remove-Item -LiteralPath $destination -Recurse -Force
    }
    Move-Item -LiteralPath $resolvedSource.Path -Destination $destination -Force
  } else {
    Move-Item -LiteralPath $resolvedSource.Path -Destination $destination -Force
  }
}
