# HuiDots Revision 2 apply pack

Applies the Revision 2 organization onto the live **HuiDots** Paperclip instance without recreating the company database, secrets, or Telegram configuration.

## What this pack does

1. Upserts the Revision 2 agent roster (create missing COO/CHRO/Research Director/Business Analyst/utilities; update reportsTo, harness, instructions).
2. Keeps Summarizer and Reflection Coach **paused**.
3. Parks non-completed work to CEO `backlog` for re-triage (preserves descriptions, comments, work products, links, dependencies).
4. Creates/updates the four scheduled routines (CSO/CMO/CHRO/COO).

## What it does not do

- Merge or deploy
- Touch `ui/**` or `server/ui-dist/**`
- Change Telegram plugin files/behavior
- Shorten agent instructions to bypass adapter limits
- Delete completed history

## Prerequisites

- HuiDots Paperclip listening on `http://127.0.0.1:3100`
- Board-authenticated API key (`PAPERCLIP_API_KEY` / `--api-key`)
- Working tree includes `companies/huidots/**` and this pack

## Commands

Dry-run (default):

```powershell
node patches/huidots-revision-2/apply-revision-2.mjs --api-base http://127.0.0.1:3100 --dry-run
```

Apply:

```powershell
$env:PAPERCLIP_API_KEY = "<board-token>"
node patches/huidots-revision-2/apply-revision-2.mjs --api-base http://127.0.0.1:3100 --apply
```

Optional:

```powershell
node patches/huidots-revision-2/apply-revision-2.mjs --apply --company-id <uuid>
node patches/huidots-revision-2/apply-revision-2.mjs --apply --skip-task-migration
node patches/huidots-revision-2/apply-revision-2.mjs --apply --skip-routines
```

## After apply

1. Restart only the existing **HuiDots Paperclip** scheduled task if agents were mid-run.
2. Confirm `/api/health` = 200.
3. CEO re-triages parked backlog: cancel, keep parked, re-scope, split, or assign to the correct executive.
4. Confirm routines appear for CSO/CMO/CHRO/COO.
5. Confirm utilities remain paused.

## Related code fix

Windows `pi_local` long-prompt repair (temp system-prompt file + stdin user prompt) ships on branch `cursor/huidots-revision-2-fdc9` and should be present in the HuiDots checkout before MiniMax/`pi_local` agents run large AGENTS.md instructions.
