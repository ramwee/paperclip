param(
  [string]$PaperclipRepo = "",
  [string]$PaperclipApi = "http://127.0.0.1:3100",
  [string]$ExpectedBranch = "examples/pixel-strip-and-vault-read-bridge-clean",
  [string]$BaseSha = "def9c581b48a1fea845bb7b4a8726e201a3ad5d2",
  [string]$ForwardPortBranch = "fix/hdo-windows-dashboard-telegram-forward-port",
  [string]$ScheduledTaskName = "HuiDots Paperclip",
  [int]$ReadyTimeoutSec = 180
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Fail([string]$Message) {
  Write-Host "HDO_OWNER_APPLY=FAIL"
  Write-Host $Message
  exit 1
}

function Invoke-Native {
  param(
    [string]$File,
    [string[]]$Arguments,
    [string]$FailPrefix
  )
  $output = & $File @Arguments 2>&1
  $code = $LASTEXITCODE
  $text = @($output | ForEach-Object { "$_" }) -join "`n"
  if ($code -ne 0) {
    throw "$FailPrefix (exit $code): $text"
  }
  return $text
}

function Resolve-RepoRoot {
  param([string]$Requested)

  $candidates = @()
  if (-not [string]::IsNullOrWhiteSpace($Requested)) { $candidates += $Requested }
  $candidates += (Get-Location).Path
  $candidates += "C:\Users\admin\Documents\Paperclip"

  foreach ($candidate in $candidates) {
    if (
      (Test-Path (Join-Path $candidate "package.json")) -and
      (Test-Path (Join-Path $candidate ".git")) -and
      (Test-Path (Join-Path $candidate "pnpm-workspace.yaml"))
    ) {
      return (Resolve-Path $candidate).Path
    }
  }

  throw "Repo path is not a Paperclip checkout (need package.json, .git, pnpm-workspace.yaml)."
}

function Get-GitText {
  param([string]$Repo, [string[]]$GitArgs)
  return (Invoke-Native -File "git" -Arguments (@("-C", $Repo) + $GitArgs) -FailPrefix "git $($GitArgs -join ' ') failed").Trim()
}

function Test-GitAncestor {
  param([string]$Repo, [string]$Ancestor, [string]$Descendant)
  git -C $Repo merge-base --is-ancestor $Ancestor $Descendant
  return ($LASTEXITCODE -eq 0)
}

function Get-NodeVersion {
  $raw = (Invoke-Native -File "node" -Arguments @("-v") -FailPrefix "node is not available").Trim().TrimStart("v")
  $parts = $raw.Split(".")
  if ($parts.Count -lt 2) { throw "Cannot parse Node version '$raw'" }
  return [pscustomobject]@{
    Raw = $raw
    Major = [int]$parts[0]
    Minor = [int]$parts[1]
  }
}

function Wait-BackendReady {
  param([string]$ApiBase, [int]$TimeoutSec)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $healthUrl = "$($ApiBase.TrimEnd('/'))/api/health"
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -eq 200) { return }
    } catch {
      Start-Sleep -Seconds 5
      continue
    }
    Start-Sleep -Seconds 5
  }
  throw "Backend was not ready at $healthUrl within ${TimeoutSec}s."
}

function Restart-HuiDotsTask {
  param([string]$TaskName)
  $query = schtasks.exe /Query /TN $TaskName /FO LIST
  if ($LASTEXITCODE -ne 0) {
    throw "Scheduled task '$TaskName' was not found. This script will not create or reconfigure it."
  }
  schtasks.exe /End /TN $TaskName | Out-Null
  Start-Sleep -Seconds 3
  $run = schtasks.exe /Run /TN $TaskName
  if ($LASTEXITCODE -ne 0) {
    throw "Could not start scheduled task '$TaskName': $run"
  }
}

function Clear-ViteOptimizedDeps {
  param([string]$Repo)
  $paths = @(
    (Join-Path $Repo "node_modules\.vite"),
    (Join-Path $Repo "ui\node_modules\.vite"),
    (Join-Path $Repo "ui\node_modules\.cache\vite")
  )
  foreach ($path in $paths) {
    if (Test-Path $path) {
      Remove-Item -LiteralPath $path -Recurse -Force
    }
  }
}

function Assert-Zod4Runtime {
  param([string]$Repo)
  $script = @'
const fs = require("node:fs");
const path = require("node:path");
const repo = process.argv[1];
const shared = JSON.parse(fs.readFileSync(path.join(repo, "packages/shared/package.json"), "utf8"));
if (shared.dependencies?.zod !== "^4.4.3") {
  console.error("shared zod specifier is " + shared.dependencies?.zod + ", expected ^4.4.3");
  process.exit(2);
}
const candidates = [
  path.join(repo, "packages/shared/node_modules/zod/package.json"),
  path.join(repo, "node_modules/zod/package.json"),
];
let resolved = null;
for (const candidate of candidates) {
  if (fs.existsSync(candidate)) {
    resolved = JSON.parse(fs.readFileSync(candidate, "utf8"));
    break;
  }
}
if (!resolved || !String(resolved.version).startsWith("4.")) {
  console.error("resolved zod is " + (resolved?.version ?? "missing") + ", expected 4.x");
  process.exit(3);
}
console.log("ZOD_RUNTIME=" + resolved.version);
'@
  $result = & node -e $script $Repo
  if ($LASTEXITCODE -ne 0) {
    throw "Zod 4 runtime check failed: $result"
  }
  Write-Host $result
}

function Invoke-OverlayScript {
  param([string]$Repo, [string]$Name, [string]$ApiBase)
  $path = Join-Path $Repo "patches\telegram-owner-decision\$Name"
  if (-not (Test-Path $path)) {
    throw "Missing overlay script $path after fast-forward."
  }
  $overlayOutput = & $path -PaperclipRepo $Repo -PaperclipApi $ApiBase 2>&1
  $code = $LASTEXITCODE
  $text = @($overlayOutput | ForEach-Object { "$_" }) -join "`n"
  if ($code -ne 0) {
    throw "$Name failed with exit $code: $text"
  }
  foreach ($line in @($overlayOutput)) {
    $asText = "$line"
    if ($asText -like "NEXT_ACTION=*") { continue }
    Write-Host $asText
  }
}

try {
  $repo = Resolve-RepoRoot -Requested $PaperclipRepo
  Set-Location $repo
  Write-Host "REPO=$repo"

  $branch = Get-GitText -Repo $repo -GitArgs @("branch", "--show-current")
  if ($branch -ne $ExpectedBranch) {
    throw "Current branch is '$branch'; expected '$ExpectedBranch'. The orchestrator will not switch branches."
  }

  $porcelain = Get-GitText -Repo $repo -GitArgs @("status", "--porcelain")
  if (-not [string]::IsNullOrWhiteSpace($porcelain)) {
    throw "Worktree is not clean. Commit, stash, or restore local changes, then re-run this one command."
  }

  $node = Get-NodeVersion
  if ($node.Major -lt 24 -or ($node.Major -eq 24 -and $node.Minor -lt 11)) {
    throw "Node $($node.Raw) is below the repository policy (>=24.11.0)."
  }

  $null = Get-Command pnpm -ErrorAction Stop
  $null = Get-Command git -ErrorAction Stop

  $taskQuery = schtasks.exe /Query /TN $ScheduledTaskName /FO LIST
  if ($LASTEXITCODE -ne 0) {
    throw "Scheduled task '$ScheduledTaskName' does not exist. This script will not create or alter task configuration."
  }

  Get-GitText -Repo $repo -GitArgs @("cat-file", "-e", "$BaseSha^{commit}") | Out-Null
  if (-not (Test-GitAncestor -Repo $repo -Ancestor $BaseSha -Descendant "HEAD")) {
    throw "HEAD is not a descendant of $BaseSha. Fast-forward is refused."
  }

  Write-Host "PREFLIGHT=PASS branch=$branch node=$($node.Raw) task=$ScheduledTaskName"

  Get-GitText -Repo $repo -GitArgs @("fetch", "origin", $ForwardPortBranch) | Out-Null
  $remoteHead = Get-GitText -Repo $repo -GitArgs @("rev-parse", "origin/$ForwardPortBranch")
  $localHead = Get-GitText -Repo $repo -GitArgs @("rev-parse", "HEAD")

  if (-not (Test-GitAncestor -Repo $repo -Ancestor $BaseSha -Descendant $remoteHead)) {
    throw "origin/$ForwardPortBranch ($remoteHead) is not a descendant of $BaseSha."
  }
  if ($localHead -eq $remoteHead) {
    Write-Host "FAST_FORWARD=SKIPPED already-at $remoteHead"
  } else {
    if (-not (Test-GitAncestor -Repo $repo -Ancestor $localHead -Descendant $remoteHead)) {
      throw "HEAD ($localHead) is not a clean ancestor of origin/$ForwardPortBranch ($remoteHead). No reset, force, checkout, or conflict resolution will be attempted."
    }
    Get-GitText -Repo $repo -GitArgs @("merge", "--ff-only", $remoteHead) | Out-Null
    $after = Get-GitText -Repo $repo -GitArgs @("rev-parse", "HEAD")
    $stillOn = Get-GitText -Repo $repo -GitArgs @("branch", "--show-current")
    if ($stillOn -ne $ExpectedBranch) {
      throw "Branch unexpectedly became '$stillOn' after fast-forward."
    }
    if ($after -ne $remoteHead) {
      throw "Fast-forward did not land on $remoteHead."
    }
    Write-Host "FAST_FORWARD=PASS $localHead -> $after"
  }

  Write-Host "DEPS=repairing lockfile via repo policy (no-frozen-lockfile resolution, then install)"
  Invoke-Native -File "pnpm" -Arguments @("install", "--resolution-only", "--ignore-scripts", "--no-frozen-lockfile") -FailPrefix "pnpm lockfile resolution failed" | Out-Null
  Invoke-Native -File "pnpm" -Arguments @("install", "--frozen-lockfile") -FailPrefix "pnpm install failed" | Out-Null
  Assert-Zod4Runtime -Repo $repo
  Clear-ViteOptimizedDeps -Repo $repo
  Write-Host "DEPS=PASS zod4 vite-cache-cleared"

  $pixel = Join-Path $repo "packages\plugins\examples\plugin-pixel-strip-example\package.json"
  $vault = Join-Path $repo "packages\plugins\examples\plugin-vault-read-bridge-example\package.json"
  if (-not (Test-Path $pixel) -or -not (Test-Path $vault)) {
    throw "Pixel Strip or Vault Read Bridge example package is missing after fast-forward."
  }

  Write-Host "OVERLAY=apply-installed (authenticated paperclipai path; tokens are not printed)"
  Invoke-OverlayScript -Repo $repo -Name "apply-installed.ps1" -ApiBase $PaperclipApi

  Write-Host "RESTART=$ScheduledTaskName"
  Restart-HuiDotsTask -TaskName $ScheduledTaskName
  Wait-BackendReady -ApiBase $PaperclipApi -TimeoutSec $ReadyTimeoutSec
  Write-Host "BACKEND=PASS"

  Write-Host "OVERLAY=re-apply readiness against the restarted process"
  Invoke-OverlayScript -Repo $repo -Name "apply-installed.ps1" -ApiBase $PaperclipApi
  Invoke-OverlayScript -Repo $repo -Name "verify.ps1" -ApiBase $PaperclipApi

  $smoke = Join-Path $repo "patches\hdo-owner-dashboard-smoke.mjs"
  if (-not (Test-Path $smoke)) {
    throw "Dashboard smoke helper is missing: $smoke"
  }
  $env:PAPERCLIP_REPO = $repo
  $env:PAPERCLIP_API = $PaperclipApi.TrimEnd("/")
  Invoke-Native -File "node" -Arguments @($smoke) -FailPrefix "Dashboard Playwright smoke failed" | Write-Host

  foreach ($filter in @(
      "@paperclipai/plugin-pixel-strip-example",
      "@paperclipai/plugin-vault-read-bridge-example"
    )) {
    Invoke-Native -File "pnpm" -Arguments @("--filter", $filter, "typecheck") -FailPrefix "$filter typecheck failed" | Out-Null
    Invoke-Native -File "pnpm" -Arguments @("--filter", $filter, "test") -FailPrefix "$filter tests failed" | Out-Null
    Invoke-Native -File "pnpm" -Arguments @("--filter", $filter, "build") -FailPrefix "$filter build failed" | Out-Null
  }
  Write-Host "EXAMPLES=PASS pixel-strip vault-read-bridge"

  Write-Host "HDO_OWNER_APPLY=PASS"
  Write-Host "OWNER_ACCEPTANCE=Send one genuine Telegram Approve or Revise on a pending Owner decision. This script does not fabricate that callback."
} catch {
  Write-Fail $_.Exception.Message
}
