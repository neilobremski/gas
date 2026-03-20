# GAS Bridge

Turn a Google Apps Script project into a key-authenticated JSON API.

GAS Bridge deploys as a [Web App](https://developers.google.com/apps-script/guides/web) and exposes Google Workspace services -- Gmail, Drive, Sheets, Calendar, Docs, Contacts, Translate, and Tasks -- through simple HTTP POST requests. Any language or tool that can send JSON over HTTPS can use it.

## Quick Start

### 1. Create the Script

1. Go to [script.google.com](https://script.google.com) and create a new project.
2. Replace the contents of `Code.gs` with [`Code.js`](Code.js) from this folder.
3. Copy `appsscript.json` into the project (Editor > Project Settings > Show manifest).

### 2. Generate a Key

In the Apps Script editor:

1. Select `Bridge.initKey` from the function dropdown.
2. Click **Run** (authorize when prompted).
3. Open **Execution Log** -- your key is printed there.

Store this key securely. It authenticates every request to your bridge.

### 3. Activate Services

Run `Bridge.activateScopes` to trigger authorization prompts for each Google service. This ensures the OAuth token covers all the APIs you want to use. You only need to do this once (or again if you add new services).

### 4. Deploy

1. **Deploy** > **New Deployment**
2. Type: **Web App**
3. Execute as: **Me**
4. Who has access: **Anyone**
5. Click **Deploy** and copy the URL.

### 5. Use It

```bash
# Health check
curl -s -L -X POST 'YOUR_DEPLOYMENT_URL' \
  -H 'Content-Type: application/json' \
  -d '{"action": "info", "key": "YOUR_KEY"}' | python3 -m json.tool

# Send an email
curl -s -L -X POST 'YOUR_DEPLOYMENT_URL' \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "gmail.send",
    "key": "YOUR_KEY",
    "to": "someone@example.com",
    "subject": "Hello from GAS Bridge",
    "body": "Sent via a simple POST request."
  }'

# Read a spreadsheet
curl -s -L -X POST 'YOUR_DEPLOYMENT_URL' \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "sheets.read",
    "key": "YOUR_KEY",
    "spreadsheet_id": "YOUR_SHEET_ID",
    "range": "Sheet1!A1:C10"
  }'
```

> **Note:** Use `-L` with curl -- Google Apps Script redirects on first request.

## Actions

| Action | Description | Required Fields |
|--------|-------------|-----------------|
| `calendar.calendars` | List all calendars | -- |
| `calendar.create` | Create calendar event | `title`, `start`, `end` (+ `calendarId`, `description`, `location`, `guests`) |
| `calendar.delete` | Delete calendar event | `event_id` (+ `calendarId`) |
| `calendar.list` | Upcoming events | `days` (default: 7) (+ `calendarId`) |
| `config.get` | Read Script Properties (disabled by default) | `key` for single value, or omit for all |
| `config.set` | Write Script Properties (disabled by default) | `config` (object of key-value pairs) |
| `contacts.list` | List contacts | `count` (default: 20) |
| `docs.create` | Create Google Doc | `title` (+ `body`) |
| `drive.create` | Create file | `name` (+ `type`, `content`, `mime`, `folder_id`) |
| `drive.delete` | Trash a file or folder | `id` |
| `drive.download` | Download file as base64 | `id` or `name` |
| `drive.folders` | List/search/create folders | `query`, `count` (+ `create`, `parent_id`) |
| `drive.list` | List/search files and folders | `query`, `count` (+ `folder_id` to scope to a folder) |
| `drive.upload` | Upload base64 file (always creates) | `name`, `data_base64` (+ `mime`, `folder_id`) |
| `drive.upsert` | Upload or replace by name | `name`, `data_base64` (+ `mime`, `folder_id`) |
| `fetch` | HTTP proxy (disabled by default) | `url` (+ `method`, `headers`, `payload`, `contentType`) |
| `gmail.archive` | Archive and mark read | `thread_id` |
| `gmail.attachments` | Get/save attachments | `message_id` or `thread_id` (+ `save_to_drive`, `folder_id`) |
| `gmail.draft.create` | Create email draft | `to` (+ `subject`, `body`, `html`) |
| `gmail.draft.delete` | Delete a draft | `draft_id` |
| `gmail.draft.list` | List drafts | `count` (default: 10) |
| `gmail.draft.send` | Send an existing draft | `draft_id` |
| `gmail.get` | Get full thread with HTML | `thread_id` |
| `gmail.label` | Add/remove labels | `thread_id` (+ `add`, `remove`) |
| `gmail.read` | Mark thread as read | `thread_id` |
| `gmail.reply` | Reply to thread | `thread_id`, `body` (+ `html`, `cc`, `inlineImages`, `driveImages`) |
| `gmail.search` | Search email threads | `query` (default: `is:unread`), `count` (default: 10) |
| `gmail.send` | Send email | `to` (+ `subject`, `body`, `cc`, `bcc`, `html`, `replyTo`, `inlineImages`, `driveImages`, `attachments`) |
| `info` | Health check, list actions | -- |
| `quota` | Email remaining, Drive usage, properties count | -- |
| `sheets.append` | Append rows | `spreadsheet_id` or `name`, `rows` (+ `sheet`) |
| `sheets.create` | Create spreadsheet | `name` (+ `headers`) |
| `sheets.read` | Read spreadsheet | `spreadsheet_id` or `name` (+ `range`) |
| `sheets.update` | Write values to range | `spreadsheet_id` or `name`, `range`, `values` |
| `tasks.create` | Create a task | `title` (+ `list_id`, `notes`, `due`, `status`) |
| `tasks.list` | List Google Tasks | -- (requires Tasks API enabled) |
| `tasks.update` | Update a task | `task_id`, `list_id` (+ `title`, `notes`, `status`, `due`) |
| `token.get` | Get OAuth token (disabled by default) | -- |
| `translate` | Translate text | `text` (+ `from`, `to`) |

Every request is a JSON POST with at minimum `{"action": "...", "key": "..."}`.

Every response is JSON with either the result or `{"error": "..."}`.

### Name Resolution

Actions that normally require an ID (`spreadsheet_id`, `id`) also accept `name` as an alternative. The bridge searches Drive for a file with that exact title and uses the newest match. This saves a round-trip compared to calling `drive.list` first.

```bash
# These are equivalent:
gas sheets.read spreadsheet_id=1wCyx...
gas sheets.read name=Tadpole

# Works for drive.download too:
gas drive.download name="My File.pdf"
```

If multiple files share the same name, the most recently updated one is used.

## Quotas

Every bridge call runs inside Google Apps Script, which has [daily quotas](https://developers.google.com/apps-script/guides/services/quotas) per Google account. The limits that matter most:

| Resource | Consumer (gmail.com) | Google Workspace |
|----------|---------------------|------------------|
| **Email read/write** (search, get, label, reply, draft — everything except send) | **20,000/day** | 50,000/day |
| **Email send** (recipients/day) | 100/day | 1,500/day |
| **URL Fetch calls** (the `fetch` action) | 20,000/day | 100,000/day |
| **Script runtime** per execution | 6 min | 6 min |
| **Trigger total runtime** per day | 90 min | 6 hr |
| **Properties read/write** | 50,000/day | 500,000/day |
| **Properties storage** | 500 KB total | 500 KB total |
| **Simultaneous executions** | 30/user | 30/user |

The **email read/write** quota is the one you'll hit first. Every `gmail.search`, `gmail.get`, `gmail.label`, `gmail.reply` (the read/thread part), `gmail.archive`, `gmail.read`, and `gmail.draft.*` call counts against the 20K pool. A single "search + get + reply + label" cycle burns 4 quota units.

Use `gas quota` to check remaining email quota at any time. If you hit the ceiling, enable `token.get` and call the [Gmail REST API](https://developers.google.com/gmail/api/reference/rest) directly — that uses the Gmail API's own quota (250 units/second) instead of the Apps Script pool.

**References:**
- [Apps Script Quotas](https://developers.google.com/apps-script/guides/services/quotas) — full daily limits table
- [GmailApp Reference](https://developers.google.com/apps-script/reference/gmail/gmail-app) — GmailApp methods and per-method notes
- [Gmail REST API](https://developers.google.com/gmail/api/reference/rest) — direct API (bypasses Apps Script quotas)
- [DriveApp Reference](https://developers.google.com/apps-script/reference/drive/drive-app) — DriveApp methods
- [Apps Script Dashboard](https://script.google.com/home/executions) — monitor executions and errors

## Security

GAS Bridge uses a **shared secret key** stored in Script Properties (never in source code). This is simple and effective for personal use and trusted integrations, but it is not OAuth -- anyone with the key and the deployment URL has full access to the enabled services.

**Recommendations:**

- **Rotate your key as needed.** Run `Bridge.initKey()` to generate a new one. Update all clients that use the old key.
- **Limit scope.** Only run `activateScopes()` for services you actually need. Remove actions from the `HANDLERS` map if you want to disable them.
- **Keep the deployment URL private.** The URL plus the key is all that's needed to access your Google account's services.
- **Monitor usage.** Check the Apps Script dashboard (Executions tab) for unexpected activity.

## Updating

After editing `Code.gs`:

1. **Deploy** > **Manage Deployments** > **Edit** (pencil icon)
2. Version: **New Version**
3. Click **Deploy**

The URL stays the same -- clients don't need to change anything.

## How It Works

The bridge is a single Apps Script file that:

1. **`doGet`** returns a simple health-check text response.
2. **`doPost`** parses the JSON body, validates the key, and routes the `action` to the matching handler function.
3. Each handler wraps a Google Apps Script API (GmailApp, SpreadsheetApp, DriveApp, etc.) and returns a JSON response.

The `fetch` action is an HTTP proxy -- it lets you make outbound HTTP requests from Google's servers, which is useful when you need a clean IP or want to call APIs from environments with network restrictions. It is disabled by default. Run `Bridge.enableFetch()` from the Apps Script editor to enable it, or `Bridge.disableFetch()` to disable it again.

The `token.get` action returns a live OAuth access token that inherits the script's authorized scopes. This is useful for calling Google APIs directly (e.g., from a local script) without managing your own OAuth flow. It is disabled by default. Run `Bridge.enableTokenGet()` to enable it, or `Bridge.disableTokenGet()` to disable it again.

The `config.get` and `config.set` actions read and write Script Properties -- useful for storing configuration that multiple clients share. They are disabled by default. Run `Bridge.enableConfig()` to enable them, or `Bridge.disableConfig()` to disable them again. The `BRIDGE_KEY` property is always protected -- `config.get` never exposes it and `config.set` silently skips it.
