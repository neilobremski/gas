# gas

Google Apps Script modules and deployable scripts for Google Workspace automation.

## What's in this repo

| Path | What it is | Deploy |
|------|------------|--------|
| [`bridge/`](bridge/) | **GAS Bridge** — key-authenticated JSON API for Gmail, Drive, Sheets, Calendar, Docs, Contacts, Tasks, Translate, Gemini | Apps Script Web App |
| [`a8s/`](a8s/) | **A8S participant** — Drive file-proxy agent; polls commands, pushes email/calendar notifications | clasp (`./deploy.sh`) |
| [`GasAWS.js`](GasAWS.js), [`GasBQ.js`](GasBQ.js) | Standalone library snippets to copy into your own GAS projects | Manual copy |
| [`vidsite/`](vidsite/) | Static site | — |

The [`gas`](https://github.com/neilobremski/gas) Python CLI (separate install) talks to a deployed GAS Bridge via JSON POST. See the `gas` skill for CLI usage.

## Quick links

- [GAS Bridge README](bridge/README.md) — actions, quotas, security, logging
- [A8S README](a8s/README.md) — setup, commands, Markdown email, transaction logging
- [AGENTS.md](AGENTS.md) — guidance for AI agents working in this repo

## GAS Bridge

Turn a Google Apps Script project into a key-authenticated HTTP API. Clients POST JSON like `{"action": "gmail.send", "key": "...", "to": "...", "body": "..."}`.

See [bridge/README.md](bridge/README.md) for the full action list, setup, and deployment.

## A8S participant

A time-triggered GAS script that bridges an [A8S](https://github.com/neilobremski/a8s) file-proxy agent to Gmail and Calendar via a Google Drive folder (`.inbox`, `.outbox`, `.files`).

Features:

- Gmail commands: `/check`, `/search`, `/read`, `/send`, `/reply`
- Calendar commands: `/today`, `/week`, `/create`
- **Markdown email** — auto-detects Markdown in `/send` and `/reply` bodies; sends multipart plain + sanitized HTML
- **Transaction logging** — same `GAS Log YYYY-MM-DD` sheets as GAS Bridge (run `enableLogging()` in either project)

```bash
cd a8s
./deploy.sh    # npm ci, vendor marked, tests, clasp push
```

See [a8s/README.md](a8s/README.md) for setup, Script Properties, and debugging.

## Standalone modules

Copy-paste into a GAS project as `GasAWS.gs`, etc.:

```javascript
function TestGas() {
  AWS.init("access-key-id", "secret-access-key");
  let response = AWS.request('ec2', 'DescribeInstances', {"Version":"2015-10-01"});
  Logger.log(response);
}
```

## Shared transaction logging

Both **GAS Bridge** and **A8S** can log to the same place:

1. Run `enableLogging()` in the Apps Script editor (sets `LOGGING_ENABLED=true`)
2. Logs append to a spreadsheet named **`GAS Log YYYY-MM-DD`** (one per UTC day)
3. A8S searches Drive for an existing sheet with that name (e.g. one Bridge already created) and appends there

Bridge logs HTTP actions (`gmail.send`, etc.). A8S logs commands (`a8s.send`, `a8s.reply`) and push events (`a8s.push.email`), with a **Notes** column for Markdown diagnostics.

## Development

| Component | Tests | Deploy |
|-----------|-------|--------|
| A8S | `a8s/tests/run` (132 tests) | `a8s/deploy.sh` |
| Bridge | Manual / `gas` CLI | Apps Script editor |
| Standalone modules | — | Copy-paste |

Agent-oriented conventions and workflows: [AGENTS.md](AGENTS.md).

## CI

GitHub Actions runs on pull requests:

- **pii-check** — scans the PR diff for patterns in the `PII_PATTERNS` secret
- **version-check** — requires version bumps in `bridge/Code.js` / `a8s/Code.js` when deployable files change
- **a8s** — `npm ci`, vendor marked, 134 Node tests, PII and version unit tests

Local setup:

```bash
cp .github/pii-patterns.example.txt .github/pii-patterns.local.txt
# edit patterns, then:
./install-hooks.sh              # pre-push hook
.github/sync-pii-patterns.sh    # sync secret for CI
```
