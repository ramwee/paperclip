/**
 * Package entrypoint. The `paperclipPlugin` field in `package.json` resolves
 * `manifest`, `worker`, and `ui` relative to this file, so re-exporting the
 * manifest here keeps a single source of truth.
 */
export { default as manifest } from "./manifest.js";
export { default } from "./worker.js";
