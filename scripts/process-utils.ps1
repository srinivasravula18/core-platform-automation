function Get-ListeningProcessIdsByPort {
  param(
    [int]$Port
  )

  try {
    $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  } catch {
    $connections = @()
  }

  if (-not $connections) {
    return @()
  }

  return @($connections | Select-Object -ExpandProperty OwningProcess -Unique)
}

function Test-ProcessOwnsPort {
  param(
    [int]$ProcessId,
    [int]$Port
  )

  if (-not $ProcessId) {
    return $false
  }

  return (Get-ListeningProcessIdsByPort -Port $Port) -contains [int]$ProcessId
}

function Get-ProcessCommandLine {
  param(
    [int]$ProcessId
  )

  if (-not $ProcessId) {
    return $null
  }

  try {
    return (Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop).CommandLine
  } catch {
    return $null
  }
}

function Test-ProcessCommandLineMatch {
  param(
    [int]$ProcessId,
    [string[]]$Patterns
  )

  if (-not $ProcessId -or -not $Patterns -or $Patterns.Count -eq 0) {
    return $false
  }

  $commandLine = Get-ProcessCommandLine -ProcessId $ProcessId
  if (-not $commandLine) {
    return $false
  }

  foreach ($pattern in $Patterns) {
    if ($pattern -and $commandLine -like "*$pattern*") {
      return $true
    }
  }

  return $false
}

function Stop-ProcessByPort {
  param(
    [int]$Port,
    [string]$Label
  )

  $pids = Get-ListeningProcessIdsByPort -Port $Port
  if (-not $pids -or $pids.Count -eq 0) {
    Write-Host "$Label not detected on port $Port."
    return
  }

  foreach ($processId in $pids) {
    if (-not $processId) { continue }
    try {
      Stop-Process -Id $processId -Force -ErrorAction Stop
      Write-Host "$Label stopped. PID: $processId"
    } catch {
      Write-Host "Failed to stop $Label PID $processId. It may already be stopped."
    }
  }
}

function Stop-ProcessTree {
  param(
    [int]$ProcessId,
    [string]$Label
  )

  if (-not $ProcessId) {
    return
  }

  $taskKillOutput = & taskkill.exe /PID $ProcessId /T /F 2>&1
  if ($LASTEXITCODE -eq 0) {
    Write-Host "$Label stopped. PID tree: $ProcessId"
    return
  }

  try {
    Stop-Process -Id $ProcessId -Force -ErrorAction Stop
    Write-Host "$Label stopped. PID: $ProcessId"
  } catch {
    Write-Host "Failed to stop $Label PID $ProcessId. $taskKillOutput"
  }
}
