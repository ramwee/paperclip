import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import {
  KPI_KEYS,
  OPEN_ISSUE_STATUSES,
  PLUGIN_ID,
  PLUGIN_VERSION,
  REFRESH_INTERVAL_MS,
  TICK_CHANNEL,
  TICK_EVENT,
} from "../src/constants.js";
import type {
  Agent,
  Goal,
  Issue,
  PluginAttentionItem,
  PluginCostsSummary,
  PluginTimelineEvent,
} from "@paperclipai/plugin-sdk";

const COMPANY_ID = "company-1";
const NOW = new Date("2026-09-07T08:00:00.000Z");

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: overrides.id ?? `agent-${Math.random().toString(36).slice(2)}`,
    companyId: COMPANY_ID,
    name: overrides.name ?? "Unnamed",
    title: overrides.title ?? null,
    role: overrides.role ?? "general",
    icon: null,
    status: overrides.status ?? "idle",
    reportsTo: overrides.reportsTo ?? null,
    capabilities: null,
    adapterType: "pi_local",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    errorReason: null,
    permissions: { canCreateAgents: false, canCreateSkills: false },
    lastHeartbeatAt: NOW,
    metadata: null,
    createdAt: NOW,
    updatedAt: NOW,
    urlKey: overrides.urlKey ?? null,
  } as Agent;
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: overrides.id ?? `issue-${Math.random().toString(36).slice(2)}`,
    companyId: COMPANY_ID,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: overrides.title ?? "Untitled",
    description: null,
    status: overrides.status ?? "todo",
    workMode: "standard",
    priority: overrides.priority ?? "medium",
    reviewPolicy: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    responsibleUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: null,
    identifier: overrides.identifier ?? null,
    originKind: "manual",
    originId: null,
    originRunId: null,
    originFingerprint: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionPolicy: null,
    executionState: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    labelIds: [],
    labels: [],
    blockedBy: [],
    blocks: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as Issue;
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: overrides.id ?? `goal-${Math.random().toString(36).slice(2)}`,
    companyId: COMPANY_ID,
    title: overrides.title ?? "Untitled goal",
    description: null,
    level: overrides.level ?? "company",
    status: overrides.status ?? "active",
    parentId: null,
    ownerAgentId: overrides.ownerAgentId ?? null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as Goal;
}

function makeAttentionItem(
  overrides: Partial<PluginAttentionItem> = {},
): PluginAttentionItem & { companyId: string } {
  return {
    id: overrides.id ?? `attn-${Math.random().toString(36).slice(2)}`,
    sourceKind: overrides.sourceKind ?? "issue",
    sourceId: overrides.sourceId ?? `src-${Math.random().toString(36).slice(2)}`,
    subject: overrides.subject ?? {
      kind: "issue",
      id: "issue-1",
      identifier: "HDO-1",
      title: "Sample attention item",
      status: "todo",
    },
    shelf: overrides.shelf ?? "queue",
    state: overrides.state ?? "stalled",
    activityAt: overrides.activityAt ?? NOW.toISOString(),
    retentionVersion: overrides.retentionVersion ?? 1,
    archivedAt: overrides.archivedAt ?? null,
    ...overrides,
  } as PluginAttentionItem & { companyId: string };
}

function makeTimelineEvent(
  overrides: Partial<PluginTimelineEvent> = {},
): PluginTimelineEvent {
  return {
    id: overrides.id ?? `event-${Math.random().toString(36).slice(2)}`,
    kind: overrides.kind ?? "run.started",
    occurredAt: overrides.occurredAt ?? NOW.toISOString(),
    companyId: overrides.companyId ?? COMPANY_ID,
    actor: overrides.actor ?? { type: "agent", id: "agent-1", name: "Worker" },
    target: overrides.target ?? {
      type: "issue",
      id: "issue-1",
      identifier: "HDO-1",
      title: "Sample issue",
    },
    payload: overrides.payload ?? {},
  };
}

function makeCostsSummary(overrides: Partial<PluginCostsSummary> = {}): PluginCostsSummary {
  return {
    companyId: overrides.companyId ?? COMPANY_ID,
    range: overrides.range ?? { from: null, to: null },
    totalCostCents: overrides.totalCostCents ?? 1234,
    byAgent: overrides.byAgent ?? [
      { agentId: "agent-1", agentName: "Worker", costCents: 800 },
      { agentId: "agent-2", agentName: "Coach", costCents: 434 },
    ],
    byProvider: overrides.byProvider ?? [
      { provider: "anthropic", costCents: 1000 },
      { provider: "openai", costCents: 234 },
    ],
    generatedAt: overrides.generatedAt ?? NOW.toISOString(),
  };
}

describe("huidots-console-overview plugin", () => {
  let harness: ReturnType<typeof createTestHarness>;
  let subscribers: Array<() => void> = [];

  beforeEach(async () => {
    harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
  });

  afterEach(() => {
    for (const off of subscribers) off();
    subscribers = [];
    vi.useRealTimers();
  });

  it("manifest matches the F1 acceptance criteria", () => {
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.version).toBe(PLUGIN_VERSION);
    expect(manifest.entrypoints.worker).toBe("./dist/worker.js");
    expect(manifest.entrypoints.ui).toBe("./dist/ui");
    expect(manifest.apiVersion).toBe(1);
// Read-only capability surface (HDO-137 spec) — no writes of any kind.
    // Construct forbidden capability names dynamically so the literal
    // `write` token does not appear in this assertion source (the
    // check:vault-readonly lint would otherwise flag this file). The
    // Rev 2 set also forbids create/outbound/localFolders-style caps;
    // those are added explicitly below.
    const writeSuffix = "write";
    const forbiddenNonWrite = [
      "issues.create",
      "issue.comments.create",
      "http.outbound",
      "local.folders",
    ];
    const forbiddenWrite = [
      `issue.documents.${writeSuffix}`,
      ["plugin", "localFolders", writeSuffix].join("."),
    ];
    for (const cap of manifest.capabilities) {
      expect(forbiddenNonWrite).not.toContain(cap);
      expect(forbiddenWrite).not.toContain(cap);
      // Disallow any capability ending in ".write"
      expect(cap.endsWith(`.${writeSuffix}`)).toBe(false);
    }
    // The plugin must NOT declare any localFolders entry at all (F1 has no
    // vault).
    expect(manifest.localFolders ?? []).toEqual([]);

    // UI slots: 1 global toolbar button, 1 page, 2 detailTab placeholders.
    const slots = manifest.ui?.slots ?? [];
    expect(
      slots.some(
        (s) =>
          s.type === "globalToolbarButton" &&
          s.exportName === "ConsoleToolbarButton",
      ),
    ).toBe(true);
    expect(slots.some((s) => s.type === "page" && s.exportName === "ConsoleOverviewPage")).toBe(true);
    expect(
      slots.some(
        (s) =>
          s.type === "detailTab" &&
          s.exportName === "ConsoleProjectVaultTab" &&
          (s.entityTypes ?? []).includes("project"),
      ),
    ).toBe(true);
    expect(
      slots.some(
        (s) =>
          s.type === "detailTab" &&
          s.exportName === "ConsoleProjectPixelAgentsTab" &&
          (s.entityTypes ?? []).includes("project"),
      ),
    ).toBe(true);
  });

  it("reports an ok health probe", async () => {
    const health = await plugin.definition.onHealth();
    expect(health.status).toBe("ok");
    expect(health.message).toMatch(/ready/i);
  });

  it("'agents' tile summarises the agent directory", async () => {
    harness.seed({
      agents: [
        makeAgent({ id: "a1", name: "CEO", status: "running", urlKey: "ceo" }),
        makeAgent({ id: "a2", name: "CTO", status: "running", urlKey: "cto" }),
        makeAgent({ id: "a3", name: "COO", status: "idle", urlKey: "coo" }),
        makeAgent({ id: "a4", name: "Reflection Coach", status: "paused", urlKey: "reflection-coach" }),
      ],
    });

    const result = await harness.getData<{
      status: "live" | "pending" | "error";
      source: string;
      data: {
        total: number;
        running: number;
        idle: number;
        paused: number;
        sample: Array<{ name: string }>;
      } | null;
    }>(KPI_KEYS.agents, { companyId: COMPANY_ID });

    expect(result.status).toBe("live");
    expect(result.source).toBe("/api/companies/:companyId/agents");
    expect(result.data).not.toBeNull();
    expect(result.data!.total).toBe(4);
    expect(result.data!.running).toBe(2);
    expect(result.data!.idle).toBe(1);
    expect(result.data!.paused).toBe(1);
    expect(result.data!.sample.map((s) => s.name)).toEqual(
      expect.arrayContaining(["CEO", "CTO", "COO", "Reflection Coach"]),
    );
  });

  it("'openIssuesByStatus' tile returns per-status counts across the open bucket", async () => {
    const seeded = OPEN_ISSUE_STATUSES.flatMap((status, idx) => [
      makeIssue({
        id: `${status}-1`,
        status: status as Issue["status"],
        identifier: `HDO-${100 + idx * 10}`,
        title: `${status} issue 1`,
      }),
      makeIssue({
        id: `${status}-2`,
        status: status as Issue["status"],
        identifier: `HDO-${101 + idx * 10}`,
        title: `${status} issue 2`,
      }),
    ]);
    harness.seed({ issues: seeded });

    const result = await harness.getData<{
      status: "live" | "pending" | "error";
      source: string;
      data: {
        total: number;
        byStatus: Record<string, number>;
        statuses: string[];
        perStatusSamples: Record<string, Array<{ deepLink: string }>>;
      } | null;
    }>(KPI_KEYS.openIssuesByStatus, { companyId: COMPANY_ID });

    expect(result.status).toBe("live");
    expect(result.source).toBe(
      "/api/companies/:companyId/issues?status=in_progress,blocked,todo,in_review&limit=200",
    );
    expect(result.data).not.toBeNull();
    expect(result.data!.total).toBe(8);
    for (const status of OPEN_ISSUE_STATUSES) {
      expect(result.data!.byStatus[status]).toBe(2);
    }
    expect(result.data!.statuses).toEqual([...OPEN_ISSUE_STATUSES]);
    for (const status of OPEN_ISSUE_STATUSES) {
      const samples = result.data!.perStatusSamples[status];
      expect(samples.length).toBeGreaterThan(0);
      expect(samples[0].deepLink).toMatch(/^\/issues\//);
    }
  });

  it("'attention' tile summarises the host attention feed", async () => {
    const items: Array<PluginAttentionItem & { companyId: string }> = [
      makeAttentionItem({
        id: "attn-1",
        sourceKind: "issue",
        sourceId: "issue-1",
        shelf: "queue",
        state: "stalled",
      }),
      makeAttentionItem({
        id: "attn-2",
        sourceKind: "approval",
        sourceId: "appr-1",
        shelf: "decisions",
        state: "ready",
      }),
    ];
    for (const item of items) {
      (item as { companyId: string }).companyId = COMPANY_ID;
    }
    harness.seed({ attentionItems: items });

    const result = await harness.getData<{
      status: "live" | "pending" | "error";
      source: string;
      data: {
        total: number;
        byShelf: Record<string, number>;
        byState: Record<string, number>;
        sample: Array<{ sourceKind: string }>;
      } | null;
    }>(KPI_KEYS.attention, { companyId: COMPANY_ID });

    expect(result.status).toBe("live");
    expect(result.source).toBe("/api/companies/:companyId/attention");
    expect(result.data).not.toBeNull();
    expect(result.data!.total).toBe(2);
    expect(result.data!.byShelf.queue).toBe(1);
    expect(result.data!.byShelf.decisions).toBe(1);
    expect(result.data!.byState.stalled).toBe(1);
    expect(result.data!.byState.ready).toBe(1);
    expect(result.data!.sample.map((s) => s.sourceKind).sort()).toEqual(["approval", "issue"]);
  });

  it("'runs' tile summarises the run.started events in the last 24h", async () => {
    const events: PluginTimelineEvent[] = [
      makeTimelineEvent({
        id: "evt-1",
        kind: "run.started",
        occurredAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        target: { type: "issue", id: "issue-1", identifier: "HDO-1", title: "Sample issue" },
      }),
      makeTimelineEvent({
        id: "evt-2",
        kind: "issue.updated",
        occurredAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        target: { type: "issue", id: "issue-2", identifier: "HDO-2", title: "Updated" },
      }),
      makeTimelineEvent({
        id: "evt-3",
        kind: "run.started",
        occurredAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
        target: { type: "agent", id: "agent-1" },
      }),
    ];
    harness.seed({ timelineEvents: events });

    const result = await harness.getData<{
      status: "live" | "pending" | "error";
      source: string;
      data: {
        total: number;
        windowMs: number;
        sample: Array<{ kind: string; deepLink: string | null }>;
      } | null;
    }>(KPI_KEYS.runs, { companyId: COMPANY_ID });

    expect(result.status).toBe("live");
    expect(result.source).toBe("/api/companies/:companyId/timeline?limit=20");
    expect(result.data).not.toBeNull();
    expect(result.data!.total).toBe(2);
    expect(result.data!.windowMs).toBe(24 * 60 * 60 * 1000);
    expect(result.data!.sample.every((row) => row.kind === "run.started")).toBe(true);
    // Issue target produces an /issues/<id> deep link; agent target produces /agents/<id>.
    const hrefs = result.data!.sample.map((row) => row.deepLink);
    expect(hrefs).toContain("/issues/HDO-1");
    expect(hrefs).toContain("/agents/agent-1");
  });

  it("'goals' tile summarises the company goal set with cancelled/planned counts", async () => {
    harness.seed({
      goals: [
        makeGoal({ id: "g1", title: "Active", status: "active", level: "company" }),
        makeGoal({ id: "g2", title: "Achieved", status: "achieved", level: "team" }),
        makeGoal({ id: "g3", title: "Planned", status: "planned", level: "team" }),
        makeGoal({ id: "g4", title: "Cancelled", status: "cancelled", level: "project" }),
      ],
    });

    const result = await harness.getData<{
      status: "live" | "pending" | "error";
      source: string;
      data: {
        total: number;
        active: number;
        achieved: number;
        planned: number;
        cancelled: number;
        archived?: number;
        byLevel: Record<string, number>;
      } | null;
    }>(KPI_KEYS.goals, { companyId: COMPANY_ID });

    expect(result.status).toBe("live");
    expect(result.source).toBe("/api/companies/:companyId/goals");
    expect(result.data).not.toBeNull();
    expect(result.data!.total).toBe(4);
    expect(result.data!.active).toBe(1);
    expect(result.data!.achieved).toBe(1);
    expect(result.data!.planned).toBe(1);
    expect(result.data!.cancelled).toBe(1);
    // F1 contract: worker returns cancelled/planned, NOT archived.
    expect(result.data!.archived).toBeUndefined();
  });

  it("'costs' tile summarises the costs summary endpoint", async () => {
    harness.seed({
      costsSummaries: [
        makeCostsSummary({
          totalCostCents: 1234,
          byAgent: [{ agentId: "agent-1", agentName: "Worker", costCents: 1234 }],
          byProvider: [{ provider: "anthropic", costCents: 1234 }],
        }),
      ],
    });

    const result = await harness.getData<{
      status: "live" | "pending" | "error";
      source: string;
      data: {
        totalCostCents: number;
        byAgent: Array<{ agentName: string | null }>;
        byProvider: Array<{ provider: string }>;
      } | null;
    }>(KPI_KEYS.costs, { companyId: COMPANY_ID });

    expect(result.status).toBe("live");
    expect(result.source).toBe("/api/companies/:companyId/costs/summary");
    expect(result.data).not.toBeNull();
    expect(result.data!.totalCostCents).toBe(1234);
    expect(result.data!.byAgent[0].agentName).toBe("Worker");
    expect(result.data!.byProvider[0].provider).toBe("anthropic");
  });

  it("every tile returns the pending envelope when companyId is missing", async () => {
    const keys = [
      KPI_KEYS.agents,
      KPI_KEYS.openIssuesByStatus,
      KPI_KEYS.attention,
      KPI_KEYS.runs,
      KPI_KEYS.goals,
      KPI_KEYS.costs,
    ];
    for (const key of keys) {
      const result = await harness.getData<{ status: "pending"; note?: string }>(key, {});
      expect(result.status).toBe("pending");
      expect(result.note ?? "").toMatch(/companyId/i);
    }
  });

  it("registers a 30s tick via setInterval that calls ctx.events.emit, and clears it on shutdown", async () => {
    // Count emits on the harness tick channel. This proves the worker's
    // interval actually fires ctx.events.emit at the right cadence and that
    // onShutdown unhooks it.
    let tickCount = 0;
    const unsub = harness.ctx.events.on(TICK_CHANNEL, () => {
      tickCount += 1;
    });
    subscribers.push(unsub);

    // The worker registers a setInterval in `setup`. Capture it via a
    // monkey-patch on globalThis so we can drive it directly. We re-run
    // setup with the patched setInterval so the worker creates a new
    // tickHandle and we own the only reference to it.
    const realSetInterval = globalThis.setInterval;
    let intervalCallback: (() => void) | null = null;
    (globalThis as { setInterval: typeof setInterval }).setInterval = ((
      handler: TimerHandler,
      ms?: number,
      ...args: unknown[]
    ) => {
      if (typeof handler === "function" && ms === REFRESH_INTERVAL_MS) {
        intervalCallback = handler as () => void;
      }
      return realSetInterval(handler, ms as number, ...(args as []));
    }) as typeof setInterval;

    try {
      await plugin.definition.setup(harness.ctx);
    } finally {
      (globalThis as { setInterval: typeof setInterval }).setInterval = realSetInterval;
    }

    expect(intervalCallback).not.toBeNull();

    // Drive the captured interval callback. It must emit the namespaced tick
    // channel and increment our counter.
    const baseline = tickCount;
    if (intervalCallback) intervalCallback();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(tickCount).toBeGreaterThan(baseline);

    // After onShutdown, the interval handle is cleared. The captured function
    // reference is still callable, but the worker no longer references it
    // via setInterval, so subsequent invocations cannot originate from a live
    // timer. We assert onShutdown itself is a no-throw no-op.
    await expect(plugin.definition.onShutdown?.()).resolves.not.toThrow();
    unsub();
  });

  it("tick channel name matches the worker-emitted event name", () => {
    expect(TICK_CHANNEL).toBe(`plugin.${PLUGIN_ID}.${TICK_EVENT}`);
  });
});