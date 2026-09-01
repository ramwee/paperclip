import { describe, expect, it } from "vitest";

import {
  PAPERCLIP_RUNNER_DEFAULT_MODELS,
  isPaperclipRunnerProvider,
  resolvePaperclipRunnerModel,
  resolvePaperclipRunnerPermissionMode,
} from "./paperclip-runner-permissions.js";

describe("Paperclip Runner permission defaults", () => {
  it("defaults Codex to approval for untrusted operations", () => {
    expect(resolvePaperclipRunnerPermissionMode("codex", undefined)).toBe(
      "untrusted",
    );
  });

  it("uses interactive defaults for dormant non-Codex providers", () => {
    expect(resolvePaperclipRunnerPermissionMode("opencode", undefined)).toBe(
      "ask",
    );
    expect(resolvePaperclipRunnerPermissionMode("acpx", undefined)).toBe(
      "approve-reads",
    );
  });

  it("recognizes only exact provider identifiers", () => {
    expect(isPaperclipRunnerProvider("codex")).toBe(true);
    expect(isPaperclipRunnerProvider("opencode")).toBe(true);
    expect(isPaperclipRunnerProvider("acpx")).toBe(true);
    expect(isPaperclipRunnerProvider("toString")).toBe(false);
    expect(isPaperclipRunnerProvider("__proto__")).toBe(false);
  });

  it("uses the Codex default for missing or blank models", () => {
    expect(resolvePaperclipRunnerModel("codex", undefined)).toBe(
      PAPERCLIP_RUNNER_DEFAULT_MODELS.codex,
    );
    expect(resolvePaperclipRunnerModel("codex", "   ")).toBe(
      PAPERCLIP_RUNNER_DEFAULT_MODELS.codex,
    );
  });

  it("preserves an explicit Codex model", () => {
    expect(resolvePaperclipRunnerModel("codex", "gpt-5.5")).toBe("gpt-5.5");
    expect(resolvePaperclipRunnerModel("codex", "  gpt-5.5  ")).toBe("gpt-5.5");
  });
});
