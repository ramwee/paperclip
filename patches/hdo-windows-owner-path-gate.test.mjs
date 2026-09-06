import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { match, ok } from "node:assert/strict";
import { findInlineNodeEHazards, findPs51ExpandableScopeErrors } from "./hdo-windows-ps51-scan.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(dir, "..");
const ownerPs1 = [
  path.join(dir, "hdo-owner-apply-and-verify.ps1"),
  path.join(dir, "telegram-owner-decision", "apply-installed.ps1"),
  path.join(dir, "telegram-owner-decision", "verify.ps1"),
  path.join(dir, "hdo-windows-powershell-gate.ps1"),
];
const ownerChanged = [
  ...ownerPs1,
  path.join(dir, "hdo-windows-ps51-scan.mjs"),
  path.join(dir, "hdo-owner-apply-and-verify.test.mjs"),
  path.join(dir, "hdo-owner-dashboard-smoke.mjs"),
  path.join(dir, "hdo-windows-powershell-gate.test.mjs"),
  path.join(dir, "hdo-windows-owner-path-gate.test.mjs"),
  path.join(dir, "telegram-owner-decision", "README.md"),
  path.join(dir, "telegram-owner-decision", "owner-decision-actor.ts"),
  path.join(dir, "telegram-owner-decision", "owner-decision-actor.test.ts"),
  path.join(repo, "server", "src", "services", "plugin-esm-url.ts"),
  path.join(repo, "server", "src", "services", "plugin-loader.ts"),
  path.join(repo, "server", "src", "__tests__", "plugin-loader-windows-esm.test.ts"),
  path.join(repo, "packages", "shared", "src", "constants.ts"),
  path.join(repo, "server", "src", "services", "activity-log.ts"),
  path.join(repo, "packages", "plugins", "examples", "plugin-pixel-strip-example", "package.json"),
  path.join(repo, "packages", "plugins", "examples", "plugin-vault-read-bridge-example", "package.json"),
];

const bootstrapGit =
  "git fetch origin fix/hdo-windows-dashboard-telegram-forward-port:refs/hdo-owner/forward-port; git show refs/hdo-owner/forward-port:patches/hdo-owner-apply-and-verify.ps1 | ";

function commandExists(name) {
  try {
    execFileSync("sh", ["-lc", `command -v ${JSON.stringify(name)}`], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

function resolvePowerShellHost() {
  if (process.platform === "win32" && commandExists("powershell.exe")) {
    return {
      exe: "powershell.exe",
      prefix: "-NoProfile -ExecutionPolicy Bypass -Command -",
    };
  }
  if (commandExists("pwsh")) {
    return { exe: "pwsh", prefix: "-NoProfile -ExecutionPolicy Bypass -Command -" };
  }
  const portable = path.join(os.tmpdir(), "hdo-pwsh", "pwsh");
  if (existsSync(portable)) return { exe: portable, prefix: "-NoProfile -ExecutionPolicy Bypass -Command -" };
  const portableDir = path.join(os.tmpdir(), "hdo-pwsh");
  mkdirSync(portableDir, { recursive: true });
  execFileSync(
    "curl",
    ["-fsSL", "https://github.com/PowerShell/PowerShell/releases/download/v7.5.2/powershell-7.5.2-linux-x64.tar.gz", "-o", path.join(portableDir, "pwsh.tgz")],
    { stdio: "pipe" },
  );
  execFileSync("tar", ["-xzf", path.join(portableDir, "pwsh.tgz"), "-C", portableDir], { stdio: "pipe" });
  chmodSync(portable, 0o755);
  return { exe: portable, prefix: "-NoProfile -ExecutionPolicy Bypass -Command -" };
}

function git(cwd, args) {
  return execFileSync("git", ["-c", "user.name=hdo-gate", "-c", "user.email=hdo@gate.test", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

function writeTree(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

function fixtureFiles() {
  return {
    "package.json": '{"name":"paperclip","private":true}\n',
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "packages/shared/package.json": '{"name":"@paperclipai/shared","dependencies":{"zod":"^4.4.3"}}\n',
    "packages/shared/node_modules/zod/package.json": '{"name":"zod","version":"4.4.3"}\n',
    "server/src/services/plugin-esm-url.ts": "export function toNodeEsmImportUrl() { return pathToFileURL; }\n",
    "server/src/services/plugin-loader.ts": "toNodeEsmImportUrl(DEV_TSX_LOADER_PATH)\n",
    "packages/adapters/pi-local/src/ui/build-config.ts": "ac.timeoutSec = 0\nac.graceSec = 20\n",
    "packages/adapter-utils/src/execution-target.ts": "export function resolveAdapterExecutionTargetTimeoutSec() {}\n",
    "packages/plugins/examples/plugin-pixel-strip-example/package.json":
      '{"name":"@paperclipai/plugin-pixel-strip-example","engines":{"node":">=24.11.0"},"devDependencies":{"@types/node":"^24.0.0"}}\n',
    "packages/plugins/examples/plugin-vault-read-bridge-example/package.json":
      '{"name":"@paperclipai/plugin-vault-read-bridge-example","engines":{"node":">=24.11.0"},"devDependencies":{"@types/node":"^24.0.0"}}\n',
    "patches/hdo-owner-apply-and-verify.ps1": readFileSync(ownerPs1[0], "utf8"),
    "patches/telegram-owner-decision/apply-installed.ps1": readFileSync(ownerPs1[1], "utf8"),
    "patches/telegram-owner-decision/verify.ps1": readFileSync(ownerPs1[2], "utf8"),
    "patches/hdo-owner-dashboard-smoke.mjs": "console.log('synthetic smoke')\n",
  };
}

function createSyntheticCheckout() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "hdo-owner-path-"));
  const remote = path.join(tmp, "remote.git");
  const seed = path.join(tmp, "seed");
  const local = path.join(tmp, "local");
  const bin = path.join(tmp, "bin");
  mkdirSync(bin, { recursive: true });
  const realNode = execFileSync("sh", ["-lc", "command -v node"], { encoding: "utf8" }).trim();
  writeFileSync(
    path.join(bin, "node"),
    `#!/bin/sh\nif [ "$1" = "-v" ]; then echo v24.18.0; exit 0; fi\nexec ${JSON.stringify(realNode)} "$@"\n`,
  );
  writeFileSync(
    path.join(bin, "pnpm"),
    `#!/bin/sh
if printf '%s' "$*" | grep -q -- '--resolution-only'; then
  printf '\\n# synthetic-resolution\\n' >> pnpm-lock.yaml
  exit 0
fi
if [ -n "$HDO_FAKE_TYPECHECK_FAIL" ] && printf '%s' "$*" | grep -q typecheck; then
  echo typecheck failed >&2
  exit 1
fi
exit 0
`,
  );
  chmodSync(path.join(bin, "node"), 0o755);
  chmodSync(path.join(bin, "pnpm"), 0o755);

  git(tmp, ["init", "--bare", remote]);
  git(tmp, ["init", "-b", "examples/pixel-strip-and-vault-read-bridge-clean", seed]);
  writeTree(seed, {
    "package.json": '{"name":"paperclip","private":true}\n',
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "README": "runtime base\n",
  });
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "runtime base"]);
  const baseSha = git(seed, ["rev-parse", "HEAD"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-u", "origin", "HEAD"]);

  git(seed, ["checkout", "-b", "fix/hdo-windows-dashboard-telegram-forward-port"]);
  writeTree(seed, fixtureFiles());
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "forward-port owner path"]);
  git(seed, ["push", "origin", "HEAD"]);

  git(tmp, [
    "clone",
    "--single-branch",
    "--branch",
    "examples/pixel-strip-and-vault-read-bridge-clean",
    remote,
    local,
  ]);
  git(local, [
    "config",
    "remote.origin.fetch",
    "+refs/heads/examples/pixel-strip-and-vault-read-bridge-clean:refs/remotes/origin/examples/pixel-strip-and-vault-read-bridge-clean",
  ]);
  return { tmp, local, bin, baseSha };
}

function runExactBootstrap(local, bin, extraEnv = {}) {
  const host = resolvePowerShellHost();
  const command = `${bootstrapGit}${JSON.stringify(host.exe)} ${host.prefix}`;
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    HDO_SYNTHETIC: "1",
    ...extraEnv,
  };
  try {
    const out = execFileSync("bash", ["-lc", command], { cwd: local, encoding: "utf8", env });
    return { code: 0, out };
  } catch (err) {
    return {
      code: err.status ?? 1,
      out: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  }
}

function assertSectionedReport(out, overall) {
  match(out, /===== HDO ACCEPTANCE SWEEP =====/);
  match(out, new RegExp(`HDO_OWNER_APPLY=${overall}`));
  ok(!/Variable reference is not valid/.test(out), out);
  ok(!/SyntaxError/.test(out), out);
  ok(!/guid is not a function/.test(out), out);
  ok(!/const fs = require\(node:fs\)/.test(out), out);
}

function resolveWindowsPowerShellHost() {
  const host = resolvePowerShellHost();
  return {
    exe: host.exe,
    argsPrefix:
      process.platform === "win32"
        ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]
        : ["-NoProfile", "-NonInteractive"],
  };
}

describe("Windows-native Owner path acceptance", () => {
  it("parses every Owner .ps1 and finds no 5.1 interpolation or node -e hazards in changed files", () => {
    const parseHost = resolveWindowsPowerShellHost();
    const parseOut = execFileSync(
      parseHost.exe,
      [...parseHost.argsPrefix, "-File", path.join(dir, "hdo-windows-powershell-gate.ps1"), "-PaperclipRepo", repo, "-SkipHarness"],
      { encoding: "utf8", cwd: repo },
    );
    match(parseOut, /HDO_WINDOWS_PARSE=PASS/);
    match(parseOut, /hdo-owner-apply-and-verify\.ps1/);
    match(parseOut, /apply-installed\.ps1/);
    match(parseOut, /verify\.ps1/);
    match(parseOut, /hdo-windows-powershell-gate\.ps1/);
    match(parseOut, /HDO_WINDOWS_POWERSHELL_GATE=PASS/);

    const interpolation = [];
    const nodeE = [];
    for (const file of ownerChanged) {
      const text = readFileSync(file, "utf8");
      if (file.endsWith(".ps1")) {
        interpolation.push(...findPs51ExpandableScopeErrors(text, file));
      }
      if (!file.endsWith(".test.mjs") && !file.endsWith("hdo-windows-ps51-scan.mjs")) {
        nodeE.push(...findInlineNodeEHazards(text, file));
      }
    }
    ok(interpolation.length === 0, interpolation.join("\n"));
    ok(nodeE.length === 0, nodeE.join("\n"));

    const orchestrator = readFileSync(ownerPs1[0], "utf8");
    const applyInstalled = readFileSync(ownerPs1[1], "utf8");
    ok(orchestrator.includes("HDO_SYNTHETIC"));
    ok(orchestrator.includes("function Join-RepoPath"));
    ok(orchestrator.includes("${NamePrefix}.presence_policy"));
    ok(applyInstalled.includes("${Path}.ownerdecision.source-control.bak"));
    ok(applyInstalled.includes("[switch]$SkipReadiness"));
    ok(!orchestrator.includes("schtasks.exe /Change"));
    ok(!/git(?:\.exe)?\s+reset/i.test(orchestrator));
    ok(!orchestrator.includes("node -e"));
  });

  it("runs the exact bootstrap on a checkout without origin/fix/... and reports PASS", () => {
    const { tmp, local, bin, baseSha } = createSyntheticCheckout();
    try {
      let originExists = true;
      try {
        git(local, ["rev-parse", "--verify", "origin/fix/hdo-windows-dashboard-telegram-forward-port"]);
      } catch {
        originExists = false;
      }
      ok(!originExists, "fixture must start without origin/fix/...");
      const result = runExactBootstrap(local, bin, { HDO_SYNTHETIC_BASE_SHA: baseSha });
      assertSectionedReport(result.out, "PASS");
      match(result.out, /repo\.fast_forward\s+PASS/);
      match(result.out, /deps\.zod4\s+PASS/);
      match(result.out, /deps\.lockfile_preserved\s+PASS/);
      match(result.out, /deps\.lockfile_restored\s+PASS/);
      match(result.out, /runtime\.mutation_gate\s+PASS/);
      match(result.out, /repo\.worktree_final\s+PASS/);
      ok(!result.out.includes("synthetic-resolution") || !readFileSync(path.join(local, "pnpm-lock.yaml"), "utf8").includes("synthetic-resolution"));
      ok(!readFileSync(path.join(local, "pnpm-lock.yaml"), "utf8").includes("synthetic-resolution"));
      equalishClean(local);
      ok(git(local, ["branch", "--show-current"]) === "examples/pixel-strip-and-vault-read-bridge-clean");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("emits HDO_OWNER_APPLY=FAIL for dirty worktree and typecheck gate failures", () => {
    const { tmp, local, bin, baseSha } = createSyntheticCheckout();
    try {
      writeFileSync(path.join(local, "dirty.txt"), "owner edit\n");
      const dirty = runExactBootstrap(local, bin, { HDO_SYNTHETIC_BASE_SHA: baseSha });
      assertSectionedReport(dirty.out, "FAIL");
      match(dirty.out, /repo\.worktree\s+FAIL/);
      ok(!/Variable reference is not valid/.test(dirty.out));
      rmSync(path.join(local, "dirty.txt"));

      const gated = runExactBootstrap(local, bin, {
        HDO_SYNTHETIC_BASE_SHA: baseSha,
        HDO_FAKE_TYPECHECK_FAIL: "1",
      });
      assertSectionedReport(gated.out, "FAIL");
      match(gated.out, /runtime\.mutation_gate\s+FAIL/);
      match(gated.out, /live HuiDots instance left untouched/);
      ok(!gated.out.includes("schtasks.exe /End"));
      ok(!gated.out.includes("schtasks.exe /Run"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function equalishClean(local) {
  const porcelain = git(local, ["status", "--porcelain"]);
  ok(porcelain === "", `final checkout dirty: ${porcelain}`);
}
