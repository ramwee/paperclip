param(
  [string]$PaperclipRepo = "C:\Users\admin\Documents\Paperclip",
  [string]$PluginRoot = "C:\Users\admin\.paperclip\plugins\node_modules\paperclip-plugin-telegram",
  [string]$PaperclipApi = "http://127.0.0.1:3100",
  [string]$PluginKey = "paperclip-plugin-telegram",
  [switch]$SkipReadiness
)

$ErrorActionPreference = "Stop"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Read-Text([string]$Path) {
  [IO.File]::ReadAllText($Path)
}

function Write-Text([string]$Path, [string]$Value) {
  [IO.File]::WriteAllText($Path, $Value, $Utf8NoBom)
}

function Backup-Once([string]$Path) {
  $backup = "$Path.ownerdecision.source-control.bak"
  if (-not (Test-Path $backup)) {
    Copy-Item $Path $backup -Force
  }
}

function Replace-Required([string]$Text, [string]$Anchor, [string]$Replacement, [string]$Name) {
  if (-not $Text.Contains($Anchor)) {
    throw "ANCHOR_NOT_FOUND: $Name"
  }
  $Text.Replace($Anchor, $Replacement)
}

if (-not (Test-Path $PaperclipRepo)) { throw "PAPERCLIP_REPO_NOT_FOUND: $PaperclipRepo" }
if (-not (Test-Path $PluginRoot)) { throw "TELEGRAM_PLUGIN_NOT_FOUND: $PluginRoot" }

$packageJson = Get-Content (Join-Path $PluginRoot "package.json") -Raw | ConvertFrom-Json
if ($packageJson.name -ne "paperclip-plugin-telegram" -or $packageJson.version -ne "0.8.0") {
  throw "TELEGRAM_PLUGIN_PIN_MISMATCH: expected paperclip-plugin-telegram@0.8.0"
}

# Paperclip core: expose the existing interaction-created activity to plugins.
$constantsPath = Join-Path $PaperclipRepo "packages\shared\src\constants.ts"
$constants = Read-Text $constantsPath
if (-not $constants.Contains('"issue.thread_interaction.created"')) {
  Backup-Once $constantsPath
  $constants = Replace-Required $constants '  "issue.relations.updated",' "  `"issue.relations.updated`",`r`n  `"issue.thread_interaction.created`"," "Paperclip plugin event type"
  Write-Text $constantsPath $constants
}

$activityPath = Join-Path $PaperclipRepo "server\src\services\activity-log.ts"
$activity = Read-Text $activityPath
if (-not $activity.Contains('issue_thread_interaction_created: "issue.thread_interaction.created"')) {
  Backup-Once $activityPath
  $activity = Replace-Required $activity '  issue_blockers_updated: "issue.relations.updated",' "  issue_blockers_updated: `"issue.relations.updated`",`r`n  issue_thread_interaction_created: `"issue.thread_interaction.created`"," "Paperclip activity event mapping"
  Write-Text $activityPath $activity
}

# Telegram manifest: use the already-governed Paperclip interaction APIs.
$manifestPath = Join-Path $PluginRoot "dist\manifest.js"
$manifest = Read-Text $manifestPath
if (-not $manifest.Contains('"issue.interactions.read"')) {
  Backup-Once $manifestPath
  $manifest = Replace-Required $manifest '        "issue.comments.create",' "        `"issue.comments.create`",`r`n        `"issue.interactions.read`",`r`n        `"issue.interactions.respond`"," "Telegram interaction capabilities"
  Write-Text $manifestPath $manifest
}

$workerPath = Join-Path $PluginRoot "dist\worker.js"
$worker = Read-Text $workerPath

# Ensure board-access state normalization keeps actorUserId (canonical user id).
if (-not $worker.Contains('actorUserId: asNonEmptyString(record.actorUserId)')) {
  Backup-Once $workerPath
  $normalizeAnchor = @'
    return {
        paperclipBoardApiTokenRef: asNonEmptyString(record.paperclipBoardApiTokenRef),
        identity: asNonEmptyString(record.identity),
        companyId: asNonEmptyString(record.companyId),
        updatedAt: asNonEmptyString(record.updatedAt),
    };
'@
  $normalizeReplacement = @'
    return {
        paperclipBoardApiTokenRef: asNonEmptyString(record.paperclipBoardApiTokenRef),
        identity: asNonEmptyString(record.identity),
        actorUserId: asNonEmptyString(record.actorUserId),
        companyId: asNonEmptyString(record.companyId),
        updatedAt: asNonEmptyString(record.updatedAt),
    };
'@
  if ($worker.Contains($normalizeAnchor)) {
    $worker = Replace-Required $worker $normalizeAnchor $normalizeReplacement "Telegram board-access actorUserId normalize"
  }
}

# Inject canonical actor resolver once (uses Board Access token + /api/cli-auth/me).
if (-not $worker.Contains('async function resolveOwnerDecisionActorUserId(')) {
  Backup-Once $workerPath
  $resolverAnchor = 'async function loadBoardAccessState(ctx) {'
  $resolverBlock = @'
async function resolveOwnerDecisionActorUserId(ctx, boardAccess, companyId, baseUrl, boardApiToken) {
    if (boardAccess.companyId && boardAccess.companyId !== companyId) {
        return { ok: false, message: "Board access company mismatch" };
    }
    if (boardAccess.actorUserId) {
        return { ok: true, actorUserId: boardAccess.actorUserId };
    }
    if (!boardApiToken) {
        return { ok: false, message: "Connect board access in Paperclip Telegram settings" };
    }
    try {
        const response = await fetchPaperclipApi(ctx, `${baseUrl}/api/cli-auth/me`, {
            headers: {
                ...buildPaperclipAuthHeaders(boardApiToken),
            },
        });
        const me = await response.json();
        const actorUserId = asNonEmptyString(me?.userId) ?? asNonEmptyString(me?.user?.id);
        if (!actorUserId) {
            return { ok: false, message: "Connect board access in Paperclip Telegram settings" };
        }
        await persistBoardAccessState(ctx, {
            ...boardAccess,
            actorUserId,
            updatedAt: new Date().toISOString(),
        });
        return { ok: true, actorUserId };
    }
    catch {
        return { ok: false, message: "Connect board access in Paperclip Telegram settings" };
    }
}
async function loadBoardAccessState(ctx) {
'@
  $worker = Replace-Required $worker $resolverAnchor $resolverBlock "Telegram owner decision actor resolver"
}

if (-not $worker.Contains('ctx.events.on("issue.thread_interaction.created"')) {
  Backup-Once $workerPath
  $eventAnchor = '        ctx.events.on("approval.created", async (event) => {'
  $eventBlock = @'
        ctx.events.on("issue.thread_interaction.created", async (event) => {
            const rt = ensureRuntime();
            if (!rt)
                return;
            const payload = event.payload ?? {};
            const interactionId = String(payload.interactionId ?? "");
            const issueId = event.entityId ? String(event.entityId) : "";
            if (!interactionId || !issueId || String(payload.interactionKind ?? "") !== "request_confirmation")
                return;
            if (!doneDedupe(`decision|${interactionId}`))
                return;
            try {
                const interactions = await ctx.issues.listInteractions(issueId, event.companyId);
                const interaction = interactions.find((value) => value.id === interactionId);
                if (!interaction || interaction.kind !== "request_confirmation" || interaction.status !== "pending")
                    return;
                if (interaction.effectiveResolverPolicy !== "board_only")
                    return;
                const issue = await ctx.issues.get(issueId, event.companyId);
                const issueLabel = issue?.identifier
                    ? `${issue.identifier}: ${issue.title}`
                    : issue?.title ?? "Owner decision";
                const prompt = String(interaction.payload?.prompt ?? interaction.title ?? interaction.summary ?? "Owner decision required");
                const details = String(interaction.payload?.detailsMarkdown ?? interaction.summary ?? "").trim();
                const lines = ["Owner decision required", "", issueLabel, prompt];
                if (details && details !== prompt)
                    lines.push("", details);
                await notify(ctx, rt, event, () => ({
                    text: lines.join("\n"),
                    options: {
                        inlineKeyboard: [[
                            { text: "Approve", callback_data: `decision_accept_${interactionId}` },
                            { text: "Revise", callback_data: `decision_revise_${interactionId}` },
                        ]],
                    },
                }), rt.config.approvalsChatId, rt.config.approvalsTopicId);
            }
            catch (err) {
                ctx.logger.error("Failed to forward Owner decision to Telegram", {
                    issueId,
                    interactionId,
                    error: String(err),
                });
            }
        });

'@
  $worker = Replace-Required $worker $eventAnchor ($eventBlock + $eventAnchor) "Telegram owner decision event handler"
}

# Prefer the canonical-userId callback body. Replace any prior identity-as-actorUserId overlay.
$legacyIdentityCallback = 'boardAccess.identity'
$desiredCallbackMarker = 'resolveOwnerDecisionActorUserId(ctx, boardAccess, companyId, baseUrl, boardApiToken)'
if (-not $worker.Contains($desiredCallbackMarker)) {
  Backup-Once $workerPath
  if ($worker.Contains('data.startsWith("decision_accept_")')) {
    # Strip an older decision callback block so we can re-insert the fixed one.
    $pattern = '(?s)\n    if \(data\.startsWith\("decision_accept_"\) \|\| data\.startsWith\("decision_revise_"\)\) \{.*?\n        return;\n    \}\n'
    $worker = [regex]::Replace($worker, $pattern, "`n", 1)
  }

  $callbackAnchor = '    if (data.startsWith("approve_")) {'
  $callbackBlock = @'
    if (data.startsWith("decision_accept_") || data.startsWith("decision_revise_")) {
        const accept = data.startsWith("decision_accept_");
        const interactionId = data.replace(accept ? "decision_accept_" : "decision_revise_", "");
        if (!chatId || !messageId) {
            await answerCallbackQuery(ctx, token, query.id, "Decision context missing");
            return;
        }
        const mapping = await ctx.state.get({
            scopeKind: "instance",
            stateKey: `msg_${chatId}_${messageId}`,
        });
        const companyId = mapping?.companyId ? String(mapping.companyId) : null;
        const issueId = mapping?.entityType === "issue" && mapping?.entityId ? String(mapping.entityId) : null;
        if (!companyId || !issueId) {
            await answerCallbackQuery(ctx, token, query.id, "Decision context invalid");
            return;
        }
        try {
            const interactions = await ctx.issues.listInteractions(issueId, companyId);
            const interaction = interactions.find((value) => value.id === interactionId);
            if (!interaction || interaction.kind !== "request_confirmation" || interaction.status !== "pending" || interaction.effectiveResolverPolicy !== "board_only") {
                await answerCallbackQuery(ctx, token, query.id, "Decision is no longer pending");
                return;
            }
            const boardAccess = await loadBoardAccessState(ctx);
            const resolvedActor = await resolveOwnerDecisionActorUserId(ctx, boardAccess, companyId, baseUrl, boardApiToken);
            if (!resolvedActor.ok) {
                await answerCallbackQuery(ctx, token, query.id, resolvedActor.message);
                return;
            }
            const actorUserId = resolvedActor.actorUserId;
            const displayActor = boardAccess.identity ?? actor;
            const result = await ctx.issues.respondInteraction(issueId, interactionId, accept
                ? { action: "accept", actorUserId }
                : { action: "reject", actorUserId, reason: "Revision requested via Telegram" }, companyId);
            if (result?.applied === false) {
                await answerCallbackQuery(ctx, token, query.id, "Decision already resolved");
                return;
            }
            await answerCallbackQuery(ctx, token, query.id, accept ? "Approved" : "Revision requested");
            await editMessage(ctx, token, chatId, messageId, accept ? `Approved by ${displayActor}` : `Revision requested by ${displayActor}`, {});
        }
        catch (err) {
            ctx.logger.error("Telegram Owner decision callback failed", { interactionId, error: String(err) });
            await answerCallbackQuery(ctx, token, query.id, "Decision action failed");
        }
        return;
    }

'@
  $worker = Replace-Required $worker $callbackAnchor ($callbackBlock + $callbackAnchor) "Telegram owner decision callback"
}

# Normalize the earlier manual overlay to the current Paperclip resolver-policy vocabulary.
$worker = $worker.Replace('if(policy&&policy!=="human_only"&&policy!=="board_only")return;', 'if(policy&&policy!=="board_only")return;')

# Guard: identity display label must never be assigned as actorUserId in the decision path.
if ($worker.Contains('? boardAccess.identity') -and $worker.Contains('decision_accept_')) {
  if ($worker -match 'decision_accept_[\s\S]{0,1200}\? boardAccess\.identity') {
    throw "IDENTITY_USED_AS_ACTOR: decision callback still treats boardAccess.identity as actorUserId"
  }
}

Write-Text $workerPath $worker

node --check $manifestPath
node --check $workerPath

# Smallest readiness correction: activation failures mark plugins `error`, and
# loadAll() only loads `ready` plugins — producing "no ready plugins to load".
# Re-enable the already-installed Telegram plugin without recreating config/secrets.
# Fail closed: this script must not report PASS unless Telegram is ready.
# Auth: use the supported paperclipai CLI (stored board credential / env), never
# naked unauthenticated HTTP to /api/plugins (that returns 403 while the server
# is healthy). Do not print, hard-code, or persist tokens.
function Get-TelegramPluginRecord {
  param([object[]]$Plugins, [string]$Key)
  return @($Plugins) | Where-Object {
    $_.pluginKey -eq $Key -or $_.packageName -eq $Key -or $_.id -eq $Key
  } | Select-Object -First 1
}

function Redact-SensitiveText([string]$Text) {
  if ([string]::IsNullOrEmpty($Text)) { return $Text }
  $redacted = [regex]::Replace($Text, '(?i)Bearer\s+\S+', 'Bearer [redacted]')
  $redacted = [regex]::Replace($redacted, '(?i)(api[_-]?key|token|authorization)(["'':=\s]+)\S+', '$1$2[redacted]')
  return $redacted
}

function Resolve-PaperclipAiInvocation {
  param([string]$Repo)

  $cmd = Get-Command paperclipai -ErrorAction SilentlyContinue
  if ($cmd) {
    return @{ Executable = $cmd.Source; Prefix = @() }
  }

  $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($pnpm -and (Test-Path (Join-Path $Repo "package.json"))) {
    return @{ Executable = $pnpm.Source; Prefix = @("--dir", $Repo, "exec", "--", "paperclipai") }
  }

  $dist = Join-Path $Repo "cli\dist\index.js"
  if (Test-Path $dist) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
      throw "TELEGRAM_PLUGIN_READY_FAILED: node not found while resolving paperclipai from '$dist'"
    }
    return @{ Executable = $node.Source; Prefix = @($dist) }
  }

  throw "TELEGRAM_PLUGIN_READY_FAILED: paperclipai CLI not found on PATH and cannot be resolved from repo '$Repo'. Build/install the CLI and ensure board access is configured (paperclipai login), then re-run apply-installed.ps1."
}

function Invoke-PaperclipAiJson {
  param(
    [string]$Repo,
    [string]$ApiBase,
    [string[]]$CliArgs
  )

  $inv = Resolve-PaperclipAiInvocation -Repo $Repo
  # Rely on stored board credential / PAPERCLIP_* env already used by the CLI.
  # Never pass --api-key here (would risk logging tokens).
  $fullArgs = @($inv.Prefix) + $CliArgs + @("--api-base", $ApiBase, "--json")
  $raw = & $inv.Executable @fullArgs 2>&1
  $code = $LASTEXITCODE
  $text = ($raw | ForEach-Object { "$_" }) -join "`n"
  if ($code -ne 0) {
    throw "TELEGRAM_PLUGIN_READY_FAILED: paperclipai $($CliArgs -join ' ') failed (exit $code): $(Redact-SensitiveText $text)"
  }
  $trimmed = $text.Trim()
  if ([string]::IsNullOrWhiteSpace($trimmed)) { return $null }
  try {
    return $trimmed | ConvertFrom-Json
  } catch {
    throw "TELEGRAM_PLUGIN_READY_FAILED: paperclipai $($CliArgs -join ' ') returned non-JSON output: $(Redact-SensitiveText $trimmed)"
  }
}

function Ensure-TelegramPluginReady {
  param(
    [string]$Repo,
    [string]$ApiBase,
    [string]$Key
  )

  try {
    $plugins = Invoke-PaperclipAiJson -Repo $Repo -ApiBase $ApiBase -CliArgs @("plugin", "list")
  } catch {
    if ($_.Exception.Message -like "TELEGRAM_PLUGIN_READY_FAILED:*") { throw }
    throw "TELEGRAM_PLUGIN_READY_FAILED: authenticated plugin list failed ($($_.Exception.Message)). Start the existing HuiDots Paperclip task, wait for embedded Postgres (~90s), ensure board login (`paperclipai login`), then re-run apply-installed.ps1. Do not recreate company/DB/secrets."
  }

  $plugin = Get-TelegramPluginRecord -Plugins @($plugins) -Key $Key
  if (-not $plugin) {
    throw "TELEGRAM_PLUGIN_READY_FAILED: plugin DB record missing for '$Key' (package may be on disk). Install/enable the existing Telegram plugin via Paperclip UI/CLI without recreating company/secrets, then re-run apply-installed.ps1."
  }

  Write-Host "TELEGRAM_PLUGIN_STATUS=$($plugin.status) id=$($plugin.id)"
  if ($plugin.status -eq "ready") {
    Write-Host "TELEGRAM_PLUGIN_READY=ALREADY"
    return
  }

  try {
    if ($plugin.status -in @("error", "disabled", "upgrade_pending")) {
      $enabled = Invoke-PaperclipAiJson -Repo $Repo -ApiBase $ApiBase -CliArgs @("plugin", "enable", [string]$plugin.id)
      Write-Host "TELEGRAM_PLUGIN_ENABLE_RESULT status=$($enabled.status)"
    } elseif ($plugin.status -eq "installed") {
      # Install command reuses lifecycle.load for existing packages; enable rejects installed.
      $loaded = Invoke-PaperclipAiJson -Repo $Repo -ApiBase $ApiBase -CliArgs @("plugin", "install", $Key)
      Write-Host "TELEGRAM_PLUGIN_LOAD_RESULT status=$($loaded.status)"
    } else {
      throw "TELEGRAM_PLUGIN_READY_FAILED: unhandled plugin status '$($plugin.status)' for id=$($plugin.id)"
    }
  } catch {
    if ($_.Exception.Message -like "TELEGRAM_PLUGIN_READY_FAILED:*") { throw }
    throw "TELEGRAM_PLUGIN_READY_FAILED: enable/load failed for id=$($plugin.id) status=$($plugin.status) ($($_.Exception.Message))"
  }

  try {
    $pluginsAfter = Invoke-PaperclipAiJson -Repo $Repo -ApiBase $ApiBase -CliArgs @("plugin", "list")
  } catch {
    if ($_.Exception.Message -like "TELEGRAM_PLUGIN_READY_FAILED:*") { throw }
    throw "TELEGRAM_PLUGIN_READY_FAILED: enable/load attempted but authenticated re-list failed ($($_.Exception.Message))"
  }

  $pluginAfter = Get-TelegramPluginRecord -Plugins @($pluginsAfter) -Key $Key
  if (-not $pluginAfter) {
    throw "TELEGRAM_PLUGIN_READY_FAILED: plugin DB record missing after enable/load"
  }
  if ($pluginAfter.status -ne "ready") {
    throw "TELEGRAM_PLUGIN_READY_FAILED: resulting status is '$($pluginAfter.status)' (expected ready) for id=$($pluginAfter.id)"
  }

  Write-Host "TELEGRAM_PLUGIN_READY=READY id=$($pluginAfter.id)"
}

if (-not $SkipReadiness) {
  Ensure-TelegramPluginReady -Repo $PaperclipRepo -ApiBase $PaperclipApi.TrimEnd('/') -Key $PluginKey
} else {
  Write-Host "TELEGRAM_OWNER_DECISION_READINESS=SKIPPED"
}

Write-Host "TELEGRAM_OWNER_DECISION_PATCH=PASS"
if ($SkipReadiness) {
  Write-Host "NEXT_ACTION=Restart only the existing 'HuiDots Paperclip' scheduled task, wait for backend ready, then re-run apply-installed.ps1 without -SkipReadiness."
} else {
  Write-Host "NEXT_ACTION=Restart only the existing 'HuiDots Paperclip' scheduled task if workers were mid-run, then confirm GET /api/health=200 and plugin status ready."
}
