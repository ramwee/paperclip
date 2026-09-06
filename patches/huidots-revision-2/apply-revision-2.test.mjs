import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planAgentActions, planTaskMigration } from "./apply-revision-2.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("huidots revision 2 roster planning", () => {
  it("plans creates for missing COO/CHRO/research roles and updates for CEO", async () => {
    const roster = JSON.parse(await readFile(path.join(__dirname, "roster.json"), "utf8"));
    const existing = [
      {
        id: "11111111-1111-1111-1111-111111111111",
        name: "CEO",
        urlKey: "ceo",
        status: "active",
        metadata: {},
      },
      {
        id: "22222222-2222-2222-2222-222222222222",
        name: "CTO",
        urlKey: "cto",
        status: "active",
        metadata: {},
      },
    ];
    const actions = planAgentActions(roster, existing);
    const bySlug = Object.fromEntries(actions.map((a) => [a.slug, a.kind]));
    expect(bySlug.ceo).toBe("update");
    expect(bySlug.cto).toBe("update");
    expect(bySlug.coo).toBe("create");
    expect(bySlug.chro).toBe("create");
    expect(bySlug["research-director"]).toBe("create");
    expect(bySlug["business-analyst"]).toBe("create");
    expect(bySlug.summarizer).toBe("create");
    const summarizer = actions.find((a) => a.slug === "summarizer");
    expect(summarizer.desired.paused).toBe(true);
    const web = actions.find((a) => a.slug === "web-engineer");
    expect(web.harness.adapterType).toBe("codex_local");
    const designer = actions.find((a) => a.slug === "ui-ux-designer");
    expect(designer.harness.adapterType).toBe("cursor");
  });

  it("parks non-completed issues not already on CEO backlog", () => {
    const roster = {
      taskMigration: {
        nonCompletedStatuses: ["backlog", "todo", "in_progress", "in_review", "blocked"],
        parkStatus: "backlog",
        assigneeSlug: "ceo",
      },
    };
    const ceo = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const issues = [
      { id: "1", status: "done", assigneeAgentId: "x" },
      { id: "2", status: "cancelled", assigneeAgentId: "x" },
      { id: "3", status: "todo", assigneeAgentId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" },
      { id: "4", status: "backlog", assigneeAgentId: ceo },
      { id: "5", status: "blocked", assigneeAgentId: "cccccccc-cccc-cccc-cccc-cccccccccccc" },
    ];
    const targets = planTaskMigration(roster, issues, ceo);
    expect(targets.map((t) => t.id).sort()).toEqual(["3", "5"]);
  });

  it("keeps package AGENTS.md bodies non-empty for every roster agent", async () => {
    const roster = JSON.parse(await readFile(path.join(__dirname, "roster.json"), "utf8"));
    for (const agent of roster.agents) {
      const file = path.join(
        __dirname,
        "../../companies/huidots/agents",
        agent.slug,
        "AGENTS.md",
      );
      const raw = await readFile(file, "utf8");
      expect(raw.includes("Role:")).toBe(true);
      expect(raw.includes("reportsTo:")).toBe(true);
    }
  });
});
