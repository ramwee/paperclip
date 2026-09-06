import path from "node:path";
import { describe, expect, it } from "vitest";
import { toNodeEsmImportUrl } from "../services/plugin-esm-url.js";

describe("plugin-loader Windows ESM import URL", () => {
  it("converts absolute loader paths to file:// URLs for --import", () => {
    const loaderPath = path.resolve("/tmp/paperclip-tsx-loader.mjs");
    const importArg = toNodeEsmImportUrl(loaderPath);

    expect(importArg.startsWith("file:")).toBe(true);
    expect(importArg).toContain("://");
    // Bare drive-letter / absolute filesystem paths must never be passed to --import.
    expect(importArg).not.toMatch(/^[A-Za-z]:[\\/]/);
    expect(importArg).not.toBe(loaderPath);
  });

  it("keeps Windows-style absolute paths off the bare path form when platform is win32", () => {
    if (process.platform !== "win32") {
      const posixArg = toNodeEsmImportUrl(path.resolve("/usr/local/tsx/dist/loader.mjs"));
      expect(posixArg.startsWith("file://")).toBe(true);
      return;
    }

    const windowsLoaderPath =
      "C:\\Users\\admin\\Documents\\Paperclip\\cli\\node_modules\\tsx\\dist\\loader.mjs";
    const importArg = toNodeEsmImportUrl(windowsLoaderPath);
    expect(importArg.startsWith("file:///")).toBe(true);
    expect(importArg).toMatch(/^file:\/\/\/[A-Za-z]:\//);
    expect(importArg).not.toMatch(/^C:\\/);
  });
});
