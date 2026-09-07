# @huidots/huidots-console-overview

F1 + F3 deliverable for the HuiDots Console / Dashboard initiative. This
plugin implements the **Live Company State Screen** plus the **F3 Obsidian
vault read bridge** inside the live Paperclip control plane
(`paperclip-pi-local-backport`).

## Surface

- **Top-bar "Console" tab** — `sidebar` slot rendered as an entry in the host
  app sidebar, opening the full overview page below.
- **Full overview page** at `:companyPrefix/plugins/huidots-console-overview/console` — six KPI tiles plus three status cards (Open issues by status, Agent status, Latest activity), each deep-linking back into Paperclip.
- **Per-project detail-tab "Vault"** — `detailTab` slot rendered on every
  project's detail page. The F3 surface exposes the operator-selected Obsidian
  vault at `HuiDots/Knowledge/ramsey-ai-portfolio-brain/` as a two-column
  desktop browser / one-panel mobile browser, read-only.
- **Per-project detail-tab "Pixel Agents"** — F2 placeholder tab. Scaffolding
  ships on the F3 branch; content lives in a separate child.

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
plugin write capability that could mutate host data.

## 30-second tick refresh

The worker emits `plugin.huidots-console-overview.tick` on a 30s interval
via `ctx.events.emit`. The UI mirror calls `usePluginData.refresh()` on the
same cadence so the six KPI tiles and three status cards re-render without
relying on plugin-side timers the host can't observe.

## F3 Obsidian vault read bridge (HDO-139 / HDO-76 Note B)

The F3 extension adds three new `getData` workers and a per-project
**Vault** detail tab. The bridge is one-way and read-only — the operator
points the plugin at a local folder containing the Obsidian vault, the
plugin renders it, and the vault remains human-controlled truth.

### Data handlers

| Key            | Params                                      | Returns                                                                                          |
|----------------|---------------------------------------------|--------------------------------------------------------------------------------------------------|
| `vaultStatus`  | `{ companyId }`                             | Folder health, configured path, access, problems, sensitivity policy, watcher cursors.            |
| `vaultTree`    | `{ companyId, projectId }`                  | Project-scoped tree (product subtree + cross-reference folders) with last-refreshed cursors.      |
| `vaultNote`    | `{ companyId, projectId, path }`            | Markdown body (or `[redacted]` placeholder), resolved wikilinks, headings, sensitivity metadata.  |

### Local file watcher

The worker starts a `fs.watch({ recursive: true })` (chokidar-or-equivalent)
on the operator's configured vault root **on the first vault data request
for a company** and writes a per-subtree cursor into `pluginState` on every
change:

```
plugin.huidots-console-overview.vault.changed   { path, subtree, mtimeMs, kind, at }
```

The watcher is debounced (250ms default), filters for `.md` files, and
refuses to start when the configured folder is not `access: "read"`.

### Sensitive-information rules

The bridge parses `10-Portfolio/Sensitive Information Rules.md` at read
time:

- If the rules note is missing the policy **fails closed** — every note
  renders as `[redacted]` with a clear reason.
- Notes whose `sensitivity:` frontmatter is not in the publish-safe
  allow-list (`internal-safe`, `public`, `shareable`) are redacted.
- Notes under `80-Career-and-Personal-Projects/` (personal health,
  workplace, political, career notes) are redacted regardless of
  frontmatter.
- Redaction happens in the worker before the payload crosses the bridge;
  the UI never receives flagged note bodies.

### Wikilink resolution

`[[wikilinks]]` in the rendered Markdown resolve **against the vault only**.
The host `MarkdownBlock` is configured with a `resolveWikiLinkHref` that
returns `null` for unresolvable targets (rendered as plain text) and
`#vault-note:<encoded path>` for resolvable targets. The read-pane
container intercepts those hash-href clicks and selects the note in-tab,
so the bridge never navigates into a Paperclip issue.

### Layout

- **Desktop** (≥720px): two columns — folder tree on the left, read pane
  on the right. The product subtree is auto-expanded on first load.
- **Mobile** (<720px): one panel with a back button from the read pane to
  the tree.

## Hard Constraints (binding)

This plugin is read-only by design (F1 spec, HDO-137 / HDO-117.C1; F3 spec,
HDO-139 / HDO-76 Note B §5):

- ❌ No schema change in Paperclip core
- ❌ No `issues.write`, `comments.write`, `documents.write`, or `activity.log.write`
- ❌ No `plugin.localFolders.write`
- ❌ No `localFolders.configure` call from plugin source (operator sets the
  path through the host plugin settings UI)
- ❌ No auto-issue-creation from vault notes
- ❌ No sync of vault notes into Paperclip issues / comments / docs
- ❌ No cross-tenant export — the bridge reads only the locally
  configured vault root
- ❌ No outbound HTTP
- ❌ No secret-parsing from vault notes
- ❌ No bundled credentials
- ❌ No fork or separate HuiDots product

`pnpm check:vault-readonly` enforces the binding rules at lint time: it
rejects any reference to `writeTextAtomic`, `deleteFile`,
`localFolders.configure`, the `plugin.localFolders.write` capability, or
the `issues.create` / `issue.comments.create` / `issue.documents.write` /
`activity.log.write` / `document.upsert` call shapes anywhere in `src/`,
and asserts the manifest declares `access: "read"` for the vault folder
key.

## Operator setup (reviewer reproduction)

1. Build the plugin: `pnpm --filter @huidots/huidots-console-overview build`.
2. Install: `paperclipai plugin install ./packages/plugins/huidots-console-overview`
   from `paperclip-pi-local-backport/`.
3. Open the HuiDots Console plugin settings page for the operator's
   company and set **Obsidian vault root** to the absolute path that
   contains the vault (for example, the live
   `HuiDots/Knowledge/ramsey-ai-portfolio-brain/` folder). The settings
   page probes the path with the same `PluginLocalFolderStatus` checks
   the worker uses.
4. Open any project's detail page and click the **Vault** tab. The tree
   shows the project's `30-Products/<Product>/` subtree plus the three
   cross-reference folders (`10-Portfolio`, `70-Reviews-and-Scorecards`,
   `60-Portfolio-Decisions`).
5. Click any `.md` note. The read pane renders it (or `[redacted]` for
   flagged notes), with vault-only wikilinks and a last-refreshed
   timestamp.
6. Touch a `.md` file under the configured vault root from a separate
   shell (`touch …/30-Products/Crevoro/00-Product Overview.md`). The
   watcher emits `plugin.huidots-console-overview.vault.changed`; the
   cursor in `pluginState` is updated; the next `vaultTree` call
   surfaces the new mtime in the `lastRefreshedAt` badge.

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

## Out of Scope (F1 + F3)

- F2 Pixel-Agent Inventory content (rendered as a tab placeholder)
- Top-bar global vault search (P2 candidate; out of scope for F3)
- Vault write-back, vault→Paperclip sync, auto-issue-creation from vault
  notes — **all three are explicitly binding-rejected** by HDO-76 Note B
  §5 and §7.
