/**
 * Stable identifiers for the F1 huidots-console-overview plugin.
 *
 * Centralised so worker, UI, and manifest stay in lockstep.
 */

export const PLUGIN_ID = "huidots-console-overview";
export const PLUGIN_VERSION = "0.2.0";
export const PLUGIN_DISPLAY_NAME = "HuiDots Console";
export const PLUGIN_DESCRIPTION =
  "Live company state screen — agents, open issues, attention, runs, goals, costs. Read-only; no host writes, no local-folder, no outbound HTTP. The Vault and Pixel Agents detail tabs render an empty-state card until the F2/F3 extensions land.";

/**
 * Top-bar "Console" button. Mounts in the host's global toolbar (breadcrumb
 * bar) on every page. Renders a tab that deep-links to the Console overview
 * page at `/:companyPrefix/console`.
 */
export const TOOLBAR_BUTTON_SLOT_ID = "console-toolbar-button";
export const TOOLBAR_BUTTON_EXPORT_NAME = "ConsoleToolbarButton";

/** Full-screen overview page that opens from the top-bar tab. */
export const PAGE_SLOT_ID = "console-overview-page";
export const PAGE_EXPORT_NAME = "ConsoleOverviewPage";
export const PAGE_ROUTE = "console";

/** Per-project detail-tab scaffolding. Both render empty-state cards today. */
export const PROJECT_TAB_VAULT_SLOT_ID = "console-project-vault-tab";
export const PROJECT_TAB_VAULT_EXPORT_NAME = "ConsoleProjectVaultTab";

export const PROJECT_TAB_PIXEL_AGENTS_SLOT_ID = "console-project-pixel-agents-tab";
export const PROJECT_TAB_PIXEL_AGENTS_EXPORT_NAME = "ConsoleProjectPixelAgentsTab";

/** Names of the six KPI tiles — also used as getData keys. */
export const KPI_KEYS = {
  agents: "agents",
  openIssuesByStatus: "openIssuesByStatus",
  attention: "attention",
  runs: "runs",
  goals: "goals",
  costs: "costs",
} as const;

export type KpiKey = (typeof KPI_KEYS)[keyof typeof KPI_KEYS];

/** 30-second refresh interval for the server tick and the UI consumer. */
export const REFRESH_INTERVAL_MS = 30_000;

/** F2/F3 target date used in the empty-state copy. */
export const EXTENSION_TARGET_DATE_ISO = "2026-09-21";

/**
 * Statuses counted as "open" for the open-issues tile. Matches the URL filter
 * the issue spec calls out (`GET /api/companies/{id}/issues?status=...`).
 */
export const OPEN_ISSUE_STATUSES = ["in_progress", "blocked", "todo", "in_review"] as const;

/**
 * Bare event name emitted by the worker's 30-second interval. The SDK
 * namespaces it to `plugin.<pluginId>.tick` on the wire.
 */
export const TICK_EVENT = "tick";
export const TICK_CHANNEL = `plugin.${PLUGIN_ID}.${TICK_EVENT}`;