# @huidots/huidots-console-overview

F1 deliverable for the HuiDots Console / Dashboard initiative. This plugin
implements the **Live Company State Screen** as the first interactive surface
inside the live Paperclip control plane (`paperclip-pi-local-backport`).

## Surface

- **Top-bar "Console" tab** — `sidebar` slot rendered as an entry in the host
  app sidebar, opening the full overview page below.
- **Full overview page** at `:companyPrefix/plugins/huidots-console-overview/console` — six KPI tiles plus three status cards (Open issues by status, Agent status, Latest activity), each deep-linking back into Paperclip.
- **Per-project detail-tab scaffolding** — two empty-state placeholder tabs on every project's detail page (Vault for the F3 Obsidian library, Pixel Agents for the F2 inventory), each pointing to the [HDO-117](https://dashboard.huidots.com/HDO/issues/HDO-117) parent initiative.

## KPI Tiles (six `getData` workers)

| Key                   | Host endpoint                                                                       | SDK path                              |
|-----------------------|-------------------------------------------------------------------------------------|---------------------------------------|
| `agents`              | `GET /api/companies/{id}/agents`                                                    | `ctx.agents.list({ companyId })`      |
| `openIssuesByStatus`  | `GET /api/companies/{id}/issues?status=in_progress,blocked,todo,in_review&limit=200` | four `ctx.issues.list` joins (SDK limitation) |
| `attention`           | `GET /api/companies/{id}/attention`                                                 | pending envelope — endpoint not yet in SDK |
| `runs`                | `GET /api/companies/{id}/timeline?limit=20`                                         | pending envelope — endpoint not yet in SDK |
| `goals`               | `GET /api/companies/{id}/goals`                                                     | `ctx.goals.list({ companyId })`        |
| `costs`               | `GET /api/companies/{id}/costs/summary`                                             | pending envelope — endpoint not yet in SDK |

All Paperclip API traffic flows through the canonical host client. There is
no bundled credential, no `localFolders.write`, no `issues.write`, and no
plugin write capability of any kind.

## 30-second tick refresh

The worker emits `plugin.huidots-console-overview.tick` on a 30s interval
via `ctx.events.emit`. The UI mirror calls `usePluginData.refresh()` on the
same cadence so the six KPI tiles and three status cards re-render without
relying on plugin-side timers the host can't observe.

## Hard Constraints

This plugin is read-only by design (F1 spec, HDO-137 / HDO-117.C1):

- ❌ No schema change in Paperclip core
- ❌ No `issues.write`, `comments.write`, `documents.write`, or any write capability
- ❌ No `plugin.localFolders.write` (the plugin has no `localFolders` declaration)
- ❌ No bundled credentials (everything goes through `ctx.*`)
- ❌ No third-party SaaS, no remote vault, no remote pixel-office renderer
- ❌ No fork or separate HuiDots product

## Local Development

```bash
pnpm install
pnpm --filter @huidots/huidots-console-overview build
pnpm --filter @huidots/huidots-console-overview test
pnpm --filter @huidots/huidots-console-overview check:vault-readonly
```

## Local Install (board user)

Instance-wide plugin installation requires instance-admin (board) privileges,
so the install command itself must be run from a human board session:

```bash
cd paperclip-pi-local-backport
pnpm --filter @huidots/huidots-console-overview build
paperclipai plugin install ./packages/plugins/huidots-console-overview
```

## Out of Scope (F1)

- F2 Pixel-Agent Inventory content (rendered as a tab placeholder)
- F3 Obsidian Library content (rendered as a tab placeholder)
- Any P1 or later feature from the [feature list](https://dashboard.huidots.com/HDO/issues/HDO-117#document-feature-list)
