[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$RepositoryPath = "C:\Users\admin\Documents\Paperclip",
  [string]$PaperclipHome = "C:\Users\admin\.paperclip",
  [string]$CloudflaredPath = "C:\Users\admin\AppData\Local\HuiDots\cloudflared\cloudflared.exe",
  [string]$CloudflaredConfig = "C:\Users\admin\.cloudflared\owner-console-config.yml",
  [switch]$KeepAcSleepEnabled
)

$ErrorActionPreference = "Stop"
$paperclipScript = Join-Path $RepositoryPath "windows\Start-HuiDotsPaperclip.ps1"
$verificationScript = Join-Path $RepositoryPath "windows\Test-HuiDotsUnattended.ps1"
foreach ($path in @($paperclipScript, $verificationScript, $CloudflaredPath, $CloudflaredConfig)) {
  if (-not (Test-Path -LiteralPath $path)) { throw "Required path not found: $path" }
}

$serviceAccount = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$bootTrigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew

$paperclipAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$paperclipScript`" -RepositoryPath `"$RepositoryPath`" -PaperclipHome `"$PaperclipHome`""
$cloudflareAction = New-ScheduledTaskAction -Execute $CloudflaredPath -Argument "--config `"$CloudflaredConfig`" tunnel run"

$definitions = @(
  @{ Name = "HuiDots-Paperclip-Unattended"; Description = "Boot-time Paperclip supervisor with API health recovery"; Action = $paperclipAction },
  @{ Name = "HuiDots-Cloudflare-Unattended"; Description = "Boot-time supervised Cloudflare Tunnel for dashboard.huidots.com"; Action = $cloudflareAction }
)

foreach ($definition in $definitions) {
  if ($PSCmdlet.ShouldProcess($definition.Name, "register boot-time SYSTEM scheduled task")) {
    Register-ScheduledTask -TaskName $definition.Name -Description $definition.Description -Action $definition.Action -Trigger $bootTrigger -Principal $serviceAccount -Settings $settings -Force -ErrorAction Stop | Out-Null
  }
}

foreach ($legacyName in @("HuiDots Paperclip", "HuiDots-Paperclip-Recover", "Paperclip-Patched", "HuiDots-Cloudflare", "HuiDots Cloudflare Tunnel V0")) {
  $legacyTask = Get-ScheduledTask -TaskName $legacyName -ErrorAction SilentlyContinue
  if ($legacyTask -and $PSCmdlet.ShouldProcess($legacyName, "disable conflicting legacy scheduled task")) {
    Disable-ScheduledTask -TaskName $legacyName -ErrorAction Stop | Out-Null
  }
}

if (-not $KeepAcSleepEnabled -and $PSCmdlet.ShouldProcess("active power scheme", "disable sleep while connected to AC power")) {
  & "$env:SystemRoot\System32\powercfg.exe" /change standby-timeout-ac 0
  if ($LASTEXITCODE -ne 0) { throw "Failed to disable AC sleep (powercfg exit $LASTEXITCODE)" }
}

# The legacy VBS launcher detached cloudflared from Task Scheduler. Stop only
# that executable before the new supervised task starts, avoiding two tunnel
# connectors with different lifecycle owners.
$legacyCloudflared = Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue
if ($legacyCloudflared -and $PSCmdlet.ShouldProcess("cloudflared", "stop legacy detached process")) {
  $legacyCloudflared | Stop-Process -Force -ErrorAction Stop
  $legacyCloudflared | Wait-Process -Timeout 15 -ErrorAction SilentlyContinue
}

if ($PSCmdlet.ShouldProcess("HuiDots-Paperclip-Unattended", "start")) { Start-ScheduledTask -TaskName "HuiDots-Paperclip-Unattended" -ErrorAction Stop }
if ($PSCmdlet.ShouldProcess("HuiDots-Cloudflare-Unattended", "start")) { Start-ScheduledTask -TaskName "HuiDots-Cloudflare-Unattended" -ErrorAction Stop }

Write-Output "Installed boot-time unattended HuiDots tasks."
if (-not $WhatIfPreference) {
  & $verificationScript
}
