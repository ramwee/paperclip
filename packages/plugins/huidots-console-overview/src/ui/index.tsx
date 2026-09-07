/**
 * huidots-console-overview UI bundle.
 *
 * Exports four components that the manifest references by exportName:
 *
 *   - ConsoleSidebarLink        (sidebar slot — top-bar "Console" tab)
 *   - ConsoleOverviewPage       (page slot — the live company-state screen)
 *   - ConsoleProjectVaultTab    (detailTab slot — F3 Obsidian library placeholder)
 *   - ConsoleProjectPixelAgentsTab
 *                                (detailTab slot — F2 pixel-agent inventory placeholder)
 *
 * All Paperclip API traffic flows through the SDK bridge
 * (`usePluginData(key, params)`); the bundle never imports the host client
 * directly and never builds its own auth context.
 */

import {
  StatusBadge,
  useHostContext,
  useHostNavigation,
  usePluginData,
  type PluginDataResult,
  type PluginPageProps,
  type PluginSidebarProps,
  type PluginDetailTabProps,
  type PluginHostContext,
} from "@paperclipai/plugin-sdk/ui";
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  EXTENSION_TARGET_DATE_ISO,
  KPI_KEYS,
  PAGE_ROUTE,
  PLUGIN_DISPLAY_NAME,
  SIDEBAR_SLOT_ID,
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

type OpenIssuesTile = {
  total: number;
  byStatus: Record<string, number>;
  perStatusSamples: Record<string, Array<{
    id: string;
    identifier: string | null;
    title: string;
    status: string;
    priority: string;
    assigneeAgentId: string | null;
    updatedAt: string;
  }>>;
  statuses: string[];
};

type GoalsTile = {
  total: number;
  active: number;
  achieved: number;
  archived: number;
  byLevel: Record<string, number>;
  sample: Array<{
    id: string;
    title: string;
    level: string;
    status: string;
    ownerAgentId: string | null;
  }>;
};

type AgentsData = TileEnvelope<AgentsTile>;
type OpenIssuesData = TileEnvelope<OpenIssuesTile>;
type GoalsData = TileEnvelope<GoalsTile>;
type PendingData = TileEnvelope<null>;

// ---------------------------------------------------------------------------
// Constants — display-only.
// ---------------------------------------------------------------------------

const REFRESH_INTERVAL_MS = 30_000;

const OPEN_STATUS_COLUMNS: Array<{ key: string; label: string; tone: "warning" | "info" | "pending" | "ok" }> = [
  { key: "in_progress", label: "In progress", tone: "warning" },
  { key: "blocked", label: "Blocked", tone: "warning" },
  { key: "in_review", label: "In review", tone: "pending" },
  { key: "todo", label: "Todo", tone: "info" },
];

// ---------------------------------------------------------------------------
// Tiny presentational helpers
// ---------------------------------------------------------------------------

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

function statusBadgeVariant(status: TileStatus): "ok" | "warning" | "error" | "info" | "pending" {
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

function useAgentsTile(companyId: string | null): PluginDataResult<AgentsData> {
  return usePluginData<AgentsData>(KPI_KEYS.agents, { companyId });
}

function useOpenIssuesTile(companyId: string | null): PluginDataResult<OpenIssuesData> {
  return usePluginData<OpenIssuesData>(KPI_KEYS.openIssuesByStatus, { companyId });
}

function useAttentionTile(companyId: string | null): PluginDataResult<PendingData> {
  return usePluginData<PendingData>(KPI_KEYS.attention, { companyId });
}

function useRunsTile(companyId: string | null): PluginDataResult<PendingData> {
  return usePluginData<PendingData>(KPI_KEYS.runs, { companyId });
}

function useGoalsTile(companyId: string | null): PluginDataResult<GoalsData> {
  return usePluginData<GoalsData>(KPI_KEYS.goals, { companyId });
}

function useCostsTile(companyId: string | null): PluginDataResult<PendingData> {
  return usePluginData<PendingData>(KPI_KEYS.costs, { companyId });
}

// ---------------------------------------------------------------------------
// 30-second tick refresh.
// Subscribes to the worker-emitted `plugin.<id>.tick` event (via document
// visibility refresh as a graceful fallback when the stream bridge is not
// available in the host runtime).
// ---------------------------------------------------------------------------

function useTickRefresh(companyId: string | null, refreshes: Array<() => void>) {
  const [lastTick, setLastTick] = useState<number>(Date.now());

  useEffect(() => {
    if (!companyId) return;
    const handle = window.setInterval(() => {
      setLastTick(Date.now());
      for (const refresh of refreshes) {
        try {
          refresh();
        } catch {
          // ignore — `usePluginData.refresh` is idempotent and the bridge
          // surfaces errors through `error`
        }
      }
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(handle);
  }, [companyId, refreshes]);

  return lastTick;
}

// ---------------------------------------------------------------------------
// ConsoleSidebarLink — the "Console" top-bar tab.
// ---------------------------------------------------------------------------

export function ConsoleSidebarLink({ context }: PluginSidebarProps) {
  const hostNavigation = useHostNavigation();
  const pluginKey = "huidots-console-overview";

  const href = useMemo(() => {
    const prefix = context.companyPrefix ? `/${context.companyPrefix}` : "";
    return hostNavigation.resolveHref(`/${pluginKey}/${PAGE_ROUTE}`);
  }, [context.companyPrefix, hostNavigation]);

  const handleClick = useCallback(
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
      event.preventDefault();
      hostNavigation.navigate(href);
    },
    [hostNavigation, href],
  );

  const isActive = useMemo(() => {
    if (typeof window === "undefined") return false;
    const target = window.location.pathname.replace(/\/+$/, "");
    const expected = href.replace(/\/+$/, "");
    return target === expected || target.startsWith(`${expected}/`);
  }, [href]);

  return (
    <a
      href={href}
      onClick={handleClick}
      aria-current={isActive ? "page" : undefined}
      data-plugin-slot={SIDEBAR_SLOT_ID}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        padding: "0.4rem 0.75rem",
        fontSize: "0.8125rem",
        fontWeight: 500,
        color: isActive ? "var(--foreground)" : "var(--muted-foreground)",
        background: isActive ? "var(--accent)" : "transparent",
        borderRadius: "0.5rem",
        textDecoration: "none",
        transition: "background 0.15s, color 0.15s",
      }}
      onMouseEnter={(e) => {
        if (!isActive) e.currentTarget.style.background = "color-mix(in oklab, var(--accent) 60%, transparent)";
      }}
      onMouseLeave={(e) => {
        if (!isActive) e.currentTarget.style.background = "transparent";
      }}
    >
      <span aria-hidden="true" style={{ fontSize: "1rem", lineHeight: 1 }}>
        ◧
      </span>
      <span>Console</span>
    </a>
  );
}

// ---------------------------------------------------------------------------
// ConsoleOverviewPage — the full live company-state screen.
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
  if (data.note || data.error) {
    return (
      <p style={{ ...mutedTextStyle, fontSize: "0.75rem", color: "var(--warning)" }}>
        {data.note ?? data.error}
      </p>
    );
  }
  return null;
}

function PendingTile({
  label,
  data,
}: {
  label: string;
  data: TileEnvelope<null> | null;
}) {
  const hostNavigation = useHostNavigation();
  return (
    <article style={cardStyle} aria-label={label}>
      <header style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <span style={{ ...mutedTextStyle, fontSize: "0.6875rem", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          {label}
        </span>
        <span style={{ fontSize: "1.5rem", fontWeight: 600, color: "var(--muted-foreground)" }}>
          —
        </span>
      </header>
      <TileSourceBadge data={data ?? null} />
      <TileNote data={data ?? null} />
      <p style={{ ...mutedTextStyle }}>
        Data feed pending. Tile will populate once the platform exposes this endpoint to the
        plugin SDK. See <a {...hostNavigation.linkProps("/HDO/issues/HDO-137")} style={linkStyle}>HDO-137</a>.
      </p>
    </article>
  );
}

function AgentsTileCard({ data }: { data: PluginDataResult<AgentsData> }) {
  const hostNavigation = useHostNavigation();
  const payload = data.data?.data ?? null;
  const status = data.data?.status;
  return (
    <article
      style={cardStyle}
      aria-label="Agents KPI"
      onClick={data.loading ? undefined : () => hostNavigation.navigate(`/${hostNavigation.resolveHref("/agents").replace(/^\//, "")}`)}
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
      {status !== "live" ? null : (
        <p style={{ ...mutedTextStyle }}>
          Click to view the{" "}
          <a {...hostNavigation.linkProps("/agents")} style={linkStyle}>
            full agent directory
          </a>
          .
        </p>
      )}
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
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.5rem" }}>
          <div style={{ ...mutedTextStyle }}>
            <div style={{ color: "var(--foreground)", fontWeight: 600 }}>{payload.active}</div>
            <div>active</div>
          </div>
          <div style={{ ...mutedTextStyle }}>
            <div style={{ color: "var(--foreground)", fontWeight: 600 }}>{payload.achieved}</div>
            <div>achieved</div>
          </div>
          <div style={{ ...mutedTextStyle }}>
            <div style={{ color: "var(--foreground)", fontWeight: 600 }}>{payload.archived}</div>
            <div>archived</div>
          </div>
        </div>
      ) : null}
      <TileSourceBadge data={data.data ?? null} />
      <TileNote data={data.data ?? null} />
    </article>
  );
}

function KpiGrid({
  companyId,
  agents,
  openIssues,
  attention,
  runs,
  goals,
  costs,
}: {
  companyId: string | null;
  agents: PluginDataResult<AgentsData>;
  openIssues: PluginDataResult<OpenIssuesData>;
  attention: PluginDataResult<PendingData>;
  runs: PluginDataResult<PendingData>;
  goals: PluginDataResult<GoalsData>;
  costs: PluginDataResult<PendingData>;
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
      <AgentsTileCard data={agents} />
      <OpenIssuesTileCard data={openIssues} />
      <PendingTile label="Attention" data={attention.data ?? null} />
      <PendingTile label="Runs (24h)" data={runs.data ?? null} />
      <GoalsTileCard data={goals} />
      <PendingTile label="Costs" data={costs.data ?? null} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Status cards row — three cards under the tiles.
// ---------------------------------------------------------------------------

function OpenIssuesCard({
  data,
}: {
  data: PluginDataResult<OpenIssuesData>;
}) {
  const hostNavigation = useHostNavigation();
  const payload = data.data?.data ?? null;

  const onCardClick = useCallback(() => {
    if (!data.data) return;
    hostNavigation.navigate(hostNavigation.resolveHref("/issues?status=in_progress,blocked,todo,in_review"));
  }, [hostNavigation, data.data]);

  return (
    <button
      type="button"
      onClick={onCardClick}
      aria-label="Open issues by status"
      style={{
        ...cardStyle,
        cursor: "pointer",
        textAlign: "left",
        background: "transparent",
        color: "var(--foreground)",
        outline: "none",
      }}
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
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <span style={{ fontWeight: 600, color: "var(--foreground)" }}>{count}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {payload && payload.total > 0 ? (
        <p style={{ ...mutedTextStyle }}>
          Click to open the issues inbox.
        </p>
      ) : null}
    </button>
  );
}

function AgentStatusCard({ data }: { data: PluginDataResult<AgentsData> }) {
  const hostNavigation = useHostNavigation();
  const payload = data.data?.data ?? null;

  const onCardClick = useCallback(() => {
    hostNavigation.navigate(hostNavigation.resolveHref("/agents"));
  }, [hostNavigation]);

  const onAgentClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, urlKey: string | null) => {
      event.preventDefault();
      event.stopPropagation();
      if (!urlKey) return;
      hostNavigation.navigate(hostNavigation.resolveHref(`/agents/${urlKey}`));
    },
    [hostNavigation],
  );

  return (
    <button
      type="button"
      onClick={onCardClick}
      aria-label="Agent status grid"
      style={{
        ...cardStyle,
        cursor: "pointer",
        textAlign: "left",
        background: "transparent",
        color: "var(--foreground)",
        outline: "none",
      }}
    >
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
          {payload.sample.map((agent) => (
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
              <a
                href={hostNavigation.resolveHref(`/agents/${agent.urlKey ?? agent.id}`)}
                onClick={(event) => onAgentClick(event, agent.urlKey)}
                style={{ ...linkStyle, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {agent.name}
              </a>
              <StatusBadge
                label={agent.status}
                status={agent.status === "running" ? "ok" : agent.status === "paused" ? "warning" : "info"}
              />
            </li>
          ))}
          {payload.sample.length === 0 ? (
            <li style={mutedTextStyle}>No agents recorded yet.</li>
          ) : null}
        </ul>
      )}
    </button>
  );
}

function LatestActivityCard({
  agents,
  goals,
}: {
  agents: PluginDataResult<AgentsData>;
  goals: PluginDataResult<GoalsData>;
}) {
  const hostNavigation = useHostNavigation();
  const agentList = agents.data?.data?.sample ?? [];
  const goalList = goals.data?.data?.sample ?? [];

  const items = useMemo(() => {
    const merged: Array<{ at: string; label: string; href: string }> = [];
    for (const agent of agentList) {
      merged.push({
        at: agents.data?.generatedAt ?? new Date().toISOString(),
        label: `Agent: ${agent.name} (${agent.status})`,
        href: hostNavigation.resolveHref(`/agents/${agent.urlKey ?? agent.id}`),
      });
    }
    for (const goal of goalList) {
      merged.push({
        at: goals.data?.generatedAt ?? new Date().toISOString(),
        label: `Goal: ${goal.title} (${goal.status})`,
        href: hostNavigation.resolveHref(`/goals/${goal.id}`),
      });
    }
    return merged.slice(0, 8);
  }, [agentList, goalList, agents.data?.generatedAt, goals.data?.generatedAt, hostNavigation]);

  return (
    <article style={cardStyle} aria-label="Latest activity feed">
      <header style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <span style={{ ...mutedTextStyle, fontSize: "0.6875rem", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Latest activity
        </span>
      </header>
      {items.length === 0 ? (
        <p style={mutedTextStyle}>No activity yet — once the workspace spins up, agent and goal state changes will appear here.</p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "0.375rem" }}>
          {items.map((item, i) => (
            <li key={`${item.href}-${i}`} style={{ display: "flex", flexDirection: "column", gap: "0.125rem" }}>
              <a href={item.href} style={{ ...linkStyle, fontSize: "0.875rem" }} onClick={(e) => {
                e.preventDefault();
                hostNavigation.navigate(item.href);
              }}>
                {item.label}
              </a>
              <span style={{ ...mutedTextStyle, fontSize: "0.6875rem" }}>
                {relativeTime(item.at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function StatusCardsRow({
  agents,
  openIssues,
  goals,
}: {
  agents: PluginDataResult<AgentsData>;
  openIssues: PluginDataResult<OpenIssuesData>;
  goals: PluginDataResult<GoalsData>;
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
      <LatestActivityCard agents={agents} goals={goals} />
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
        companyId={companyId}
        agents={agents}
        openIssues={openIssues}
        attention={attention}
        runs={runs}
        goals={goals}
        costs={costs}
      />

      <StatusCardsRow agents={agents} openIssues={openIssues} goals={goals} />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Per-project scaffolding detail tabs (F2 / F3 placeholders)
// ---------------------------------------------------------------------------

function ExtensionEmptyState({
  context,
  extension,
  featureTitle,
}: {
  context: PluginHostContext;
  extension: "vault" | "pixel-agents";
  featureTitle: string;
}) {
  const hostNavigation = useHostNavigation();

  const featureIssueHref = useMemo(() => {
    return hostNavigation.resolveHref("/HDO/issues/HDO-117");
  }, [hostNavigation]);

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
            ? "Read-mostive Obsidian library surface for this project."
            : "Pixel-agent inventory sourced from the existing research findings."}
        </p>
      </header>

      <p style={mutedTextStyle}>
        Coming <strong>{EXTENSION_TARGET_DATE_ISO}</strong>. This tab is scaffolded so the
        project detail navigation shows the reserved surfaces today; data loading is added
        in the F3 ({extension === "vault" ? "Vault" : "Pixel Agents"}) extension wave.
      </p>

      <p style={mutedTextStyle}>
        See <a {...hostNavigation.linkProps(featureIssueHref)} style={linkStyle}>HDO-117</a> for the
        parent initiative and{" "}
        <a {...hostNavigation.linkProps("/HDO/issues/HDO-137")} style={linkStyle}>HDO-137</a> for
        this F1 plugin's review trail.
      </p>

      <p style={{ ...mutedTextStyle, fontSize: "0.75rem" }}>
        Plugin context: company <code>{context.companyId ?? "—"}</code>
        {context.entityId ? <> · project <code>{context.entityId}</code></> : null}
      </p>
    </section>
  );
}

export function ConsoleProjectVaultTab({ context }: PluginDetailTabProps) {
  return <ExtensionEmptyState context={context} extension="vault" featureTitle="Vault" />;
}

export function ConsoleProjectPixelAgentsTab({ context }: PluginDetailTabProps) {
  return (
    <ExtensionEmptyState
      context={context}
      extension="pixel-agents"
      featureTitle="Pixel Agents"
    />
  );
}
