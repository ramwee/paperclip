import { pathToFileURL } from "node:url";

/**
 * Convert a filesystem path into a `file://` URL suitable for Node's
 * `--import` / dynamic `import()`. On Windows, bare absolute paths such as
 * `C:\...` throw `ERR_UNSUPPORTED_ESM_URL_SCHEME`; `pathToFileURL().href`
 * is required. On POSIX the result is still a `file://` URL, so this is
 * safe cross-platform.
 *
 * @see paperclipai/paperclip@ac46bc26187dd93b798ae5a5ae49e729bfa7f7f7
 */
export function toNodeEsmImportUrl(filePath: string): string {
  return pathToFileURL(filePath).href;
}
