import { describe, expect, it, vi } from "vitest";
import { waitForEmbeddedPostgresAdoption } from "../embedded-postgres-adoption.js";

describe("waitForEmbeddedPostgresAdoption", () => {
  it("waits through crash recovery until PostgreSQL reports its data directory", async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue("C:\\paperclip\\db");
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(waitForEmbeddedPostgresAdoption({
      expectedDataDir: "C:\\paperclip\\db",
      probeDataDir: probe,
      timeoutMs: 10_000,
      retryIntervalMs: 1,
      sleep,
    })).resolves.toBe("C:\\paperclip\\db");

    expect(probe).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the port belongs to another PostgreSQL data directory", async () => {
    await expect(waitForEmbeddedPostgresAdoption({
      expectedDataDir: "C:\\paperclip\\db",
      probeDataDir: async () => "C:\\other\\db",
    })).rejects.toThrow("unexpected data directory");
  });

  it("times out instead of allowing a duplicate postmaster startup", async () => {
    await expect(waitForEmbeddedPostgresAdoption({
      expectedDataDir: "C:\\paperclip\\db",
      probeDataDir: async () => null,
      timeoutMs: 0,
      sleep: async () => undefined,
    })).rejects.toThrow("did not become ready");
  });
});
