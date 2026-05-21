# A8S-GAS — Google Apps Script participant for A8S

A GAS script that polls a Google Drive folder for A8S message envelopes, processes commands via Gmail/Calendar, and writes responses back. Works with any A8S server that mounts Drive via rclone.

## Architecture

```
A8S server (rclone mount) ←→ Google Drive folder ←→ GAS (time trigger, 5min)
```

Drive folder layout:
```
<root>/
  .inbox/     ← A8S writes here; GAS reads + deletes after processing
  .outbox/    ← GAS writes responses here; A8S picks up
  .files/     ← bidirectional attachments
```

## Setup

1. Create a folder in Google Drive for this agent
2. Create subfolders: `.inbox`, `.outbox`, `.files` (or let the script create them)
3. In Apps Script, create a new project and paste `a8s-gas.gs`
4. Set Script Properties (Project Settings > Script properties):

| Property | Value |
|----------|-------|
| `A8S_ROOT_FOLDER_ID` | Drive folder ID (from the URL) |
| `A8S_PARTICIPANTS` | `{"my-email": ["gmail"], "my-calendar": ["calendar"]}` |
| `A8S_AGENT` | Agent name for push notifications, e.g. `"claude"` |
| `TEMPFILE_URL` | Optional. Default: `https://tempfile.org/` |

5. Run `setup()` from the editor to verify config
6. Run `testConnection()` to confirm Drive access
7. Run `installTrigger()` to start polling every 5 minutes

## Commands

### Gmail (participant with `["gmail"]` service)

| Command | Description |
|---------|-------------|
| `/check` | Unread count + last 5 subjects |
| `/search <query>` | Gmail search, returns thread IDs + subjects |
| `/read <thread_id>` | Full thread text |
| `/send <to> <subject>` | Send email (body = remaining lines after command) |

### Calendar (participant with `["calendar"]` service)

| Command | Description |
|---------|-------------|
| `/today` | Today's remaining events |
| `/week` | Events for the next 7 days |
| `/create <title> <datetime>` | Create a 1-hour event |

## Push mode

When `A8S_AGENT` is configured, the script proactively notifies about:
- Calendar events starting within 15 minutes

Push messages are written to `.outbox/` addressed to the configured agent.

## Message format

Inbound (A8S writes to `.inbox/`):
```json
{
  "id": "01HXYZ...",
  "date": "2026-05-21T10:00:00.000Z",
  "from": "claude",
  "to": "my-email",
  "content": "/check"
}
```

Outbound (GAS writes to `.outbox/`):
```json
{
  "id": "01HXYZ...",
  "date": "2026-05-21T10:00:05.000Z",
  "to": "claude",
  "content": "3 unread\nSubject 1 (from: alice@example.com)\n..."
}
```

## Admin functions

Run these from the Apps Script editor:

- `setup()` — verify configuration
- `testConnection()` — confirm Drive folder access
- `installTrigger()` — create 5-minute polling trigger
- `removeTrigger()` — stop polling

## Constraints

- Single .gs file, V8 runtime, no external dependencies
- 6-minute execution limit per trigger invocation
- No persistent state between invocations (uses Script Properties for push dedup)
- Drive operations via `DriveApp`, email via `GmailApp`, calendar via `CalendarApp`
