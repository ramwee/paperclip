[CmdletBinding()]
param(
  [string]$HealthUrl = "http://127.0.0.1:3100/api/health",
  [string]$OriginUrl = "http://127.0.0.1:3100/",
  [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
$requiredTasks = @("HuiDots-Paperclip-Unattended", "HuiDots-Cloudflare-Unattended")
foreach ($name in $requiredTasks) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
  if ($task.Principal.LogonType -ne "ServiceAccount") { throw "$name is not configured for non-interactive service-account startup" }
  if (-not ($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq "MSFT_TaskBootTrigger" })) { throw "$name has no boot trigger" }
  if ($task.Settings.DisallowStartIfOnBatteries -or $task.Settings.StopIfGoingOnBatteries) { throw "$name is battery-sensitive" }
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
do {
  try {
    $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 10
    if ($health.status -eq "ok" -and $health.bootstrapStatus -eq "ready") { break }
  } catch {}
  Start-Sleep -Seconds 2
} while ((Get-Date) -lt $deadline)

if (-not $health -or $health.status -ne "ok" -or $health.bootstrapStatus -ne "ready") {
  throw "Paperclip did not become healthy within $TimeoutSeconds seconds"
}

$origin = Invoke-WebRequest -UseBasicParsing -Uri $OriginUrl -TimeoutSec 10
if ($origin.StatusCode -ne 200) { throw "Paperclip origin returned HTTP $($origin.StatusCode)" }

$cloudflared = Get-Process -Name cloudflared -ErrorAction SilentlyContinue
if (-not $cloudflared) { throw "cloudflared is not running" }

[pscustomobject]@{
  PaperclipStatus = $health.status
  BootstrapStatus = $health.bootstrapStatus
  OriginStatus = $origin.StatusCode
  CloudflaredProcessCount = @($cloudflared).Count
  VerifiedAt = (Get-Date).ToString("o")
}
