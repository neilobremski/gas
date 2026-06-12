# AGENTS.md — gas repo

Guidance for AI agents working in this repository.

## What this repo is

Google Apps Script (GAS) modules and deployable scripts:

| Path | Purpose |
|------|---------|
| `bridge/` | **GAS Bridge** — key-authenticated JSON API (Gmail, Drive, Sheets, Calendar, Docs, Contacts, Tasks, Translate, Gemini). Single file: `bridge/Code.js`. |
| `a8s/` | **A8S participant** — Drive file-proxy agent for A8S. Main logic: `a8s/Code.js`; vendored deps: `a8s/vendor/marked.js`. |
| `GasAWS.js`, `GasBQ.js` | Standalone library modules users copy into their own GAS projects. |
| `vidsite/` | Static site (not GAS). |

The `gas` Python CLI (separate install) POSTs JSON to a deployed GAS Bridge web app. See the `gas` skill for CLI usage.

## A8S project layout

```
a8s/
  Code.js                 # main script (IIFE + top-level entry points)
  vendor/marked.js        # esbuild-transpiled marked (ES2017, pushed to GAS)
  appsscript.json         # manifest (V8, Calendar advanced service)
  package.json            # npm dep: marked; devDep: esbuild
  scripts/vendor-marked.mjs
  tests/test.js           # 132 unit tests (Node.js)
  deploy.sh               # npm ci → vendor → tests → clasp push
  .claspignore            # excludes node_modules, tests, scripts, etc.
```

**clasp pushes:** `Code.js`, `vendor/marked.js`, `appsscript.json` only.

## Development workflows

### A8S participant (`a8s/`)

```bash
cd a8s
npm ci && npm run vendor   # transpile marked → vendor/marked.js
tests/run                  # 132 tests
./deploy.sh                # npm ci, vendor, tests, clasp push
clasp push                 # push without testing
```

- **Multi-file GAS project:** `Code.js` + `vendor/marked.js` share one global scope.
- **npm vendoring:** `marked` is bundled with esbuild (`target: es2017`) because GAS V8 lacks class fields, optional chaining, etc. Never copy raw `marked.umd.js` — it will fail clasp push. See `scripts/vendor-marked.mjs`.
- **Pure helpers** duplicated in `a8s/tests/test.js` — keep in sync when changing markdown or logging formatters.
- **Runtime:** V8, 6-minute execution limit, Drive/Gmail quotas.
- **Config (Script Properties):**

| Property | Default | Purpose |
|----------|---------|---------|
| `A8S_ROOT_FOLDER_ID` | — | Drive folder for `.inbox`/`.outbox`/`.files` |
| `A8S_PARTICIPANT` | — | Authorized sender/recipient name |
| `CAPABILITIES` | — | `gmail`, `calendar` (comma-delimited) |
| `TRIGGER_MINUTES` | `5` | Poll interval: 1, 5, 10, 15, or 30 |
| `MARKDOWN_AUTO` | on | Set `false` to disable auto Markdown detection |
| `LOGGING_ENABLED` | off | Set by `enableLogging()` — shared with Bridge pattern |

### GAS Bridge (`bridge/`)

- Edit `bridge/Code.js`, bump `version` in `_info()` and the header comment.
- Deploy manually via Apps Script editor (Deploy > Manage Deployments > New Version).
- Update `bridge/README.md` action table when adding actions.
- PR checklist (`.github/pull_request_template.md`): version bump, README table, critic review.

### Standalone modules (`GasAWS.js`, etc.)

Copy-paste into user GAS projects. No deploy step in this repo.

## A8S features

### Markdown email (`/send`, `/reply`)

- **Auto-detect on by default** — headings, lists, bold/italic, links, code, fences
- **`--markdown`** — force HTML conversion
- **`--no-markdown`** — plain text only
- **`MARKDOWN_AUTO=false`** — disable auto-detection globally
- Quoted reply blocks (`On … wrote:`) excluded from detection
- HTML sanitized (allowlist tags; no scripts, images, `javascript:` URLs)
- Falls back to plain text if conversion fails or HTML > 200 KB
- Outbox response includes `(html)` when multipart was sent

Key functions in `Code.js`: `detectMarkdown`, `buildHtmlBody`, `sanitizeHtml`, `buildMailOpts`, `formatMarkdownLogNotes`.

### Transaction logging

Mirrors GAS Bridge `_logRequest` pattern:

- Enable: `enableLogging()` in editor (or `LOGGING_ENABLED=true`)
- Sheet: `GAS Log YYYY-MM-DD` — searches Drive for existing sheet (unifies with Bridge on same account)
- Actions: `a8s.send`, `a8s.reply`, `a8s.push.email`, `a8s.push.calendar`, `a8s.command`
- **Notes column:** Markdown diagnostics (`mode=auto, md=detected, html=yes`)
- Never logs message bodies — params only

### GAS editor debug functions

| Function | Purpose |
|----------|---------|
| `testConnection()` | Config, folder access, markdown/logging status |
| `testMarkdown()` | Detection + pipeline diagnostics |
| `testMarkdownDetection()` | Sample strings |
| `testMarkdownPipeline()` | Full `/send` pipeline log |

## Code conventions

- **JavaScript:** ES5 in `bridge/Code.js`; ES6+ in `a8s/Code.js`. Avoid optional chaining, class fields, and other syntax GAS V8 rejects — even in `a8s/Code.js` (GAS parses it directly).
- **Minimal scope:** Smallest correct diff.
- **Dependencies:** npm locally, esbuild to `vendor/`, clasp push. See `a8s/THIRD_PARTY_NOTICES.md`.
- **Security:** Sanitize HTML before email. Never log secrets. Logging must never break requests (try/catch).
- **Comments:** Only for non-obvious business logic.

## Testing

| Component | How to test |
|-----------|-------------|
| A8S | `a8s/tests/run` — 132 tests, mocked Gmail/Drive/Calendar + `marked` from npm |
| Bridge | Manual curl / `gas` CLI against deployed instance |

Add tests in `a8s/tests/test.js` using `assert` / `assertEqual`. Run before every push.

## Key APIs

### A8S Gmail commands

| Command | Notes |
|---------|-------|
| `/check`, `/search`, `/read` | Standard Gmail ops |
| `/send [--markdown\|--no-markdown] <to> <subject>` | Body = lines after command |
| `/reply [--markdown\|--no-markdown] <thread_id>` | Body = lines after command |

### Bridge actions

Routed via `HANDLERS` in `bridge/Code.js`. `gmail.send` / `gmail.reply` accept optional `html` → `htmlBody`.

## Git workflow

- Base branch: `main`
- Branch naming: `issue-<N>/<short-description>` or `fix/<topic>`
- Do not commit unless explicitly asked
- Do not push unless explicitly asked

## References

- [Root README](README.md)
- [GAS Bridge README](bridge/README.md)
- [A8S README](a8s/README.md)
- [A8S third-party notices](a8s/THIRD_PARTY_NOTICES.md)
- [Apps Script V8 runtime limitations](https://developers.google.com/apps-script/guides/v8-runtime)
- [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas)
