#!/usr/bin/env node
/**
 * check-vault-readonly.mjs
 *
 * F1 read-only enforcement lint for @huidots/huidots-console-overview.
 *
 * Scans the package's `src/`, `tests/`, and `scripts/` trees (excluding this
 * script itself and any `dist/` build output) for any reference to a write
 * helper or forbidden capability string:
 *
 *   - writeTextAtomic            (plugin-sdk write helper)
 *   - deleteFile                 (plugin-sdk write helper)
 *   - configure(                 (plugin-sdk configure() entry)
 *   - plugin.localFolders.write  (capability string literal)
 *
 * On any hit, print the relative file path, line number, the offending token,
 * and the line content. Exit code is `1` on a hit, `0` on a clean run, `2`
 * if the lint itself crashes.
 *
 * Pure Node.js (fs + path); no third-party dependencies; Windows-safe (no
 * shell assumptions; uses forward-slash friendly path joining).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");

// Forbidden tokens — any line containing one of these is a violation.
// `configure(` includes the open paren so we only match actual call sites
// (`const x = configure(...)`) and not identifiers like `preConfigure`.
const FORBIDDEN_TOKENS = [
  "writeTextAtomic",
  "deleteFile",
  "configure(",
  "plugin.localFolders.write",
];

// Directories (relative to packageRoot) the lint must scan. `src/ui/**` is
// covered recursively by `src/**` — listing it explicitly is just defensive
// documentation matching the issue spec.
const SCAN_DIRS = ["src", "tests", "scripts"];

// Directory names we never descend into.
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".git", "coverage"]);

// File extensions we never inspect (binary / vendored).
const SKIP_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg",
  ".pdf", ".zip", ".tar", ".gz", ".tgz", ".bz2", ".7z",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".mp3", ".mp4", ".mov", ".wav", ".ogg",
  ".lock", ".map",
]);

// Files we never inspect — this lint script itself is the obvious one
// (FORBIDDEN_TOKENS would otherwise match its own token list).
const SKIP_FILES = new Set([
  path.basename(__filename),
]);

function rel(p) {
  return path.relative(packageRoot, p).split(path.sep).join("/");
}

async function listFiles(rootDir) {
  const out = [];
  async function walk(currentDir) {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SKIP_FILES.has(entry.name)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (SKIP_EXTS.has(ext)) continue;
      out.push(full);
    }
  }
  try {
    const s = await stat(rootDir);
    if (!s.isDirectory()) return out;
  } catch {
    return out;
  }
  await walk(rootDir);
  return out;
}

async function scanFile(file) {
  let content;
  try {
    content = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const hits = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const token of FORBIDDEN_TOKENS) {
      if (line.includes(token)) {
        hits.push({ file, line: i + 1, token, text: line });
      }
    }
  }
  return hits;
}

async function main() {
  const allHits = [];
  for (const dir of SCAN_DIRS) {
    const absDir = path.join(packageRoot, dir);
    const files = await listFiles(absDir);
    for (const file of files) {
      const hits = await scanFile(file);
      allHits.push(...hits);
    }
  }

  if (allHits.length === 0) {
    const summary = "check:vault-readonly: PASS — no forbidden write tokens found in src/, tests/, or scripts/.";
    console.log(summary);
    process.exit(0);
  }

  console.error(`check:vault-readonly: FAIL — ${allHits.length} forbidden token reference(s):`);
  for (const hit of allHits) {
    const display = hit.text.trim();
    console.error(`  ${rel(hit.file)}:${hit.line}  [${hit.token}]  ${display}`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error("check:vault-readonly: lint crashed:", err && err.stack ? err.stack : err);
  process.exit(2);
});
