/**
 * Stable identifiers for the F1 console overview plugin.
 *
 * Centralised so worker, UI, and manifest stay in lockstep.
 */

export const PLUGIN_ID = "huidots-console-overview";
export const PLUGIN_VERSION = "0.1.0";
export const PLUGIN_DISPLAY_NAME = "HuiDots Console (Overview)";
export const PLUGIN_DESCRIPTION =
  "Live company state screen: agents, open issues, attention, runs, goals, costs, plus per-project Vault and Pixel Agents placeholders.";

/** Sidebar entry — the "Console" tab in the host app sidebar. */
export const SIDEBAR_SLOT_ID = "console-sidebar-link";
export const SIDEBAR_EXPORT_NAME = "ConsoleSidebarLink";

/** Full-screen overview page that opens from the sidebar tab. */
export const PAGE_SLOT_ID = "console-overview-page";
export const PAGE_EXPORT_NAME = "ConsoleOverviewPage";
export const PAGE_ROUTE = "console";

/** Per-project detail-tab placeholders for F2 / F3 extensions. */
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

export const REFRESH_INTERVAL_MS = 30_000;

/** F2/F3 target date used in the empty-state copy. */
export const EXTENSION_TARGET_DATE_ISO = "2026-09-21";

/**
 * Statuses counted as "open" for the open-issues tile. Matches the URL filter
 * the issue spec calls out (`GET /api/companies/{id}/issues?status=...`).
 */
export const OPEN_ISSUE_STATUSES = ["in_progress", "blocked", "todo", "in_review"] as const;
