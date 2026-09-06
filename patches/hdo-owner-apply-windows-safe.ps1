param(
  [string]$PaperclipRepo = "C:\Users\admin\Documents\Paperclip",
  [string]$PaperclipApi = "http://127.0.0.1:3100"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repo = (Resolve-Path -LiteralPath $PaperclipRepo).Path
$orchestratorPath = Join-Path $repo "patches\hdo-owner-apply-and-verify.ps1"
if (-not (Test-Path -LiteralPath $orchestratorPath)) {
  throw "HDO_ORCHESTRATOR_NOT_FOUND: $orchestratorPath"
}

$source = [IO.File]::ReadAllText($orchestratorPath)
$pattern = '(?ms)^  \$output = & \$File @Arguments 2>&1\r?\n  \$code = \$LASTEXITCODE$'
$matches = [regex]::Matches($source, $pattern)
if ($matches.Count -ne 1) {
  throw "HDO_NATIVE_STDERR_PATCH_MISMATCH: expected exactly one Invoke-Native capture block, found $($matches.Count)"
}

$replacement = @'
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = & $File @Arguments 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
'@

$patched = [regex]::Replace($source, $pattern, $replacement, 1)
$scriptBlock = [ScriptBlock]::Create($patched)

$previousNodeNoWarnings = $env:NODE_NO_WARNINGS
$env:NODE_NO_WARNINGS = "1"
try {
  & $scriptBlock -PaperclipRepo $repo -PaperclipApi $PaperclipApi
  $exitCode = $LASTEXITCODE
} finally {
  $env:NODE_NO_WARNINGS = $previousNodeNoWarnings
}

exit $exitCode
