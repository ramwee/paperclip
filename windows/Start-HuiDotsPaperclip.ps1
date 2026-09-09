[CmdletBinding()]
param(
  [string]$RepositoryPath = "C:\Users\admin\Documents\Paperclip",
  [string]$PaperclipHome = "C:\Users\admin\.paperclip",
  [string]$InstanceId = "huidots",
  [string]$HealthUrl = "http://127.0.0.1:3100/api/health",
  [string]$LogPath = "C:\Users\admin\paperclip-huidots-service.log",
  [string]$ProcessLogDirectory = "C:\Users\admin\.paperclip\instances\huidots\logs\supervised",
  [int]$StartupTimeoutSeconds = 120,
  [int]$HealthIntervalSeconds = 30,
  [int]$UnhealthyThreshold = 3,
  [int]$RestartDelaySeconds = 10
)

$ErrorActionPreference = "Stop"

function Write-SupervisorLog([string]$Message) {
  $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffK"
  Add-Content -LiteralPath $LogPath -Value "[$timestamp] [huidots-supervisor] $Message"
}

function Test-PaperclipHealth {
  try {
    $response = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 10
    return $response.status -eq "ok" -and $response.bootstrapStatus -eq "ready"
  } catch {
    return $false
  }
}

function Stop-ProcessTree([int]$ProcessId) {
  if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return }
  & "$env:SystemRoot\System32\taskkill.exe" /PID $ProcessId /T /F | Out-Null
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) | Out-Null
New-Item -ItemType Directory -Force -Path $ProcessLogDirectory | Out-Null
$env:PAPERCLIP_HOME = $PaperclipHome
$env:PAPERCLIP_INSTANCE_ID = $InstanceId
$env:PAPERCLIP_UI_DEV_MIDDLEWARE = "false"
$env:PAPERCLIP_SERVICE_MANAGED = "1"

$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$tsxPath = Join-Path $RepositoryPath "cli\node_modules\tsx\dist\cli.mjs"
$cliPath = Join-Path $RepositoryPath "cli\src\index.ts"
if (-not (Test-Path -LiteralPath $tsxPath)) { throw "Paperclip tsx launcher not found: $tsxPath" }
if (-not (Test-Path -LiteralPath $cliPath)) { throw "Paperclip CLI entrypoint not found: $cliPath" }

Set-Location -LiteralPath $RepositoryPath
Write-SupervisorLog "supervisor started; instance=$InstanceId health=$HealthUrl"

while ($true) {
  $arguments = @($tsxPath, $cliPath, "run", "--instance", $InstanceId)
  $attemptStamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
  $stdoutPath = Join-Path $ProcessLogDirectory "paperclip-$attemptStamp.log"
  $stderrPath = Join-Path $ProcessLogDirectory "paperclip-$attemptStamp.err.log"
  $process = Start-Process -FilePath $nodePath -ArgumentList $arguments -WorkingDirectory $RepositoryPath -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
  Write-SupervisorLog "Paperclip started pid=$($process.Id) stdout=$stdoutPath stderr=$stderrPath"

  $startupDeadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  while (-not $process.HasExited -and (Get-Date) -lt $startupDeadline) {
    if (Test-PaperclipHealth) { break }
    Start-Sleep -Seconds 2
    $process.Refresh()
  }

  if ($process.HasExited) {
    Write-SupervisorLog "Paperclip exited during startup code=$($process.ExitCode); retrying in ${RestartDelaySeconds}s"
    Start-Sleep -Seconds $RestartDelaySeconds
    continue
  }

  if (-not (Test-PaperclipHealth)) {
    Write-SupervisorLog "startup health deadline exceeded; terminating pid=$($process.Id) tree"
    Stop-ProcessTree -ProcessId $process.Id
    Start-Sleep -Seconds $RestartDelaySeconds
    continue
  }

  Write-SupervisorLog "Paperclip healthy pid=$($process.Id)"
  $consecutiveFailures = 0
  while (-not $process.HasExited) {
    Start-Sleep -Seconds $HealthIntervalSeconds
    $process.Refresh()
    if ($process.HasExited) { break }
    if (Test-PaperclipHealth) {
      $consecutiveFailures = 0
    } else {
      $consecutiveFailures++
      Write-SupervisorLog "health failure $consecutiveFailures/$UnhealthyThreshold pid=$($process.Id)"
      if ($consecutiveFailures -ge $UnhealthyThreshold) {
        Write-SupervisorLog "health threshold exceeded; terminating pid=$($process.Id) tree"
        Stop-ProcessTree -ProcessId $process.Id
        break
      }
    }
  }

  if ($process.HasExited) { Write-SupervisorLog "Paperclip exited code=$($process.ExitCode)" }
  Start-Sleep -Seconds $RestartDelaySeconds
}
