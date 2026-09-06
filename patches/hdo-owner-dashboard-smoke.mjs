#!/usr/bin/env node
/**
 * Bounded HuiDots dashboard runtime check.
 *
 * Attaches to the already-running Paperclip URL. Does not start a throwaway
 * Paperclip instance and does not call the repository e2e onboard runner.
 */
import { createRequire } from "node:module";
import path from "node:path";

const repoRoot = process.env.PAPERCLIP_REPO ?? process.cwd();
const dashboardUrl = process.env.PAPERCLIP_API ?? "http://127.0.0.1:3100";
const require = createRequire(path.join(repoRoot, "package.json"));

function loadChromium() {
  const errors = [];
  for (const spec of ["playwright", "@playwright/test"]) {
    try {
      const mod = require(spec);
      if (mod?.chromium?.launch) return mod.chromium;
    } catch (err) {
      errors.push(`${spec}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(
    `Playwright Chromium is not available from ${repoRoot}. ${errors.join(" | ")}`,
  );
}

const fatalPattern =
  /guid is not a function|Failed to fetch dynamically imported module|Failed to resolve module|Cannot read propert|SyntaxError|TypeError: .* is not a function/i;

const pageErrors = [];
const consoleErrors = [];
const chromium = loadChromium();
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  page.on("pageerror", (err) => {
    pageErrors.push(String(err?.message ?? err));
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  const response = await page.goto(dashboardUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  if (!response) {
    throw new Error(`Dashboard navigation returned no response for ${dashboardUrl}`);
  }

  await page.waitForLoadState("load", { timeout: 30_000 });
  await new Promise((resolve) => setTimeout(resolve, 2500));

  const bodyText = await page.evaluate(() => document.body?.innerText ?? "");
  const rootHtml = await page.evaluate(() => {
    const root = document.getElementById("root");
    return root ? root.innerHTML.length : 0;
  });
  const title = await page.title();

  const fatal = [...pageErrors, ...consoleErrors].filter((line) => fatalPattern.test(line));
  if (fatal.length > 0) {
    throw new Error(`Dashboard runtime fatal: ${fatal[0]}`);
  }
  if (!title && rootHtml === 0 && bodyText.trim().length === 0) {
    throw new Error("Dashboard loaded an empty document (HTTP status alone is not enough)");
  }

  process.stdout.write(
    `DASHBOARD_SMOKE=PASS status=${response.status()} title=${JSON.stringify(title)} rootChars=${rootHtml}\n`,
  );
} finally {
  await browser.close();
}
