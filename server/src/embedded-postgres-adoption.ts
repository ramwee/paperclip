import { resolve } from "node:path";

export type EmbeddedPostgresAdoptionOptions = {
  expectedDataDir: string;
  probeDataDir: () => Promise<string | null>;
  timeoutMs?: number;
  retryIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  onRetry?: (attempt: number) => void;
};

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));

/**
 * Wait for an already-bound embedded PostgreSQL instance to finish crash
 * recovery, then prove that it owns the expected data directory.
 *
 * A null probe means the server is not protocol-ready yet (including 57P03,
 * "database system is starting up"). A different data directory is terminal:
 * waiting cannot turn an unrelated PostgreSQL server into the expected one.
 */
export async function waitForEmbeddedPostgresAdoption(
  options: EmbeddedPostgresAdoptionOptions,
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const retryIntervalMs = options.retryIntervalMs ?? 250;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  do {
    attempt++;
    const actualDataDir = await options.probeDataDir();
    if (actualDataDir !== null) {
      if (resolve(actualDataDir) !== resolve(options.expectedDataDir)) {
        throw new Error(
          `PostgreSQL on the configured embedded port uses an unexpected data directory: ${actualDataDir}`,
        );
      }
      return actualDataDir;
    }
    options.onRetry?.(attempt);
    if (Date.now() >= deadline) break;
    await sleep(Math.min(retryIntervalMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() <= deadline);

  throw new Error(
    `PostgreSQL on the configured embedded port did not become ready within ${timeoutMs}ms`,
  );
}
