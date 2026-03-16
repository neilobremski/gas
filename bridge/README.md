# GAS Bridge

Turn a Google Apps Script project into a key-authenticated JSON API.

GAS Bridge deploys as a [Web App](https://developers.google.com/apps-script/guides/web) and exposes Google Workspace services — Gmail, Drive, Sheets, Calendar, Docs, Contacts, Translate, and Tasks — through simple HTTP POST requests. Any language or tool that can send JSON over HTTPS can use it.

## Quick Start

### 1. Create the Script

1. Go to [script.google.com](https://script.google.com) and create a new project.
2. Replace the contents of `Code.gs` with [`Code.js`](Code.js) from this folder.
3. Copy `appsscript.json` into the project (Editor > Project Settings > Show manifest).

### 2. Generate a Key

In the Apps Script editor:

1. Select `Bridge.initKey` from the function dropdown.
2. Click **Run** (authorize when prompted).
3. Open **Execution Log** — your key is printed there.

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

> **Note:** Use `-L` with curl — Google Apps Script redirects on first request.

## Available Actions

| Action | Description | Required Fields |
|--------|-------------|-----------------|
| `info` | Health check, list actions | — |
| `gmail.send` | Send email | `to` (+ `subject`, `body`, `cc`, `bcc`, `html`, `replyTo`) |
| `gmail.check` | Search inbox | `query` (default: `is:unread`), `count` |
| `sheets.read` | Read spreadsheet | `spreadsheet_id`, `range` |
| `sheets.append` | Append rows | `spreadsheet_id`, `rows`, `sheet` |
| `drive.list` | List/search files | `query`, `count` |
| `drive.create` | Create file | `name`, `type`, `content`, `mime` |
| `calendar.list` | Upcoming events | `days` (default: 7) |
| `docs.create` | Create Google Doc | `title`, `body` |
| `contacts.list` | List contacts | `count` |
| `tasks.list` | List Google Tasks | — (requires Tasks API enabled) |
| `translate` | Translate text | `text`, `from`, `to` |
| `fetch` | HTTP proxy (disabled by default) | `url`, `method`, `headers`, `payload`, `contentType` |
| `token.get` | Get OAuth token (disabled by default) | — |

Every request is a JSON POST with at minimum `{"action": "...", "key": "..."}`.

Every response is JSON with either the result or `{"error": "..."}`.

## Security

GAS Bridge uses a **shared secret key** stored in Script Properties (never in source code). This is simple and effective for personal use and trusted integrations, but it is not OAuth — anyone with the key and the deployment URL has full access to the enabled services.

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

The URL stays the same — clients don't need to change anything.

## How It Works

The bridge is a single Apps Script file that:

1. **`doGet`** returns a simple health-check text response.
2. **`doPost`** parses the JSON body, validates the key, and routes the `action` to the matching handler function.
3. Each handler wraps a Google Apps Script API (GmailApp, SpreadsheetApp, DriveApp, etc.) and returns a JSON response.

The `fetch` action is an HTTP proxy — it lets you make outbound HTTP requests from Google's servers, which is useful when you need a clean IP or want to call APIs from environments with network restrictions. **It is disabled by default.** Run `Bridge.enableFetch()` from the Apps Script editor to enable it, or `Bridge.disableFetch()` to disable it again.

The `token.get` action returns a live OAuth access token that inherits the script's authorized scopes. This is useful for calling Google APIs directly (e.g., from a local script) without managing your own OAuth flow. **It is disabled by default.** Run `Bridge.enableTokenGet()` to enable it, or `Bridge.disableTokenGet()` to disable it again.
