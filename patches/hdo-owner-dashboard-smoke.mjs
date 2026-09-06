#!/usr/bin/env node
/**
 * Bounded HuiDots dashboard runtime check.
 *
 * Attaches to the already-running Paperclip URL. Does not start a throwaway
 * Paperclip instance and does not call the repository e2e onboard runner.
 *
 * Distinguishes Cloudflare Access / public login 200 from actual Paperclip
 * application acceptance. HTTP status alone is never treated as app health.
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

const cloudflareAccessPattern =
  /cloudflare access|cf-access|cdn-cgi\/access|cloudflareaccess\.com|Sign in to Cloudflare Access/i;

function emitChecks(checks) {
  process.stdout.write(`HDO_SWEEP_JSON=${JSON.stringify({ checks })}\n`);
}

function loadFailed(detail) {
  emitChecks([
    { name: "dashboard.cloudflare_access", status: "NOT-VERIFIABLE-LOCALLY", detail },
    { name: "dashboard.application", status: "NOT-VERIFIABLE-LOCALLY", detail },
    { name: "dashboard.fatal_console", status: "NOT-VERIFIABLE-LOCALLY", detail },
  ]);
}

let chromium;
try {
  chromium = loadChromium();
} catch (err) {
  loadFailed(err instanceof Error ? err.message : String(err));
  process.exit(0);
}

const pageErrors = [];
const consoleErrors = [];
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
    emitChecks([
      { name: "dashboard.cloudflare_access", status: "FAIL", detail: `no response for ${dashboardUrl}` },
      { name: "dashboard.application", status: "FAIL", detail: "navigation returned no response" },
      { name: "dashboard.fatal_console", status: "FAIL", detail: "navigation returned no response" },
    ]);
    process.exit(0);
  }

  await page.waitForLoadState("load", { timeout: 30_000 }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 2500));

  const snapshot = await page.evaluate(() => ({
    title: document.title ?? "",
    bodyText: document.body?.innerText ?? "",
    rootChars: document.getElementById("root")?.innerHTML.length ?? 0,
    hasPaperclipTheme: Boolean(document.documentElement.dataset.theme) ||
      document.documentElement.classList.contains("dark") ||
      Boolean(document.querySelector('meta[name="theme-color"]')),
    hasPaperclipRoot: Boolean(document.getElementById("root")),
  }));
  const finalUrl = page.url();
  const headerBlob = [
    response.headers()["cf-access-authenticated-user-email"] ?? "",
    response.headers()["cf-ray"] ?? "",
    response.headers()["server"] ?? "",
    finalUrl,
    snapshot.title,
    snapshot.bodyText.slice(0, 2000),
  ].join("\n");

  const accessIntercepted = cloudflareAccessPattern.test(headerBlob);
  const fatal = [...pageErrors, ...consoleErrors].filter((line) => fatalPattern.test(line));
  const appShell =
    snapshot.hasPaperclipRoot &&
    (snapshot.rootChars > 0 || /paperclip/i.test(snapshot.title) || snapshot.hasPaperclipTheme);

  if (accessIntercepted) {
    emitChecks([
      {
        name: "dashboard.cloudflare_access",
        status: "NOT-VERIFIABLE-LOCALLY",
        detail: "Cloudflare Access/login intercepted the page; HTTP 200 is not app health",
      },
      {
        name: "dashboard.application",
        status: "NOT-VERIFIABLE-LOCALLY",
        detail: "did not reach the Paperclip application shell",
      },
      {
        name: "dashboard.fatal_console",
        status: "NOT-VERIFIABLE-LOCALLY",
        detail: "application JS did not run behind Access",
      },
    ]);
    process.exit(0);
  }

  const checks = [
    {
      name: "dashboard.cloudflare_access",
      status: "PASS",
      detail: "no Cloudflare Access intercept",
    },
    appShell
      ? {
          name: "dashboard.application",
          status: "PASS",
          detail: `Paperclip application shell loaded title=${JSON.stringify(snapshot.title)} rootChars=${snapshot.rootChars} http=${response.status()}`,
        }
      : {
          name: "dashboard.application",
          status: "FAIL",
          detail: `public HTTP ${response.status()} without Paperclip application shell (title=${JSON.stringify(snapshot.title)} rootChars=${snapshot.rootChars})`,
        },
    fatal.length > 0
      ? {
          name: "dashboard.fatal_console",
          status: "FAIL",
          detail: fatal[0],
        }
      : {
          name: "dashboard.fatal_console",
          status: appShell ? "PASS" : "FAIL",
          detail: appShell ? "no fatal module-init or guid errors" : "application shell missing; console check is not sufficient alone",
        },
  ];
  emitChecks(checks);
} catch (err) {
  loadFailed(err instanceof Error ? err.message : String(err));
} finally {
  await browser.close();
}
