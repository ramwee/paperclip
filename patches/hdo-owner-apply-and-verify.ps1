param(
  [string]$PaperclipRepo = "",
  [string]$PaperclipApi = "http://127.0.0.1:3100",
  [string]$ExpectedBranch = "examples/pixel-strip-and-vault-read-bridge-clean",
  [string]$BaseSha = "def9c581b48a1fea845bb7b4a8726e201a3ad5d2",
  [string]$ForwardPortBranch = "fix/hdo-windows-dashboard-telegram-forward-port",
  [string]$OwnerFetchRef = "refs/hdo-owner/forward-port",
  [string]$ScheduledTaskName = "HuiDots Paperclip",
  [int]$ReadyTimeoutSec = 180,
  [switch]$WindowsHarness,
  [switch]$Synthetic
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$script:Checks = New-Object System.Collections.Generic.List[object]
$script:UnsafeStop = $false
$script:Synthetic = [bool]$Synthetic
if ($env:HDO_SYNTHETIC -eq "1") { $script:Synthetic = $true }
if ($script:Synthetic -and -not [string]::IsNullOrWhiteSpace($env:HDO_SYNTHETIC_BASE_SHA)) {
  $BaseSha = $env:HDO_SYNTHETIC_BASE_SHA.Trim()
}

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
  $fails = @(@($script:Checks | Where-Object { $_.Status -eq "FAIL" } | ForEach-Object { $_.Name }))
  $unverifiable = @(
    @($script:Checks |
      Where-Object { $_.Status -eq "NOT-VERIFIABLE-LOCALLY" -and -not $_.DesignedSkip } |
      ForEach-Object { $_.Name })
  )
  $overall = "PASS"
  if (@($fails).Count -gt 0) { $overall = "FAIL" }
  elseif (@($unverifiable).Count -gt 0) { $overall = "NOT-VERIFIABLE-LOCALLY" }

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
  if (@($fails).Count -gt 0) { Write-Host ("FAIL: " + ($fails -join ", ")) }
  if (@($unverifiable).Count -gt 0) { Write-Host ("NOT-VERIFIABLE-LOCALLY: " + ($unverifiable -join ", ")) }
  $designed = @(@($script:Checks | Where-Object { $_.DesignedSkip } | ForEach-Object { $_.Name }))
  if (@($designed).Count -gt 0) {
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
    throw ("{0} (exit {1}): {2}" -f $FailPrefix, $code, $text)
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

function Get-OwnerWorktreePorcelain {
  param([string]$Repo)
  $raw = Get-GitText -Repo $Repo -GitArgs @("status", "--porcelain", "--untracked-files=all")
  $kept = @(
    @($raw -split "`r?`n") | Where-Object {
      -not [string]::IsNullOrWhiteSpace($_) -and
      ($_ -notmatch '(^|[ /\\])((ui[/\\]dist)|(server[/\\]ui-dist))([/\\]|$)')
    }
  )
  return (@($kept) -join "`n").Trim()
}

function Test-GitAncestor {
  param([string]$Repo, [string]$Ancestor, [string]$Descendant)
  git -C $Repo merge-base --is-ancestor $Ancestor $Descendant
  return ($LASTEXITCODE -eq 0)
}

function Get-FetchedForwardPortSha {
  param([string]$Repo, [string]$Branch, [string]$FetchRef)
  # Explicit refspec into a dedicated local ref. Do not require origin/<branch>
  # to exist — a limited remote.fetch config only updates FETCH_HEAD.
  Get-GitText -Repo $Repo -GitArgs @("fetch", "origin", "${Branch}:${FetchRef}") | Out-Null
  $sha = Get-GitText -Repo $Repo -GitArgs @("rev-parse", "--verify", "${FetchRef}^{commit}")
  if ([string]::IsNullOrWhiteSpace($sha) -or $sha.Length -lt 40) {
    throw "Fetched SHA from $FetchRef is missing or not a commit."
  }
  return $sha
}

function Get-NodeVersion {
  $raw = (Invoke-Native -File "node" -Arguments @("-v") -FailPrefix "node is not available").Trim().TrimStart("v")
  $parts = $raw.Split(".")
  if (@($parts).Count -lt 2) { throw "Cannot parse Node version '$raw'" }
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

function Get-JsonProperty {
  param($Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  $prop = $Object.PSObject.Properties[$Name]
  if ($null -eq $prop) { return $null }
  return $prop.Value
}

function Assert-Zod4Runtime {
  param([string]$Repo)
  $sharedPath = [IO.Path]::Combine($Repo, "packages", "shared", "package.json")
  if (-not (Test-Path -LiteralPath $sharedPath)) {
    throw "shared package.json missing at $sharedPath"
  }
  $shared = Get-Content -LiteralPath $sharedPath -Raw | ConvertFrom-Json
  $spec = Get-JsonProperty (Get-JsonProperty $shared "dependencies") "zod"
  if ($spec -ne "^4.4.3") {
    throw "shared zod specifier is $spec, expected ^4.4.3"
  }
  $candidates = @(
    [IO.Path]::Combine($Repo, "packages", "shared", "node_modules", "zod", "package.json"),
    [IO.Path]::Combine($Repo, "node_modules", "zod", "package.json")
  )
  $resolved = $null
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      $resolved = Get-Content -LiteralPath $candidate -Raw | ConvertFrom-Json
      break
    }
  }
  $version = Get-JsonProperty $resolved "version"
  if (-not $version -or -not ([string]$version).StartsWith("4.")) {
    $shown = if ($version) { $version } else { "missing" }
    throw "resolved zod is $shown, expected 4.x"
  }
  return "ZOD_RUNTIME=$version"
}

function Invoke-OverlayScript {
  param(
    [string]$Repo,
    [string]$Name,
    [string]$ApiBase,
    [string[]]$ExtraArgs = @()
  )
  $path = [IO.Path]::Combine($Repo, "patches", "telegram-owner-decision", $Name)
  if (-not (Test-Path $path)) {
    throw "Missing overlay script $path after fast-forward."
  }
  $overlayOutput = & $path -PaperclipRepo $Repo -PaperclipApi $ApiBase @ExtraArgs 2>&1
  $code = $LASTEXITCODE
  $text = @($overlayOutput | ForEach-Object { "$_" }) -join "`n"
  if ($code -ne 0) {
    throw ("{0} failed with exit {1}: {2}" -f $Name, $code, $text)
  }
  foreach ($line in @($overlayOutput)) {
    $asText = "$line"
    if ($asText -like "NEXT_ACTION=*") { continue }
    Write-Host $asText
  }
  return $text
}

function Get-RuntimePrerequisiteFailures {
  $required = @(
    "deps.lockfile_graph",
    "deps.zod4",
    "tooling.node_policy",
    "deps.node_version_policy",
    "plugin_loader.windows_esm_source",
    "plugin_loader.windows_esm_tests",
    "plugin.readiness_auth_path",
    "examples.pixel_strip.presence_policy",
    "examples.pixel_strip.typecheck",
    "examples.pixel_strip.test",
    "examples.pixel_strip.build",
    "examples.vault_read_bridge.presence_policy",
    "examples.vault_read_bridge.typecheck",
    "examples.vault_read_bridge.test",
    "examples.vault_read_bridge.build",
    "dashboard.ui_build",
    "dashboard.ui_served_sync"
  )
  return @(
    $script:Checks |
      Where-Object { $required -contains $_.Name -and $_.Status -eq "FAIL" } |
      ForEach-Object { $_.Name }
  )
}

function Add-UntouchedRuntimeChecks {
  param([string]$Detail, [switch]$DesignedSkip)
  foreach ($name in @(
    "telegram.overlay_apply",
    "task.restart",
    "task.backend_ready",
    "telegram.registry_ready",
    "telegram.overlay_invariants",
    "dashboard.application",
    "dashboard.fatal_console",
    "dashboard.cloudflare_access"
  )) {
    Add-Check -Name $name -Status "NOT-VERIFIABLE-LOCALLY" -Detail $Detail -DesignedSkip:$DesignedSkip
  }
}

function Join-RepoPath {
  param([string]$Repo, [string[]]$Parts)
  $path = $Repo
  foreach ($part in @($Parts)) {
    $path = [IO.Path]::Combine($path, $part)
  }
  return $path
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

function Get-Sha256Hex {
  param([string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Get-UiIndexReferencedAssets {
  param([string]$IndexPath)
  $html = [IO.File]::ReadAllText($IndexPath)
  $found = New-Object System.Collections.Generic.List[string]
  $pattern = '(?:src|href)\s*=\s*["'']([^"'']+)["'']'
  foreach ($match in [regex]::Matches($html, $pattern)) {
    $href = [string]$match.Groups[1].Value
    if ($href -notlike "*assets/*") { continue }
    $clean = $href.Split("?")[0].Split("#")[0].TrimStart("/")
    $rel = $clean.Replace("/", [string][IO.Path]::DirectorySeparatorChar)
    if (-not [string]::IsNullOrWhiteSpace($rel)) { $found.Add($rel) }
  }
  return @($found)
}

function Copy-DirectoryTree {
  param([string]$Source, [string]$Destination)
  if (-not (Test-Path -LiteralPath $Source)) {
    throw ("UI copy source missing: {0}" -f $Source)
  }
  if (-not (Test-Path -LiteralPath $Destination)) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  }
  Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $Destination $_.Name) -Recurse -Force
  }
}

function Remove-TreeIfExists {
  param([string]$Path)
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Assert-ServedUiMatchesBuild {
  param([string]$UiDist, [string]$ServedDist)
  $uiIndex = Join-Path $UiDist "index.html"
  $servedIndex = Join-Path $ServedDist "index.html"
  if (-not (Test-Path -LiteralPath $uiIndex)) {
    throw ("ui/dist/index.html missing at {0}" -f $uiIndex)
  }
  if (-not (Test-Path -LiteralPath $servedIndex)) {
    throw ("server/ui-dist/index.html missing at {0}" -f $servedIndex)
  }
  $uiHash = Get-Sha256Hex -Path $uiIndex
  $servedHash = Get-Sha256Hex -Path $servedIndex
  if ($uiHash -ne $servedHash) {
    throw ("served index hash {0} does not match ui/dist {1}; stale server/ui-dist was not replaced" -f $servedHash, $uiHash)
  }
  $assets = @(Get-UiIndexReferencedAssets -IndexPath $uiIndex)
  foreach ($rel in $assets) {
    $srcAsset = Join-Path $UiDist $rel
    $dstAsset = Join-Path $ServedDist $rel
    if (-not (Test-Path -LiteralPath $dstAsset)) {
      throw ("served asset missing under server/ui-dist: {0}" -f $rel)
    }
    if ((Get-Sha256Hex -Path $srcAsset) -ne (Get-Sha256Hex -Path $dstAsset)) {
      throw ("served asset is stale under server/ui-dist: {0}" -f $rel)
    }
  }
  return ("indexSha256={0} assets={1}" -f $servedHash, @($assets).Count)
}

function Sync-ServerUiDistFromBuild {
  param([string]$Repo, [string]$UiDist, [string]$ServedDist)
  # Bounded PowerShell equivalent of scripts/prepare-server-ui-dist.sh:
  # copy ui/dist -> server/ui-dist. Stage first, then swap; if the live
  # HuiDots process has the served directory locked, fall back to in-place
  # overwrite and still require hash equality.
  if ($script:Synthetic -and $env:HDO_FAKE_UI_SYNC_FAIL -eq "1") {
    throw "synthetic served-directory sync failure"
  }
  $parent = Split-Path -Parent $ServedDist
  $staging = Join-Path $parent "ui-dist.next"
  $previous = Join-Path $parent "ui-dist.prev"
  Remove-TreeIfExists -Path $staging
  Remove-TreeIfExists -Path $previous
  New-Item -ItemType Directory -Path $staging -Force | Out-Null
  Copy-DirectoryTree -Source $UiDist -Destination $staging
  $swapped = $false
  try {
    if (Test-Path -LiteralPath $ServedDist) {
      Rename-Item -LiteralPath $ServedDist -NewName "ui-dist.prev"
    }
    Rename-Item -LiteralPath $staging -NewName "ui-dist"
    $swapped = $true
  } catch {
    if (Test-Path -LiteralPath $ServedDist) {
      Get-ChildItem -LiteralPath $ServedDist -Force | ForEach-Object {
        $peer = Join-Path $UiDist $_.Name
        if (-not (Test-Path -LiteralPath $peer)) {
          Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
        }
      }
    }
    Copy-DirectoryTree -Source $UiDist -Destination $ServedDist
  }
  if ($swapped) { Remove-TreeIfExists -Path $previous }
  Remove-TreeIfExists -Path $staging
  Remove-TreeIfExists -Path $previous
  return (Assert-ServedUiMatchesBuild -UiDist $UiDist -ServedDist $ServedDist)
}

function Invoke-ReviewedUiPrepare {
  param([string]$Repo)
  # Owner-path equivalent of scripts/prepare-server-ui-dist.sh.
  # Always rebuild the reviewed UI (do not honor PAPERCLIP_RELEASE_REUSE_UI_DIST).
  # Board static mode in server/src/app.ts serves server/ui-dist FIRST, then
  # ui/dist. Telegram overlay patches the installed plugin dist in place.
  # No other board-UI build-then-copy served path exists on this Owner run.
  $uiDist = Join-RepoPath -Repo $Repo -Parts @("ui", "dist")
  $servedDist = Join-RepoPath -Repo $Repo -Parts @("server", "ui-dist")
  $uiIndex = Join-Path $uiDist "index.html"

  $built = $false
  try {
    Invoke-Native -File "pnpm" -Arguments @("--filter", "@paperclipai/ui", "build") -FailPrefix "@paperclipai/ui build failed" | Out-Null
    if (-not (Test-Path -LiteralPath $uiIndex)) {
      throw ("UI build output missing at {0}" -f $uiIndex)
    }
    Add-Check -Name "dashboard.ui_build" -Status "PASS" -Detail $uiIndex
    $built = $true
  } catch {
    Add-Check -Name "dashboard.ui_build" -Status "FAIL" -Detail $_.Exception.Message
    Add-Check -Name "dashboard.ui_served_sync" -Status "FAIL" -Detail "ui build did not produce a reviewable dist; live HuiDots instance left untouched"
    return
  }

  if (-not $built) { return }
  try {
    $detail = Sync-ServerUiDistFromBuild -Repo $Repo -UiDist $uiDist -ServedDist $servedDist
    Add-Check -Name "dashboard.ui_served_sync" -Status "PASS" -Detail $detail
  } catch {
    Add-Check -Name "dashboard.ui_served_sync" -Status "FAIL" -Detail $_.Exception.Message
  }
}

function Invoke-WindowsHarness {
  $repo = $null
  if (-not [string]::IsNullOrWhiteSpace($PaperclipRepo) -and (Test-Path -LiteralPath $PaperclipRepo)) {
    $repo = (Resolve-Path $PaperclipRepo).Path
  } else {
    $repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
  }

  $zod = Assert-Zod4Runtime -Repo $repo
  if ($zod -notlike "ZOD_RUNTIME=4.*") {
    throw "Assert-Zod4Runtime harness failed: $zod"
  }
  Write-Host "HDO_WINDOWS_HARNESS_ZOD=$zod"

  $scratch = Join-Path ([IO.Path]::GetTempPath()) ("hdo-overlay-harness-" + [guid]::NewGuid().ToString("N"))
  $overlayDir = [IO.Path]::Combine($scratch, "patches", "telegram-owner-decision")
  New-Item -ItemType Directory -Path $overlayDir -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $overlayDir "fail.ps1") -Value "exit 7" -Encoding ASCII
  $threw = $false
  try {
    Invoke-OverlayScript -Repo $scratch -Name "fail.ps1" -ApiBase "http://127.0.0.1:3100" | Out-Null
  } catch {
    $threw = $true
    $message = $_.Exception.Message
    if ($message -notlike "fail.ps1 failed with exit 7*") {
      throw "Invoke-OverlayScript error format harness failed: $message"
    }
    Write-Host "HDO_WINDOWS_HARNESS_OVERLAY=$message"
  } finally {
    if (Test-Path -LiteralPath $scratch) {
      Remove-Item -LiteralPath $scratch -Recurse -Force
    }
  }
  if (-not $threw) {
    throw "Invoke-OverlayScript harness expected a non-zero exit"
  }
  Write-Host "HDO_WINDOWS_HARNESS=PASS"
}

function Invoke-ExampleSurface {
  param([string]$Filter, [string]$NamePrefix, [string]$ManifestPath)
  $policy = Get-ExamplePolicyStatus -ManifestPath $ManifestPath -Label $Filter
  if ($policy.Ok) {
    Add-Check -Name "${NamePrefix}.presence_policy" -Status "PASS" -Detail $policy.Detail
  } else {
    Add-Check -Name "${NamePrefix}.presence_policy" -Status "FAIL" -Detail $policy.Detail
  }
  foreach ($scriptName in @("typecheck", "test", "build")) {
    $checkName = "${NamePrefix}.$scriptName"
    try {
      Invoke-Native -File "pnpm" -Arguments @("--filter", $Filter, $scriptName) -FailPrefix "$Filter $scriptName failed" | Out-Null
      Add-Check -Name $checkName -Status "PASS"
    } catch {
      Add-Check -Name $checkName -Status "FAIL" -Detail $_.Exception.Message
    }
  }
}

if ($WindowsHarness) {
  try {
    Invoke-WindowsHarness
    exit 0
  } catch {
    Write-Host ("HDO_WINDOWS_HARNESS=FAIL {0}" -f $_.Exception.Message)
    exit 1
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
  $porcelain = Get-OwnerWorktreePorcelain -Repo $repo
  if (-not [string]::IsNullOrWhiteSpace($porcelain)) {
    Stop-Unsafe -Name "repo.worktree" -Detail "Worktree is not clean. Commit, stash, or restore local changes, then re-run this one command."
  }
  Add-Check -Name "repo.worktree" -Status "PASS"
} catch {
  if ($script:UnsafeStop) { throw }
  Stop-Unsafe -Name "repo.worktree" -Detail $_.Exception.Message
}

if ($script:Synthetic) {
  Add-Check -Name "task.huidots_paperclip" -Status "PASS" -Detail "synthetic; live HuiDots task not queried or reconfigured"
} else {
  $taskQuery = schtasks.exe /Query /TN $ScheduledTaskName /FO LIST
  if ($LASTEXITCODE -ne 0) {
    Stop-Unsafe -Name "task.huidots_paperclip" -Detail "Scheduled task '$ScheduledTaskName' does not exist. This script will not create or alter task configuration."
  }
  if ($taskQuery -match "/Change|TR: /Create") {
    Add-Check -Name "task.huidots_paperclip" -Status "FAIL" -Detail "task query unexpectedly looks like a reconfiguration command"
  } else {
    Add-Check -Name "task.huidots_paperclip" -Status "PASS" -Detail "present; configuration will not be changed"
  }
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
    Stop-Unsafe -Name "tooling.node_policy" -Detail "Node $($node.Raw) is below >=24.11.0. Fast-forward, install, and runtime mutation are refused."
  }
  Add-Check -Name "tooling.node_policy" -Status "PASS" -Detail $node.Raw
} catch {
  if ($script:UnsafeStop) { throw }
  Stop-Unsafe -Name "tooling.node_policy" -Detail $_.Exception.Message
}

try {
  $fetchedSha = Get-FetchedForwardPortSha -Repo $repo -Branch $ForwardPortBranch -FetchRef $OwnerFetchRef
  $localHead = Get-GitText -Repo $repo -GitArgs @("rev-parse", "HEAD")
  if (-not (Test-GitAncestor -Repo $repo -Ancestor $BaseSha -Descendant $fetchedSha)) {
    Stop-Unsafe -Name "repo.fast_forward" -Detail "Fetched $ForwardPortBranch ($fetchedSha) is not a descendant of $BaseSha."
  }
  if ($localHead -eq $fetchedSha) {
    Add-Check -Name "repo.fast_forward" -Status "PASS" -Detail "already-at $fetchedSha via $OwnerFetchRef"
  } else {
    if (-not (Test-GitAncestor -Repo $repo -Ancestor $localHead -Descendant $fetchedSha)) {
      Stop-Unsafe -Name "repo.fast_forward" -Detail "HEAD ($localHead) is not a clean ancestor of fetched $fetchedSha. No reset, force, checkout, or conflict resolution will be attempted."
    }
    Get-GitText -Repo $repo -GitArgs @("merge", "--ff-only", $fetchedSha) | Out-Null
    $after = Get-GitText -Repo $repo -GitArgs @("rev-parse", "HEAD")
    $stillOn = Get-GitText -Repo $repo -GitArgs @("branch", "--show-current")
    if ($stillOn -ne $ExpectedBranch -or $after -ne $fetchedSha) {
      Stop-Unsafe -Name "repo.fast_forward" -Detail "Fast-forward landed on branch=$stillOn head=$after"
    }
    Add-Check -Name "repo.fast_forward" -Status "PASS" -Detail "$localHead -> $after via $OwnerFetchRef"
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
  Stop-Unsafe -Name "deps.lockfile_preserved" -Detail "Cannot preserve pnpm-lock.yaml before dependency mutation: $($_.Exception.Message)"
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
    @(
      (Join-Path $repo "node_modules\.vite"),
      (Join-Path $repo "ui\node_modules\.vite")
    ) | Where-Object { Test-Path $_ }
  )
  if (@($stale).Count -gt 0) {
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

$esmUrl = Join-RepoPath -Repo $repo -Parts @("server", "src", "services", "plugin-esm-url.ts")
$esmLoader = Join-RepoPath -Repo $repo -Parts @("server", "src", "services", "plugin-loader.ts")
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

$applyPath = Join-RepoPath -Repo $repo -Parts @("patches", "telegram-owner-decision", "apply-installed.ps1")
$verifyPath = Join-RepoPath -Repo $repo -Parts @("patches", "telegram-owner-decision", "verify.ps1")
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

$piBuild = Join-RepoPath -Repo $repo -Parts @("packages", "adapters", "pi-local", "src", "ui", "build-config.ts")
$piTimeout = Join-RepoPath -Repo $repo -Parts @("packages", "adapter-utils", "src", "execution-target.ts")
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

$pixelManifest = Join-RepoPath -Repo $repo -Parts @("packages", "plugins", "examples", "plugin-pixel-strip-example", "package.json")
$vaultManifest = Join-RepoPath -Repo $repo -Parts @("packages", "plugins", "examples", "plugin-vault-read-bridge-example", "package.json")
Invoke-ExampleSurface -Filter "@paperclipai/plugin-pixel-strip-example" -NamePrefix "examples.pixel_strip" -ManifestPath $pixelManifest
Invoke-ExampleSurface -Filter "@paperclipai/plugin-vault-read-bridge-example" -NamePrefix "examples.vault_read_bridge" -ManifestPath $vaultManifest

Invoke-ReviewedUiPrepare -Repo $repo

$prereqFails = @(Get-RuntimePrerequisiteFailures)
if (@($prereqFails).Count -gt 0) {
  Add-Check -Name "runtime.mutation_gate" -Status "FAIL" -Detail ("blocked: " + ($prereqFails -join ", "))
  Add-UntouchedRuntimeChecks -Detail "prerequisite failed; live HuiDots instance left untouched"
} elseif ($script:Synthetic) {
  Add-Check -Name "runtime.mutation_gate" -Status "PASS" -Detail "source/dependency/focused checks passed; live HuiDots instance not touched"
  Add-UntouchedRuntimeChecks -Detail "synthetic; live HuiDots instance not touched" -DesignedSkip
} else {
  Add-Check -Name "runtime.mutation_gate" -Status "PASS" -Detail "source/dependency/focused checks passed"

  $overlayApplied = $false
  try {
    Invoke-OverlayScript -Repo $repo -Name "apply-installed.ps1" -ApiBase $PaperclipApi -ExtraArgs @("-SkipReadiness") | Out-Null
    $overlayApplied = $true
    Add-Check -Name "telegram.overlay_apply" -Status "PASS" -Detail "installed overlay patched; readiness deferred until after restart"
  } catch {
    Add-Check -Name "telegram.overlay_apply" -Status "FAIL" -Detail $_.Exception.Message
  }

  if (-not $overlayApplied) {
    Add-Check -Name "task.restart" -Status "NOT-VERIFIABLE-LOCALLY" -Detail "overlay patch failed; live instance left untouched"
    Add-Check -Name "task.backend_ready" -Status "NOT-VERIFIABLE-LOCALLY" -Detail "overlay patch failed; live instance left untouched"
    Add-Check -Name "telegram.registry_ready" -Status "NOT-VERIFIABLE-LOCALLY" -Detail "overlay patch failed"
    Add-Check -Name "telegram.overlay_invariants" -Status "NOT-VERIFIABLE-LOCALLY" -Detail "overlay patch failed"
    Add-Check -Name "dashboard.application" -Status "NOT-VERIFIABLE-LOCALLY" -Detail "overlay patch failed"
    Add-Check -Name "dashboard.fatal_console" -Status "NOT-VERIFIABLE-LOCALLY" -Detail "overlay patch failed"
    Add-Check -Name "dashboard.cloudflare_access" -Status "NOT-VERIFIABLE-LOCALLY" -Detail "overlay patch failed"
  } else {
    $restarted = $false
    try {
      Restart-HuiDotsTask -TaskName $ScheduledTaskName
      $restarted = $true
      Add-Check -Name "task.restart" -Status "PASS" -Detail "End+Run only; no /Change"
    } catch {
      Add-Check -Name "task.restart" -Status "FAIL" -Detail $_.Exception.Message
    }

    $backendReady = $false
    if (-not $restarted) {
      Add-Check -Name "task.backend_ready" -Status "NOT-VERIFIABLE-LOCALLY" -Detail "task restart failed; readiness not run against the pre-restart server"
      Add-Check -Name "telegram.registry_ready" -Status "NOT-VERIFIABLE-LOCALLY" -Detail "readiness occurs only after restart/backend-ready"
      if (Test-Path $verifyPath) {
        try {
          Invoke-OverlayScript -Repo $repo -Name "verify.ps1" -ApiBase $PaperclipApi | Out-Null
          Add-Check -Name "telegram.overlay_invariants" -Status "PASS" -Detail "static overlay markers only"
        } catch {
          Add-Check -Name "telegram.overlay_invariants" -Status "FAIL" -Detail $_.Exception.Message
        }
      } else {
        Add-Check -Name "telegram.overlay_invariants" -Status "NOT-VERIFIABLE-LOCALLY" -Detail "verify.ps1 not runnable"
      }
    } else {
      $backendReady = Wait-BackendReady -ApiBase $PaperclipApi -TimeoutSec $ReadyTimeoutSec
      if ($backendReady) {
        Add-Check -Name "task.backend_ready" -Status "PASS" -Detail "/api/health reached after bounded wait"
      } else {
        Add-Check -Name "task.backend_ready" -Status "FAIL" -Detail "backend not ready within ${ReadyTimeoutSec}s"
      }
    }

    if ($restarted -and $backendReady) {
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
    } elseif ($restarted) {
      Add-Check -Name "telegram.registry_ready" -Status "NOT-VERIFIABLE-LOCALLY" -Detail "backend not ready; readiness not run against the pre-restart server"
      if (Test-Path $verifyPath) {
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
  $finalPorcelain = Get-OwnerWorktreePorcelain -Repo $repo
  if ([string]::IsNullOrWhiteSpace($finalPorcelain)) {
    Add-Check -Name "repo.worktree_final" -Status "PASS" -Detail "checkout is clean after scripted source/dependency operations"
  } else {
    Add-Check -Name "repo.worktree_final" -Status "FAIL" -Detail $finalPorcelain
  }
} catch {
  Add-Check -Name "repo.worktree_final" -Status "FAIL" -Detail $_.Exception.Message
}

Write-SweepReport
