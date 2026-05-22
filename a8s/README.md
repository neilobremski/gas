# A8S-GAS — Google Apps Script participant for A8S

A GAS script that polls a Google Drive folder for A8S message envelopes, processes commands via Gmail/Calendar, and pushes notifications. Works with any A8S server using the file-proxy transport (rclone mount to Drive).

## Architecture

```
A8S server (rclone mount) ←→ Google Drive folder ←→ GAS (time trigger, 5min)
```

Drive folder layout:
```
<root>/
  .inbox/     ← A8S writes here; GAS reads + deletes after processing
  .outbox/    ← GAS writes responses here; A8S picks up
  .files/     ← bidirectional attachments (A8S handles tempfile.org upload/download)
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
tests/run      # run tests only
clasp push     # push without testing
clasp pull     # pull remote changes
clasp open     # open in browser
```

Tests run with plain Node.js (no dependencies). They exercise pure logic (ulid, parseCommand, formatEmailForAgent, writeEnvelope, routing) with mocked GAS APIs.

## Setup

1. Create a folder in Google Drive for this agent
2. Push `Code.js` and `appsscript.json` via `clasp push`
3. Set Script Properties (Project Settings > Script properties):

| Property | Value |
|----------|-------|
| `A8S_ROOT_FOLDER_ID` | Drive folder ID (from the URL) |
| `A8S_PARTICIPANT` | Who to push notifications to (e.g. `my-agent`) |
| `CAPABILITIES` | Comma-delimited capabilities (e.g. `gmail,calendar`) |

4. Run `setup()` from the editor to verify config
5. Run `testConnection()` to confirm Drive access
6. Run `installTrigger()` to start polling every 5 minutes

On the server side, register the file-proxy agent:
```bash
a8s add my-email /mnt/gdrive/my-email/ file-proxy.json
```

## Email Push (primary feature)

Every trigger cycle, GAS checks for **unread** emails. For each unread message:
1. Marks it as READ
2. Saves any attachments to `.files/`
3. Pushes an envelope to `.outbox/` addressed to `A8S_AGENT` containing:
   - `thread_id` (for replying)
   - `from`, `subject`, `date`
   - Email body (truncated at 4KB)
   - `FILE:` references for attachments

To re-push an email: mark it as UNREAD in Gmail. Next trigger picks it up again.

### Replying to an email thread

```
tell my-email "/reply <thread_id>"
Your reply body goes here as the message content.
```

The reply goes into the same Gmail thread so conversations stay together.

## Commands

### Gmail (participant with `["gmail"]` service)

| Command | Description |
|---------|-------------|
| `/check` | Unread count + last 5 subjects with thread IDs |
| `/search <query>` | Gmail search, returns thread IDs + subjects |
| `/read <thread_id>` | Full thread text |
| `/send <to> <subject>` | Send new email (body = lines after command; FILE: for attachments) |
| `/reply <thread_id>` | Reply to existing thread (body = lines after command; FILE: for attachments) |

### Calendar (participant with `["calendar"]` service)

| Command | Description |
|---------|-------------|
| `/today` | Today's remaining events |
| `/week` | Events for the next 7 days |
| `/create <title> <datetime>` | Create a 1-hour event |

## Message format

Push notification (new email → agent):
```json
{
  "id": "01HXYZ...",
  "date": "2026-05-21T10:00:05.000Z",
  "to": "my-agent",
  "content": "New email\nthread_id: 18a3b...\nfrom: alice@example.com\nsubject: Hello\ndate: 2026-05-21T10:00:00Z\n---\nEmail body here...",
  "files": [{"filename": "report.pdf", "path": "./.files/report.pdf"}]
}
```

## Admin functions

Run from the Apps Script editor:

- `setup()` — verify configuration
- `testConnection()` — confirm Drive folder access
- `installTrigger()` — create 5-minute polling trigger
- `removeTrigger()` — stop polling

## Constraints

- Single `Code.js` file, V8 runtime, no external dependencies
- 6-minute execution limit per trigger invocation
- No persistent state between invocations (Script Properties for dedup)
- File transfer: GAS writes to `.files/`, A8S file-proxy handles tempfile.org for cross-cluster delivery
- Drive operations don't count against UrlFetch quota
