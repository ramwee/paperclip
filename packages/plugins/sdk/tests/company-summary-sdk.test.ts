import { describe, expect, it } from "vitest";

import { createTestHarness } from "../src/testing.js";
import type {
  PluginAttentionFeed,
  PluginCostsSummary,
  PluginTimelineFeed,
  PaperclipPluginManifestV1,
} from "../src/types.js";

const baseManifest = {
  id: "paperclip.company-summary",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Company Summary",
  description: "Verifies the attention/timeline/costs bridges on ctx.companies",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["attention.read", "activity.read", "costs.read"],
  entrypoints: {},
} satisfies PaperclipPluginManifestV1;

describe("ctx.companies attention/timeline/costs bridges", () => {
  const companyId = "00000000-0000-0000-0000-000000000001";

  const seededAttention: PluginAttentionFeed = {
    items: [
      {
        id: "approval:abc",
        sourceKind: "approval",
        sourceId: "abc",
        subject: {
          kind: "approval",
          id: "abc",
          title: "Pending approval",
          identifier: null,
          status: "pending",
        },
        shelf: "false",
        state: "pending",
        activityAt: "2026-09-08T05:00:00.000Z",
        retentionVersion: 1,
        archivedAt: null,
      },
    ],
    nextCursor: null,
    generatedAt: "2026-09-08T05:50:00.000Z",
  };

  const seededTimeline: PluginTimelineFeed = {
    events: [
      {
        id: "issue-1:created:0",
        kind: "created",
        occurredAt: "2026-09-08T05:00:00.000Z",
        companyId,
        actor: { type: "agent", id: "agent-1", name: "CTO" },
        target: { type: "issue", id: "issue-1", identifier: "PAP-1", title: "First issue" },
        payload: {},
      },
    ],
    nextOffset: null,
    generatedAt: "2026-09-08T05:50:00.000Z",
  };

  const seededCosts: PluginCostsSummary = {
    companyId,
    range: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-08T05:50:00.000Z" },
    totalCostCents: 1234,
    byAgent: [{ agentId: "agent-1", agentName: "CTO", costCents: 1234 }],
    byProvider: [{ provider: "anthropic", costCents: 1234 }],
    generatedAt: "2026-09-08T05:50:00.000Z",
  };

  it("returns the seeded attention feed through ctx.companies.attention.list", async () => {
    const harness = createTestHarness({ manifest: baseManifest });
    harness.seed({ attentionFeeds: [{ companyId, feed: seededAttention }] });

    const feed = await harness.ctx.companies.attention.list({ companyId });
    expect(feed).toEqual(seededAttention);
  });

  it("returns the seeded timeline feed through ctx.companies.timeline.list", async () => {
    const harness = createTestHarness({ manifest: baseManifest });
    harness.seed({ timelineFeeds: [{ companyId, feed: seededTimeline }] });

    const feed = await harness.ctx.companies.timeline.list({ companyId });
    expect(feed).toEqual(seededTimeline);
  });

  it("returns the seeded cost summary through ctx.companies.costs.summary", async () => {
    const harness = createTestHarness({ manifest: baseManifest });
    harness.seed({ costsSummaries: [{ companyId, summary: seededCosts }] });

    const summary = await harness.ctx.companies.costs.summary({ companyId });
    expect(summary).toEqual(seededCosts);
  });

  it("rejects attention.list when the manifest lacks attention.read", async () => {
    const harness = createTestHarness({
      manifest: {
        ...baseManifest,
        capabilities: ["activity.read", "costs.read"],
      },
    });
    harness.seed({ attentionFeeds: [{ companyId, feed: seededAttention }] });

    await expect(harness.ctx.companies.attention.list({ companyId })).rejects.toThrow(/attention\.read/);
  });

  it("rejects timeline.list when the manifest lacks activity.read", async () => {
    const harness = createTestHarness({
      manifest: {
        ...baseManifest,
        capabilities: ["attention.read", "costs.read"],
      },
    });
    harness.seed({ timelineFeeds: [{ companyId, feed: seededTimeline }] });

    await expect(harness.ctx.companies.timeline.list({ companyId })).rejects.toThrow(/activity\.read/);
  });

  it("rejects costs.summary when the manifest lacks costs.read", async () => {
    const harness = createTestHarness({
      manifest: {
        ...baseManifest,
        capabilities: ["attention.read", "activity.read"],
      },
    });
    harness.seed({ costsSummaries: [{ companyId, summary: seededCosts }] });

    await expect(harness.ctx.companies.costs.summary({ companyId })).rejects.toThrow(/costs\.read/);
  });

  it("returns empty payloads when nothing is seeded for a company", async () => {
    const harness = createTestHarness({ manifest: baseManifest });

    const attention = await harness.ctx.companies.attention.list({ companyId });
    expect(attention.items).toEqual([]);
    expect(attention.nextCursor).toBeNull();

    const timeline = await harness.ctx.companies.timeline.list({ companyId });
    expect(timeline.events).toEqual([]);
    expect(timeline.nextOffset).toBeNull();

    const costs = await harness.ctx.companies.costs.summary({ companyId });
    expect(costs.totalCostCents).toBe(0);
    expect(costs.byAgent).toEqual([]);
    expect(costs.byProvider).toEqual([]);
    expect(costs.companyId).toBe(companyId);
  });
});
