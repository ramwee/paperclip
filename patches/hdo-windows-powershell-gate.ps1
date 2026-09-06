param(
  [string]$PaperclipRepo = "",
  [switch]$SkipHarness
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Resolve-GateRepo {
  if (-not [string]::IsNullOrWhiteSpace($PaperclipRepo) -and (Test-Path -LiteralPath $PaperclipRepo)) {
    return (Resolve-Path $PaperclipRepo).Path
  }
  if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
    return (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
  }
  return (Get-Location).Path
}

function Test-PowerShellParseFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    throw ("PARSE_MISSING {0}" -f $Path)
  }
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
  if ($null -ne $errors -and $errors.Count -gt 0) {
    $text = @($errors | ForEach-Object { $_.ToString() }) -join "`n"
    throw ("PARSE_ERROR {0}: {1}" -f $Path, $text)
  }
}

$repo = Resolve-GateRepo
$targets = @(
  [IO.Path]::Combine($repo, "patches", "hdo-owner-apply-and-verify.ps1"),
  [IO.Path]::Combine($repo, "patches", "telegram-owner-decision", "apply-installed.ps1"),
  [IO.Path]::Combine($repo, "patches", "telegram-owner-decision", "verify.ps1"),
  [IO.Path]::Combine($repo, "patches", "hdo-owner-apply-windows-safe.ps1"),
  [IO.Path]::Combine($repo, "patches", "hdo-windows-powershell-gate.ps1")
)

Write-Host ("HDO_WINDOWS_PS_HOST={0} {1}" -f $PSVersionTable.PSVersion, $PSVersionTable.PSEdition)
foreach ($target in $targets) {
  Test-PowerShellParseFile -Path $target
  Write-Host ("HDO_WINDOWS_PARSE=PASS {0}" -f $target)
}

if (-not $SkipHarness) {
  $orchestrator = $targets[0]
  & $orchestrator -PaperclipRepo $repo -WindowsHarness
  if ($LASTEXITCODE -ne 0) {
    throw ("HARNESS_FAILED exit {0}" -f $LASTEXITCODE)
  }
}

Write-Host "HDO_WINDOWS_POWERSHELL_GATE=PASS"
