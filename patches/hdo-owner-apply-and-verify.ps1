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

$script:Checks = New-Object System.Collections.Generic.List[object]
$script:UnsafeStop = $false

function Add-Check {
  param(
    [string]$Name,
    [ValidateSet("PASS", "FAIL", "NOT-VERIFIABLE-LOCALLY")]
    [string]$Status,
    [string]$Detail = "",
    [switch]$DesignedSkip
  )
  $script:Checks.Add([pscustomobject]@{
    Name = $Name
    Status = $Status
    Detail = $Detail
    DesignedSkip = [bool]$DesignedSkip
  })
}

function Add-ImportedChecks {
  param([object[]]$Imported)
  foreach ($item in @($Imported)) {
    if ($null -eq $item) { continue }
    Add-Check -Name ([string]$item.name) -Status ([string]$item.status) -Detail ([string]$item.detail)
  }
}

function Write-SweepReport {
  param([int]$ExitCode = -1)
  $fails = @($script:Checks | Where-Object { $_.Status -eq "FAIL" } | ForEach-Object { $_.Name })
  $unverifiable = @(
    $script:Checks |
      Where-Object { $_.Status -eq "NOT-VERIFIABLE-LOCALLY" -and -not $_.DesignedSkip } |
      ForEach-Object { $_.Name }
  )
  $overall = "PASS"
  if ($fails.Count -gt 0) { $overall = "FAIL" }
  elseif ($unverifiable.Count -gt 0) { $overall = "NOT-VERIFIABLE-LOCALLY" }

  Write-Host "===== HDO ACCEPTANCE SWEEP ====="
  foreach ($check in $script:Checks) {
    $line = "{0,-34} {1}" -f $check.Name, $check.Status
    if (-not [string]::IsNullOrWhiteSpace($check.Detail)) {
      $line = "$line  $($check.Detail)"
    }
    Write-Host $line
  }
  Write-Host "--------------------------------"
  Write-Host "HDO_OWNER_APPLY=$overall"
  if ($fails.Count -gt 0) { Write-Host ("FAIL: " + ($fails -join ", ")) }
  if ($unverifiable.Count -gt 0) { Write-Host ("NOT-VERIFIABLE-LOCALLY: " + ($unverifiable -join ", ")) }
  $designed = @($script:Checks | Where-Object { $_.DesignedSkip } | ForEach-Object { $_.Name })
  if ($designed.Count -gt 0) {
    Write-Host ("DESIGNED_SKIP: " + ($designed -join ", "))
  }
  Write-Host "OWNER_ACCEPTANCE=Send one genuine Telegram Approve or Revise on a pending Owner decision. This script does not fabricate that callback."
  Write-Host "====="
  if ($ExitCode -ge 0) {
    exit $ExitCode
  }
  if ($overall -eq "FAIL") { exit 1 }
  if ($overall -eq "NOT-VERIFIABLE-LOCALLY") { exit 2 }
  exit 0
}

function Stop-Unsafe {
  param([string]$Name, [string]$Detail)
  $script:UnsafeStop = $true
  Add-Check -Name $Name -Status "FAIL" -Detail $Detail
  Write-SweepReport -ExitCode 1
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

function Test-FileContains {
  param([string]$Path, [string]$Needle)
  if (-not (Test-Path $Path)) { return $false }
  return [IO.File]::ReadAllText($Path).Contains($Needle)
}

function Wait-BackendReady {
  param([string]$ApiBase, [int]$TimeoutSec)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $healthUrl = "$($ApiBase.TrimEnd('/'))/api/health"
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -eq 200) { return $true }
    } catch {
      Start-Sleep -Seconds 5
      continue
    }
    Start-Sleep -Seconds 5
  }
  return $false
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
  return "$result"
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
  return $text
}

function Get-ExamplePolicyStatus {
  param([string]$ManifestPath, [string]$Label)
  if (-not (Test-Path $ManifestPath)) {
    return [pscustomobject]@{ Ok = $false; Detail = "$Label package.json missing" }
  }
  $pkg = Get-Content $ManifestPath -Raw | ConvertFrom-Json
  $types = $null
  if ($pkg.devDependencies) { $types = $pkg.devDependencies.'@types/node' }
  $engine = $null
  if ($pkg.engines) { $engine = $pkg.engines.node }
  if ($types -ne "^24.0.0" -or $engine -ne ">=24.11.0") {
    return [pscustomobject]@{
      Ok = $false
      Detail = "$Label @types/node=$types engines.node=$engine"
    }
  }
  return [pscustomobject]@{ Ok = $true; Detail = "$Label Node policy aligned" }
}

function Save-LockfileBytes {
  param([string]$Path)
  if (-not (Test-Path $Path)) {
    throw "pnpm-lock.yaml is missing at $Path"
  }
  return [IO.File]::ReadAllBytes($Path)
}

function Restore-LockfileBytes {
  param([string]$Path, [byte[]]$Bytes)
  if ($null -eq $Bytes) {
    throw "no preserved pnpm-lock.yaml bytes to restore"
  }
  [IO.File]::WriteAllBytes($Path, $Bytes)
  $restored = [IO.File]::ReadAllBytes($Path)
  if ($restored.Length -ne $Bytes.Length) {
    throw "restored pnpm-lock.yaml length $($restored.Length) does not match preserved $($Bytes.Length)"
  }
  for ($i = 0; $i -lt $Bytes.Length; $i++) {
    if ($restored[$i] -ne $Bytes[$i]) {
      throw "restored pnpm-lock.yaml bytes differ at offset $i"
    }
  }
}

function Invoke-ExampleSurface {
  param([string]$Filter, [string]$NamePrefix, [string]$ManifestPath)
  $policy = Get-ExamplePolicyStatus -ManifestPath $ManifestPath -Label $Filter
  if ($policy.Ok) {
    Add-Check -Name "$NamePrefix.presence_policy" -Status "PASS" -Detail $policy.Detail
  } else {
    Add-Check -Name "$NamePrefix.presence_policy" -Status "FAIL" -Detail $policy.Detail
  }
  foreach ($scriptName in @("typecheck", "test", "build")) {
    $checkName = "$NamePrefix.$scriptName"
    try {
      Invoke-Native -File "pnpm" -Arguments @("--filter", $Filter, $scriptName) -FailPrefix "$Filter $scriptName failed" | Out-Null
      Add-Check -Name $checkName -Status "PASS"
    } catch {
      Add-Check -Name $checkName -Status "FAIL" -Detail $_.Exception.Message
    }
  }
}

try {
  $repo = Resolve-RepoRoot -Requested $PaperclipRepo
  Set-Location $repo
  Add-Check -Name "repo.identity" -Status "PASS" -Detail $repo
} catch {
  Stop-Unsafe -Name "repo.identity" -Detail $_.Exception.Message
}

try { $null = Get-Command git -ErrorAction Stop } catch { Stop-Unsafe -Name "tooling.git" -Detail "git is required" }
try { $null = Get-Command node -ErrorAction Stop } catch { Stop-Unsafe -Name "tooling.node" -Detail "node is required" }
try { $null = Get-Command pnpm -ErrorAction Stop } catch { Stop-Unsafe -Name "tooling.pnpm" -Detail "pnpm is required" }
Add-Check -Name "tooling.git_node_pnpm" -Status "PASS"

$branch = ""
try {
  $branch = Get-GitText -Repo $repo -GitArgs @("branch", "--show-current")
  if ($branch -ne $ExpectedBranch) {
    Stop-Unsafe -Name "repo.branch" -Detail "Current branch is '$branch'; expected '$ExpectedBranch'. The orchestrator will not switch branches."
  }
  Add-Check -Name "repo.branch" -Status "PASS" -Detail $branch
} catch {
  if ($script:UnsafeStop) { throw }
  Stop-Unsafe -Name "repo.branch" -Detail $_.Exception.Message
}

try {
  $porcelain = Get-GitText -Repo $repo -GitArgs @("status", "--porcelain")
  if (-not [string]::IsNullOrWhiteSpace($porcelain)) {
    Stop-Unsafe -Name "repo.worktree" -Detail "Worktree is not clean. Commit, stash, or restore local changes, then re-run this one command."
  }
  Add-Check -Name "repo.worktree" -Status "PASS"
} catch {
  if ($script:UnsafeStop) { throw }
  Stop-Unsafe -Name "repo.worktree" -Detail $_.Exception.Message
}

$taskQuery = schtasks.exe /Query /TN $ScheduledTaskName /FO LIST
if ($LASTEXITCODE -ne 0) {
  Stop-Unsafe -Name "task.huidots_paperclip" -Detail "Scheduled task '$ScheduledTaskName' does not exist. This script will not create or alter task configuration."
}
if ($taskQuery -match "/Change|TR: /Create") {
  Add-Check -Name "task.huidots_paperclip" -Status "FAIL" -Detail "task query unexpectedly looks like a reconfiguration command"
} else {
  Add-Check -Name "task.huidots_paperclip" -Status "PASS" -Detail "present; configuration will not be changed"
}

try {
  Get-GitText -Repo $repo -GitArgs @("cat-file", "-e", "$BaseSha^{commit}") | Out-Null
  if (-not (Test-GitAncestor -Repo $repo -Ancestor $BaseSha -Descendant "HEAD")) {
    Stop-Unsafe -Name "repo.ancestry" -Detail "HEAD is not a descendant of $BaseSha. Fast-forward is refused."
  }
  $localHead = Get-GitText -Repo $repo -GitArgs @("rev-parse", "HEAD")
  Add-Check -Name "repo.ancestry" -Status "PASS" -Detail "HEAD=$localHead descendant-of $BaseSha"
} catch {
  if ($script:UnsafeStop) { throw }
  Stop-Unsafe -Name "repo.ancestry" -Detail $_.Exception.Message
}

try {
  $node = Get-NodeVersion
  if ($node.Major -lt 24 -or ($node.Major -eq 24 -and $node.Minor -lt 11)) {
    Add-Check -Name "tooling.node_policy" -Status "FAIL" -Detail "Node $($node.Raw) is below >=24.11.0"
  } else {
    Add-Check -Name "tooling.node_policy" -Status "PASS" -Detail $node.Raw
  }
} catch {
  Add-Check -Name "tooling.node_policy" -Status "FAIL" -Detail $_.Exception.Message
}

try {
  Get-GitText -Repo $repo -GitArgs @("fetch", "origin", $ForwardPortBranch) | Out-Null
  $remoteHead = Get-GitText -Repo $repo -GitArgs @("rev-parse", "origin/$ForwardPortBranch")
  $localHead = Get-GitText -Repo $repo -GitArgs @("rev-parse", "HEAD")
  if (-not (Test-GitAncestor -Repo $repo -Ancestor $BaseSha -Descendant $remoteHead)) {
    Stop-Unsafe -Name "repo.fast_forward" -Detail "origin/$ForwardPortBranch ($remoteHead) is not a descendant of $BaseSha."
  }
  if ($localHead -eq $remoteHead) {
    Add-Check -Name "repo.fast_forward" -Status "PASS" -Detail "already-at $remoteHead"
  } else {
    if (-not (Test-GitAncestor -Repo $repo -Ancestor $localHead -Descendant $remoteHead)) {
      Stop-Unsafe -Name "repo.fast_forward" -Detail "HEAD ($localHead) is not a clean ancestor of origin/$ForwardPortBranch ($remoteHead). No reset, force, checkout, or conflict resolution will be attempted."
    }
    Get-GitText -Repo $repo -GitArgs @("merge", "--ff-only", $remoteHead) | Out-Null
    $after = Get-GitText -Repo $repo -GitArgs @("rev-parse", "HEAD")
    $stillOn = Get-GitText -Repo $repo -GitArgs @("branch", "--show-current")
    if ($stillOn -ne $ExpectedBranch -or $after -ne $remoteHead) {
      Stop-Unsafe -Name "repo.fast_forward" -Detail "Fast-forward landed on branch=$stillOn head=$after"
    }
    Add-Check -Name "repo.fast_forward" -Status "PASS" -Detail "$localHead -> $after"
  }
} catch {
  if ($script:UnsafeStop) { throw }
  Stop-Unsafe -Name "repo.fast_forward" -Detail $_.Exception.Message
}

$lockPath = Join-Path $repo "pnpm-lock.yaml"
$lockBackup = $null
try {
  $lockBackup = Save-LockfileBytes -Path $lockPath
  Add-Check -Name "deps.lockfile_preserved" -Status "PASS" -Detail "exact pre-resolution pnpm-lock.yaml bytes captured"
} catch {
  Add-Check -Name "deps.lockfile_preserved" -Status "FAIL" -Detail $_.Exception.Message
}

try {
  try {
    Invoke-Native -File "pnpm" -Arguments @("install", "--resolution-only", "--ignore-scripts", "--no-frozen-lockfile") -FailPrefix "pnpm lockfile resolution failed" | Out-Null
    Invoke-Native -File "pnpm" -Arguments @("install", "--frozen-lockfile") -FailPrefix "pnpm install failed" | Out-Null
    Add-Check -Name "deps.lockfile_graph" -Status "PASS"
  } catch {
    Add-Check -Name "deps.lockfile_graph" -Status "FAIL" -Detail $_.Exception.Message
  }

try {
  $zod = Assert-Zod4Runtime -Repo $repo
  Add-Check -Name "deps.zod4" -Status "PASS" -Detail $zod
} catch {
  Add-Check -Name "deps.zod4" -Status "FAIL" -Detail $_.Exception.Message
}

try {
  Clear-ViteOptimizedDeps -Repo $repo
  $stale = @(
    (Join-Path $repo "node_modules\.vite"),
    (Join-Path $repo "ui\node_modules\.vite")
  ) | Where-Object { Test-Path $_ }
  if ($stale.Count -gt 0) {
    Add-Check -Name "deps.vite_cache" -Status "FAIL" -Detail ($stale -join ", ")
  } else {
    Add-Check -Name "deps.vite_cache" -Status "PASS" -Detail "optimized deps cache removed"
  }
} catch {
  Add-Check -Name "deps.vite_cache" -Status "FAIL" -Detail $_.Exception.Message
}

try {
  Invoke-Native -File "pnpm" -Arguments @("check:node-version") -FailPrefix "node version policy failed" | Out-Null
  Add-Check -Name "deps.node_version_policy" -Status "PASS"
} catch {
  Add-Check -Name "deps.node_version_policy" -Status "FAIL" -Detail $_.Exception.Message
}

$esmUrl = Join-Path $repo "server\src\services\plugin-esm-url.ts"
$esmLoader = Join-Path $repo "server\src\services\plugin-loader.ts"
if (
  (Test-FileContains $esmUrl "toNodeEsmImportUrl") -and
  (Test-FileContains $esmUrl "pathToFileURL") -and
  (Test-FileContains $esmLoader 'toNodeEsmImportUrl(DEV_TSX_LOADER_PATH)')
) {
  Add-Check -Name "plugin_loader.windows_esm_source" -Status "PASS" -Detail "file:// import helper wired"
} else {
  Add-Check -Name "plugin_loader.windows_esm_source" -Status "FAIL" -Detail "toNodeEsmImportUrl wiring missing"
}

try {
  Push-Location (Join-Path $repo "server")
  Invoke-Native -File "pnpm" -Arguments @("exec", "vitest", "run", "--config", "vitest.config.ts", "src/__tests__/plugin-loader-windows-esm.test.ts") -FailPrefix "Windows ESM vitest failed" | Out-Null
  Add-Check -Name "plugin_loader.windows_esm_tests" -Status "PASS"
} catch {
  Add-Check -Name "plugin_loader.windows_esm_tests" -Status "FAIL" -Detail $_.Exception.Message
} finally {
  Pop-Location
}

$applyPath = Join-Path $repo "patches\telegram-owner-decision\apply-installed.ps1"
$verifyPath = Join-Path $repo "patches\telegram-owner-decision\verify.ps1"
if (-not (Test-Path $applyPath) -or -not (Test-Path $verifyPath)) {
  Add-Check -Name "plugin.readiness_auth_path" -Status "FAIL" -Detail "overlay scripts missing"
} else {
  $applyText = [IO.File]::ReadAllText($applyPath)
  $naked = [regex]::IsMatch($applyText, 'Invoke-RestMethod[^\n]*/api/plugins')
  $hasCli = $applyText.Contains("Invoke-PaperclipAiJson") -and $applyText.Contains('plugin", "list"')
  if ($naked -or -not $hasCli) {
    Add-Check -Name "plugin.readiness_auth_path" -Status "FAIL" -Detail "unauthenticated /api/plugins shortcut or missing paperclipai path"
  } else {
    Add-Check -Name "plugin.readiness_auth_path" -Status "PASS" -Detail "authenticated paperclipai plugin list/enable"
  }
}

$piBuild = Join-Path $repo "packages\adapters\pi-local\src\ui\build-config.ts"
$piTimeout = Join-Path $repo "packages\adapter-utils\src\execution-target.ts"
if (
  (Test-FileContains $piBuild "ac.timeoutSec = 0") -and
  (Test-FileContains $piBuild "ac.graceSec = 20") -and
  (Test-FileContains $piTimeout "resolveAdapterExecutionTargetTimeoutSec")
) {
  Add-Check -Name "pi.timeout_reliability_source" -Status "PASS" -Detail "pi-local timeoutSec=0 + shared resolver present"
} else {
  Add-Check -Name "pi.timeout_reliability_source" -Status "FAIL" -Detail "Pi timeout/reliability source missing on this checkout"
}
Add-Check -Name "codex.live_uat" -Status "NOT-VERIFIABLE-LOCALLY" -Detail "not repeated by design" -DesignedSkip

$pixelManifest = Join-Path $repo "packages\plugins\examples\plugin-pixel-strip-example\package.json"
$vaultManifest = Join-Path $repo "packages\plugins\examples\plugin-vault-read-bridge-example\package.json"
Invoke-ExampleSurface -Filter "@paperclipai/plugin-pixel-strip-example" -NamePrefix "examples.pixel_strip" -ManifestPath $pixelManifest
Invoke-ExampleSurface -Filter "@paperclipai/plugin-vault-read-bridge-example" -NamePrefix "examples.vault_read_bridge" -ManifestPath $vaultManifest

$overlayApplied = $false
try {
  Invoke-OverlayScript -Repo $repo -Name "apply-installed.ps1" -ApiBase $PaperclipApi | Out-Null
  $overlayApplied = $true
  Add-Check -Name "telegram.overlay_apply" -Status "PASS"
} catch {
  Add-Check -Name "telegram.overlay_apply" -Status "FAIL" -Detail $_.Exception.Message
}

try {
  Restart-HuiDotsTask -TaskName $ScheduledTaskName
  Add-Check -Name "task.restart" -Status "PASS" -Detail "End+Run only; no /Change"
} catch {
  Add-Check -Name "task.restart" -Status "FAIL" -Detail $_.Exception.Message
}

$backendReady = Wait-BackendReady -ApiBase $PaperclipApi -TimeoutSec $ReadyTimeoutSec
if ($backendReady) {
  Add-Check -Name "task.backend_ready" -Status "PASS" -Detail "/api/health reached after bounded wait"
} else {
  Add-Check -Name "task.backend_ready" -Status "FAIL" -Detail "backend not ready within ${ReadyTimeoutSec}s"
}

if ($backendReady) {
  try {
    Invoke-OverlayScript -Repo $repo -Name "apply-installed.ps1" -ApiBase $PaperclipApi | Out-Null
    Add-Check -Name "telegram.registry_ready" -Status "PASS" -Detail "authenticated enable/list reported ready"
  } catch {
    Add-Check -Name "telegram.registry_ready" -Status "FAIL" -Detail $_.Exception.Message
  }
  try {
    Invoke-OverlayScript -Repo $repo -Name "verify.ps1" -ApiBase $PaperclipApi | Out-Null
    Add-Check -Name "telegram.overlay_invariants" -Status "PASS"
  } catch {
    Add-Check -Name "telegram.overlay_invariants" -Status "FAIL" -Detail $_.Exception.Message
  }
} else {
  Add-Check -Name "telegram.registry_ready" -Status "NOT-VERIFIABLE-LOCALLY" -Detail "backend not ready"
  if ($overlayApplied -and (Test-Path $verifyPath)) {
    try {
      Invoke-OverlayScript -Repo $repo -Name "verify.ps1" -ApiBase $PaperclipApi | Out-Null
      Add-Check -Name "telegram.overlay_invariants" -Status "PASS" -Detail "static overlay markers only"
    } catch {
      Add-Check -Name "telegram.overlay_invariants" -Status "FAIL" -Detail $_.Exception.Message
    }
  } else {
    Add-Check -Name "telegram.overlay_invariants" -Status "NOT-VERIFIABLE-LOCALLY" -Detail "verify.ps1 not runnable"
  }
}

$smoke = Join-Path $repo "patches\hdo-owner-dashboard-smoke.mjs"
if (-not (Test-Path $smoke)) {
  Add-Check -Name "dashboard.application" -Status "FAIL" -Detail "smoke helper missing"
  Add-Check -Name "dashboard.fatal_console" -Status "FAIL" -Detail "smoke helper missing"
  Add-Check -Name "dashboard.cloudflare_access" -Status "FAIL" -Detail "smoke helper missing"
} elseif (-not $backendReady) {
  Add-Check -Name "dashboard.application" -Status "NOT-VERIFIABLE-LOCALLY" -Detail "backend not ready"
  Add-Check -Name "dashboard.fatal_console" -Status "NOT-VERIFIABLE-LOCALLY" -Detail "backend not ready"
  Add-Check -Name "dashboard.cloudflare_access" -Status "NOT-VERIFIABLE-LOCALLY" -Detail "backend not ready"
} else {
  $env:PAPERCLIP_REPO = $repo
  $env:PAPERCLIP_API = $PaperclipApi.TrimEnd("/")
  try {
    $smokeOut = & node $smoke 2>&1
    $smokeText = @($smokeOut | ForEach-Object { "$_" }) -join "`n"
    Write-Host $smokeText
    $jsonLine = @($smokeText -split "`n" | Where-Object { $_ -like "HDO_SWEEP_JSON=*" } | Select-Object -Last 1)
    if (-not $jsonLine) {
      Add-Check -Name "dashboard.application" -Status "FAIL" -Detail "smoke produced no structured result"
      Add-Check -Name "dashboard.fatal_console" -Status "FAIL" -Detail "smoke produced no structured result"
    } else {
      $payload = ($jsonLine -replace "^HDO_SWEEP_JSON=", "") | ConvertFrom-Json
      Add-ImportedChecks -Imported @($payload.checks)
    }
  } catch {
    Add-Check -Name "dashboard.application" -Status "NOT-VERIFIABLE-LOCALLY" -Detail $_.Exception.Message
    Add-Check -Name "dashboard.fatal_console" -Status "NOT-VERIFIABLE-LOCALLY" -Detail $_.Exception.Message
    Add-Check -Name "dashboard.cloudflare_access" -Status "NOT-VERIFIABLE-LOCALLY" -Detail $_.Exception.Message
  }
}
} finally {
  if ($null -ne $lockBackup) {
    try {
      Restore-LockfileBytes -Path $lockPath -Bytes $lockBackup
      Add-Check -Name "deps.lockfile_restored" -Status "PASS" -Detail "pre-resolution pnpm-lock.yaml bytes restored"
    } catch {
      Add-Check -Name "deps.lockfile_restored" -Status "FAIL" -Detail $_.Exception.Message
    }
  } else {
    Add-Check -Name "deps.lockfile_restored" -Status "FAIL" -Detail "no preserved lockfile bytes; cannot restore"
  }
}

try {
  $finalPorcelain = Get-GitText -Repo $repo -GitArgs @("status", "--porcelain")
  if ([string]::IsNullOrWhiteSpace($finalPorcelain)) {
    Add-Check -Name "repo.worktree_final" -Status "PASS" -Detail "checkout is clean after scripted source/dependency operations"
  } else {
    Add-Check -Name "repo.worktree_final" -Status "FAIL" -Detail $finalPorcelain
  }
} catch {
  Add-Check -Name "repo.worktree_final" -Status "FAIL" -Detail $_.Exception.Message
}

Write-SweepReport
