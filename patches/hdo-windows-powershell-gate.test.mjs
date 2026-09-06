import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { match, ok } from "node:assert/strict";
import { findInlineNodeEHazards, findPs51ExpandableScopeErrors } from "./hdo-windows-ps51-scan.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(dir, "..");
const orchestratorPath = path.join(dir, "hdo-owner-apply-and-verify.ps1");
const applyPath = path.join(dir, "telegram-owner-decision", "apply-installed.ps1");
const verifyPath = path.join(dir, "telegram-owner-decision", "verify.ps1");
const gatePath = path.join(dir, "hdo-windows-powershell-gate.ps1");

const scripts = [
  ["hdo-owner-apply-and-verify.ps1", readFileSync(orchestratorPath, "utf8")],
  ["apply-installed.ps1", readFileSync(applyPath, "utf8")],
  ["verify.ps1", readFileSync(verifyPath, "utf8")],
  ["hdo-windows-powershell-gate.ps1", readFileSync(gatePath, "utf8")],
];

function commandExists(name) {
  try {
    execFileSync("sh", ["-lc", `command -v ${name}`], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

function resolveWindowsPowerShellHost() {
  if (process.platform === "win32" && commandExists("powershell.exe")) {
    return { exe: "powershell.exe", argsPrefix: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"] };
  }
  if (commandExists("pwsh")) {
    return { exe: "pwsh", argsPrefix: ["-NoProfile", "-NonInteractive"] };
  }
  const portableDir = path.join(os.tmpdir(), "hdo-pwsh");
  const portable = path.join(portableDir, "pwsh");
  if (existsSync(portable)) {
    return { exe: portable, argsPrefix: ["-NoProfile", "-NonInteractive"] };
  }
  mkdirSync(portableDir, { recursive: true });
  const url = "https://github.com/PowerShell/PowerShell/releases/download/v7.5.2/powershell-7.5.2-linux-x64.tar.gz";
  execFileSync("curl", ["-fsSL", url, "-o", path.join(portableDir, "pwsh.tgz")], { stdio: "pipe" });
  execFileSync("tar", ["-xzf", path.join(portableDir, "pwsh.tgz"), "-C", portableDir], { stdio: "pipe" });
  chmodSync(portable, 0o755);
  return { exe: portable, argsPrefix: ["-NoProfile", "-NonInteractive"] };
}

describe("Windows PowerShell 5.1 parser and harness gate", () => {
  it("detects the known 5.1 interpolation and node -e hazards", () => {
    const scoped = findPs51ExpandableScopeErrors('throw "$Name failed with exit $code: $text"', "x.ps1");
    ok(scoped.length > 0, "must flag $code:");
    const concat = findPs51ExpandableScopeErrors('$backup = "$Path.ownerdecision.source-control.bak"', "y.ps1");
    ok(concat.length > 0, "must flag $Path.ownerdecision concatenation");
    const nodeE = findInlineNodeEHazards('node -e "console.log(1)"', "z.ps1");
    ok(nodeE.length > 0, "must flag node -e");
  });

  it("rejects expandable $name: constructs the Windows 5.1 parser treats as scoped variables", () => {
    const all = [];
    for (const [file, source] of scripts) {
      all.push(...findPs51ExpandableScopeErrors(source, file));
    }
    ok(all.length === 0, all.join("\n"));
    const nodeE = scripts.flatMap(([file, source]) => findInlineNodeEHazards(source, file));
    ok(nodeE.length === 0, nodeE.join("\n"));
    const orchestrator = scripts[0][1];
    ok(!orchestrator.includes("node -e"), "Zod probe must not use node -e");
    ok(orchestrator.includes("${NamePrefix}.presence_policy"));
    ok(orchestrator.includes("${NamePrefix}.$scriptName"));
    ok(scripts[1][1].includes("${Path}.ownerdecision.source-control.bak"));
    ok(orchestrator.includes("function Get-JsonProperty"));
    ok(orchestrator.includes("ConvertFrom-Json"));
    ok(orchestrator.includes("{0} failed with exit {1}: {2}"));
    ok(orchestrator.includes("-WindowsHarness"));
  });

  it("parses the Owner scripts and executes the non-destructive Zod/overlay harness", () => {
    const host = resolveWindowsPowerShellHost();
    const output = execFileSync(
      host.exe,
      [...host.argsPrefix, "-File", gatePath, "-PaperclipRepo", repo],
      { encoding: "utf8", cwd: repo },
    );
    match(output, /HDO_WINDOWS_PARSE=PASS/);
    match(output, /hdo-owner-apply-and-verify\.ps1/);
    match(output, /apply-installed\.ps1/);
    match(output, /verify\.ps1/);
    match(output, /hdo-windows-powershell-gate\.ps1/);
    match(output, /HDO_WINDOWS_HARNESS_ZOD=ZOD_RUNTIME=4\./);
    match(output, /HDO_WINDOWS_HARNESS_OVERLAY=fail\.ps1 failed with exit 7/);
    match(output, /HDO_WINDOWS_HARNESS=PASS/);
    match(output, /HDO_WINDOWS_POWERSHELL_GATE=PASS/);
    ok(!/Read-Host|Pause/.test(output));
  });

  it("keeps the one-command fail-closed invariants", () => {
    const orchestrator = scripts[0][1];
    ok(orchestrator.includes("===== HDO ACCEPTANCE SWEEP ====="));
    ok(orchestrator.includes("HDO_OWNER_APPLY=$overall"));
    ok(orchestrator.includes('merge", "--ff-only"'));
    ok(!/git(?:\.exe)?\s+checkout/i.test(orchestrator));
    ok(!/git(?:\.exe)?\s+switch/i.test(orchestrator));
    ok(!/git(?:\.exe)?\s+reset/i.test(orchestrator));
    ok(orchestrator.includes('Stop-Unsafe -Name "tooling.node_policy"'));
    ok(orchestrator.includes('Stop-Unsafe -Name "deps.lockfile_preserved"'));
    ok(orchestrator.includes("runtime.mutation_gate"));
    ok(orchestrator.includes("-SkipReadiness"));
    ok(!orchestrator.includes("Read-Host"));
    ok(!orchestrator.includes("Pause"));
  });
});
