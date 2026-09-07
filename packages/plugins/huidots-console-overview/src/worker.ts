/**
 * huidots-console-overview worker.
 *
 * Registers the six `getData` handlers that back the F1 KPI tiles. Each
 * handler exposes exactly one host data source through the canonical
 * Paperclip client (`ctx.*`):
 *
 *   agents             → `ctx.agents.list({ companyId })`
 *                        (host: GET /api/companies/{id}/agents)
 *
 *   openIssuesByStatus → `ctx.issues.list({ companyId, status })` per
 *                        OPEN_ISSUE_STATUSES, joined into a single
 *                        status-bucketed payload
 *                        (host: GET /api/companies/{id}/issues)
 *
 *   attention          → graceful "data feed pending" payload (the
 *                        /companies/{id}/attention endpoint exists on
 *                        the host but is not yet wired into the SDK;
 *                        see HDO-137 / completion comment).
 *
 *   runs               → graceful "data feed pending" payload (the
 *                        /companies/{id}/timeline endpoint exists but
 *                        has no SDK client yet).
 *
 *   goals              → `ctx.goals.list({ companyId })`
 *                        (host: GET /api/companies/{id}/goals)
 *
 *   costs              → graceful "data feed pending" payload (the
 *                        /companies/{id}/costs/summary endpoint exists
 *                        but has no SDK client yet).
 *
 * The worker also emits a `plugin.<id>.tick` event on a 30s interval
 * (matching the spec's tick refresh requirement) so the UI can react
 * without holding its own timer.
 */

import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { KPI_KEYS, OPEN_ISSUE_STATUSES, PLUGIN_ID } from "./constants.js";

const PLUGIN_NAME = "huidots-console-overview";
const TICK_INTERVAL_MS = 30_000;

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

function pendingTile(source: string, note: string): TileEnvelope<null> {
  return envelope<null>(null, "pending", source, note);
}

function summariseError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_NAME} plugin setup`);

    // -------------------------------------------------------------------
    // 30-second server-side tick. The issue spec uses this name verbatim.
    // -------------------------------------------------------------------
    let stopped = false;
    const tickHandle = setInterval(() => {
      if (stopped) return;
      void ctx.events
        .emit(`${PLUGIN_ID}.tick`, "", {
          at: new Date().toISOString(),
          intervalMs: TICK_INTERVAL_MS,
        })
        .catch((err: unknown) => {
          ctx.logger.warn(`tick emit failed: ${summariseError(err)}`);
        });
    }, TICK_INTERVAL_MS);
    // keep the handle reachable for graceful shutdown hooks below
    void tickHandle;

    // -------------------------------------------------------------------
    // KPI tile: agents
    // Host endpoint: GET /api/companies/{id}/agents
    // -------------------------------------------------------------------
    ctx.data.register(KPI_KEYS.agents, async (params: Record<string, unknown>) => {
      const companyId = asCompanyId(params.companyId);
      if (!companyId) {
        return pendingTile(
          `/api/companies/:companyId/agents`,
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
    // Host endpoint: GET /api/companies/{id}/issues?status=in_progress,
    // blocked,todo,in_review&limit=200
    // -------------------------------------------------------------------
    ctx.data.register(KPI_KEYS.openIssuesByStatus, async (params: Record<string, unknown>) => {
      const companyId = asCompanyId(params.companyId);
      if (!companyId) {
        return pendingTile(
          `/api/companies/:companyId/issues?status=${OPEN_ISSUE_STATUSES.join(",")}&limit=200`,
          "companyId missing from request; cannot fetch issues",
        );
      }
      const byStatus: Record<string, number> = {};
      let total = 0;
      const perStatusSamples: Record<string, unknown[]> = {};
      const errors: string[] = [];
      try {
        for (const status of OPEN_ISSUE_STATUSES) {
          try {
            const issues = await ctx.issues.list({
              companyId,
              status: status as Parameters<typeof ctx.issues.list>[0]["status"],
              limit: 200,
              offset: 0,
            });
            byStatus[status] = issues.length;
            total += issues.length;
            perStatusSamples[status] = issues.slice(0, 3).map((issue) => ({
              id: issue.id,
              identifier: issue.identifier,
              title: issue.title,
              status: issue.status,
              priority: issue.priority,
              assigneeAgentId: issue.assigneeAgentId,
              updatedAt: issue.updatedAt,
            }));
          } catch (err) {
            errors.push(`${status}: ${summariseError(err)}`);
          }
        }
        const status: TileStatus = errors.length === 0 ? "live" : "error";
        return envelope(
          {
            total,
            byStatus,
            perStatusSamples,
            statuses: [...OPEN_ISSUE_STATUSES],
          },
          status,
          `/api/companies/:companyId/issues?status=${OPEN_ISSUE_STATUSES.join(",")}&limit=200`,
          status === "live"
            ? undefined
            : `partial result; ${errors.length} status bucket(s) errored`,
          errors.length > 0 ? errors.join("; ") : undefined,
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
    // KPI tile: attention — graceful empty until SDK exposes /attention.
    // -------------------------------------------------------------------
    ctx.data.register(KPI_KEYS.attention, async (params: Record<string, unknown>) => {
      const companyId = asCompanyId(params.companyId);
      return pendingTile(
        "/api/companies/:companyId/attention",
        companyId
          ? "Plugin SDK does not yet expose the /attention endpoint; awaiting capability-gated company-state read method (HDO-137 platform gap)."
          : "companyId missing from request",
      );
    });

    // -------------------------------------------------------------------
    // KPI tile: runs — graceful empty until SDK exposes /timeline.
    // -------------------------------------------------------------------
    ctx.data.register(KPI_KEYS.runs, async (params: Record<string, unknown>) => {
      const companyId = asCompanyId(params.companyId);
      return pendingTile(
        "/api/companies/:companyId/timeline?limit=20",
        companyId
          ? "Plugin SDK does not yet expose the /timeline endpoint; awaiting capability-gated company-state read method (HDO-137 platform gap)."
          : "companyId missing from request",
      );
    });

    // -------------------------------------------------------------------
    // KPI tile: goals
    // Host endpoint: GET /api/companies/{id}/goals
    // -------------------------------------------------------------------
    ctx.data.register(KPI_KEYS.goals, async (params: Record<string, unknown>) => {
      const companyId = asCompanyId(params.companyId);
      if (!companyId) {
        return pendingTile(
          "/api/companies/:companyId/goals",
          "companyId missing from request; cannot fetch goals",
        );
      }
      try {
        const goals = await ctx.goals.list({ companyId });
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
    // KPI tile: costs — graceful empty until SDK exposes /costs/summary.
    // -------------------------------------------------------------------
    ctx.data.register(KPI_KEYS.costs, async (params: Record<string, unknown>) => {
      const companyId = asCompanyId(params.companyId);
      return pendingTile(
        "/api/companies/:companyId/costs/summary",
        companyId
          ? "Plugin SDK does not yet expose the /costs/summary endpoint; awaiting capability-gated company-state read method (HDO-137 platform gap)."
          : "companyId missing from request",
      );
    });
  },

  async onHealth() {
    return { status: "ok", message: `${PLUGIN_NAME} ready` };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
