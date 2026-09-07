import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  PAGE_EXPORT_NAME,
  PAGE_ROUTE,
  PAGE_SLOT_ID,
  PLUGIN_DESCRIPTION,
  PLUGIN_DISPLAY_NAME,
  PLUGIN_ID,
  PLUGIN_VERSION,
  PROJECT_TAB_PIXEL_AGENTS_EXPORT_NAME,
  PROJECT_TAB_PIXEL_AGENTS_SLOT_ID,
  PROJECT_TAB_VAULT_EXPORT_NAME,
  PROJECT_TAB_VAULT_SLOT_ID,
  SIDEBAR_EXPORT_NAME,
  SIDEBAR_SLOT_ID,
} from "./constants.js";

/**
 * F1 huidots-console-overview manifest.
 *
 * Constraints (binding, see HDO-137 / HDO-117.C1):
 *   - read-only host data flow (no issues.write / comments.write / documents.write)
 *   - zero localFolders.write capabilities (the F1 plugin has no
 *     localFolders declaration at all)
 *   - no bundled credentials (all Paperclip API calls use the host's
 *     authenticated context client)
 *
 * The plugin contributes four UI slots:
 *   - `sidebar`        → top-bar "Console" tab in the app sidebar
 *   - `page`           → the live company-state screen reached from that tab
 *   - `detailTab`      → two per-project placeholder tabs (Vault, Pixel Agents)
 *     reserved for the F3 / F2 extension waves on 2026-09-21.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: PLUGIN_DISPLAY_NAME,
  description: PLUGIN_DESCRIPTION,
  author: "HuiDots",
  categories: ["ui"],
  minimumHostVersion: ">=2026.09.04",
  capabilities: [
    "ui.sidebar.register",
    "ui.page.register",
    "ui.detailTab.register",
    "companies.read",
    "projects.read",
    "issues.read",
    "agents.read",
    "goals.read",
    "costs.read",
    "activity.read",
    "plugin.state.read",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "sidebar",
        id: SIDEBAR_SLOT_ID,
        displayName: "Console",
        exportName: SIDEBAR_EXPORT_NAME,
        order: 5,
      },
      {
        type: "page",
        id: PAGE_SLOT_ID,
        displayName: "Console Overview",
        exportName: PAGE_EXPORT_NAME,
        routePath: PAGE_ROUTE,
        order: 10,
      },
      {
        type: "detailTab",
        id: PROJECT_TAB_VAULT_SLOT_ID,
        displayName: "Vault",
        exportName: PROJECT_TAB_VAULT_EXPORT_NAME,
        entityTypes: ["project"],
        order: 50,
      },
      {
        type: "detailTab",
        id: PROJECT_TAB_PIXEL_AGENTS_SLOT_ID,
        displayName: "Pixel Agents",
        exportName: PROJECT_TAB_PIXEL_AGENTS_EXPORT_NAME,
        entityTypes: ["project"],
        order: 51,
      },
    ],
  },
};

export default manifest;
