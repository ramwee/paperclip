# Telegram Owner decision bridge

This directory captures the HuiDots Telegram Owner-decision compatibility overlay so the working local fix is reproducible instead of living only inside an installed `node_modules` package.

## Owner apply (one command)

After this PR is reviewed, stay on the HuiDots runtime checkout (`examples/pixel-strip-and-vault-read-bridge-clean`). Do not switch branches. From the Paperclip repo root, run exactly this:

```powershell
git fetch origin fix/hdo-windows-dashboard-telegram-forward-port:refs/hdo-owner/forward-port; git show refs/hdo-owner/forward-port:patches/hdo-owner-apply-and-verify.ps1 | powershell -NoProfile -ExecutionPolicy Bypass -Command -
```

That command fetches the reviewed forward-port commit into `refs/hdo-owner/forward-port` (it does not require `origin/<branch>` to exist), then runs `patches/hdo-owner-apply-and-verify.ps1`. The orchestrator keeps you on the current local branch, fast-forwards only that fetched SHA when it is a clean descendant of `def9c581`, reuses `apply-installed.ps1` / `verify.ps1`, and restarts only the existing **HuiDots Paperclip** scheduled task. It runs one affected-surface acceptance sweep and prints a single sectioned `HDO_OWNER_APPLY=PASS` / `FAIL` / `NOT-VERIFIABLE-LOCALLY` report with every failing check name. It stops immediately only when continuing would be unsafe (wrong repo/branch/ancestry, dirty worktree, missing required task/tooling, Node below 24.11, or inability to preserve `pnpm-lock.yaml`). Overlay patching is applied first with `-SkipReadiness`; authenticated Telegram enable runs only after the existing task restart and backend ready. If source/dependency/focused prerequisites fail, the live instance is left untouched. A genuine Telegram Approve/Revise remains a separate Owner acceptance action.

## Pins

- Paperclip base branch: `examples/pixel-strip-and-vault-read-bridge-clean`
- Paperclip base SHA used for this task: `def9c581b48a1fea845bb7b4a8726e201a3ad5d2`
- Forward-port branch: `fix/hdo-windows-dashboard-telegram-forward-port`
- Shared Zod on this base: already `^4.4.3` (no Zod migration replayed)
- Telegram plugin package: `paperclip-plugin-telegram@0.8.0`
- Telegram plugin v0.8.0 commit: `611a28d4a126180acdd5b62d2c7acdbf9b7af87e`
- Telegram annotated tag object: `705e9253a6010654d658c7d63ad01a0e03a447b2`

The upstream v0.8.0 tag is signed and currently remains the latest release. Current Paperclip upstream still logs `issue.thread_interaction_created`, but does not expose that activity as a plugin event. Current Telegram upstream does not implement `request_confirmation` Owner-decision handling.

## Scope

The overlay adds only the missing path:

1. Paperclip exposes `issue.thread_interaction.created` to plugins.
2. Telegram requests `issue.interactions.read` and `issue.interactions.respond`.
3. Pending `request_confirmation` interactions are sent to the linked/allowed Telegram chat with **Approve** and **Revise** buttons.
4. Callback handling rechecks company, issue, interaction kind and pending status before using the existing Paperclip interaction-response API.
5. `boardAccess.identity` remains a display label only. Canonical `actorUserId` comes from the existing Board Access token via `GET /api/cli-auth/me` (`userId` / `user.id`). Legacy board-access state recovers by token introspection without reconnecting.
6. Host-side board-user authorization remains authoritative. Missing/invalid token and company mismatch fail closed.

No new decision store, polling loop, supervisor, merge path or deployment mechanism is introduced.

## Plugin readiness note

`plugin-loader: no ready plugins to load` means the plugins table has no rows in `ready` status. Telegram is an npm-installed plugin (not a bundled auto-provision). If a prior activation failure marked it `error`, startup will skip it until `POST /api/plugins/:id/enable` succeeds. `apply-installed.ps1` performs that readiness correction against the existing HuiDots instance via the authenticated `paperclipai` CLI (stored board credential / env — never naked unauthenticated HTTP, and never printing or persisting tokens), without recreating the company, database, secrets, or Telegram configuration. The Owner orchestrator is the one command that applies that overlay, restarts only the existing **HuiDots Paperclip** scheduled task, waits for embedded Postgres, and verifies readiness.

## Files

- `paperclip-core.patch` — the two-line Paperclip event exposure change.
- `telegram-v0.8.0.patch` — source patch against the pinned Telegram v0.8.0 commit.
- `owner-decision-actor.ts` / `owner-decision-actor.test.ts` — pure actor-resolution contract + focused tests.
- `apply-installed.ps1` — idempotent Windows installer for the already-installed v0.8.0 package used by HuiDots. Default includes readiness enable. `-SkipReadiness` patches installed files only.
- `verify.ps1` — bounded verification of the Paperclip source markers, installed Telegram runtime files, and optional live health/ready checks.
- `../hdo-owner-apply-and-verify.ps1` — single Owner apply-and-verify orchestrator. Reuses the two scripts above. Invoked by the one bootstrap command.

## Acceptance status

Static validation is covered by focused actor tests, plugin-loader Windows ESM coverage, shared/server typechecks, and `git diff --check` on this forward-port branch.

Live acceptance for the Owner-decision callback remains pending until the overlay is applied on HuiDots, Paperclip is restarted, the Telegram plugin reports `ready`, and the next genuine `request_confirmation` Approve/Revise callback succeeds with the canonical `actorUserId` path. Synthetic live Telegram UAT is intentionally not repeated.
