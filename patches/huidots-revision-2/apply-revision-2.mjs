#!/usr/bin/env node
/**
 * HuiDots Revision 2 apply + task migration.
 *
 * Safe defaults: --dry-run. Live apply requires --apply and a board token.
 * Does not merge, deploy, touch ui/**, or modify Telegram.
 *
 * Auth (first match):
 *   --api-key
 *   PAPERCLIP_API_KEY
 *   PAPERCLIP_BOARD_TOKEN
 *
 * Example (Owner Windows host after Paperclip is healthy on :3100):
 *   node patches/huidots-revision-2/apply-revision-2.mjs --api-base http://127.0.0.1:3100 --dry-run
 *   node patches/huidots-revision-2/apply-revision-2.mjs --api-base http://127.0.0.1:3100 --apply
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

function parseArgs(argv) {
  const out = {
    apiBase: "http://127.0.0.1:3100",
    apiKey: process.env.PAPERCLIP_API_KEY || process.env.PAPERCLIP_BOARD_TOKEN || "",
    companyId: "",
    dryRun: true,
    apply: false,
    skipTaskMigration: false,
    skipRoutines: false,
    rosterPath: path.join(__dirname, "roster.json"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--api-base" && next) {
      out.apiBase = next.replace(/\/$/, "");
      i++;
    } else if (a === "--api-key" && next) {
      out.apiKey = next;
      i++;
    } else if (a === "--company-id" && next) {
      out.companyId = next;
      i++;
    } else if (a === "--roster" && next) {
      out.rosterPath = path.resolve(next);
      i++;
    } else if (a === "--apply") {
      out.apply = true;
      out.dryRun = false;
    } else if (a === "--dry-run") {
      out.dryRun = true;
      out.apply = false;
    } else if (a === "--skip-task-migration") {
      out.skipTaskMigration = true;
    } else if (a === "--skip-routines") {
      out.skipRoutines = true;
    } else if (a === "--help" || a === "-h") {
      out.help = true;
    }
  }
  return out;
}

function normalizeUrlKey(name) {
  if (!name || typeof name !== "string") return null;
  const key = name
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return key || null;
}

function splitAgentsMd(raw) {
  const text = String(raw ?? "");
  if (!text.startsWith("---")) {
    return { frontmatter: "", body: text.trim() };
  }
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { frontmatter: "", body: text.trim() };
  const bodyStart = text.indexOf("\n", end + 4);
  const body = (bodyStart >= 0 ? text.slice(bodyStart + 1) : "").trim();
  return { frontmatter: text.slice(0, bodyStart >= 0 ? bodyStart : end), body };
}

async function loadRoster(rosterPath) {
  const raw = await readFile(rosterPath, "utf8");
  return JSON.parse(raw);
}

async function readAgentInstructions(packagePath, slug) {
  const file = path.join(REPO_ROOT, packagePath, "agents", slug, "AGENTS.md");
  const raw = await readFile(file, "utf8");
  return splitAgentsMd(raw).body;
}

async function api(opts, method, route, body) {
  const headers = {
    Accept: "application/json",
    ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
  };
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${opts.apiBase}${route}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`${method} ${route} -> ${res.status}: ${typeof json === "object" ? JSON.stringify(json) : text}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

function indexAgents(agents) {
  const byUrlKey = new Map();
  const byId = new Map();
  for (const agent of agents ?? []) {
    if (!agent || agent.status === "terminated") continue;
    byId.set(agent.id, agent);
    const key = agent.urlKey || normalizeUrlKey(agent.name);
    if (key && !byUrlKey.has(key)) byUrlKey.set(key, agent);
  }
  return { byUrlKey, byId };
}

function findCompany(companies, roster, companyId) {
  if (companyId) {
    const hit = (companies ?? []).find((c) => c.id === companyId);
    if (!hit) throw new Error(`Company id ${companyId} not found`);
    return hit;
  }
  const hints = (roster.companyNameHints ?? []).map((h) => h.toLowerCase());
  const matches = (companies ?? []).filter((c) => {
    const name = String(c.name ?? "").toLowerCase();
    const key = normalizeUrlKey(c.name);
    return hints.some((h) => name === h.toLowerCase() || key === normalizeUrlKey(h));
  });
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(
      `Could not find HuiDots company. Pass --company-id. Visible companies: ${(companies ?? [])
        .map((c) => `${c.name}(${c.id})`)
        .join(", ")}`,
    );
  }
  throw new Error(`Ambiguous HuiDots company match: ${matches.map((c) => `${c.name}(${c.id})`).join(", ")}`);
}

function harnessConfig(roster, harness) {
  const entry = roster.harnessPolicy?.[harness];
  if (!entry) throw new Error(`Unknown harness ${harness}`);
  return entry;
}

export function planAgentActions(roster, existingAgents) {
  const { byUrlKey } = indexAgents(existingAgents);
  const actions = [];
  for (const desired of roster.agents) {
    const existing = byUrlKey.get(desired.slug) || byUrlKey.get(normalizeUrlKey(desired.name));
    const harness = harnessConfig(roster, desired.harness);
    if (!existing) {
      actions.push({ kind: "create", slug: desired.slug, desired, harness });
    } else {
      actions.push({
        kind: "update",
        slug: desired.slug,
        agentId: existing.id,
        existing,
        desired,
        harness,
        needsPause: Boolean(desired.paused) && existing.status !== "paused",
        needsResume: !desired.paused && existing.status === "paused",
      });
    }
  }
  return actions;
}

export function planTaskMigration(roster, issues, ceoAgentId) {
  const statuses = new Set(roster.taskMigration.nonCompletedStatuses);
  const targets = [];
  for (const issue of issues ?? []) {
    if (!statuses.has(issue.status)) continue;
    const already =
      issue.status === roster.taskMigration.parkStatus && issue.assigneeAgentId === ceoAgentId;
    if (already) continue;
    targets.push(issue);
  }
  return targets;
}

async function ensureInstructions(opts, agentId, body, dryRun) {
  if (dryRun) return { dryRun: true };
  // Prefer instructions-bundle file upsert; fall back to adapterConfig instructions text is not used.
  try {
    await api(opts, "PUT", `/api/agents/${agentId}/instructions-bundle/file`, {
      path: "AGENTS.md",
      content: body,
    });
    return { ok: true };
  } catch (err) {
    // Older instances may need bundle create first.
    if (err.status === 404 || err.status === 422) {
      await api(opts, "PATCH", `/api/agents/${agentId}/instructions-bundle`, {
        rootPath: "AGENTS.md",
      }).catch(() => undefined);
      await api(opts, "PUT", `/api/agents/${agentId}/instructions-bundle/file`, {
        path: "AGENTS.md",
        content: body,
      });
      return { ok: true, recovered: true };
    }
    throw err;
  }
}

async function upsertAgents(opts, roster, companyId, existingAgents, dryRun) {
  const actions = planAgentActions(roster, existingAgents);
  const created = [];
  const updated = [];
  const idBySlug = new Map();

  // Seed known ids
  for (const action of actions) {
    if (action.kind === "update") idBySlug.set(action.slug, action.agentId);
  }

  // Create missing first (reportsTo wired in a second pass)
  for (const action of actions) {
    if (action.kind !== "create") continue;
    const instructions = await readAgentInstructions(roster.packagePath, action.slug);
    const payload = {
      name: action.desired.name,
      title: action.desired.title,
      role: action.desired.role,
      adapterType: action.harness.adapterType,
      adapterConfig: { ...action.harness.adapterConfig },
      metadata: {
        huidotsRevision: 2,
        huidotsSlug: action.slug,
        huidotsHarness: action.desired.harness,
      },
      ...(action.desired.canCreateAgents
        ? { permissions: { canCreateAgents: true } }
        : {}),
    };
    if (dryRun) {
      created.push({ slug: action.slug, dryRun: true, payload });
      continue;
    }
    const agent = await api(opts, "POST", `/api/companies/${companyId}/agents`, payload);
    idBySlug.set(action.slug, agent.id);
    await ensureInstructions(opts, agent.id, instructions, false);
    if (action.desired.paused) {
      await api(opts, "POST", `/api/agents/${agent.id}/pause`, {});
    }
    created.push({ slug: action.slug, id: agent.id });
  }

  // Refresh map if dry-run (synthetic) — skip reportsTo wiring
  if (!dryRun) {
    const refreshed = await api(opts, "GET", `/api/companies/${companyId}/agents`);
    const list = Array.isArray(refreshed) ? refreshed : refreshed?.agents ?? [];
    for (const agent of list) {
      const key = agent.urlKey || normalizeUrlKey(agent.name);
      if (key) idBySlug.set(key, agent.id);
      // also map package slugs for names like UI/UX Designer -> ui-ux-designer
      for (const desired of roster.agents) {
        if (normalizeUrlKey(desired.name) === key) idBySlug.set(desired.slug, agent.id);
      }
    }
  }

  for (const action of actions) {
    if (action.kind !== "update") continue;
    const instructions = await readAgentInstructions(roster.packagePath, action.slug);
    const reportsToSlug = action.desired.reportsTo;
    const reportsTo = reportsToSlug ? idBySlug.get(reportsToSlug) ?? null : null;
    const patch = {
      title: action.desired.title,
      role: action.desired.role,
      reportsTo,
      adapterType: action.harness.adapterType,
      adapterConfig: { ...action.harness.adapterConfig },
      replaceAdapterConfig: false,
      metadata: {
        ...(action.existing.metadata && typeof action.existing.metadata === "object"
          ? action.existing.metadata
          : {}),
        huidotsRevision: 2,
        huidotsSlug: action.slug,
        huidotsHarness: action.desired.harness,
      },
    };
    if (dryRun) {
      updated.push({ slug: action.slug, dryRun: true, patch, needsPause: action.needsPause });
      continue;
    }
    await api(opts, "PATCH", `/api/agents/${action.agentId}`, patch);
    await ensureInstructions(opts, action.agentId, instructions, false);
    if (action.needsPause) await api(opts, "POST", `/api/agents/${action.agentId}/pause`, {});
    if (action.needsResume) {
      // Keep utilities paused unless desired.paused is false.
      await api(opts, "POST", `/api/agents/${action.agentId}/resume`, {});
    }
    updated.push({ slug: action.slug, id: action.agentId });
  }

  // Second pass: set reportsTo for newly created agents
  if (!dryRun) {
    for (const action of actions) {
      if (action.kind !== "create") continue;
      const id = idBySlug.get(action.slug);
      if (!id) continue;
      const reportsTo = action.desired.reportsTo ? idBySlug.get(action.desired.reportsTo) ?? null : null;
      await api(opts, "PATCH", `/api/agents/${id}`, { reportsTo });
    }
  }

  return { created, updated, idBySlug, actions };
}

async function migrateTasks(opts, roster, companyId, ceoAgentId, dryRun) {
  const status = roster.taskMigration.nonCompletedStatuses.join(",");
  const issues = await api(
    opts,
    "GET",
    `/api/companies/${companyId}/issues?status=${encodeURIComponent(status)}`,
  );
  const list = Array.isArray(issues) ? issues : issues?.issues ?? [];
  const targets = planTaskMigration(roster, list, ceoAgentId);
  const results = [];
  for (const issue of targets) {
    const comment = [
      `${roster.taskMigration.commentPrefix}: parked for CEO re-triage.`,
      "",
      "- Preserved description, comments, work products, parent/child links, and dependencies.",
      "- Status set to backlog and assignee set to CEO.",
      "- CEO may cancel, keep parked, re-scope, split, or assign to the correct executive.",
      `- Previous status: \`${issue.status}\``,
      `- Previous assigneeAgentId: \`${issue.assigneeAgentId ?? "none"}\``,
    ].join("\n");
    if (dryRun) {
      results.push({ id: issue.id, identifier: issue.identifier ?? issue.title, dryRun: true });
      continue;
    }
    const updated = await api(opts, "PATCH", `/api/issues/${issue.id}`, {
      status: roster.taskMigration.parkStatus,
      assigneeAgentId: ceoAgentId,
      comment,
    });
    results.push({
      id: issue.id,
      identifier: updated?.identifier ?? issue.identifier ?? issue.title,
      status: updated?.status,
      assigneeAgentId: updated?.assigneeAgentId,
    });
  }
  return { scanned: list.length, migrated: results };
}

async function ensureRoutines(opts, roster, companyId, idBySlug, dryRun) {
  const existing = await api(opts, "GET", `/api/companies/${companyId}/routines`).catch(() => []);
  const list = Array.isArray(existing) ? existing : existing?.routines ?? [];
  const byTitle = new Map(list.map((r) => [String(r.title ?? "").toLowerCase(), r]));
  const results = [];
  for (const routine of roster.routines) {
    const hit = byTitle.get(routine.title.toLowerCase());
    const assigneeAgentId = idBySlug.get(routine.assignee);
    if (!assigneeAgentId && !dryRun) {
      results.push({ key: routine.key, skipped: true, reason: `missing assignee ${routine.assignee}` });
      continue;
    }
    if (hit) {
      if (dryRun) {
        results.push({ key: routine.key, action: "update", dryRun: true, id: hit.id });
        continue;
      }
      await api(opts, "PATCH", `/api/routines/${hit.id}`, {
        title: routine.title,
        description: routine.description,
        assigneeAgentId,
        status: "active",
      });
      // Ensure a schedule trigger exists
      const triggers = hit.triggers ?? [];
      const hasSchedule = triggers.some((t) => t.kind === "schedule");
      if (!hasSchedule) {
        await api(opts, "POST", `/api/routines/${hit.id}/triggers`, {
          kind: "schedule",
          cronExpression: routine.cronExpression,
          timezone: routine.timezone,
          enabled: true,
          label: routine.key,
        });
      }
      results.push({ key: routine.key, action: "update", id: hit.id });
      continue;
    }
    if (dryRun) {
      results.push({ key: routine.key, action: "create", dryRun: true });
      continue;
    }
    const created = await api(opts, "POST", `/api/companies/${companyId}/routines`, {
      title: routine.title,
      description: routine.description,
      assigneeAgentId,
      status: "active",
      priority: "medium",
    });
    await api(opts, "POST", `/api/routines/${created.id}/triggers`, {
      kind: "schedule",
      cronExpression: routine.cronExpression,
      timezone: routine.timezone,
      enabled: true,
      label: routine.key,
    });
    results.push({ key: routine.key, action: "create", id: created.id });
  }
  return results;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`Usage: node patches/huidots-revision-2/apply-revision-2.mjs [options]
  --api-base URL          Default http://127.0.0.1:3100
  --api-key TOKEN         Board bearer token (or PAPERCLIP_API_KEY)
  --company-id UUID       Optional explicit company id
  --dry-run               Plan only (default)
  --apply                 Perform mutations
  --skip-task-migration   Do not park non-completed issues
  --skip-routines         Do not create/update routines`);
    process.exit(0);
  }

  const roster = await loadRoster(opts.rosterPath);
  if (!opts.apiKey && !opts.dryRun) {
    throw new Error("Missing board API key. Pass --api-key or set PAPERCLIP_API_KEY.");
  }

  // Health is optional in dry-run without a running server; try anyway.
  try {
    const health = await api(opts, "GET", "/api/health");
    console.log(JSON.stringify({ health: health?.status ?? health }, null, 2));
  } catch (err) {
    if (!opts.dryRun) throw err;
    console.log(JSON.stringify({ health: "unreachable", note: "continuing dry-run offline plan only for package integrity" }, null, 2));
    // Offline dry-run: validate package files exist
    for (const agent of roster.agents) {
      await readAgentInstructions(roster.packagePath, agent.slug);
    }
    const packageSkills = path.join(REPO_ROOT, roster.packagePath, "skills");
    const skills = await readdir(packageSkills);
    console.log(
      JSON.stringify(
        {
          mode: "dry-run-offline",
          agents: roster.agents.map((a) => ({
            slug: a.slug,
            reportsTo: a.reportsTo,
            harness: a.harness,
            paused: a.paused,
          })),
          routines: roster.routines,
          skills,
        },
        null,
        2,
      ),
    );
    return;
  }

  const companies = await api(opts, "GET", "/api/companies");
  const companyList = Array.isArray(companies) ? companies : companies?.companies ?? [];
  const company = findCompany(companyList, roster, opts.companyId);
  console.log(JSON.stringify({ company: { id: company.id, name: company.name } }, null, 2));

  const agentsResp = await api(opts, "GET", `/api/companies/${company.id}/agents`);
  const agents = Array.isArray(agentsResp) ? agentsResp : agentsResp?.agents ?? [];
  const agentPlan = await upsertAgents(opts, roster, company.id, agents, opts.dryRun);

  // Resolve CEO id for migration
  let ceoId = agentPlan.idBySlug.get("ceo");
  if (!ceoId) {
    const { byUrlKey } = indexAgents(agents);
    ceoId = byUrlKey.get("ceo")?.id;
  }
  if (!ceoId && !opts.dryRun) throw new Error("CEO agent id not resolved after upsert");

  let migration = { scanned: 0, migrated: [] };
  if (!opts.skipTaskMigration) {
    if (opts.dryRun && !ceoId) {
      migration = { scanned: 0, migrated: [], note: "CEO id unknown until apply; dry-run skipped live issue scan detail" };
      // Still attempt scan if API available
      try {
        migration = await migrateTasks(opts, roster, company.id, "00000000-0000-0000-0000-000000000000", true);
      } catch {
        /* ignore */
      }
    } else {
      migration = await migrateTasks(opts, roster, company.id, ceoId, opts.dryRun);
    }
  }

  let routines = [];
  if (!opts.skipRoutines) {
    routines = await ensureRoutines(opts, roster, company.id, agentPlan.idBySlug, opts.dryRun);
  }

  console.log(
    JSON.stringify(
      {
        mode: opts.dryRun ? "dry-run" : "apply",
        revision: roster.revision,
        agents: { created: agentPlan.created, updated: agentPlan.updated },
        taskMigration: migration,
        routines,
      },
      null,
      2,
    ),
  );
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
  });
}
