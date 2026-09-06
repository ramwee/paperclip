import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { match, ok } from "node:assert/strict";

const dir = path.dirname(fileURLToPath(import.meta.url));
const orchestrator = readFileSync(path.join(dir, "hdo-owner-apply-and-verify.ps1"), "utf8");
const smoke = readFileSync(path.join(dir, "hdo-owner-dashboard-smoke.mjs"), "utf8");
const readme = readFileSync(path.join(dir, "telegram-owner-decision", "README.md"), "utf8");

describe("HuiDots owner apply-and-verify contract", () => {
  it("documents one bootstrap command that fetches the PR without a branch switch", () => {
    match(
      readme,
      /git fetch origin fix\/hdo-windows-dashboard-telegram-forward-port; git show origin\/fix\/hdo-windows-dashboard-telegram-forward-port:patches\/hdo-owner-apply-and-verify\.ps1 \| powershell -NoProfile -ExecutionPolicy Bypass -Command -/,
    );
    ok(!readme.includes("git checkout"), "bootstrap must not ask the Owner to check out a branch");
    ok(!readme.includes("git switch"), "bootstrap must not ask the Owner to switch branches");
  });

  it("collects a sectioned PASS/FAIL/NOT-VERIFIABLE-LOCALLY sweep instead of aborting after the first safe check", () => {
    ok(orchestrator.includes("===== HDO ACCEPTANCE SWEEP ====="));
    ok(orchestrator.includes("HDO_OWNER_APPLY=$overall"));
    ok(orchestrator.includes("NOT-VERIFIABLE-LOCALLY"));
    ok(orchestrator.includes("function Add-Check"));
    ok(orchestrator.includes("function Stop-Unsafe"));
    ok(orchestrator.includes("FAIL: "));
    ok(orchestrator.includes("does not fabricate"));
    ok(!orchestrator.includes("Read-Host"));
    ok(!orchestrator.includes("Pause"));
  });

  it("hard-stops only for unsafe repo/branch/worktree/task/tooling conditions", () => {
    ok(orchestrator.includes('Stop-Unsafe -Name "repo.identity"'));
    ok(orchestrator.includes('Stop-Unsafe -Name "repo.branch"'));
    ok(orchestrator.includes('Stop-Unsafe -Name "repo.worktree"'));
    ok(orchestrator.includes('Stop-Unsafe -Name "repo.ancestry"'));
    ok(orchestrator.includes('Stop-Unsafe -Name "task.huidots_paperclip"'));
    ok(orchestrator.includes('Stop-Unsafe -Name "repo.fast_forward"'));
    ok(orchestrator.includes('ExpectedBranch = "examples/pixel-strip-and-vault-read-bridge-clean"'));
    ok(orchestrator.includes('BaseSha = "def9c581b48a1fea845bb7b4a8726e201a3ad5d2"'));
  });

  it("fast-forwards only, with no reset/force/checkout/master merge", () => {
    ok(orchestrator.includes('merge", "--ff-only"') || orchestrator.includes("merge --ff-only"));
    ok(orchestrator.includes("fetch"));
    ok(!/git(?:\.exe)?\s+reset/i.test(orchestrator));
    ok(!/git(?:\.exe)?\s+checkout/i.test(orchestrator));
    ok(!/git(?:\.exe)?\s+switch/i.test(orchestrator));
    ok(!/--force\b/.test(orchestrator));
    ok(!/-B\b/.test(orchestrator));
    ok(!/merge.*master/.test(orchestrator));
    ok(!/merge.*main/.test(orchestrator));
  });

  it("covers Node/pnpm policy, Zod 4, Vite cache, and Windows ESM file:// behavior", () => {
    ok(orchestrator.includes("check:node-version"));
    ok(orchestrator.includes("Assert-Zod4Runtime"));
    ok(orchestrator.includes("Clear-ViteOptimizedDeps"));
    ok(orchestrator.includes("plugin_loader.windows_esm_source"));
    ok(orchestrator.includes("plugin_loader.windows_esm_tests"));
    ok(orchestrator.includes("plugin-loader-windows-esm.test.ts"));
    ok(orchestrator.includes("toNodeEsmImportUrl"));
  });

  it("reuses Telegram overlay scripts and forbids unauthenticated /api/plugins", () => {
    ok(orchestrator.includes("apply-installed.ps1"));
    ok(orchestrator.includes("verify.ps1"));
    ok(orchestrator.includes("plugin.readiness_auth_path"));
    ok(orchestrator.includes("Invoke-RestMethod"));
    ok(orchestrator.includes("/api/plugins"));
    ok(!/PAPERCLIP_API_KEY/.test(orchestrator));
    ok(!/Bearer /.test(orchestrator));
  });

  it("restarts only the existing HuiDots task and waits for backend readiness", () => {
    ok(orchestrator.includes("schtasks.exe /End /TN"));
    ok(orchestrator.includes("schtasks.exe /Run /TN"));
    ok(!orchestrator.includes("schtasks.exe /Change"));
    ok(!orchestrator.includes("Register-ScheduledTask"));
    ok(!orchestrator.includes("New-ScheduledTask"));
    ok(orchestrator.includes("Wait-BackendReady"));
    ok(orchestrator.includes("/api/health"));
  });

  it("distinguishes Cloudflare Access/login 200 from dashboard application acceptance", () => {
    ok(smoke.includes("cloudflareAccessPattern"));
    ok(smoke.includes("dashboard.cloudflare_access"));
    ok(smoke.includes("dashboard.application"));
    ok(smoke.includes("dashboard.fatal_console"));
    ok(smoke.includes("guid is not a function"));
    ok(smoke.includes("HTTP status alone is never treated as app health") || smoke.includes("HTTP 200 is not app health"));
    ok(!smoke.includes("reuseExistingServer"));
    ok(!smoke.includes("pnpm paperclipai onboard"));
  });

  it("preserves exact pre-resolution lockfile bytes and requires a clean final worktree", () => {
    ok(orchestrator.includes("function Save-LockfileBytes"));
    ok(orchestrator.includes("function Restore-LockfileBytes"));
    ok(orchestrator.includes("[IO.File]::ReadAllBytes"));
    ok(orchestrator.includes("[IO.File]::WriteAllBytes"));
    ok(orchestrator.includes("} finally {"));
    ok(orchestrator.includes("deps.lockfile_preserved"));
    ok(orchestrator.includes("deps.lockfile_restored"));
    ok(orchestrator.includes("repo.worktree_final"));
    ok(orchestrator.includes('"status", "--porcelain"'));
    const preserveCall = orchestrator.indexOf("$lockBackup = Save-LockfileBytes");
    const resolveCall = orchestrator.indexOf("--no-frozen-lockfile");
    const restoreCall = orchestrator.indexOf("Restore-LockfileBytes -Path");
    const finalCheck = orchestrator.indexOf('Add-Check -Name "repo.worktree_final"');
    ok(preserveCall > 0 && resolveCall > preserveCall, "lockfile bytes must be captured before resolution-only");
    ok(restoreCall > resolveCall, "lockfile bytes must be restored after resolution/install");
    ok(finalCheck > restoreCall, "repo.worktree_final must run after lockfile restore");
    ok(!/git(?:\.exe)?\s+checkout\s+--\s+pnpm-lock/i.test(orchestrator));
    ok(!orchestrator.includes("Read-Host"));
    ok(!orchestrator.includes("Pause"));
  });

  it("verifies Pixel Strip, Vault Read Bridge, and the Pi timeout source without live Codex UAT", () => {
    ok(orchestrator.includes("examples.pixel_strip"));
    ok(orchestrator.includes("examples.vault_read_bridge"));
    ok(orchestrator.includes("@paperclipai/plugin-pixel-strip-example"));
    ok(orchestrator.includes("@paperclipai/plugin-vault-read-bridge-example"));
    ok(orchestrator.includes("pi.timeout_reliability_source"));
    ok(orchestrator.includes("ac.timeoutSec = 0"));
    ok(orchestrator.includes("resolveAdapterExecutionTargetTimeoutSec"));
    ok(orchestrator.includes("codex.live_uat"));
    ok(orchestrator.includes("not repeated by design"));
    ok(orchestrator.includes("-DesignedSkip"));
  });
});
