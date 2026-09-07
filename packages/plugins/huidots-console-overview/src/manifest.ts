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
  TOOLBAR_BUTTON_EXPORT_NAME,
  TOOLBAR_BUTTON_SLOT_ID,
} from "./constants.js";

/**
 * F1 huidots-console-overview manifest.
 *
 * The plugin ships only what the F1 acceptance criteria require:
 *
 *   - A `globalToolbarButton` slot that mounts the "Console" tab in the host's
 *     top-bar / breadcrumb bar on every page.
 *   - A `page` slot at `routePath: "console"` (resolves to `/:companyPrefix/console`).
 *   - Two `detailTab` slots (Vault and Pixel Agents) that render empty-state
 *     cards until the F2/F3 extension waves ship.
 *   - Capability-gated read access to the six KPI endpoints. Every endpoint is
 *     reached through the host's authenticated bridge — no outbound HTTP, no
 *     local-folder declarations, no host writes.
 *
 * Hard constraints (binding, see HDO-137 spec):
 *   - No schema change in Paperclip core.
 *   - No write to Paperclip from the dashboard plugin (no issues.write,
 *     comments.write, documents.write, no plugin local-folder write).
 *   - No third-party SaaS, no remote vault service, no remote pixel-office
 *     renderer.
 *   - No bundled credentials.
 *   - The plugin declares zero plugin local-folder write capabilities (this
 *     F1 plugin has no local-folder declaration at all).
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
    "ui.action.register",
    "ui.page.register",
    "ui.detailTab.register",
    "companies.read",
    "projects.read",
    "issues.read",
    "agents.read",
    "goals.read",
    "activity.read",
    "attention.read",
    "costs.read",
    "plugin.state.read",
    "events.subscribe",
    "events.emit",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "globalToolbarButton",
        id: TOOLBAR_BUTTON_SLOT_ID,
        displayName: "Console",
        exportName: TOOLBAR_BUTTON_EXPORT_NAME,
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