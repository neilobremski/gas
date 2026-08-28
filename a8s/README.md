# A8S-GAS — Google Apps Script participant for A8S

A GAS script that acts as an [A8S](https://github.com/witw-llc/ar3) participant via Google Drive ([filedrop](https://github.com/witw-llc/ar3/blob/main/docs/a8s-filedrop.md) transport). It provides a mapped-mail switchboard, named outbound email routes, an optional command surface, and calendar scheduling with a distinct sender identity.

Upstream A8S docs: [docs/a8s.md](https://github.com/witw-llc/ar3/blob/main/docs/a8s.md) · [filedrop](https://github.com/witw-llc/ar3/blob/main/docs/a8s-filedrop.md)

## Architecture

```
A8S server (rclone mount) ←→ Google Drive folder ←→ GAS (time trigger)
```

Drive folder layout:
```
<root>/
  .inbox/              ← A8S writes here; GAS reads + deletes after processing
  .outbox/
    <msg_id>.json      ← GAS writes envelopes; A8S ingests
    <msg_id>/          ← outbound attachment bundles (GAS → recipient)
  .files/
    <msg_id>/          ← inbound attachments (A8S → GAS, e.g. tell --attach)

<scheduler-root>/      ← optional; set A8S_SCHED_FOLDER_ID
  .outbox/             ← calendar envelopes only
```

Register the **same primary Drive mount** under multiple filedrop names — the command node, email principals, and named routes. Mail to any of these names lands in the shared `.inbox/`; GAS routes on `envelope.to`:

```bash
a8s add my-google /mnt/gdrive/a8s filedrop
a8s add human-mail /mnt/gdrive/a8s filedrop
a8s add owner-mail /mnt/gdrive/a8s filedrop
```

| `to` | GAS behavior |
|------|----------------|
| `my-google` (`A8S_DEVICE`) | Slash commands (if `from` is in `A8S_COMMAND_AGENTS`) |
| `human-mail` (value in `A8S_EMAIL_MAP`) | Opaque outbound email to the mapped address |
| `owner-mail` (key in `A8S_ROUTES`) | Email whose subject is the first content line and body is the remainder |

Email-ingress outbox envelopes set `"from": "human-mail"` so replies can target the email principal.

## Project files

| File | Role |
|------|------|
| `Code.js` | Main script — commands, push routing, markdown, logging |
| `vendor/marked.js` | Transpiled [marked](https://github.com/markedjs/marked) (ES2017 for GAS) |
| `appsscript.json` | Manifest (V8, Calendar advanced service) |
| `package.json` | npm deps; `npm run vendor` rebuilds `vendor/marked.js` |
| `tests/test.js` | Unit tests (`tests/run`) |
| `.claspignore` | Excludes `node_modules/`, tests, scripts from clasp push |

**Do not** push `node_modules/` — clasp will fail on ES module syntax. The vendor script transpiles marked for GAS.

## Development

### clasp setup

[clasp](https://github.com/google/clasp) is Google's CLI for pushing/pulling Apps Script code.

```bash
npm install -g @google/clasp
clasp login
clasp create --type standalone --title "A8S GAS"   # or set scriptId in .clasp.json
```

### Deploy (test + vendor + push)

```bash
./deploy.sh
```

This runs `npm ci`, transpiles marked to `vendor/marked.js`, runs tests, then `clasp push`.

### Manual commands

```bash
npm ci && npm run vendor   # transpile marked → vendor/marked.js
tests/run                  # unit tests (Node.js + marked from npm)
clasp push                 # push without testing
clasp pull                 # pull remote changes
clasp open                 # open in browser
```

## Setup

1. Create a folder in Google Drive for this participant
2. Push via `./deploy.sh` (deploys `Code.js`, `vendor/marked.js`, `appsscript.json`)
3. Enable the **Calendar Advanced Service** in the GAS editor (Services > Calendar API v3)
4. Set Script Properties (Project Settings > Script properties):

| Property | Value |
|----------|-------|
| `A8S_ROOT_FOLDER_ID` | Drive folder ID (from the URL) |
| `A8S_SCHED_FOLDER_ID` | Optional second Drive folder; calendar pushes go to its `.outbox` |
| `A8S_DEVICE` | Filedrop command-node name (e.g. `my-google`) |
| `A8S_DEFAULT_AGENT` | Sticky push destination when subject has no `@agent` |
| `A8S_EMAIL_MAP` | JSON map `{"human@example.com":"human-mail"}` (address → email principal) |
| `A8S_ROUTES` | Named recipients: `owner-mail=owner@example.com;team=a@example.com,b@example.com` |
| `A8S_COMMAND_AGENTS` | Comma list allowed to run `/commands`; set explicitly empty for no command surface |
| `CAPABILITIES` | Comma-delimited: `gmail,calendar` |
| `TRIGGER_MINUTES` | Polling interval: 1, 5, 10, 15, or 30 (default: 5) |
| `MARKDOWN_AUTO` | Set to `false` to disable auto Markdown detection (default: **on**) |
| `A8S_RESOLVE_UNMAPPED` | Set to `true` to mark unmapped unread mail read after skipping it (default: **off** — leave unread). Only for a mailbox dedicated to the agent. |
| `A8S_UNMAPPED_DIGEST` | Set to `true` for one daily informational summary of unmapped sender/subject metadata (default: **off**) |

Legacy: if `A8S_DEVICE` / `A8S_DEFAULT_AGENT` are unset, `A8S_PARTICIPANT` fills both. If `A8S_COMMAND_AGENTS` is **unset**, only `A8S_DEVICE` may run commands; an explicitly empty property allows nobody.

5. Run `setup()` from the editor to verify config
6. Run `testConnection()` to confirm Drive access (will prompt for permissions)
7. Run `enableLogging()` to enable transaction logging (optional; same sheets as GAS Bridge)
8. Run `installTrigger()` to start polling

On the server side, register the shared primary Drive mount once per name:

```bash
a8s add my-google /mnt/gdrive/a8s filedrop
a8s add human-mail /mnt/gdrive/a8s filedrop
a8s add owner-mail /mnt/gdrive/a8s filedrop
a8s start my-google   # or start an alias that covers all registered names
```

Example properties:

```
A8S_DEVICE=my-google
A8S_DEFAULT_AGENT=agent
A8S_EMAIL_MAP={"human@example.com":"human-mail"}
A8S_ROUTES=owner-mail=owner@example.com;team=a@example.com,b@example.com
A8S_COMMAND_AGENTS=
A8S_UNMAPPED_DIGEST=false
```

## Routing

| Path | Behavior |
|------|----------|
| Unread email from mapped address, subject has `@agent` | Outbox `to: agent`, `from: <email-principal>` |
| Unread email from mapped address, no `@` | Outbox `to: A8S_DEFAULT_AGENT`, `from: <email-principal>` |
| Unread email from unmapped address | Invisible to commands and left unread; `A8S_RESOLVE_UNMAPPED=true` marks it read |
| Daily unmapped digest enabled | One informational sender/subject summary to `A8S_DEFAULT_AGENT`; mail stays unread and is not re-served |
| Calendar event (optional `@agent` in title) | Scheduler `.outbox` when configured; otherwise primary `.outbox` |
| Inbox `to: A8S_DEVICE` + `/command` from `A8S_COMMAND_AGENTS` | Execute; reply to `envelope.from` |
| Inbox `to: A8S_DEVICE` + `/command` from others | Rejected (unauthorized) |
| Inbox `to: <email-principal>` | Opaque new email to mapped address; subject `@<sender>` |
| Inbox `to: <named-route>` | Email configured recipient(s); first content line is subject, remainder is body; success is silent |
| Inbox `to:` unknown | Dropped |

Subject parse strips leading `Re:` / `Fwd:` / `Fw:` (repeated), then takes the first `@agent` token. Example: `RE: @bob the thing` → `to: bob`, content subject rest + body.

### Email push (mapped senders)

Every trigger cycle, checks **unread** emails:
1. Normalize `From:` and require an `A8S_EMAIL_MAP` hit (value = email principal name, e.g. `human-mail`)
2. Resolve destination via `@agent` or sticky default
3. Stage attachments under `.outbox/<msg_id>/`
4. Write SMS-like content — a `Date:` header (with relative age), optional subject remainder, then the sanitized body — with `from` = email principal. Opaque push emits no `From:`: the sender is the email principal, and the reply chain and every known address are transport internals the agent never sees. A body over **50,000 characters** is cut at that point and the *whole* formatted message is written to `.outbox/<msg_id>/message.md`, with the inline text ending in a note naming the file and how many characters moved. Nothing is discarded (`message-2.md` if an attachment already claims the name)
5. Mark read **only after** a successful route

**Re-push:** Mark an email as UNREAD in Gmail → next trigger picks it up again (still must be mapped).

### Switchboard posture

A mapped-only bridge is a **switchboard**: the mailbox is not the agent's to browse. `/check` counts and lists only mapped unread correspondence, `/search` returns only mapped conversations, and `/read` refuses unmapped-only or mixed-external-sender threads. Unmapped unread status is never exposed through commands, regardless of `A8S_RESOLVE_UNMAPPED`.

`A8S_UNMAPPED_DIGEST=true` is an explicit exception for operators who want awareness without creating a task queue. Once per 24 hours, the bridge pushes one message beginning “Informational only — no action is required” with unmapped sender/subject metadata since the previous successful digest. It does not mark mail read, `/check` never counts it, and the checkpoint prevents it from being served again. The first enabled run looks back 24 hours.

### Outbound email (agent → human)

When an agent `tell`s an **email principal** (e.g. `tell human-mail "status?"`), GAS sends a **new** email (no thread reply in v1) to that principal’s mapped address. Subject is `@<sender>` so a human reply `Re: @agent …` routes back to that agent. Slash text on this path is not executed — it is mailed as the body.

A named route hides the transport and recipients from the agent:

```bash
tell owner-mail $'Status update\nEverything is on track.'
```

With `A8S_ROUTES=owner-mail=owner@example.com`, this sends subject `Status update` and body `Everything is on track.` Attachments use the same `files` path as `/send`. Routes do not consult `A8S_COMMAND_AGENTS`; success is silent, while delivery failure sends one error back to the originating agent. A deployment that only needs named routes can leave `A8S_COMMAND_AGENTS` explicitly empty so agents hold no slash-command rights. Keep route names distinct from `A8S_DEVICE` and email-principal names; those existing identities take precedence if names collide.

Device commands use the command node: `tell my-google "/check"`.

### Calendar push

Every trigger cycle, checks for events starting within 15 minutes. Each event is pushed as its own envelope with full details:

```
Calendar event starting soon
event_id: abc123
title: Morning Briefing
start: 2026-05-22T07:00:00-07:00
end: 2026-05-22T07:30:00-07:00
location: https://zoom.us/j/123
recurring: yes
attendees: alice@example.com
---
Check email, review messages, plan today's priorities
```

Destination: `@agent` in the title if present, else `A8S_DEFAULT_AGENT`.

When `A8S_SCHED_FOLDER_ID` is set, calendar envelopes and their attachment bundles are written beneath that folder's `.outbox`. Register its separately mounted folder as another filedrop node:

```bash
a8s add scheduler /mnt/gdrive/a8s-scheduler filedrop
```

Calendar instructions then arrive from `scheduler`, while mail still arrives from the bridge node on the primary folder. **One node, one face:** receivers key trust and pacing off the sender name, so a node should be a mail switchboard or a scheduler, not both. Leaving `A8S_SCHED_FOLDER_ID` unset preserves single-outbox behavior.

### Calendar as a scheduling mechanism

Recurring calendar events drive an agent's schedule without needing idle timeouts:
- "Morning briefing" at 7am daily → pushes every morning
- "Weekly review" on Fridays at 3pm → pushes weekly
- Put the prompt in the event **description** — it's delivered verbatim

### Drive file attachments

Files attached to calendar events (via Calendar Advanced Service) or linked in the description are:
- Staged under `.outbox/<msg_id>/` when the push envelope is written
- Listed in the envelope as `files: [{filename}]` (filename only)
- Google Docs exported as markdown (`.md`)
- Google Sheets exported as CSV (`.csv`)
- Other files downloaded as-is

### Deduplication

Events are deduped by `eventId@startTime`. Rescheduling an event re-triggers the notification. Dedup entries expire after 1 hour.

## Commands

Authorized senders are listed in `A8S_COMMAND_AGENTS` (e.g. `diagnostic-agent`).

### Gmail (requires `gmail` in CAPABILITIES)

| Command | Description |
|---------|-------------|
| `/check` | Mapped unread-thread count + newest 5 mapped subjects with thread IDs and age |
| `/search <query>` | Gmail search restricted to mapped conversations; returns thread IDs + subjects |
| `/read <thread_id>` | Full mapped conversation; refuses unmapped-only or mixed-external-sender threads |
| `/send <to> <subject>` | Send new email (body = lines after command; attachments via `files: [{filename}]` in inbox envelope) |
| `/reply <thread_id>` | Reply to existing thread (body = lines after command; attachments from `.files/<msg_id>/`) |

#### Markdown email

Both `/send` and `/reply` support multipart plain + HTML when Markdown is detected or forced.

| Flag | Effect |
|------|--------|
| `--markdown` | Always convert body to HTML |
| `--no-markdown` | Plain text only |

**Default:** Markdown is auto-detected (headings, lists, bold/italic, links, code, fences). Set `MARKDOWN_AUTO=false` to disable globally.

Auto-detection ignores markers in quoted reply text (`On … wrote:` blocks). HTML is sanitized (safe tags only; no scripts, images, or `javascript:` URLs). Falls back to plain text if conversion fails or HTML exceeds 200 KB.

Outbox responses include `(html)` when multipart was sent.

Examples:

```
/send alice@example.com API review
Please review the **API changes** below:

- Add /users endpoint
- Remove legacy field
```

```
/send --markdown alice@example.com Release notes
# v2.0
- New feature
```

```
tell my-google "/reply <thread_id>"
Your reply with **markdown** here.
```

Third-party: [marked](https://github.com/markedjs/marked) (MIT) — see `THIRD_PARTY_NOTICES.md`.

### Calendar (requires `calendar` in CAPABILITIES)

| Command | Description |
|---------|-------------|
| `/today` | Today's remaining events |
| `/week` | Events for the next 7 days |
| `/create <title> <datetime>` | Create a 1-hour event |

## Transaction logging

Same mechanism as [GAS Bridge](../bridge/README.md): run **`enableLogging()`** once from the Apps Script editor.

When enabled, every command, push, and rejection is logged to **`GAS Log YYYY-MM-DD`** (one spreadsheet per UTC day). If a sheet with that name already exists on Drive (e.g. from GAS Bridge), A8S appends to it.

| Column | Content |
|--------|---------|
| Timestamp | ISO-8601 |
| Action | `a8s.send`, `a8s.reply`, `a8s.push.email`, `a8s.push.calendar`, `a8s.command` |
| Params | `from`, `to`, `thread_id`, flags — **not message bodies** |
| Status | `ok`, `error: …`, `rejected: unauthorized` |
| Notes | Markdown diagnostics: `mode=auto, md=detected, html=yes` |

Run **`disableLogging()`** to turn off. Uses `LOGGING_ENABLED` Script Property (same flag name as Bridge).

## Debugging

### Outbox diagnostics

Outbox envelopes include a `logs` field with diagnostic messages from the trigger run (Drive link extraction, attachment download status, Calendar API errors, etc.).

### Apps Script editor functions

Run from the function dropdown; view output in **Execution log**:

| Function | Purpose |
|----------|---------|
| `testConnection()` | Config, folders, markdown auto-detect, logging status, `marked` availability |
| `testMarkdown()` | Markdown detection + full pipeline diagnostics |
| `testMarkdownDetection()` | Sample strings against `detectMarkdown()` |
| `testMarkdownPipeline()` | Step-by-step pipeline for a sample `/send` body |

In pipeline output, confirm `markedAvailable: true` and `willSendHtml: true`.

## Admin functions

Run from the Apps Script editor:

| Function | Purpose |
|----------|---------|
| `a8sHelp()` | List Script Properties and the two-node scheduler pattern |
| `setup()` | Verify configuration |
| `testConnection()` | Confirm Drive folder access + permissions |
| `enableLogging()` / `disableLogging()` | Transaction log to `GAS Log YYYY-MM-DD` |
| `installTrigger()` | Create trigger at configured interval |
| `removeTrigger()` | Stop polling |

## Constraints

- `Code.js` + `vendor/marked.js`; V8 runtime
- GAS V8 is not full ES2022 — vendored libs must be transpiled (see `scripts/vendor-marked.mjs`)
- 6-minute execution limit per trigger invocation
- GAS quotas: ~20,000 Drive calls/day, 1,500 Gmail reads/day
- At 1-minute intervals: ~1,440 runs/day × ~10 Drive calls ≈ 14,000 (within quota)
- Calendar Advanced Service required for event attachments
- File transfer: outbound bundles under `.outbox/<msg_id>/`; inbound from A8S under `.files/<msg_id>/`
- `ScriptApp.getOAuthToken()` used for Drive API export (Google Docs → markdown)
- Register each email principal and named route as a separate filedrop name on the same Drive mount as `A8S_DEVICE`
- v1: outbound human mail is always a new message (no Gmail thread reply routing)
