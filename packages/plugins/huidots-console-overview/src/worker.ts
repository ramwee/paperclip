/**
 * huidots-console-overview worker.
 *
 * Registers the six `getData` handlers that back the F1 KPI tiles. Every tile
 * hits exactly one Paperclip endpoint via the host's capability-gated bridge:
 *
 *   agents             → GET /api/companies/{id}/agents
 *   openIssuesByStatus → GET /api/companies/{id}/issues?status=in_progress,blocked,todo,in_review&limit=200
 *   attention          → GET /api/companies/{id}/attention
 *   runs               → derived from GET /api/companies/{id}/timeline?limit=20
 *                        (filter kind=run.started, last 24h)
 *   goals              → GET /api/companies/{id}/goals
 *   costs              → GET /api/companies/{id}/costs/summary
 *
 * Emits a `plugin.<id>.tick` event on a 30-second interval so the UI can
 * refresh without holding its own timer. The interval is cleared on shutdown.
 *
 * No outbound HTTP, no Paperclip writes, no local-folder declarations —
 * F1 is a pure read surface over the existing authenticated host client.
 */

import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import {
  KPI_KEYS,
  OPEN_ISSUE_STATUSES,
  PLUGIN_ID,
  REFRESH_INTERVAL_MS,
  TICK_EVENT,
} from "./constants.js";

const PLUGIN_NAME = "huidots-console-overview";
const RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const RUN_KIND = "run.started";

/**
 * Module-scope handle for the 30s tick interval. Hoisted out of `setup` so
 * `onShutdown` can clear it without leaking. `setup` is the only place that
 * creates the timer; `onShutdown` is the only place that clears it.
 */
let tickHandle: ReturnType<typeof setInterval> | null = null;

type TileStatus = "live" | "pending" | "error";

type TileEnvelope<T> = {
  data: T | null;
  status: TileStatus;
  source: string;
  generatedAt: string;
  note?: string;
  error?: string;
};

function asCompanyId(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "";
}

function envelope<T>(
  data: T | null,
  status: TileStatus,
  source: string,
  note?: string,
  error?: string,
): TileEnvelope<T> {
  return {
    data,
    status,
    source,
    generatedAt: new Date().toISOString(),
    ...(note !== undefined ? { note } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

function pendingTile<T>(source: string, note: string): TileEnvelope<T> {
  return envelope<T>(null, "pending", source, note);
}

function summariseError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_NAME} plugin setup`);

    // -------------------------------------------------------------------
    // 30-second server-side tick. The SDK auto-namespaces plugin events to
    // `plugin.<pluginId>.<name>`, so we emit the bare name `tick`.
    //
    // The interval is captured in `tickHandle` so onShutdown() can clear it.
    // -------------------------------------------------------------------
    tickHandle = setInterval(() => {
      void ctx.events
        .emit(TICK_EVENT, "", {
          at: new Date().toISOString(),
          intervalMs: REFRESH_INTERVAL_MS,
        })
        .catch((err: unknown) => {
          ctx.logger.warn(`tick emit failed: ${summariseError(err)}`);
        });
    }, REFRESH_INTERVAL_MS);
    // Make the timer unref'd so it never blocks worker shutdown even if
    // onShutdown somehow fails to clear it.
    if (typeof (tickHandle as { unref?: () => void }).unref === "function") {
      (tickHandle as { unref: () => void }).unref();
    }

    // -------------------------------------------------------------------
    // KPI tile: agents
    // -------------------------------------------------------------------
    ctx.data.register(KPI_KEYS.agents, async (params: Record<string, unknown>) => {
      const companyId = asCompanyId(params.companyId);
      if (!companyId) {
        return pendingTile(
          "/api/companies/:companyId/agents",
          "companyId missing from request; cannot fetch agents",
        );
      }
      try {
        const agents = await ctx.agents.list({ companyId, limit: 200, offset: 0 });
        return envelope(
          {
            total: agents.length,
            running: agents.filter((a) => a.status === "running").length,
            idle: agents.filter((a) => a.status === "idle").length,
            paused: agents.filter((a) => a.status === "paused").length,
            byStatus: agents.reduce<Record<string, number>>((acc, a) => {
              const key = String(a.status);
              acc[key] = (acc[key] ?? 0) + 1;
              return acc;
            }, {}),
            sample: agents.slice(0, 5).map((agent) => ({
              id: agent.id,
              name: agent.name,
              title: agent.title,
              role: agent.role,
              status: agent.status,
              urlKey: agent.urlKey,
            })),
          },
          "live",
          "/api/companies/:companyId/agents",
        );
      } catch (err) {
        return envelope(
          null,
          "error",
          "/api/companies/:companyId/agents",
          undefined,
          summariseError(err),
        );
      }
    });

    // -------------------------------------------------------------------
    // KPI tile: openIssuesByStatus
    // -------------------------------------------------------------------
    ctx.data.register(KPI_KEYS.openIssuesByStatus, async (params: Record<string, unknown>) => {
      const companyId = asCompanyId(params.companyId);
      if (!companyId) {
        return pendingTile(
          `/api/companies/:companyId/issues?status=${OPEN_ISSUE_STATUSES.join(",")}&limit=200`,
          "companyId missing from request; cannot fetch issues",
        );
      }
      try {
        const byStatus: Record<string, number> = {};
        let total = 0;
        const perStatusSamples: Record<string, unknown[]> = {};
        for (const status of OPEN_ISSUE_STATUSES) {
          const rows = await ctx.issues.list({
            companyId,
            status: status as Parameters<typeof ctx.issues.list>[0]["status"],
            limit: 200,
            offset: 0,
          });
          byStatus[status] = rows.length;
          total += rows.length;
          perStatusSamples[status] = rows.slice(0, 3).map((issue) => ({
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            status: issue.status,
            priority: issue.priority,
            assigneeAgentId: issue.assigneeAgentId,
            updatedAt: issue.updatedAt,
            deepLink: issue.identifier
              ? `/issues/${issue.identifier}`
              : `/issues/${issue.id}`,
          }));
        }
        return envelope(
          {
            total,
            byStatus,
            perStatusSamples,
            statuses: [...OPEN_ISSUE_STATUSES],
          },
          "live",
          `/api/companies/:companyId/issues?status=${OPEN_ISSUE_STATUSES.join(",")}&limit=200`,
        );
      } catch (err) {
        return envelope(
          null,
          "error",
          `/api/companies/:companyId/issues?status=${OPEN_ISSUE_STATUSES.join(",")}&limit=200`,
          undefined,
          summariseError(err),
        );
      }
    });

    // -------------------------------------------------------------------
    // KPI tile: attention
    // -------------------------------------------------------------------
    ctx.data.register(KPI_KEYS.attention, async (params: Record<string, unknown>) => {
      const companyId = asCompanyId(params.companyId);
      if (!companyId) {
        return pendingTile(
          "/api/companies/:companyId/attention",
          "companyId missing from request",
        );
      }
      try {
        const feed = await ctx.companies.attention.list({
          companyId,
          archived: false,
          includeDismissed: false,
          sort: "activity",
          limit: 50,
        });
        const items = feed.items ?? [];
        return envelope(
          {
            total: items.length,
            byShelf: items.reduce<Record<string, number>>((acc, item) => {
              const key = String(item.shelf);
              acc[key] = (acc[key] ?? 0) + 1;
              return acc;
            }, {}),
            byState: items.reduce<Record<string, number>>((acc, item) => {
              const key = String(item.state);
              acc[key] = (acc[key] ?? 0) + 1;
              return acc;
            }, {}),
            sample: items.slice(0, 5).map((item) => ({
              id: item.id,
              sourceKind: item.sourceKind,
              sourceId: item.sourceId,
              subject: item.subject,
              shelf: item.shelf,
              state: item.state,
              activityAt: item.activityAt,
            })),
            generatedAt: feed.generatedAt,
          },
          "live",
          "/api/companies/:companyId/attention",
        );
      } catch (err) {
        return envelope(
          null,
          "error",
          "/api/companies/:companyId/attention",
          undefined,
          summariseError(err),
        );
      }
    });

    // -------------------------------------------------------------------
    // KPI tile: runs — derived from /timeline?limit=20, kind=run.started, 24h.
    // -------------------------------------------------------------------
    ctx.data.register(KPI_KEYS.runs, async (params: Record<string, unknown>) => {
      const companyId = asCompanyId(params.companyId);
      if (!companyId) {
        return pendingTile(
          "/api/companies/:companyId/timeline?limit=20",
          "companyId missing from request",
        );
      }
      try {
        const since = new Date(Date.now() - RUN_LOOKBACK_MS).toISOString();
        const feed = await ctx.companies.timeline.list({
          companyId,
          from: since,
          limit: 20,
          offset: 0,
        });
        const events = feed.events ?? [];
        const runStarted = events.filter((event) => event.kind === RUN_KIND);
        return envelope(
          {
            total: runStarted.length,
            windowMs: RUN_LOOKBACK_MS,
            sample: runStarted.slice(0, 5).map((event) => ({
              id: event.id,
              kind: event.kind,
              occurredAt: event.occurredAt,
              actor: event.actor,
              target: event.target,
              deepLink: event.target
                ? event.target.type === "issue" && event.target.identifier
                  ? `/issues/${event.target.identifier}`
                  : event.target.type === "agent"
                    ? `/agents/${event.target.id}`
                    : null
                : null,
            })),
            generatedAt: feed.generatedAt,
          },
          "live",
          "/api/companies/:companyId/timeline?limit=20",
        );
      } catch (err) {
        return envelope(
          null,
          "error",
          "/api/companies/:companyId/timeline?limit=20",
          undefined,
          summariseError(err),
        );
      }
    });

    // -------------------------------------------------------------------
    // KPI tile: goals
    // -------------------------------------------------------------------
    ctx.data.register(KPI_KEYS.goals, async (params: Record<string, unknown>) => {
      const companyId = asCompanyId(params.companyId);
      if (!companyId) {
        return pendingTile(
          "/api/companies/:companyId/goals",
          "companyId missing from request",
        );
      }
      try {
        const goals = await ctx.goals.list({ companyId, limit: 200 });
        const byLevel = goals.reduce<Record<string, number>>((acc, g) => {
          const key = String(g.level ?? "unknown");
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {});
        return envelope(
          {
            total: goals.length,
            active: goals.filter((g) => g.status === "active").length,
            achieved: goals.filter((g) => g.status === "achieved").length,
            cancelled: goals.filter((g) => g.status === "cancelled").length,
            planned: goals.filter((g) => g.status === "planned").length,
            byLevel,
            sample: goals.slice(0, 5).map((g) => ({
              id: g.id,
              title: g.title,
              level: g.level,
              status: g.status,
              ownerAgentId: g.ownerAgentId,
            })),
          },
          "live",
          "/api/companies/:companyId/goals",
        );
      } catch (err) {
        return envelope(
          null,
          "error",
          "/api/companies/:companyId/goals",
          undefined,
          summariseError(err),
        );
      }
    });

    // -------------------------------------------------------------------
    // KPI tile: costs
    // -------------------------------------------------------------------
    ctx.data.register(KPI_KEYS.costs, async (params: Record<string, unknown>) => {
      const companyId = asCompanyId(params.companyId);
      if (!companyId) {
        return pendingTile(
          "/api/companies/:companyId/costs/summary",
          "companyId missing from request",
        );
      }
      try {
        const summary = await ctx.companies.costs.summary({ companyId });
        return envelope(
          {
            totalCostCents: summary.totalCostCents,
            range: summary.range,
            byAgent: summary.byAgent.slice(0, 5),
            byProvider: summary.byProvider.slice(0, 5),
            generatedAt: summary.generatedAt,
          },
          "live",
          "/api/companies/:companyId/costs/summary",
        );
      } catch (err) {
        return envelope(
          null,
          "error",
          "/api/companies/:companyId/costs/summary",
          undefined,
          summariseError(err),
        );
      }
    });
  },

  async onShutdown() {
    if (tickHandle !== null) {
      clearInterval(tickHandle);
      tickHandle = null;
    }
  },

  async onHealth() {
    return { status: "ok", message: `${PLUGIN_NAME} ready` };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);