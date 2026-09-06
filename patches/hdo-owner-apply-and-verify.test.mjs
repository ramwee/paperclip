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

  it("preflights the HuiDots runtime invariants and fails closed", () => {
    for (const needle of [
      'ExpectedBranch = "examples/pixel-strip-and-vault-read-bridge-clean"',
      'BaseSha = "def9c581b48a1fea845bb7b4a8726e201a3ad5d2"',
      "status",
      "--porcelain",
      "Get-NodeVersion",
      "Get-Command pnpm",
      'ScheduledTaskName = "HuiDots Paperclip"',
      "merge-base --is-ancestor",
      "HDO_OWNER_APPLY=FAIL",
    ]) {
      ok(orchestrator.includes(needle), `missing preflight needle: ${needle}`);
    }
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

  it("repairs deps with CI lockfile policy, asserts Zod 4, and clears Vite optimized deps", () => {
    ok(orchestrator.includes("--no-frozen-lockfile"));
    ok(orchestrator.includes("--resolution-only"));
    ok(orchestrator.includes("Assert-Zod4Runtime"));
    ok(orchestrator.includes("^4.4.3"));
    ok(orchestrator.includes("Clear-ViteOptimizedDeps"));
    ok(orchestrator.includes("node_modules\\.vite"));
  });

  it("reuses the Telegram overlay scripts and does not invent token handling", () => {
    ok(orchestrator.includes("apply-installed.ps1"));
    ok(orchestrator.includes("verify.ps1"));
    ok(orchestrator.includes("patches\\telegram-owner-decision"));
    ok(!/api-key/i.test(orchestrator));
    ok(!/PAPERCLIP_API_KEY/.test(orchestrator));
    ok(!/Bearer /.test(orchestrator));
  });

  it("restarts only the existing HuiDots task and waits for backend readiness", () => {
    ok(orchestrator.includes("schtasks.exe /End /TN"));
    ok(orchestrator.includes("schtasks.exe /Run /TN"));
    ok(!orchestrator.includes("/Change"));
    ok(!orchestrator.includes("Register-ScheduledTask"));
    ok(!orchestrator.includes("New-ScheduledTask"));
    ok(orchestrator.includes("Wait-BackendReady"));
    ok(orchestrator.includes("/api/health"));
  });

  it("uses a safe Playwright attach smoke instead of HTTP-only or throwaway e2e", () => {
    ok(orchestrator.includes("hdo-owner-dashboard-smoke.mjs"));
    ok(smoke.includes("chromium"));
    ok(smoke.includes("pageerror"));
    ok(smoke.includes("guid is not a function"));
    ok(!smoke.includes("reuseExistingServer"));
    ok(!smoke.includes("pnpm paperclipai onboard"));
    ok(!smoke.includes("PAPERCLIP_E2E_PORT"));
  });

  it("verifies Pixel Strip and Vault Read Bridge packages", () => {
    ok(orchestrator.includes("@paperclipai/plugin-pixel-strip-example"));
    ok(orchestrator.includes("@paperclipai/plugin-vault-read-bridge-example"));
    ok(orchestrator.includes("typecheck"));
    ok(orchestrator.includes("plugin-pixel-strip-example"));
    ok(orchestrator.includes("plugin-vault-read-bridge-example"));
  });

  it("ends with one PASS/FAIL summary and does not fabricate Telegram acceptance", () => {
    ok(orchestrator.includes("HDO_OWNER_APPLY=PASS"));
    ok(orchestrator.includes("HDO_OWNER_APPLY=FAIL"));
    ok(orchestrator.includes("OWNER_ACCEPTANCE="));
    ok(orchestrator.includes("does not fabricate"));
    ok(!orchestrator.includes("Read-Host"));
    ok(!orchestrator.includes("Pause"));
  });
});
