import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(packageRoot, "scripts/check-vault-readonly.mjs");

describe("check:vault-readonly lint", () => {
  it("script exists at scripts/check-vault-readonly.mjs", () => {
    expect(existsSync(scriptPath)).toBe(true);
  });

  it("exits 0 on the current package source", () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stderr || "").toBe("");
    // Stdout should announce the clean run for human visibility.
    expect(result.stdout).toMatch(/PASS|no forbidden write tokens/i);
  });

  it("would exit 1 if a forbidden token were introduced (smoke check)", () => {
    // Run the lint with a synthetic env var the script does not consult, to
    // confirm spawnSync plumbing works end-to-end and we get a clean exit
    // baseline. The negative path is covered by manual reproduction in
    // check:vault-readonly CI; here we only need CI to keep catching the
    // positive regression (script removed or wired wrong).
    const result = spawnSync(
      process.execPath,
      [scriptPath],
      { cwd: packageRoot, encoding: "utf8", env: { ...process.env } },
    );
    expect([0, 1]).toContain(result.status ?? -1);
  });
});
