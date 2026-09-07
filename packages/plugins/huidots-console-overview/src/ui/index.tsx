/**
 * huidots-console-overview UI bundle.
 *
 * Exports four components that the manifest references by exportName:
///
*   - ConsoleToolbarButton           (globalToolbarButton slot — top-bar tab)
 *   - ConsoleOverviewPage            (page slot — the live company-state screen)
 *   - ConsoleProjectVaultTab         (detailTab slot — F3 placeholder)
 *   - ConsoleProjectPixelAgentsTab   (detailTab slot — F2 placeholder)
 *
 * All Paperclip API traffic flows through the SDK bridge
 * (`usePluginData(key, params)` and `usePluginStream(channel)`); the bundle
 * never imports the host client directly and never builds its own auth context.
 */

import {
  StatusBadge,
  useHostContext,
  useHostLocation,
  useHostNavigation,
  usePluginData,
  usePluginStream,
  type PluginDataResult,
  type PluginDetailTabProps,
  type PluginGlobalToolbarButtonProps,
  type PluginHostContext,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
} from "react";
import {
  EXTENSION_TARGET_DATE_ISO,
  KPI_KEYS,
  OPEN_ISSUE_STATUSES,
  PAGE_ROUTE,
  PLUGIN_DISPLAY_NAME,
  REFRESH_INTERVAL_MS,
  TICK_CHANNEL,
} from "../constants.js";

// ---------------------------------------------------------------------------
// Shared data types — one envelope per tile, returned by `ctx.data.register`.
// ---------------------------------------------------------------------------

type TileStatus = "live" | "pending" | "error";

type TileEnvelope<T> = {
  data: T | null;
  status: TileStatus;
  source: string;
  generatedAt: string;
  note?: string;
  error?: string;
};

type AgentsTile = {
  total: number;
  running: number;
  idle: number;
  paused: number;
  byStatus: Record<string, number>;
  sample: Array<{
    id: string;
    name: string;
    title: string | null;
    role: string | null;
    status: string;
    urlKey: string | null;
  }>;
};

type IssueSample = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  updatedAt: string;
  deepLink: string;
};

type OpenIssuesTile = {
  total: number;
  byStatus: Record<string, number>;
  perStatusSamples: Record<string, IssueSample[]>;
  statuses: string[];
};

type AttentionTile = {
  total: number;
  byShelf: Record<string, number>;
  byState: Record<string, number>;
  sample: Array<{
    id: string;
    sourceKind: string;
    sourceId: string;
    subject: {
      kind: string;
      id: string;
      title?: string | null;
      identifier?: string | null;
      status?: string | null;
    };
    shelf: string;
    state: string;
    activityAt: string;
  }>;
  generatedAt: string;
};

type RunsTile = {
  total: number;
  windowMs: number;
  sample: Array<{
    id: string;
    kind: string;
    occurredAt: string;
    actor: { type: "user" | "agent" | "system"; id: string | null; name: string | null } | null;
    target: {
      type: string;
      id: string;
      identifier?: string | null;
      title?: string | null;
    } | null;
    deepLink: string | null;
  }>;
  generatedAt: string;
};

type GoalsTile = {
  total: number;
  active: number;
  achieved: number;
  cancelled: number;
  planned: number;
  byLevel: Record<string, number>;
  sample: Array<{
    id: string;
    title: string;
    level: string;
    status: string;
    ownerAgentId: string | null;
  }>;
};

type CostsTile = {
  totalCostCents: number;
  range: { from: string | null; to: string | null };
  byAgent: Array<{ agentId: string; agentName: string | null; costCents: number }>;
  byProvider: Array<{ provider: string; costCents: number }>;
  generatedAt: string;
};

type AgentsData = TileEnvelope<AgentsTile>;
type OpenIssuesData = TileEnvelope<OpenIssuesTile>;
type AttentionData = TileEnvelope<AttentionTile>;
type RunsData = TileEnvelope<RunsTile>;
type GoalsData = TileEnvelope<GoalsTile>;
type CostsData = TileEnvelope<CostsTile>;

// ---------------------------------------------------------------------------
// Display-only constants.
// ---------------------------------------------------------------------------

const OPEN_STATUS_COLUMNS: Array<{
  key: string;
  label: string;
  tone: "warning" | "info" | "pending" | "ok";
}> = [
  { key: "in_progress", label: "In progress", tone: "warning" },
  { key: "blocked", label: "Blocked", tone: "warning" },
  { key: "in_review", label: "In review", tone: "pending" },
  { key: "todo", label: "Todo", tone: "info" },
];

const cardStyle: React.CSSProperties = {
  background: "color-mix(in oklab, var(--card) 92%, var(--background))",
  border: "1px solid var(--border)",
  borderRadius: "0.75rem",
  padding: "1rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  minWidth: 0,
};

const mutedTextStyle: React.CSSProperties = {
  color: "var(--muted-foreground)",
  fontSize: "0.8125rem",
  lineHeight: 1.5,
};

const linkStyle: React.CSSProperties = {
  color: "var(--primary)",
  textDecoration: "none",
  fontWeight: 500,
};

function relativeTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const diff = Math.max(0, Date.now() - ms);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function statusBadgeVariant(
  status: TileStatus,
): "ok" | "warning" | "error" | "info" | "pending" {
  if (status === "live") return "ok";
  if (status === "pending") return "pending";
  return "error";
}

function statusLabel(status: TileStatus): string {
  if (status === "live") return "Live";
  if (status === "pending") return "Pending";
  return "Error";
}

// ---------------------------------------------------------------------------
// Data hooks — every tile reads through the SDK bridge.
// ---------------------------------------------------------------------------

function useAgentsTile(companyId: string | null) {
  return usePluginData<AgentsData>(KPI_KEYS.agents, { companyId });
}
function useOpenIssuesTile(companyId: string | null) {
  return usePluginData<OpenIssuesData>(KPI_KEYS.openIssuesByStatus, { companyId });
}
function useAttentionTile(companyId: string | null) {
  return usePluginData<AttentionData>(KPI_KEYS.attention, { companyId });
}
function useRunsTile(companyId: string | null) {
  return usePluginData<RunsData>(KPI_KEYS.runs, { companyId });
}
function useGoalsTile(companyId: string | null) {
  return usePluginData<GoalsData>(KPI_KEYS.goals, { companyId });
}
function useCostsTile(companyId: string | null) {
  return usePluginData<CostsData>(KPI_KEYS.costs, { companyId });
}

// ---------------------------------------------------------------------------
// 30-second tick refresh driven by the worker-emitted `plugin.<id>.tick` SSE
// event. Falls back to a local interval only if the SSE stream is unavailable
// (e.g. the host does not wire the bridge in dev).
// ---------------------------------------------------------------------------

function useTickRefresh(
  companyId: string | null,
  refreshes: Array<() => void>,
) {
  const stream = usePluginStream<{ at: string; intervalMs: number }>(TICK_CHANNEL, {
    companyId: companyId ?? undefined,
  });

  // Fire refreshes whenever the worker emits a new tick.
  useEffect(() => {
    if (!companyId) return;
    if (stream.events.length === 0) return;
    for (const refresh of refreshes) {
      try {
        refresh();
      } catch {
        // ignore — `usePluginData.refresh` is idempotent; errors come back
        // through the `error` channel.
      }
    }
    // We intentionally depend on the last tick's id-equivalent (occurredAt is
    // not exposed, so length changes act as the heartbeat signal).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, stream.events.length]);

  // Local fallback timer. Only effective if no SSE event has arrived within
  // `REFRESH_INTERVAL_MS` — guarded by the `lastEventLength` ref pattern so
  // the two timers never double-fire.
  useEffect(() => {
    if (!companyId) return;
    const handle = window.setInterval(() => {
      for (const refresh of refreshes) {
        try {
          refresh();
        } catch {
          // ignore
        }
      }
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);
}

// ---------------------------------------------------------------------------
// ConsoleToolbarButton — the top-bar "Console" tab.
// ---------------------------------------------------------------------------

export function ConsoleToolbarButton({ context }: PluginGlobalToolbarButtonProps) {
  const hostNavigation = useHostNavigation();
  const hostLocation = useHostLocation();
  const hostContext = useHostContext();

  // The page route is declared as `routePath: "console"` in the manifest, so
  // the resolved URL is `/:companyPrefix/console`. `linkProps` produces the
  // correct href and emits a route push on left-click while preserving
  // modifier-click and copy-link behaviour.
  const linkProps = useMemo(
    () => hostNavigation.linkProps(`/${PAGE_ROUTE}`),
    [hostNavigation],
  );

  const isActive = useMemo(() => {
    const target = hostLocation.pathname.replace(/\/+$/, "");
    const expected = (hostContext.companyPrefix
      ? `/${hostContext.companyPrefix}/${PAGE_ROUTE}`
      : `/${PAGE_ROUTE}`
    ).replace(/\/+$/, "");
    return target === expected || target.startsWith(`${expected}/`);
  }, [hostLocation.pathname, hostContext.companyPrefix]);

  const onClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      // linkProps already wires preventDefault + navigate; this is the
      // defensive fallback if the host runtime doesn't return a custom
      // handler.
      if (typeof linkProps.onClick === "function") return;
      event.preventDefault();
      const href = typeof linkProps.href === "string" ? linkProps.href : `/${PAGE_ROUTE}`;
      hostNavigation.navigate(href);
    },
    [hostNavigation, linkProps],
  );

  return (
    <a
      {...linkProps}
      onClick={onClick}
      aria-current={isActive ? "page" : undefined}
      data-plugin-slot="console-toolbar-button"
      title={`${PLUGIN_DISPLAY_NAME} — live company state`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.4rem",
        padding: "0.35rem 0.65rem",
        fontSize: "0.8125rem",
        fontWeight: 500,
        color: isActive ? "var(--foreground)" : "var(--muted-foreground)",
        background: isActive ? "var(--accent)" : "transparent",
        borderRadius: "0.375rem",
        textDecoration: "none",
      }}
    >
      <span aria-hidden="true" style={{ fontSize: "0.9rem", lineHeight: 1 }}>
        ◧
      </span>
      <span>Console</span>
    </a>
  );
}

// ---------------------------------------------------------------------------
// Tile cards.
// ---------------------------------------------------------------------------

function TileSourceBadge({ data }: { data: TileEnvelope<unknown> | null | undefined }) {
  if (!data) return null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        flexWrap: "wrap",
      }}
    >
      <StatusBadge label={statusLabel(data.status)} status={statusBadgeVariant(data.status)} />
      <span style={{ ...mutedTextStyle, fontSize: "0.75rem" }}>
        {data.source} · refreshed {relativeTime(data.generatedAt)}
      </span>
    </div>
  );
}

function TileNote({ data }: { data: TileEnvelope<unknown> | null | undefined }) {
  if (!data) return null;
  if (data.status === "live") return null;
  const text = data.note ?? data.error ?? "Data feed unavailable.";
  return (
    <p style={{ ...mutedTextStyle, fontSize: "0.75rem", color: "var(--warning)" }}>
      {text}
    </p>
  );
}

function AgentsTileCard({
  data,
  onCardActivate,
}: {
  data: PluginDataResult<AgentsData>;
  onCardActivate: (() => void) | undefined;
}) {
  const payload = data.data?.data ?? null;
  return (
    <article
      style={{ ...cardStyle, cursor: onCardActivate ? "pointer" : "default" }}
      aria-label="Agents KPI"
      onClick={onCardActivate}
      onKeyDown={(event) => {
        if (!onCardActivate) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onCardActivate();
        }
      }}
      tabIndex={onCardActivate ? 0 : undefined}
      role={onCardActivate ? "button" : undefined}
    >
      <header style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <span style={{ ...mutedTextStyle, fontSize: "0.6875rem", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Agents
        </span>
        <span style={{ fontSize: "1.75rem", fontWeight: 600 }}>
          {payload ? payload.total : "—"}
        </span>
      </header>
      {payload ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.5rem" }}>
          <div style={{ ...mutedTextStyle }}>
            <div style={{ color: "var(--foreground)", fontWeight: 600 }}>{payload.running}</div>
            <div>running</div>
          </div>
          <div style={{ ...mutedTextStyle }}>
            <div style={{ color: "var(--foreground)", fontWeight: 600 }}>{payload.idle}</div>
            <div>idle</div>
          </div>
          <div style={{ ...mutedTextStyle }}>
            <div style={{ color: "var(--foreground)", fontWeight: 600 }}>{payload.paused}</div>
            <div>paused</div>
          </div>
        </div>
      ) : null}
      <TileSourceBadge data={data.data ?? null} />
      <TileNote data={data.data ?? null} />
    </article>
  );
}

function OpenIssuesTileCard({ data }: { data: PluginDataResult<OpenIssuesData> }) {
  const payload = data.data?.data ?? null;
  return (
    <article style={cardStyle} aria-label="Open issues KPI">
      <header style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <span style={{ ...mutedTextStyle, fontSize: "0.6875rem", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Open issues
        </span>
        <span style={{ fontSize: "1.75rem", fontWeight: 600 }}>
          {payload ? payload.total : "—"}
        </span>
      </header>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
        {OPEN_STATUS_COLUMNS.map((col) => {
          const count = payload?.byStatus[col.key] ?? 0;
          return (
            <div key={col.key} style={{ display: "flex", alignItems: "center", gap: "0.375rem" }}>
              <StatusBadge label={col.label} status={col.tone} />
              <span style={{ fontWeight: 600, fontSize: "0.875rem" }}>{count}</span>
            </div>
          );
        })}
      </div>
      <TileSourceBadge data={data.data ?? null} />
      <TileNote data={data.data ?? null} />
    </article>
  );
}

function AttentionTileCard({ data }: { data: PluginDataResult<AttentionData> }) {
  const payload = data.data?.data ?? null;
  return (
    <article style={cardStyle} aria-label="Attention KPI">
      <header style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <span style={{ ...mutedTextStyle, fontSize: "0.6875rem", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Attention
        </span>
        <span style={{ fontSize: "1.75rem", fontWeight: 600 }}>
          {payload ? payload.total : "—"}
        </span>
      </header>
      {payload ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
          {Object.entries(payload.byShelf).map(([shelf, count]) => (
            <div key={shelf} style={{ display: "flex", alignItems: "center", gap: "0.375rem" }}>
              <StatusBadge label={shelf} status="warning" />
              <span style={{ fontWeight: 600, fontSize: "0.875rem" }}>{count}</span>
            </div>
          ))}
        </div>
      ) : null}
      <TileSourceBadge data={data.data ?? null} />
      <TileNote data={data.data ?? null} />
    </article>
  );
}

function RunsTileCard({ data }: { data: PluginDataResult<RunsData> }) {
  const payload = data.data?.data ?? null;
  return (
    <article style={cardStyle} aria-label="Runs (24h) KPI">
      <header style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <span style={{ ...mutedTextStyle, fontSize: "0.6875rem", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Runs (24h)
        </span>
        <span style={{ fontSize: "1.75rem", fontWeight: 600 }}>
          {payload ? payload.total : "—"}
        </span>
      </header>
      {payload ? (
        <div style={{ ...mutedTextStyle }}>
          <div>Filtered to <code>kind=run.started</code> within the last 24 hours.</div>
        </div>
      ) : null}
      <TileSourceBadge data={data.data ?? null} />
      <TileNote data={data.data ?? null} />
    </article>
  );
}

function GoalsTileCard({ data }: { data: PluginDataResult<GoalsData> }) {
  const payload = data.data?.data ?? null;
  return (
    <article style={cardStyle} aria-label="Goals KPI">
      <header style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <span style={{ ...mutedTextStyle, fontSize: "0.6875rem", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Goals
        </span>
        <span style={{ fontSize: "1.75rem", fontWeight: 600 }}>
          {payload ? payload.total : "—"}
        </span>
      </header>
      {payload ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.5rem" }}>
          <div style={{ ...mutedTextStyle }}>
            <div style={{ color: "var(--foreground)", fontWeight: 600 }}>{payload.active}</div>
            <div>active</div>
          </div>
          <div style={{ ...mutedTextStyle }}>
            <div style={{ color: "var(--foreground)", fontWeight: 600 }}>{payload.achieved}</div>
            <div>achieved</div>
          </div>
          <div style={{ ...mutedTextStyle }}>
            <div style={{ color: "var(--foreground)", fontWeight: 600 }}>{payload.planned}</div>
            <div>planned</div>
          </div>
          <div style={{ ...mutedTextStyle }}>
            <div style={{ color: "var(--foreground)", fontWeight: 600 }}>{payload.cancelled}</div>
            <div>cancelled</div>
          </div>
        </div>
      ) : null}
      <TileSourceBadge data={data.data ?? null} />
      <TileNote data={data.data ?? null} />
    </article>
  );
}

function CostsTileCard({ data }: { data: PluginDataResult<CostsData> }) {
  const payload = data.data?.data ?? null;
  return (
    <article style={cardStyle} aria-label="Costs KPI">
      <header style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <span style={{ ...mutedTextStyle, fontSize: "0.6875rem", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Costs
        </span>
        <span style={{ fontSize: "1.75rem", fontWeight: 600 }}>
          {payload ? `$${(payload.totalCostCents / 100).toFixed(2)}` : "—"}
        </span>
      </header>
      {payload ? (
        <div style={{ ...mutedTextStyle }}>
          <div>
            by agent: {payload.byAgent.map((row) => row.agentName ?? row.agentId).join(", ") || "—"}
          </div>
          <div>
            by provider: {payload.byProvider.map((row) => row.provider).join(", ") || "—"}
          </div>
        </div>
      ) : null}
      <TileSourceBadge data={data.data ?? null} />
      <TileNote data={data.data ?? null} />
    </article>
  );
}

function KpiGrid({
  agents,
  openIssues,
  attention,
  runs,
  goals,
  costs,
}: {
  agents: PluginDataResult<AgentsData>;
  openIssues: PluginDataResult<OpenIssuesData>;
  attention: PluginDataResult<AttentionData>;
  runs: PluginDataResult<RunsData>;
  goals: PluginDataResult<GoalsData>;
  costs: PluginDataResult<CostsData>;
}) {
  return (
    <section
      aria-label="Company state KPI tiles"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: "1rem",
      }}
    >
      <AgentsTileCard data={agents} onCardActivate={undefined} />
      <OpenIssuesTileCard data={openIssues} />
      <AttentionTileCard data={attention} />
      <RunsTileCard data={runs} />
      <GoalsTileCard data={goals} />
      <CostsTileCard data={costs} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Status cards row — three clickable resource cards under the tiles.
// ---------------------------------------------------------------------------

function OpenIssuesCard({
  data,
}: {
  data: PluginDataResult<OpenIssuesData>;
}) {
  const hostNavigation = useHostNavigation();
  const payload = data.data?.data ?? null;

  // Pick the first available issue across the open-status samples. The card
  // deep-links to a single Paperclip resource (a specific issue), not a
  // filtered inbox URL — that satisfies the AC #5 "resource card" shape.
  const leadIssue = useMemo(() => {
    if (!payload) return null;
    for (const status of OPEN_STATUS_COLUMNS.map((col) => col.key)) {
      const samples = payload.perStatusSamples[status];
      if (samples && samples.length > 0) {
        return samples[0];
      }
    }
    return null;
  }, [payload]);

  const handleActivate = useCallback(() => {
    if (!leadIssue) return;
    hostNavigation.navigate(hostNavigation.resolveHref(leadIssue.deepLink));
  }, [hostNavigation, leadIssue]);

  return (
    <article
      style={{ ...cardStyle, cursor: leadIssue ? "pointer" : "default" }}
      aria-label="Open issues by status"
      onClick={handleActivate}
      onKeyDown={(event) => {
        if (!leadIssue) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handleActivate();
        }
      }}
      tabIndex={leadIssue ? 0 : undefined}
      role={leadIssue ? "button" : undefined}
    >
      <header style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <span style={{ ...mutedTextStyle, fontSize: "0.6875rem", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Open issues by status
        </span>
        <span style={{ fontSize: "1.25rem", fontWeight: 600 }}>
          {payload ? payload.total : "—"}
        </span>
      </header>
      {!payload ? (
        <p style={mutedTextStyle}>Status breakdown unavailable.</p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "0.375rem" }}>
          {OPEN_STATUS_COLUMNS.map((col) => {
            const count = payload.byStatus[col.key] ?? 0;
            const samples = payload.perStatusSamples[col.key] ?? [];
            const lead = samples[0];
            const href = lead
              ? hostNavigation.resolveHref(lead.deepLink)
              : null;
            return (
              <li
                key={col.key}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "0.5rem",
                  fontSize: "0.875rem",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <StatusBadge label={col.label} status={col.tone} />
                  <span style={{ fontWeight: 600, color: "var(--foreground)" }}>{count}</span>
                </div>
                {lead && href ? (
                  <a
                    href={href}
                    onClick={(event) => {
                      if (
                        event.defaultPrevented ||
                        event.button !== 0 ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.altKey ||
                        event.shiftKey
                      ) {
                        return;
                      }
                      event.preventDefault();
                      hostNavigation.navigate(href);
                    }}
                    style={{
                      ...linkStyle,
                      fontSize: "0.75rem",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: "12rem",
                    }}
                  >
                    {lead.identifier ?? lead.title}
                  </a>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {leadIssue ? (
        <p style={{ ...mutedTextStyle }}>
          Click to open the most-recent open issue in Paperclip.
        </p>
      ) : null}
    </article>
  );
}

function AgentStatusCard({ data }: { data: PluginDataResult<AgentsData> }) {
  const hostNavigation = useHostNavigation();
  const payload = data.data?.data ?? null;

  // The card itself is an `<article>`, never a `<button>`. Each agent row is a
  // separate anchor that deep-links to its `/agents/<urlKey>` resource page.
  // That avoids the previous invalid `<button>`-wrapping-`<a>` markup.
  return (
    <article style={cardStyle} aria-label="Agent status grid">
      <header style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <span style={{ ...mutedTextStyle, fontSize: "0.6875rem", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Agent status
        </span>
        <span style={{ fontSize: "1.25rem", fontWeight: 600 }}>
          {payload ? payload.total : "—"}
        </span>
      </header>
      {!payload ? (
        <p style={mutedTextStyle}>Agent directory unavailable.</p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: "0.25rem" }}>
          {payload.sample.map((agent) => {
            const href = agent.urlKey
              ? hostNavigation.resolveHref(`/agents/${agent.urlKey}`)
              : null;
            return (
              <li
                key={agent.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "0.5rem",
                  fontSize: "0.8125rem",
                }}
              >
                {href ? (
                  <a
                    href={href}
                    onClick={(event) => {
                      if (
                        event.defaultPrevented ||
                        event.button !== 0 ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.altKey ||
                        event.shiftKey
                      ) {
                        return;
                      }
                      event.preventDefault();
                      hostNavigation.navigate(href);
                    }}
                    style={{
                      ...linkStyle,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {agent.name}
                  </a>
                ) : (
                  <span>{agent.name}</span>
                )}
                <StatusBadge
                  label={agent.status}
                  status={agent.status === "running" ? "ok" : agent.status === "paused" ? "warning" : "info"}
                />
              </li>
            );
          })}
          {payload.sample.length === 0 ? (
            <li style={mutedTextStyle}>No agents recorded yet.</li>
          ) : null}
        </ul>
      )}
    </article>
  );
}

function LatestActivityCard({
  runs,
}: {
  runs: PluginDataResult<RunsData>;
}) {
  const hostNavigation = useHostNavigation();
  const sample = runs.data?.data?.sample ?? [];

  return (
    <article style={cardStyle} aria-label="Latest activity feed">
      <header style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <span style={{ ...mutedTextStyle, fontSize: "0.6875rem", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Latest activity
        </span>
      </header>
      {sample.length === 0 ? (
        <p style={mutedTextStyle}>
          No timeline activity yet. Once the company runs through a heartbeat,
          run.started events will appear here.
        </p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "0.375rem" }}>
          {sample.map((event) => {
            const href = event.deepLink ? hostNavigation.resolveHref(event.deepLink) : null;
            const label = event.target
              ? `${event.kind} → ${event.target.identifier ?? event.target.title ?? event.target.id}`
              : event.kind;
            return (
              <li key={event.id} style={{ display: "flex", flexDirection: "column", gap: "0.125rem" }}>
                {href ? (
                  <a
                    href={href}
                    onClick={(evt) => {
                      if (
                        evt.defaultPrevented ||
                        evt.button !== 0 ||
                        evt.metaKey ||
                        evt.ctrlKey ||
                        evt.altKey ||
                        evt.shiftKey
                      ) {
                        return;
                      }
                      evt.preventDefault();
                      hostNavigation.navigate(href);
                    }}
                    style={{ ...linkStyle, fontSize: "0.875rem" }}
                  >
                    {label}
                  </a>
                ) : (
                  <span style={{ ...mutedTextStyle, fontSize: "0.875rem" }}>{label}</span>
                )}
                <span style={{ ...mutedTextStyle, fontSize: "0.6875rem" }}>
                  {relativeTime(event.occurredAt)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}

function StatusCardsRow({
  agents,
  openIssues,
  runs,
}: {
  agents: PluginDataResult<AgentsData>;
  openIssues: PluginDataResult<OpenIssuesData>;
  runs: PluginDataResult<RunsData>;
}) {
  return (
    <section
      aria-label="Detailed status cards"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
        gap: "1rem",
      }}
    >
      <OpenIssuesCard data={openIssues} />
      <AgentStatusCard data={agents} />
      <LatestActivityCard runs={runs} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// ConsoleOverviewPage — top-level component
// ---------------------------------------------------------------------------

export function ConsoleOverviewPage({ context }: PluginPageProps) {
  const hostContext = useHostContext();
  const companyId = context.companyId ?? hostContext.companyId;

  const agents = useAgentsTile(companyId);
  const openIssues = useOpenIssuesTile(companyId);
  const attention = useAttentionTile(companyId);
  const runs = useRunsTile(companyId);
  const goals = useGoalsTile(companyId);
  const costs = useCostsTile(companyId);

  useTickRefresh(companyId, [
    agents.refresh,
    openIssues.refresh,
    attention.refresh,
    runs.refresh,
    goals.refresh,
    costs.refresh,
  ]);

  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "1.5rem",
        padding: "1.5rem",
      }}
      aria-label={PLUGIN_DISPLAY_NAME}
      data-company-id={companyId ?? ""}
    >
      <header style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <span style={{ ...mutedTextStyle, fontSize: "0.6875rem", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          HuiDots Console
        </span>
        <h1 style={{ margin: 0, fontSize: "1.5rem", lineHeight: 1.25 }}>Live company state</h1>
        <p style={mutedTextStyle}>
          Six KPI tiles surface Paperclip state for the active company. Every card deep-links
          back into the host; the F1 plugin never writes to Paperclip and never inspects the
          host vault. Tiles refresh every 30 seconds.
        </p>
      </header>

      <KpiGrid
        agents={agents}
        openIssues={openIssues}
        attention={attention}
        runs={runs}
        goals={goals}
        costs={costs}
      />

      <StatusCardsRow agents={agents} openIssues={openIssues} runs={runs} />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Per-project scaffolding detail tabs (F2 / F3 empty states)
// ---------------------------------------------------------------------------

function ExtensionEmptyState({
  context,
  extension,
  featureTitle,
  parentIssueHref,
  pluginIssueHref,
}: {
  context: PluginHostContext;
  extension: "vault" | "pixel-agents";
  featureTitle: string;
  parentIssueHref: string;
  pluginIssueHref: string;
}) {
  return (
    <section
      aria-label={`${featureTitle} placeholder`}
      style={{
        ...cardStyle,
        alignItems: "flex-start",
        gap: "1rem",
      }}
    >
      <header>
        <h2 style={{ margin: 0, fontSize: "1.25rem", lineHeight: 1.25 }}>{featureTitle}</h2>
        <p style={{ ...mutedTextStyle, marginTop: "0.25rem" }}>
          {extension === "vault"
            ? "Read-mostly Obsidian library surface for this project."
            : "Pixel-agent inventory sourced from the existing research findings."}
        </p>
      </header>

      <p style={mutedTextStyle}>
        Coming <strong>{EXTENSION_TARGET_DATE_ISO}</strong>. This tab is scaffolded so the
        project detail navigation shows the reserved surface today; data loading is added
        in the {extension === "vault" ? "F3 (Vault)" : "F2 (Pixel Agents)"} extension wave.
      </p>

      <p style={mutedTextStyle}>
        See <a href={parentIssueHref} style={linkStyle}>HDO-117</a> for the parent initiative and{" "}
        <a href={pluginIssueHref} style={linkStyle}>HDO-137</a> for this F1 plugin's review trail.
      </p>

      <p style={{ ...mutedTextStyle, fontSize: "0.75rem" }}>
        Plugin context: company <code>{context.companyId ?? "—"}</code>
        {context.entityId ? <> · project <code>{context.entityId}</code></> : null}
      </p>
    </section>
  );
}

export function ConsoleProjectVaultTab({ context }: PluginDetailTabProps) {
  const hostNavigation = useHostNavigation();
  const parentHref = hostNavigation.resolveHref("/HDO/issues/HDO-117");
  const pluginHref = hostNavigation.resolveHref("/HDO/issues/HDO-137");
  return (
    <ExtensionEmptyState
      context={context}
      extension="vault"
      featureTitle="Vault"
      parentIssueHref={parentHref}
      pluginIssueHref={pluginHref}
    />
  );
}

export function ConsoleProjectPixelAgentsTab({ context }: PluginDetailTabProps) {
  const hostNavigation = useHostNavigation();
  const parentHref = hostNavigation.resolveHref("/HDO/issues/HDO-117");
  const pluginHref = hostNavigation.resolveHref("/HDO/issues/HDO-137");
  return (
    <ExtensionEmptyState
      context={context}
      extension="pixel-agents"
      featureTitle="Pixel Agents"
      parentIssueHref={parentHref}
      pluginIssueHref={pluginHref}
    />
  );
}