# A8S-GAS — Google Apps Script participant for A8S

A GAS script that acts as an A8S participant via Google Drive (file-proxy transport). Polls for commands, pushes email notifications and calendar events, downloads Drive file attachments including Google Docs as markdown.

## Architecture

```
A8S server (rclone mount) ←→ Google Drive folder ←→ GAS (time trigger)
```

Drive folder layout:
```
<root>/
  .inbox/     ← A8S writes here; GAS reads + deletes after processing
  .outbox/    ← GAS writes responses here; A8S picks up
  .files/     ← bidirectional attachments (A8S handles tempfile.org for cross-cluster)
```

## Development

### clasp setup

[clasp](https://github.com/google/clasp) is Google's CLI for pushing/pulling Apps Script code.

```bash
npm install -g @google/clasp
clasp login
clasp create --type standalone --title "A8S GAS"   # or set scriptId in .clasp.json
```

### Deploy (test + push)

```bash
./deploy.sh
```

This runs tests locally, then pushes to GAS via clasp.

### Manual commands

```bash
tests/run      # run tests only (91 tests, plain Node.js)
clasp push     # push without testing
clasp pull     # pull remote changes
clasp open     # open in browser
```

## Setup

1. Create a folder in Google Drive for this participant
2. Push `Code.js` and `appsscript.json` via `clasp push`
3. Enable the **Calendar Advanced Service** in the GAS editor (Services > Calendar API v3)
4. Set Script Properties (Project Settings > Script properties):

| Property | Value |
|----------|-------|
| `A8S_ROOT_FOLDER_ID` | Drive folder ID (from the URL) |
| `A8S_PARTICIPANT` | Who this script pushes to and accepts commands from |
| `CAPABILITIES` | Comma-delimited: `gmail,calendar` |
| `TRIGGER_MINUTES` | Polling interval: 1, 5, 10, 15, or 30 (default: 5) |

5. Run `setup()` from the editor to verify config
6. Run `testConnection()` to confirm Drive access (will prompt for permissions)
7. Run `installTrigger()` to start polling

On the server side, register the file-proxy agent:
```bash
a8s add my-google /mnt/gdrive/my-google/ file-proxy.json
```

## Email Push

Every trigger cycle, checks for **unread** emails:
1. Marks each as READ
2. Saves attachments to `.files/`
3. Pushes an envelope per message to `A8S_PARTICIPANT` with:
   - `thread_id` (for replying in the same thread)
   - `from`, `subject`, `date`
   - Email body (truncated at 4KB)
   - `FILE:` references for attachments

**Re-push:** Mark an email as UNREAD in Gmail → next trigger picks it up again.

### Replying to a thread

```
tell my-google "/reply <thread_id>"
Your reply body here.
```

## Calendar Push

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

### Calendar as a scheduling mechanism

Recurring calendar events drive an agent's schedule without needing idle timeouts:
- "Morning briefing" at 7am daily → pushes every morning
- "Weekly review" on Fridays at 3pm → pushes weekly
- Put the prompt in the event **description** — it's delivered verbatim

### Drive file attachments

Files attached to calendar events (via Calendar Advanced Service) or linked in the description are:
- Downloaded to `.files/`
- Referenced as `FILE:` entries in the envelope
- Google Docs exported as markdown (`.md`)
- Google Sheets exported as CSV (`.csv`)
- Other files downloaded as-is

This means you can attach a shared Google Doc to a recurring event and the agent receives the latest version as markdown each time it fires.

### Deduplication

Events are deduped by `eventId@startTime`. Rescheduling an event re-triggers the notification. Dedup entries expire after 1 hour.

## Commands

### Gmail (requires `gmail` in CAPABILITIES)

| Command | Description |
|---------|-------------|
| `/check` | Unread count + last 5 subjects with thread IDs |
| `/search <query>` | Gmail search, returns thread IDs + subjects |
| `/read <thread_id>` | Full thread text |
| `/send <to> <subject>` | Send new email (body = lines after command; FILE: for attachments) |
| `/reply <thread_id>` | Reply to existing thread (body = lines after command) |

### Calendar (requires `calendar` in CAPABILITIES)

| Command | Description |
|---------|-------------|
| `/today` | Today's remaining events |
| `/week` | Events for the next 7 days |
| `/create <title> <datetime>` | Create a 1-hour event |

## Debugging

Outbox envelopes include a `logs` field with diagnostic messages from the trigger run (Drive link extraction, attachment download status, Calendar API errors, etc.).

## Admin functions

Run from the Apps Script editor:

- `setup()` — verify configuration
- `testConnection()` — confirm Drive folder access + permissions
- `installTrigger()` — create trigger at configured interval
- `removeTrigger()` — stop polling

## Constraints

- Single `Code.js` file, V8 runtime
- 6-minute execution limit per trigger invocation
- GAS quotas: ~20,000 Drive calls/day, 1,500 Gmail reads/day
- At 1-minute intervals: ~1,440 runs/day × ~10 Drive calls = ~14,000 (within quota)
- Calendar Advanced Service required for event attachments
- File transfer: GAS writes to `.files/`, A8S file-proxy handles tempfile.org upload
- `ScriptApp.getOAuthToken()` used for Drive API export (Google Docs → markdown)
