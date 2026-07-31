# A8S-GAS — Google Apps Script participant for A8S

A GAS script that acts as an [A8S](https://github.com/witw-llc/ar3) participant via Google Drive ([filedrop](https://github.com/witw-llc/ar3/blob/main/docs/a8s-filedrop.md) transport). Polls for commands, routes inbound email/calendar like an SMS bridge, and can send new outbound email when agents message an email principal.

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
```

Register the **same** Drive mount under multiple filedrop names — a command node plus each email principal. Mail to either name lands in the shared `.inbox/`; GAS routes on `envelope.to`:

```bash
a8s add knobert-google /mnt/gdrive/a8s filedrop
a8s add neil-email /mnt/gdrive/a8s filedrop
```

| `to` | GAS behavior |
|------|----------------|
| `knobert-google` (`A8S_DEVICE`) | Slash commands (if `from` is in `A8S_COMMAND_AGENTS`) |
| `neil-email` (value in `A8S_EMAIL_MAP`) | Opaque outbound email to the mapped address |

Email-ingress outbox envelopes set `"from": "neil-email"` so replies can target the email principal.

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
| `A8S_DEVICE` | Filedrop command-node name (e.g. `knobert-google`) |
| `A8S_DEFAULT_AGENT` | Sticky push destination when subject has no `@agent` |
| `A8S_EMAIL_MAP` | JSON map `{"human@example.com":"neil-email"}` (address → email principal) |
| `A8S_COMMAND_AGENTS` | Comma list allowed to run `/commands` on the device (e.g. `neil-phone,knobert-google`) |
| `CAPABILITIES` | Comma-delimited: `gmail,calendar` |
| `TRIGGER_MINUTES` | Polling interval: 1, 5, 10, 15, or 30 (default: 5) |
| `MARKDOWN_AUTO` | Set to `false` to disable auto Markdown detection (default: **on**) |

Legacy: if `A8S_DEVICE` / `A8S_DEFAULT_AGENT` are unset, `A8S_PARTICIPANT` fills both. If `A8S_COMMAND_AGENTS` is unset, only `A8S_DEVICE` may run commands.

5. Run `setup()` from the editor to verify config
6. Run `testConnection()` to confirm Drive access (will prompt for permissions)
7. Run `enableLogging()` to enable transaction logging (optional; same sheets as GAS Bridge)
8. Run `installTrigger()` to start polling

On the server side, register the shared Drive mount once per name (command node + email principals):

```bash
a8s add knobert-google /mnt/gdrive/a8s filedrop
a8s add neil-email /mnt/gdrive/a8s filedrop
a8s start knobert-google   # or start an alias that covers both
```

Example properties:

```
A8S_DEVICE=knobert-google
A8S_DEFAULT_AGENT=bob
A8S_EMAIL_MAP={"human@example.com":"neil-email"}
A8S_COMMAND_AGENTS=neil-phone,knobert-google
```

## Routing

| Path | Behavior |
|------|----------|
| Unread email from mapped address, subject has `@agent` | Outbox `to: agent`, `from: <email-principal>` |
| Unread email from mapped address, no `@` | Outbox `to: A8S_DEFAULT_AGENT`, `from: <email-principal>` |
| Unread email from unmapped address | Left unread (not pushed) |
| Calendar event (optional `@agent` in title) | Outbox to `@agent` or sticky default |
| Inbox `to: A8S_DEVICE` + `/command` from `A8S_COMMAND_AGENTS` | Execute; reply to `envelope.from` |
| Inbox `to: A8S_DEVICE` + `/command` from others | Rejected (unauthorized) |
| Inbox `to: <email-principal>` | Opaque new email to mapped address; subject `@<sender>` |
| Inbox `to:` unknown | Dropped |

Subject parse strips leading `Re:` / `Fwd:` / `Fw:` (repeated), then takes the first `@agent` token. Example: `RE: @bob the thing` → `to: bob`, content subject rest + body.

### Email push (mapped senders)

Every trigger cycle, checks **unread** emails:
1. Normalize `From:` and require an `A8S_EMAIL_MAP` hit (value = email principal name, e.g. `neil-email`)
2. Resolve destination via `@agent` or sticky default
3. Stage attachments under `.outbox/<msg_id>/`
4. Write SMS-like content (optional subject remainder + body, body truncated at 4KB) with `from` = email principal
5. Mark read **only after** a successful route

**Re-push:** Mark an email as UNREAD in Gmail → next trigger picks it up again (still must be mapped).

### Outbound email (agent → human)

When an agent `tell`s an **email principal** (e.g. `tell neil-email "status?"`), GAS sends a **new** email (no thread reply in v1) to that principal’s mapped address. Subject is `@<sender>` so a human reply `Re: @bob …` routes back to that agent. Slash text on this path is not executed — it is mailed as the body.

Device commands use the command node: `tell knobert-google "/check"`.

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

Authorized senders are listed in `A8S_COMMAND_AGENTS` (e.g. `neil-phone` for diagnostics).

### Gmail (requires `gmail` in CAPABILITIES)

| Command | Description |
|---------|-------------|
| `/check` | Unread count + last 5 subjects with thread IDs |
| `/search <query>` | Gmail search, returns thread IDs + subjects |
| `/read <thread_id>` | Full thread text |
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
tell knobert-google "/reply <thread_id>"
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
- Register each email principal as a separate filedrop name on the same Drive mount as `A8S_DEVICE`
- v1: outbound human mail is always a new message (no Gmail thread reply routing)
