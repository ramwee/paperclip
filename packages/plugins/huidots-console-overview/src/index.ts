/**
 * F1 huidots-console-overview — public entrypoint.
 *
 * Re-exports the worker default export and the four UI components. The
 * Paperclip manifest (`./manifest.ts`) and the SDK build pipeline consume
 * these named exports.
 */

export { default as manifest } from "./manifest.js";
export { default as worker } from "./worker.js";
export {
  ConsoleToolbarButton,
  ConsoleOverviewPage,
  ConsoleProjectVaultTab,
  ConsoleProjectPixelAgentsTab,
} from "./ui/index.js";