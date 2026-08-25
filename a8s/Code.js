/*
 * A8S v1.4 — Agent-to-agent messaging via Google Drive
 *
 * Polls .inbox/ for commands, routes email/calendar like an SMS bridge,
 * writes .outbox/ envelopes.
 */
const A8S = (() => {

  const VERSION = '1.4';

  const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

  function ulid() {
    let ts = Date.now();
    const chars = [];
    for (let i = 9; i >= 0; i--) {
      chars[i] = CROCKFORD.charAt(ts & 0x1f);
      ts = Math.floor(ts / 32);
    }
    for (let j = 10; j < 26; j++) {
      chars[j] = CROCKFORD.charAt(Math.floor(Math.random() * 32));
    }
    return chars.join('');
  }

  function normalizeEmailAddress(fromHeader) {
    if (!fromHeader) return '';
    let s = String(fromHeader).trim();
    const angle = s.match(/<([^>]+)>/);
    if (angle) s = angle[1].trim();
    if (s.toLowerCase().indexOf('mailto:') === 0) s = s.slice(7).trim();
    return s.toLowerCase();
  }

  // Every address this account sends as, normalized. Each source is guarded
  // on its own: installable triggers may blank or deny the active user, and
  // one unavailable source must not suppress the others.
  function selfEmailAddresses() {
    const selves = {};
    const add = value => {
      const addr = normalizeEmailAddress(value);
      if (addr) selves[addr] = true;
    };
    try { add(Session.getActiveUser().getEmail()); } catch (e) {}
    try { add(Session.getEffectiveUser().getEmail()); } catch (e) {}
    try { (GmailApp.getAliases() || []).forEach(add); } catch (e) {}
    return selves;
  }

  // Calendar days in the script's zone (V8 Date methods run in appsscript.json
  // timeZone), not rolling 24h buckets — 23:55 read at 00:05 is "yesterday".
  function describeAge(date, now) {
    const midnight = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const days = Math.round((midnight(now) - midnight(date)) / 86400000);
    if (days < 0) return days === -1 ? 'tomorrow' : `${-days} days from now`;
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    return `${days} days ago`;
  }

  /** Age + authorship tag so an agent never mistakes its own or stale mail for fresh inbound. */
  function formatMessageTag(fromHeader, date, selves, now) {
    const age = describeAge(date, now);
    if (selves && selves[normalizeEmailAddress(fromHeader)]) {
      return `[your own sent mail, ${age}]`;
    }
    return `[${age}]`;
  }

  function parseEmailMap(raw) {
    if (!raw || !String(raw).trim()) return {};
    try {
      const obj = JSON.parse(raw);
      const out = {};
      Object.keys(obj).forEach(k => {
        const addr = normalizeEmailAddress(k);
        const agent = String(obj[k] || '').trim();
        if (addr && agent) out[addr] = agent;
      });
      return out;
    } catch (e) {
      return {};
    }
  }

  function parseRoutes(raw) {
    const routes = {};
    String(raw || '').split(';').forEach(entry => {
      const equals = entry.indexOf('=');
      if (equals < 1) return;
      const name = entry.slice(0, equals).trim();
      if (!/^[A-Za-z0-9_.:-]+$/.test(name)) return;
      const recipients = entry.slice(equals + 1).split(',')
        .map(normalizeEmailAddress)
        .filter((addr, index, all) => addr.indexOf('@') > 0 && all.indexOf(addr) === index);
      if (recipients.length) routes[name] = recipients;
    });
    return routes;
  }

  function parseCommandAgents(raw, device) {
    if (raw === null || typeof raw === 'undefined') return device ? [device] : [];
    return String(raw).split(',').map(s => s.trim()).filter(Boolean);
  }

  function stripReplyPrefixes(subject) {
    let s = (subject || '').trim();
    const prefixes = ['re:', 'fwd:', 'fw:'];
    while (true) {
      const lower = s.toLowerCase();
      let matched = false;
      for (let i = 0; i < prefixes.length; i++) {
        const pref = prefixes[i];
        if (lower.indexOf(pref) === 0) {
          s = s.slice(pref.length).replace(/^\s+/, '');
          matched = true;
          break;
        }
      }
      if (!matched) break;
    }
    return s;
  }

  function parseSubjectRoute(subject) {
    const stripped = stripReplyPrefixes(subject);
    const m = stripped.match(/@([A-Za-z0-9_.:-]+)/);
    if (!m) return { agent: null, subjectRest: stripped };
    const agent = m[1];
    const subjectRest = (stripped.slice(0, m.index) + stripped.slice(m.index + m[0].length))
      .replace(/\s+/g, ' ')
      .trim();
    return { agent, subjectRest };
  }

  function resolveEmailPush(fromHeader, subject, config) {
    const addr = normalizeEmailAddress(fromHeader);
    if (!addr || !config.emailMap[addr]) {
      return { ok: false, reason: 'unmapped' };
    }
    const fromAgent = config.emailMap[addr];
    if (!config.defaultAgent) {
      return { ok: false, reason: 'no-default' };
    }
    const route = parseSubjectRoute(subject);
    return {
      ok: true,
      to: route.agent || config.defaultAgent,
      fromAgent,
      subjectRest: route.subjectRest,
      fromAddress: addr
    };
  }

  function addressForEmailAgent(agent, config) {
    if (!agent) return '';
    const keys = Object.keys(config.emailMap || {});
    for (let i = 0; i < keys.length; i++) {
      if (config.emailMap[keys[i]] === agent) return keys[i];
    }
    return '';
  }

  function isEmailPrincipal(name, config) {
    return !!addressForEmailAgent(name, config);
  }

  function routeRecipients(name, config) {
    const routes = config.routes || {};
    return routes[(name || '').trim()] || [];
  }

  function isNamedRoute(name, config) {
    return routeRecipients(name, config).length > 0;
  }

  function isDeviceTarget(to, config) {
    const t = (to || '').trim();
    if (!t) return true;
    return t === (config.device || '');
  }

  /** Inbox routing: email principal, device command surface, or named email route. */
  function decideInboxRoute(envelope, config) {
    const to = (envelope && envelope.to) || '';
    if (isEmailPrincipal(to, config)) return 'email';
    if (isDeviceTarget(to, config)) return 'device';
    if (isNamedRoute(to, config)) return 'route';
    return 'drop';
  }

  function isCommandAgent(from, config) {
    const agents = config.commandAgents || [];
    if (!from) return false;
    for (let i = 0; i < agents.length; i++) {
      if (agents[i] === from) return true;
    }
    return false;
  }

  function getConfig() {
    const props = PropertiesService.getScriptProperties();
    const caps = (props.getProperty('CAPABILITIES') || '').split(',').map(s => s.trim()).filter(Boolean);
    const raw = parseInt(props.getProperty('TRIGGER_MINUTES') || '5', 10);
    const valid = [1, 5, 10, 15, 30];
    const triggerMinutes = valid.includes(raw) ? raw : 5;
    const legacy = props.getProperty('A8S_PARTICIPANT') || '';
    const device = props.getProperty('A8S_DEVICE') || legacy;
    const defaultAgent = props.getProperty('A8S_DEFAULT_AGENT') || legacy;
    const emailMap = parseEmailMap(props.getProperty('A8S_EMAIL_MAP') || '');
    const routes = parseRoutes(props.getProperty('A8S_ROUTES') || '');
    const commandAgents = parseCommandAgents(props.getProperty('A8S_COMMAND_AGENTS'), device);
    return {
      rootFolderId: props.getProperty('A8S_ROOT_FOLDER_ID'),
      schedFolderId: props.getProperty('A8S_SCHED_FOLDER_ID') || '',
      device,
      defaultAgent,
      emailMap,
      routes,
      commandAgents,
      // Legacy alias used by older call sites / logs
      participant: defaultAgent,
      capabilities: caps,
      triggerMinutes,
      markdownAuto: (props.getProperty('MARKDOWN_AUTO') || '').toLowerCase() !== 'false',
      resolveUnmapped: (props.getProperty('A8S_RESOLVE_UNMAPPED') || '').toLowerCase() === 'true',
      unmappedDigest: (props.getProperty('A8S_UNMAPPED_DIGEST') || '').toLowerCase() === 'true'
    };
  }

  function getOrCreateSubfolder(root, name) {
    const iter = root.getFoldersByName(name);
    if (iter.hasNext()) return iter.next();
    return root.createFolder(name);
  }

  const _logs = [];

  function copyFileToBundle(filesFolder, bundle, filename) {
    if (!filesFolder || !bundle || !filename) return;
    const iter = filesFolder.getFilesByName(filename);
    if (!iter.hasNext()) return;
    const src = iter.next();
    const existing = bundle.getFilesByName(filename);
    if (existing.hasNext()) return;
    try {
      src.makeCopy(filename, bundle);
    } catch (e) {
      bundle.createFile(filename, src.getBlob());
    }
  }

  function writeEnvelope(outbox, to, content, files, filesFolder, fromAgent) {
    const envelope = {
      id: ulid(),
      date: new Date().toISOString(),
      to,
      content
    };
    if (fromAgent) envelope.from = fromAgent;
    if (files && files.length) {
      const bundle = getOrCreateSubfolder(outbox, envelope.id);
      const normalized = [];
      files.forEach(f => {
        const filename = (f.filename || '').trim();
        if (!filename) return;
        copyFileToBundle(filesFolder, bundle, filename);
        normalized.push({ filename });
      });
      if (normalized.length) envelope.files = normalized;
    }
    if (_logs.length) envelope.logs = _logs.splice(0);
    outbox.createFile(`${envelope.id}.json`, JSON.stringify(envelope, null, 2), 'application/json');
    return envelope;
  }

  // --- Drive File Helpers ---

  const DRIVE_URL_PATTERN = /https:\/\/(?:drive\.google\.com\/file\/d\/|docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/)([a-zA-Z0-9_-]+)/g;

  function extractDriveLinks(text) {
    if (!text) return [];
    const ids = [];
    let match;
    const re = new RegExp(DRIVE_URL_PATTERN.source, 'g');
    while ((match = re.exec(text)) !== null) {
      if (!ids.includes(match[1])) ids.push(match[1]);
    }
    return ids;
  }

  function hashPrefix(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function downloadDriveFile(fileId, filesFolder) {
    const file = DriveApp.getFileById(fileId);
    const mimeType = file.getMimeType();
    const name = file.getName();
    const prefix = hashPrefix(fileId);

    if (mimeType === 'application/vnd.google-apps.document') {
      let content;
      try {
        content = exportDocAsMarkdown(fileId);
      } catch (e) {
        content = file.getAs('text/plain').getDataAsString();
      }
      const filename = `${prefix}-${name}.md`;
      const iter = filesFolder.getFilesByName(filename);
      if (iter.hasNext()) return { filename };
      filesFolder.createFile(filename, content, 'text/markdown');
      return { filename };
    }

    const filename = `${prefix}-${name}`;
    const iter = filesFolder.getFilesByName(filename);
    if (iter.hasNext()) return { filename };
    const blob = file.getBlob();
    filesFolder.createFile(blob.setName(filename));
    return { filename };
  }

  function exportDocAsMarkdown(fileId) {
    const token = ScriptApp.getOAuthToken();
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/markdown`;
    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) {
      const plainUrl = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`;
      const plainResp = UrlFetchApp.fetch(plainUrl, {
        headers: { Authorization: `Bearer ${token}` },
        muteHttpExceptions: true
      });
      return plainResp.getContentText();
    }
    return resp.getContentText();
  }

  // --- Markdown email helpers (marked loaded from vendor/marked.js) ---

  const MAX_HTML_BODY_BYTES = 200 * 1024;

  const ALLOWED_HTML_TAGS = {
    a: true, b: true, blockquote: true, br: true, code: true, em: true,
    h1: true, h2: true, h3: true, h4: true, h5: true, h6: true, hr: true,
    i: true, li: true, ol: true, p: true, pre: true, strong: true, ul: true
  };

  const MD_PATTERNS = [
    /^#{1,6}\s/m,
    /^[-*]\s/m,
    /^\d+\.\s/m,
    /\*\*[^*\n]+\*\*/,
    /\*[^*\n]+\*/,
    /_[^_\n]+_/,
    /`[^`\n]+`/,
    /\[[^\]]+\]\(https?:\/\/[^)]+\)/,
    /^```/m
  ];

  function bodyForMarkdownDetection(body) {
    const lines = body.split('\n');
    const idx = lines.findIndex(l => /^On .+ wrote:\s*$/i.test(l.trim()));
    if (idx === -1) return body;
    return lines.slice(0, idx).join('\n');
  }

  function detectMarkdown(body) {
    if (!body || !body.trim()) return false;
    const scan = bodyForMarkdownDetection(body);
    return MD_PATTERNS.some(re => re.test(scan));
  }

  function parseMarkdownFlags(args) {
    let markdownMode = null;
    const remaining = [];
    args.forEach(a => {
      if (a === '--markdown') markdownMode = 'force';
      else if (a === '--no-markdown') markdownMode = 'disable';
      else remaining.push(a);
    });
    return { remainingArgs: remaining, markdownMode };
  }

  function effectiveMarkdownMode(flagMode, config) {
    if (flagMode === 'force') return 'force';
    if (flagMode === 'disable') return 'disable';
    return config.markdownAuto ? 'auto' : 'disable';
  }

  function sanitizeHtml(html) {
    if (!html) return '';
    let out = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
    out = out.replace(/<style\b[\s\S]*?<\/style>/gi, '');
    out = out.replace(/<!--[\s\S]*?-->/g, '');
    out = out.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (match, tag, attrs) => {
      const t = tag.toLowerCase();
      if (match.charAt(1) === '/') {
        return ALLOWED_HTML_TAGS[t] ? `</${t}>` : '';
      }
      if (!ALLOWED_HTML_TAGS[t]) return '';
      if (t === 'br' || t === 'hr') return `<${t}>`;
      if (t === 'a') {
        const hrefMatch = attrs.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
        const href = (hrefMatch && (hrefMatch[2] || hrefMatch[3] || hrefMatch[4] || '')).trim();
        if (!/^https?:\/\//i.test(href) && !/^mailto:/i.test(href)) return '';
        const safe = href.replace(/"/g, '&quot;').replace(/javascript:/gi, '');
        return `<a href="${safe}">`;
      }
      return `<${t}>`;
    });
    return out.replace(/javascript:/gi, '');
  }

  function buildHtmlBody(body, markdownMode, config) {
    if (!body || markdownMode === 'disable') return null;
    const shouldConvert = markdownMode === 'force' ||
      (markdownMode === 'auto' && detectMarkdown(body));
    if (!shouldConvert) return null;
    if (typeof marked === 'undefined') return null;
    try {
      let html = marked.parse(body, { breaks: true });
      html = sanitizeHtml(html);
      if (!html) return null;
      if (Utilities.newBlob(html).getBytes().length > MAX_HTML_BODY_BYTES) return null;
      return html;
    } catch (e) {
      return null;
    }
  }

  function buildMailOpts(body, args, config, attachments) {
    const { remainingArgs, markdownMode: flagMode } = parseMarkdownFlags(args);
    const opts = {};
    if (attachments.length) opts.attachments = attachments;
    const html = buildHtmlBody(body, effectiveMarkdownMode(flagMode, config), config);
    if (html) opts.htmlBody = html;
    return { opts, remainingArgs };
  }

  function formatMarkdownLogNotes(body, args, config, htmlSent) {
    const { markdownMode: flagMode } = parseMarkdownFlags(args || []);
    const mode = effectiveMarkdownMode(flagMode, config);
    const detected = detectMarkdown(body || '');
    return `mode=${mode}, md=${detected ? 'detected' : 'no'}, html=${htmlSent ? 'yes' : 'no'}`;
  }

  function toLogAction(command) {
    return 'a8s' + command.replace('/', '.');
  }

  function formatCommandParams(parsed, envelope) {
    const parts = [`from=${envelope.from || ''}`];
    const { remainingArgs } = parseMarkdownFlags(parsed.args);
    if (parsed.args.includes('--markdown')) parts.push('--markdown');
    if (parsed.args.includes('--no-markdown')) parts.push('--no-markdown');
    if (parsed.command === '/send') {
      if (remainingArgs[0]) parts.push(`to=${remainingArgs[0]}`);
      if (remainingArgs.length > 1) parts.push('subject');
    } else if (parsed.command === '/reply') {
      if (remainingArgs[0]) parts.push(`thread_id=${remainingArgs[0]}`);
    } else if (parsed.command === '/read') {
      if (remainingArgs[0]) parts.push(`thread_id=${remainingArgs[0]}`);
    } else if (parsed.command === '/search') {
      parts.push('query');
    } else if (parsed.command === '/create') {
      parts.push('title, datetime');
    }
    return parts.join(', ');
  }

  function formatLogStatus(response) {
    const text = String(response);
    if (text.startsWith('error:')) return text;
    if (text.startsWith('unknown:')) return 'error: ' + text.split('\n')[0];
    if (text.startsWith('rejected:')) return text;
    return 'ok';
  }

  // --- Transaction logging (same format as GAS Bridge) ---

  function _loggingEnabled() {
    return PropertiesService.getScriptProperties().getProperty('LOGGING_ENABLED') === 'true';
  }

  function _pruneStaleLogProperties() {
    const props = PropertiesService.getScriptProperties();
    const today = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
    if (props.getProperty('_a8s_log_prune_date') === today) return;

    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - 7);
    const cutoffStr = Utilities.formatDate(cutoff, 'UTC', 'yyyy-MM-dd');

    const all = props.getProperties();
    Object.keys(all).forEach(k => {
      const m = k.match(/^_log_sheet_(\d{4}-\d{2}-\d{2})$/);
      if (m && m[1] < cutoffStr) props.deleteProperty(k);
    });
    props.setProperty('_a8s_log_prune_date', today);
  }

  function _getOrCreateLogSheet(today) {
    const sheetName = 'GAS Log ' + today;
    const propKey = '_log_sheet_' + today;
    const props = PropertiesService.getScriptProperties();
    let ssId = props.getProperty(propKey);

    if (ssId) {
      try {
        return SpreadsheetApp.openById(ssId).getActiveSheet();
      } catch (e) {
        ssId = null;
      }
    }

    const files = DriveApp.getFilesByName(sheetName);
    while (files.hasNext()) {
      const f = files.next();
      if (f.getMimeType() === MimeType.GOOGLE_SHEETS) {
        ssId = f.getId();
        props.setProperty(propKey, ssId);
        return SpreadsheetApp.openById(ssId).getActiveSheet();
      }
    }

    const ss = SpreadsheetApp.create(sheetName);
    const sheet = ss.getActiveSheet();
    sheet.appendRow(['Timestamp', 'Action', 'Params', 'Status', 'Notes']);
    props.setProperty(propKey, ss.getId());
    return sheet;
  }

  function _logHasNotesColumn(sheet) {
    if (sheet.getLastRow() === 0) return true;
    return sheet.getRange(1, 5).getValue() === 'Notes';
  }

  function _logTransaction(action, params, status, notes) {
    if (!_loggingEnabled()) return;
    try {
      _pruneStaleLogProperties();
      const today = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
      const sheet = _getOrCreateLogSheet(today);
      const row = [new Date().toISOString(), action, params, status];
      if (_logHasNotesColumn(sheet)) {
        row.push(notes || '');
      } else if (notes) {
        row[3] = status + '; ' + notes;
      }
      sheet.appendRow(row);
    } catch (e) { /* logging must NEVER break the actual request */ }
  }

  function enableLogging() {
    PropertiesService.getScriptProperties().setProperty('LOGGING_ENABLED', 'true');
    Logger.log('Request logging ENABLED. Logs written to "GAS Log YYYY-MM-DD" spreadsheets.');
  }

  function disableLogging() {
    PropertiesService.getScriptProperties().deleteProperty('LOGGING_ENABLED');
    Logger.log('Request logging DISABLED.');
  }

  function debugMarkdownPipeline(body, args) {
    const config = getConfig();
    const { remainingArgs, markdownMode: flagMode } = parseMarkdownFlags(args || []);
    const effectiveMode = effectiveMarkdownMode(flagMode, config);
    const detected = detectMarkdown(body || '');
    const markedAvailable = typeof marked !== 'undefined';
    const scanText = bodyForMarkdownDetection(body || '');
    const diag = {
      configMarkdownAuto: config.markdownAuto,
      flagMode,
      effectiveMode: effectiveMode,
      detected,
      scanTextPreview: scanText.substring(0, 120),
      markedAvailable,
      parseError: null,
      rawHtmlLength: 0,
      sanitizedLength: 0,
      tooLarge: false,
      htmlBodyLength: 0,
      willSendHtml: false,
      rawHtmlPreview: null,
      sanitizedPreview: null,
      remainingArgs
    };

    if (!markedAvailable) return diag;

    try {
      const shouldConvert = effectiveMode === 'force' ||
        (effectiveMode === 'auto' && detected);
      if (!shouldConvert || !body) return diag;

      const rawHtml = marked.parse(body, { breaks: true });
      const sanitized = sanitizeHtml(rawHtml);
      const htmlBody = buildHtmlBody(body, effectiveMode, config);

      diag.rawHtmlLength = rawHtml.length;
      diag.sanitizedLength = sanitized.length;
      diag.tooLarge = sanitized.length > 0 &&
        Utilities.newBlob(sanitized).getBytes().length > MAX_HTML_BODY_BYTES;
      diag.htmlBodyLength = htmlBody ? htmlBody.length : 0;
      diag.willSendHtml = !!htmlBody;
      diag.rawHtmlPreview = rawHtml.substring(0, 300);
      diag.sanitizedPreview = sanitized.substring(0, 300);
    } catch (e) {
      diag.parseError = e.message;
    }

    return diag;
  }

  function testMarkdownDetection() {
    const samples = [
      ['plain text only', false],
      ['Please review the **API changes**', true],
      ['- item one\n- item two', true],
      ['# Heading', true],
      ['use `code` here', true],
      ['[link](https://example.com)', true]
    ];
    Logger.log('=== Markdown detection ===');
    Logger.log(`markdownAuto default: ${getConfig().markdownAuto}`);
    Logger.log(`marked available: ${typeof marked !== 'undefined'}`);
    samples.forEach(([text, expect]) => {
      const got = detectMarkdown(text);
      Logger.log(`${got === expect ? 'OK' : 'FAIL'} detectMarkdown(${JSON.stringify(text)}) => ${got} (expected ${expect})`);
    });
  }

  function testMarkdownPipeline() {
    const body = 'Please review the **API changes** below:\n\n- Add /users endpoint\n- Remove legacy field';
    Logger.log('=== Markdown pipeline (sample body) ===');
    Logger.log(JSON.stringify(debugMarkdownPipeline(body, []), null, 2));

    const content = `/send you@example.com Pipeline test\n${body}`;
    const parsed = parseCommand(content);
    Logger.log('=== Markdown pipeline (/send parseCommand) ===');
    Logger.log(JSON.stringify(debugMarkdownPipeline(parsed.body, parsed.args), null, 2));
  }

  function testMarkdown() {
    testMarkdownDetection();
    testMarkdownPipeline();
  }

  // --- Gmail Handler ---

  function isMappedMailMessage(msg, config) {
    const map = config.emailMap || {};
    return !!map[normalizeEmailAddress(msg.getFrom())];
  }

  function latestMappedUnreadMessage(thread, config) {
    const messages = thread.getMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].isUnread() && isMappedMailMessage(messages[i], config)) return messages[i];
    }
    return null;
  }

  // Reading/searching a mixed thread would disclose mail from outside the
  // switchboard even if another participant is mapped, so fail the thread
  // closed. The account's own messages are safe within a mapped conversation.
  function isReadableMailThread(thread, config, selves) {
    const messages = thread.getMessages();
    let hasMappedInbound = false;
    for (let i = 0; i < messages.length; i++) {
      const addr = normalizeEmailAddress(messages[i].getFrom());
      if (selves[addr]) continue;
      if (!config.emailMap || !config.emailMap[addr]) return false;
      hasMappedInbound = true;
    }
    return hasMappedInbound;
  }

  function mappedFromQuery(config) {
    const addresses = Object.keys(config.emailMap || {});
    if (!addresses.length) return '';
    return `{${addresses.map(addr => `from:${addr}`).join(' ')}}`;
  }

  function handleGmail(command, args, body, envelope, filesFolder, outbox, config, logCtx) {
    const self = selfEmailAddresses();
    const now = new Date();

    if (command === '/check') {
      const fromQuery = mappedFromQuery(config);
      if (!fromQuery) return '0 unread\n';
      const threads = GmailApp.search(`is:unread ${fromQuery}`);
      const visible = threads.map(t => ({ thread: t, msg: latestMappedUnreadMessage(t, config) }))
        .filter(item => !!item.msg);
      const subjects = visible.slice(0, 5).map(item =>
        `${item.thread.getId()} | ${item.msg.getSubject()} | ${item.msg.getFrom()} | ${formatMessageTag(item.msg.getFrom(), item.msg.getDate(), self, now)}`
      );
      return `${visible.length} unread\n${subjects.join('\n')}`;
    }

    if (command === '/search') {
      const query = args.join(' ');
      if (!query) return 'error: /search requires a query';
      const fromQuery = mappedFromQuery(config);
      if (!fromQuery) return `no results for: ${query}`;
      const results = GmailApp.search(`(${query}) ${fromQuery}`).filter(t =>
        isReadableMailThread(t, config, self)
      ).slice(0, 10);
      if (!results.length) return `no results for: ${query}`;
      const lines = results.map(t => {
        const msg = t.getMessages()[t.getMessageCount() - 1];
        return `${t.getId()} | ${msg.getSubject()} | ${msg.getFrom()} | ${msg.getDate().toISOString()} ${formatMessageTag(msg.getFrom(), msg.getDate(), self, now)}`;
      });
      return lines.join('\n');
    }

    if (command === '/read') {
      const threadId = args[0];
      if (!threadId) return 'error: /read requires a thread ID';
      try {
        const thread = GmailApp.getThreadById(threadId);
        if (!isReadableMailThread(thread, config, self)) {
          return 'refused: thread is outside the mapped switchboard';
        }
        const messages = thread.getMessages();
        const parts = messages.map(m =>
          `--- ${m.getFrom()} (${m.getDate().toISOString()}) ${formatMessageTag(m.getFrom(), m.getDate(), self, now)} ---\n${m.getPlainBody()}`
        );
        return `thread_id: ${threadId}\n\n${parts.join('\n\n')}`;
      } catch (e) {
        return `error: ${e.message}`;
      }
    }

    if (command === '/send' || command === '/reply') {
      const attachments = collectFileAttachments(envelope, filesFolder);
      const { remainingArgs, opts: mailOpts } = buildMailOpts(body, args, config, attachments);
      if (logCtx) {
        logCtx.notes = formatMarkdownLogNotes(body, args, config, !!mailOpts.htmlBody);
      }

      if (command === '/reply') {
        const replyThreadId = remainingArgs[0];
        if (!replyThreadId) return 'error: /reply requires a thread_id';
        try {
          const replyThread = GmailApp.getThreadById(replyThreadId);
          const lastMsg = replyThread.getMessages()[replyThread.getMessageCount() - 1];
          lastMsg.reply(body || '', mailOpts);
          const mode = mailOpts.htmlBody ? ' (html)' : '';
          return `replied to thread ${replyThreadId}${mode}`;
        } catch (e) {
          return `error: ${e.message}`;
        }
      }

      if (remainingArgs.length < 2) return 'error: /send <to> <subject>';
      const to = remainingArgs[0];
      const subject = remainingArgs.slice(1).join(' ');
      GmailApp.sendEmail(to, subject, body || '', mailOpts);
      const mode = mailOpts.htmlBody ? ' (html)' : '';
      return `sent to ${to}: ${subject}${mode}`;
    }

    return `unknown: ${command}\navailable: /check, /search, /read, /send, /reply`;
  }

  function collectFileAttachments(envelope, filesFolder) {
    const attachments = [];
    if (!envelope.files || !envelope.files.length) return attachments;
    const msgId = (envelope.id || '').trim();
    let bundle = null;
    if (msgId) {
      const bundleIter = filesFolder.getFoldersByName(msgId);
      if (bundleIter.hasNext()) bundle = bundleIter.next();
    }
    envelope.files.forEach(f => {
      const filename = (f.filename || '').trim();
      if (!filename) return;
      let blob = null;
      if (bundle) {
        const bundleIter = bundle.getFilesByName(filename);
        if (bundleIter.hasNext()) blob = bundleIter.next().getBlob();
      }
      if (!blob) {
        const iter = filesFolder.getFilesByName(filename);
        if (iter.hasNext()) blob = iter.next().getBlob();
      }
      if (blob) attachments.push(blob);
    });
    return attachments;
  }

  // --- Email Push (mapped unread → sticky/@ route → mark READ) ---

  // A pushed email must read like a message from its principal, not like
  // email: the reply chain, mailto artifacts, and every known address are
  // transport internals the agent must never see.
  function stripQuotedReply(body) {
    const markers = [
      /^-{2,}\s*Original Message\s*-{2,}\s*$/im,
      /^_{10,}\s*$/m,
      /^On [\s\S]{0,300}?wrote:\s*$/m,
    ];
    let cut = body.length;
    markers.forEach(re => {
      const m = re.exec(body);
      if (m && m.index < cut) cut = m.index;
    });
    return body
      .slice(0, cut)
      .split('\n')
      .filter(line => !/^\s*>/.test(line))
      .join('\n');
  }

  function sanitizeEmailBody(text, config) {
    let out = stripQuotedReply(text);
    out = out.replace(/<mailto:[^>\s]*>/gi, '').replace(/\bmailto:[^\s>]+/gi, '');
    out = replaceKnownAddresses(out, config);
    return out.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').trim();
  }

  function replaceKnownAddresses(text, config) {
    let out = text;
    const swap = (addr, name) => {
      const esc = addr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp('<\\s*' + esc + '\\s*>|' + esc, 'gi'), name);
    };
    const map = (config && config.emailMap) || {};
    Object.keys(map).forEach(addr => swap(addr, map[addr]));
    const device = (config && config.device) || 'the switchboard';
    Object.keys(selfEmailAddresses()).forEach(addr => swap(addr, device));
    return out;
  }

  function formatEmailForAgent(msg, subjectRest, config, now) {
    const at = now || new Date();
    let body = msg.getPlainBody() || '';
    if (body.length > 4000) body = body.substring(0, 4000) + '\n[truncated]';
    body = sanitizeEmailBody(body, config);
    const date = msg.getDate();
    const header = `Date: ${date.toISOString()} (${describeAge(date, at)})`;
    const rest = replaceKnownAddresses((subjectRest || '').trim(), config);
    if (rest && body) return `${header}\n\n${rest}\n\n${body}`;
    return `${header}\n\n${rest || body}`;
  }

  function pushNewEmails(config, outbox, filesFolder) {
    if (!config.defaultAgent || !config.capabilities.includes('gmail')) return 0;
    if (!config.emailMap || !Object.keys(config.emailMap).length) return 0;

    const threads = GmailApp.search('is:unread', 0, 10);
    if (!threads.length) return 0;

    let count = 0;
    threads.forEach(thread => {
      const messages = thread.getMessages();
      const unread = messages.filter(m => m.isUnread());

      unread.forEach(msg => {
        const decision = resolveEmailPush(msg.getFrom(), msg.getSubject(), config);
        if (!decision.ok) {
          console.log(`email push skipped from "${msg.getFrom()}": ${decision.reason}`);
          if (decision.reason === 'unmapped' && config.resolveUnmapped) {
            // Opt-in: a dedicated agent mailbox can clear unmapped bait from
            // every unread scan, but marking a shared mailbox's mail read
            // must never be the default.
            msg.markRead();
            _logTransaction(
              'a8s.push.email',
              `addr=${normalizeEmailAddress(msg.getFrom())}`,
              'skipped: unmapped (marked read)',
              ''
            );
          }
          return;
        }
        const content = formatEmailForAgent(msg, decision.subjectRest, config);
        const files = saveAttachmentsToFiles(msg, filesFolder);
        writeEnvelope(outbox, decision.to, content, files, filesFolder, decision.fromAgent);
        msg.markRead();
        count++;
        _logTransaction(
          'a8s.push.email',
          `from=${decision.fromAgent} to=${decision.to} addr=${decision.fromAddress}`,
          'ok',
          decision.subjectRest ? 'subject=' + decision.subjectRest.slice(0, 80) : ''
        );
      });
    });
    return count;
  }

  function pushUnmappedDigest(config, outbox, now) {
    if (!config.unmappedDigest || !config.defaultAgent || !config.capabilities.includes('gmail')) return 0;

    const props = PropertiesService.getScriptProperties();
    const key = '_a8s_unmapped_digest_at';
    const at = now || new Date();
    const stored = props.getProperty(key);
    const parsed = stored ? new Date(stored) : null;
    const since = parsed && !isNaN(parsed.getTime())
      ? parsed
      : new Date(at.getTime() - 86400000);
    if (at.getTime() - since.getTime() < 86400000) return 0;

    const selves = selfEmailAddresses();
    const query = `in:inbox after:${Math.floor(since.getTime() / 1000)}`;
    const entries = [];
    GmailApp.search(query).forEach(thread => {
      thread.getMessages().forEach(msg => {
        const date = msg.getDate();
        const addr = normalizeEmailAddress(msg.getFrom());
        if (date <= since || date > at || selves[addr] || isMappedMailMessage(msg, config)) return;
        entries.push({
          date,
          from: msg.getFrom(),
          subject: msg.getSubject() || '(no subject)'
        });
      });
    });
    entries.sort((a, b) => a.date - b.date);

    if (entries.length) {
      const lines = [
        'Informational only — no action is required.',
        `Unmapped mailbox activity since ${since.toISOString()}:`
      ];
      entries.forEach(entry => {
        lines.push(`- ${entry.from} | ${entry.subject}`);
      });
      writeEnvelope(outbox, config.defaultAgent, lines.join('\n'));
    }
    props.setProperty(key, at.toISOString());
    return entries.length ? 1 : 0;
  }

  function saveAttachmentsToFiles(msg, filesFolder) {
    const attachments = msg.getAttachments();
    if (!attachments.length) return [];

    return attachments.map(att => {
      const filename = att.getName();
      filesFolder.createFile(att.copyBlob().setName(filename));
      return { filename };
    });
  }

  // --- Calendar Push (upcoming events → tell participant) ---

  function formatEventForAgent(ev, filesFolder) {
    const start = ev.getStartTime();
    const end = ev.getEndTime();
    const lines = [
      'Calendar event starting soon',
      `event_id: ${ev.getId()}`,
      `title: ${ev.getTitle()}`,
      `start: ${start.toISOString()}`,
      `end: ${end.toISOString()}`
    ];

    const location = ev.getLocation();
    if (location) lines.push(`location: ${location}`);

    const isRecurring = ev.isRecurringEvent();
    lines.push(`recurring: ${isRecurring ? 'yes' : 'no'}`);

    const guests = ev.getGuestList();
    if (guests.length) {
      lines.push(`attendees: ${guests.map(g => g.getEmail()).join(', ')}`);
    }

    const description = ev.getDescription();
    lines.push('---');
    if (description) lines.push(description);

    const content = lines.join('\n');
    const files = [];

    if (filesFolder) {
      // Drive links in description
      if (description) {
        const fileIds = extractDriveLinks(description);
        _logs.push(`description drive links: ${fileIds.length}`);
        fileIds.forEach(id => {
          try {
            files.push(downloadDriveFile(id, filesFolder));
          } catch (e) {
            _logs.push(`drive download failed for ${id}: ${e.message}`);
          }
        });
      }

      // Calendar event attachments (requires Calendar Advanced Service)
      try {
        const calId = ev.getOriginalCalendarId ? ev.getOriginalCalendarId() : 'primary';
        const eventId = ev.getId().replace(/@.*$/, '');
        _logs.push(`fetching attachments for event ${eventId}`);
        const advEvent = Calendar.Events.get(calId, eventId);
        if (advEvent.attachments && advEvent.attachments.length) {
          _logs.push(`found ${advEvent.attachments.length} attachment(s)`);
          advEvent.attachments.forEach(att => {
            try {
              const fileId = att.fileId;
              if (fileId) {
                files.push(downloadDriveFile(fileId, filesFolder));
              } else if (att.fileUrl) {
                const extracted = extractDriveLinks(att.fileUrl);
                extracted.forEach(id => files.push(downloadDriveFile(id, filesFolder)));
              }
            } catch (e) {
              _logs.push(`attachment download failed: ${e.message}`);
            }
          });
        } else {
          _logs.push('no attachments on event');
        }
      } catch (e) {
        _logs.push(`Calendar Advanced Service: ${e.message}`);
      }
    }

    return { content, files };
  }

  function resolveCalendarDestination(title, config) {
    const route = parseSubjectRoute(title || '');
    return route.agent || config.defaultAgent;
  }

  function resolveCalendarOutbox(config, mainOutbox) {
    if (!config.schedFolderId) return mainOutbox;
    const schedulerRoot = DriveApp.getFolderById(config.schedFolderId);
    return getOrCreateSubfolder(schedulerRoot, '.outbox');
  }

  function pushUpcomingEvents(config, outbox, filesFolder) {
    if (!config.defaultAgent || !config.capabilities.includes('calendar')) return 0;

    const cal = CalendarApp.getDefaultCalendar();
    const now = new Date();
    const soon = new Date(now.getTime() + 15 * 60000);
    const events = cal.getEvents(now, soon);
    if (!events.length) return 0;

    const props = PropertiesService.getScriptProperties();
    const notifiedKey = '_a8s_notified_events';
    const notified = JSON.parse(props.getProperty(notifiedKey) || '{}');
    let count = 0;

    events.forEach(ev => {
      const start = ev.getStartTime();
      const key = `${ev.getId()}@${start.getTime()}`;
      if (!notified[key]) {
        const { content, files } = formatEventForAgent(ev, filesFolder);
        const to = resolveCalendarDestination(ev.getTitle(), config);
        writeEnvelope(outbox, to, content, files, filesFolder);
        notified[key] = now.toISOString();
        count++;
      }
    });

    const cutoff = now.getTime() - 3600000;
    for (const id in notified) {
      if (new Date(notified[id]).getTime() < cutoff) delete notified[id];
    }
    props.setProperty(notifiedKey, JSON.stringify(notified));
    return count;
  }

  // --- Calendar Handler ---

  function handleCalendar(command, args) {
    const cal = CalendarApp.getDefaultCalendar();

    if (command === '/today') {
      const now = new Date();
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
      const events = cal.getEvents(now, end);
      if (!events.length) return 'no events today';
      return events.map(ev => {
        const start = ev.getStartTime();
        return `${pad(start.getHours())}:${pad(start.getMinutes())} ${ev.getTitle()}`;
      }).join('\n');
    }

    if (command === '/week') {
      const now = new Date();
      const end = new Date(now.getTime() + 7 * 86400000);
      const events = cal.getEvents(now, end);
      if (!events.length) return 'no events this week';
      return events.map(ev => {
        const start = ev.getStartTime();
        const dateStr = `${start.getMonth() + 1}/${start.getDate()}`;
        return `${dateStr} ${pad(start.getHours())}:${pad(start.getMinutes())} ${ev.getTitle()}`;
      }).join('\n');
    }

    if (command === '/create') {
      if (args.length < 2) return 'error: /create <title> <datetime>';
      const title = args[0];
      const dateStr = args.slice(1).join(' ');
      try {
        const start = new Date(dateStr);
        if (isNaN(start.getTime())) return `error: invalid datetime: ${dateStr}`;
        cal.createEvent(title, start, new Date(start.getTime() + 3600000));
        return `created: ${title} at ${start.toISOString()}`;
      } catch (e) {
        return `error: ${e.message}`;
      }
    }

    return `unknown: ${command}\navailable: /today, /week, /create`;
  }

  const pad = n => (n < 10 ? '0' : '') + n;

  // --- Command Routing ---

  function parseCommand(content) {
    const lines = content.split('\n');
    const firstLine = lines[0].trim();
    if (!firstLine.startsWith('/')) return null;
    const parts = firstLine.split(/\s+/);
    return { command: parts[0], args: parts.slice(1), body: lines.slice(1).join('\n').trim() };
  }

  const GMAIL_COMMANDS = ['/check', '/search', '/read', '/send', '/reply'];
  const CALENDAR_COMMANDS = ['/today', '/week', '/create'];

  function routeMessage(envelope, config, filesFolder, outbox) {
    const parsed = parseCommand(envelope.content || '');
    if (!parsed) {
      _logTransaction('a8s.command', `from=${envelope.from || ''}`, 'error: not a command', '');
      return 'error: message must start with a /command';
    }

    const logParams = formatCommandParams(parsed, envelope);
    const logCtx = {};
    const { command } = parsed;
    let response;

    if (GMAIL_COMMANDS.includes(command)) {
      if (!config.capabilities.includes('gmail')) {
        response = 'error: gmail capability not enabled';
      } else {
        response = handleGmail(parsed.command, parsed.args, parsed.body, envelope, filesFolder, outbox, config, logCtx);
      }
    } else if (CALENDAR_COMMANDS.includes(command)) {
      if (!config.capabilities.includes('calendar')) {
        response = 'error: calendar capability not enabled';
      } else {
        response = handleCalendar(parsed.command, parsed.args);
      }
    } else {
      response = `error: unknown command "${command}"\navailable: ${GMAIL_COMMANDS.concat(CALENDAR_COMMANDS).join(', ')}`;
    }

    _logTransaction(toLogAction(command), logParams, formatLogStatus(response), logCtx.notes || '');
    return response;
  }

  function sendOutboundEmail(envelope, config, filesFolder) {
    const emailAgent = envelope.to || '';
    const addr = addressForEmailAgent(emailAgent, config);
    if (!addr) return 'error: no email mapped for ' + (emailAgent || 'recipient');
    if (!config.capabilities.includes('gmail')) return 'error: gmail capability not enabled';
    const fromAgent = envelope.from || 'unknown';
    const subject = '@' + fromAgent;
    const body = envelope.content || '';
    const attachments = collectFileAttachments(envelope, filesFolder);
    const opts = {};
    if (attachments.length) opts.attachments = attachments;
    GmailApp.sendEmail(addr, subject, body, opts);
    return null;
  }

  function sendNamedRouteEmail(envelope, config, filesFolder) {
    const recipients = routeRecipients(envelope.to, config);
    if (!recipients.length) return 'error: no recipients configured for route ' + (envelope.to || 'recipient');
    if (!config.capabilities.includes('gmail')) return 'error: gmail capability not enabled';
    const lines = String(envelope.content || '').split(/\r?\n/);
    const subject = (lines.shift() || '').trim();
    const body = lines.join('\n');
    const attachments = collectFileAttachments(envelope, filesFolder);
    const opts = {};
    if (attachments.length) opts.attachments = attachments;
    GmailApp.sendEmail(recipients.join(','), subject, body, opts);
    return null;
  }

  function processInboxEnvelope(envelope, config, filesFolder, outbox) {
    const route = decideInboxRoute(envelope, config);

    if (route === 'drop') {
      console.log(`ignored message to "${envelope.to}" (not device, email principal, or named route)`);
      _logTransaction('a8s.command', `to=${envelope.to || ''} from=${envelope.from || ''}`, 'rejected: unknown to', '');
      return;
    }

    if (route === 'email' || route === 'route') {
      // Address nodes never execute slash commands and do not require command rights.
      try {
        const err = route === 'route'
          ? sendNamedRouteEmail(envelope, config, filesFolder)
          : sendOutboundEmail(envelope, config, filesFolder);
        if (err) {
          if (envelope.from) writeEnvelope(outbox, envelope.from, err);
          _logTransaction('a8s.send', `from=${envelope.from || ''} route=${envelope.to || ''}`, err, '');
          return;
        }
        _logTransaction(
          'a8s.send',
          `outbound route=${envelope.to || ''} from=${envelope.from || ''}`,
          'ok',
          ''
        );
      } catch (e) {
        const msg = 'error: send failed: ' + e.message;
        if (envelope.from) writeEnvelope(outbox, envelope.from, msg);
        _logTransaction('a8s.send', `from=${envelope.from || ''} route=${envelope.to || ''}`, msg, '');
      }
      return;
    }

    // Device target: slash commands only
    const parsed = parseCommand(envelope.content || '');
    if (!parsed) {
      _logTransaction('a8s.command', `from=${envelope.from || ''}`, 'error: not a command', '');
      if (envelope.from) {
        writeEnvelope(outbox, envelope.from, 'error: message must start with a /command');
      }
      return;
    }
    if (!isCommandAgent(envelope.from, config)) {
      console.log(`rejected message from "${envelope.from}" (command agents: ${config.commandAgents.join(', ')})`);
      _logTransaction('a8s.command', `from=${envelope.from || ''}`, 'rejected: unauthorized', '');
      return;
    }
    const response = routeMessage(envelope, config, filesFolder, outbox);
    writeEnvelope(outbox, envelope.from || config.device, response);
  }

  // --- Main Trigger ---

  function onTrigger() {
    const config = getConfig();
    if (!config.rootFolderId) {
      console.log('A8S_ROOT_FOLDER_ID not configured');
      return;
    }

    let root;
    try {
      root = DriveApp.getFolderById(config.rootFolderId);
    } catch (e) {
      console.log(`cannot access root folder: ${e.message}`);
      return;
    }

    const inbox = getOrCreateSubfolder(root, '.inbox');
    const outbox = getOrCreateSubfolder(root, '.outbox');
    const filesFolder = getOrCreateSubfolder(root, '.files');

    const files = inbox.getFiles();
    while (files.hasNext()) {
      const file = files.next();
      if (!file.getName().endsWith('.json')) continue;

      try {
        const envelope = JSON.parse(file.getBlob().getDataAsString());
        processInboxEnvelope(envelope, config, filesFolder, outbox);
      } catch (e) {
        console.log(`error processing ${file.getName()}: ${e.message}`);
        _logTransaction('a8s.command', file.getName(), 'error: ' + e.message, '');
      }

      file.setTrashed(true);
    }

    try {
      const emailCount = pushNewEmails(config, outbox, filesFolder);
      if (emailCount > 0) {
        _logTransaction('a8s.push.email', `default=${config.defaultAgent}`, `ok (${emailCount} messages)`, '');
      }
    } catch (e) {
      console.log(`email push failed: ${e.message}`);
      _logTransaction('a8s.push.email', `default=${config.defaultAgent}`, 'error: ' + e.message, '');
    }

    try {
      const digestCount = pushUnmappedDigest(config, outbox);
      if (digestCount > 0) {
        _logTransaction('a8s.push.email', `default=${config.defaultAgent}`, 'ok (unmapped digest)', 'informational');
      }
    } catch (e) {
      console.log(`unmapped digest failed: ${e.message}`);
      _logTransaction('a8s.push.email', `default=${config.defaultAgent}`, 'error: digest: ' + e.message, '');
    }

    try {
      const calendarOutbox = resolveCalendarOutbox(config, outbox);
      const eventCount = pushUpcomingEvents(config, calendarOutbox, filesFolder);
      if (eventCount > 0) {
        _logTransaction('a8s.push.calendar', `default=${config.defaultAgent}`, `ok (${eventCount} events)`, '');
      }
    } catch (e) {
      console.log(`calendar push failed: ${e.message}`);
      _logTransaction('a8s.push.calendar', `default=${config.defaultAgent}`, 'error: ' + e.message, '');
    }
  }

  // --- Setup ---

  function a8sHelp() {
    Logger.log('A8S Script Properties:');
    Logger.log('  A8S_ROOT_FOLDER_ID — primary Drive folder ID');
    Logger.log('  A8S_SCHED_FOLDER_ID — optional scheduler Drive folder ID (calendar writes to its .outbox)');
    Logger.log('  A8S_DEVICE — filedrop command node name (e.g. "my-google")');
    Logger.log('  A8S_DEFAULT_AGENT — sticky push and digest destination (e.g. "agent")');
    Logger.log('  A8S_EMAIL_MAP — JSON {"human@example.com":"human-mail"}');
    Logger.log('  A8S_ROUTES — named recipients (e.g. "owner-mail=owner@example.com;team=a@example.com,b@example.com")');
    Logger.log('  A8S_COMMAND_AGENTS — comma list allowed to run /commands; set empty for no command surface');
    Logger.log('  CAPABILITIES — comma-delimited list (e.g. "gmail,calendar")');
    Logger.log('  A8S_RESOLVE_UNMAPPED — "true" marks unmapped unread mail read after skipping (default: leave unread)');
    Logger.log('  A8S_UNMAPPED_DIGEST — "true" pushes one informational digest per day (default: off)');
    Logger.log('  TRIGGER_MINUTES — trigger interval: 1, 5, 10, 15, or 30 (default: 5)');
    Logger.log('  MARKDOWN_AUTO — set to "false" to disable auto Markdown detection (default: on)');
    Logger.log('One node, one face: use a second filedrop node on A8S_SCHED_FOLDER_ID for calendar pushes.');
    Logger.log('Legacy: A8S_PARTICIPANT fills DEVICE + DEFAULT_AGENT when those are unset.');
    Logger.log('Run enableLogging() to log transactions to "GAS Log YYYY-MM-DD" sheets.');
  }

  function setup() {
    const props = PropertiesService.getScriptProperties();
    if (!props.getProperty('A8S_ROOT_FOLDER_ID')) {
      a8sHelp();
      return;
    }
    Logger.log('Configuration OK. Run installTrigger() to activate.');
  }

  function installTrigger() {
    ScriptApp.getProjectTriggers().forEach(t => {
      if (t.getHandlerFunction() === 'onTrigger') ScriptApp.deleteTrigger(t);
    });
    const config = getConfig();
    ScriptApp.newTrigger('onTrigger').timeBased().everyMinutes(config.triggerMinutes).create();
    Logger.log(`Trigger installed: every ${config.triggerMinutes} minutes.`);
  }

  function removeTrigger() {
    let removed = 0;
    ScriptApp.getProjectTriggers().forEach(t => {
      if (t.getHandlerFunction() === 'onTrigger') {
        ScriptApp.deleteTrigger(t);
        removed++;
      }
    });
    Logger.log(`Removed ${removed} trigger(s).`);
  }

  function testConnection() {
    const config = getConfig();
    if (!config.rootFolderId) { Logger.log('ERROR: A8S_ROOT_FOLDER_ID not set'); return; }
    try {
      const root = DriveApp.getFolderById(config.rootFolderId);
      Logger.log(`Version: ${VERSION}`);
      Logger.log(`Root: ${root.getName()} (${root.getId()})`);
      Logger.log(`.inbox: ${getOrCreateSubfolder(root, '.inbox').getId()}`);
      Logger.log(`.outbox: ${getOrCreateSubfolder(root, '.outbox').getId()}`);
      Logger.log(`.files: ${getOrCreateSubfolder(root, '.files').getId()}`);
      if (config.schedFolderId) {
        const schedulerRoot = DriveApp.getFolderById(config.schedFolderId);
        Logger.log(`Scheduler root: ${schedulerRoot.getName()} (${schedulerRoot.getId()})`);
        Logger.log(`Scheduler .outbox: ${getOrCreateSubfolder(schedulerRoot, '.outbox').getId()}`);
      } else {
        Logger.log('Scheduler outbox: primary .outbox (A8S_SCHED_FOLDER_ID not set)');
      }
      Logger.log(`Device: ${config.device || '(not set)'}`);
      Logger.log(`Default agent: ${config.defaultAgent || '(not set)'}`);
      Logger.log(`Email map: ${JSON.stringify(config.emailMap)}`);
      Logger.log(`Named routes: ${JSON.stringify(config.routes)}`);
      Logger.log(`Command agents: ${config.commandAgents.join(', ') || '(none)'}`);
      Logger.log(`Capabilities: ${config.capabilities.join(', ') || '(none)'}`);
      Logger.log(`Trigger interval: ${config.triggerMinutes} minutes`);
      Logger.log(`Unmapped digest: ${config.unmappedDigest ? 'on' : 'off'}`);
      Logger.log(`Markdown auto-detect: ${config.markdownAuto ? 'on' : 'off (MARKDOWN_AUTO=false)'}`);
      Logger.log(`Transaction logging: ${_loggingEnabled() ? 'on' : 'off (run enableLogging())'}`);
      Logger.log(`marked global: ${typeof marked !== 'undefined' ? 'available' : 'MISSING — check vendor/marked.js'}`);
      Logger.log('OK');
    } catch (e) {
      Logger.log(`ERROR: ${e.message}`);
    }
  }

  return {
    onTrigger,
    setup,
    a8sHelp,
    installTrigger,
    removeTrigger,
    testConnection,
    testMarkdown,
    testMarkdownDetection,
    testMarkdownPipeline,
    debugMarkdownPipeline,
    enableLogging,
    disableLogging,
    _testing: {
      ulid, parseCommand, formatEmailForAgent, sanitizeEmailBody, stripQuotedReply, formatEventForAgent, writeEnvelope, routeMessage,
      handleGmail, pushNewEmails, pushUnmappedDigest, selfEmailAddresses,
      pad, extractDriveLinks, exportDocAsMarkdown, downloadDriveFile, hashPrefix, getConfig,
      describeAge, formatMessageTag,
      detectMarkdown, bodyForMarkdownDetection, parseMarkdownFlags, effectiveMarkdownMode,
      sanitizeHtml, buildHtmlBody, buildMailOpts, formatMarkdownLogNotes, formatCommandParams,
      formatLogStatus, toLogAction, normalizeEmailAddress, parseEmailMap, parseRoutes, parseCommandAgents,
      stripReplyPrefixes, parseSubjectRoute, resolveEmailPush, addressForEmailAgent,
      isEmailPrincipal, routeRecipients, isNamedRoute, isDeviceTarget, decideInboxRoute, isCommandAgent,
      isMappedMailMessage, latestMappedUnreadMessage, isReadableMailThread, mappedFromQuery,
      resolveCalendarDestination, resolveCalendarOutbox, pushUpcomingEvents, processInboxEnvelope,
      sendOutboundEmail, sendNamedRouteEmail
    }
  };

})();

function onTrigger()      { A8S.onTrigger(); }
function setup()          { A8S.setup(); }
function a8sHelp()        { A8S.a8sHelp(); }
function installTrigger() { A8S.installTrigger(); }
function removeTrigger()  { A8S.removeTrigger(); }
function testConnection() { A8S.testConnection(); }
function testMarkdown() { A8S.testMarkdown(); }
function testMarkdownDetection() { A8S.testMarkdownDetection(); }
function testMarkdownPipeline() { A8S.testMarkdownPipeline(); }
function enableLogging() { A8S.enableLogging(); }
function disableLogging() { A8S.disableLogging(); }
