/*
 * A8S v1.0 — Agent-to-agent messaging via Google Drive
 *
 * Polls .inbox/ for commands, executes Gmail/Calendar ops, writes .outbox/ envelopes.
 */
const A8S = (() => {

  const VERSION = '1.0';

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

  function getConfig() {
    const props = PropertiesService.getScriptProperties();
    const caps = (props.getProperty('CAPABILITIES') || '').split(',').map(s => s.trim()).filter(Boolean);
    const raw = parseInt(props.getProperty('TRIGGER_MINUTES') || '5', 10);
    const valid = [1, 5, 10, 15, 30];
    const triggerMinutes = valid.includes(raw) ? raw : 5;
    return {
      rootFolderId: props.getProperty('A8S_ROOT_FOLDER_ID'),
      participant: props.getProperty('A8S_PARTICIPANT') || '',
      capabilities: caps,
      triggerMinutes,
      markdownAuto: (props.getProperty('MARKDOWN_AUTO') || '').toLowerCase() !== 'false'
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

  function writeEnvelope(outbox, to, content, files, filesFolder) {
    const envelope = {
      id: ulid(),
      date: new Date().toISOString(),
      to,
      content
    };
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

  function handleGmail(command, args, body, envelope, filesFolder, outbox, config, logCtx) {
    if (command === '/check') {
      const threads = GmailApp.search('is:unread', 0, 5);
      const subjects = threads.map(t => {
        const msg = t.getMessages()[t.getMessageCount() - 1];
        return `${t.getId()} | ${msg.getSubject()} | ${msg.getFrom()}`;
      });
      const total = GmailApp.getInboxUnreadCount();
      return `${total} unread\n${subjects.join('\n')}`;
    }

    if (command === '/search') {
      const query = args.join(' ');
      if (!query) return 'error: /search requires a query';
      const results = GmailApp.search(query, 0, 10);
      if (!results.length) return `no results for: ${query}`;
      const lines = results.map(t => {
        const msg = t.getMessages()[t.getMessageCount() - 1];
        return `${t.getId()} | ${msg.getSubject()} | ${msg.getFrom()} | ${msg.getDate().toISOString()}`;
      });
      return lines.join('\n');
    }

    if (command === '/read') {
      const threadId = args[0];
      if (!threadId) return 'error: /read requires a thread ID';
      try {
        const thread = GmailApp.getThreadById(threadId);
        const messages = thread.getMessages();
        const parts = messages.map(m =>
          `--- ${m.getFrom()} (${m.getDate().toISOString()}) ---\n${m.getPlainBody()}`
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

  // --- Email Push (UNREAD → mark READ → tell agent) ---

  function pushNewEmails(config, outbox, filesFolder) {
    if (!config.participant || !config.capabilities.includes('gmail')) return 0;

    const threads = GmailApp.search('is:unread', 0, 10);
    if (!threads.length) return 0;

    let count = 0;
    threads.forEach(thread => {
      const messages = thread.getMessages();
      const unread = messages.filter(m => m.isUnread());

      unread.forEach(msg => {
        const content = formatEmailForAgent(msg, thread.getId());
        const files = saveAttachmentsToFiles(msg, filesFolder);
        writeEnvelope(outbox, config.participant, content, files, filesFolder);
        msg.markRead();
        count++;
      });
    });
    return count;
  }

  function formatEmailForAgent(msg, threadId) {
    const from = msg.getFrom();
    const subject = msg.getSubject();
    const date = msg.getDate().toISOString();
    let body = msg.getPlainBody();
    if (body.length > 4000) body = body.substring(0, 4000) + '\n[truncated]';

    return `New email\nthread_id: ${threadId}\nfrom: ${from}\nsubject: ${subject}\ndate: ${date}\n---\n${body}`;
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

  function pushUpcomingEvents(config, outbox, filesFolder) {
    if (!config.participant || !config.capabilities.includes('calendar')) return 0;

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
        writeEnvelope(outbox, config.participant, content, files, filesFolder);
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
        if (config.participant && envelope.from !== config.participant) {
          console.log(`rejected message from "${envelope.from}" (authorized: ${config.participant})`);
          _logTransaction('a8s.command', `from=${envelope.from || ''}`, 'rejected: unauthorized', '');
        } else {
          const response = routeMessage(envelope, config, filesFolder, outbox);
          writeEnvelope(outbox, config.participant, response);
        }
      } catch (e) {
        console.log(`error processing ${file.getName()}: ${e.message}`);
        _logTransaction('a8s.command', file.getName(), 'error: ' + e.message, '');
      }

      file.setTrashed(true);
    }

    try {
      const emailCount = pushNewEmails(config, outbox, filesFolder);
      if (emailCount > 0) {
        _logTransaction('a8s.push.email', `to=${config.participant}`, `ok (${emailCount} messages)`, '');
      }
    } catch (e) {
      console.log(`email push failed: ${e.message}`);
      _logTransaction('a8s.push.email', `to=${config.participant}`, 'error: ' + e.message, '');
    }

    try {
      const eventCount = pushUpcomingEvents(config, outbox, filesFolder);
      if (eventCount > 0) {
        _logTransaction('a8s.push.calendar', `to=${config.participant}`, `ok (${eventCount} events)`, '');
      }
    } catch (e) {
      console.log(`calendar push failed: ${e.message}`);
      _logTransaction('a8s.push.calendar', `to=${config.participant}`, 'error: ' + e.message, '');
    }
  }

  // --- Setup ---

  function setup() {
    const props = PropertiesService.getScriptProperties();
    if (!props.getProperty('A8S_ROOT_FOLDER_ID')) {
      Logger.log('Set Script Properties:');
      Logger.log('  A8S_ROOT_FOLDER_ID — Drive folder ID');
      Logger.log('  A8S_PARTICIPANT — who to push notifications to (e.g. "my-agent")');
      Logger.log('  CAPABILITIES — comma-delimited list (e.g. "gmail,calendar")');
      Logger.log('  TRIGGER_MINUTES — trigger interval: 1, 5, 10, 15, or 30 (default: 5)');
      Logger.log('  MARKDOWN_AUTO — set to "false" to disable auto Markdown detection (default: on)');
      Logger.log('Run enableLogging() to log transactions to "GAS Log YYYY-MM-DD" sheets (same as GAS Bridge).');
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
      Logger.log(`Participant: ${config.participant || '(not set)'}`);
      Logger.log(`Capabilities: ${config.capabilities.join(', ') || '(none)'}`);
      Logger.log(`Trigger interval: ${config.triggerMinutes} minutes`);
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
      ulid, parseCommand, formatEmailForAgent, formatEventForAgent, writeEnvelope, routeMessage,
      pad, extractDriveLinks, exportDocAsMarkdown, downloadDriveFile, hashPrefix, getConfig,
      detectMarkdown, bodyForMarkdownDetection, parseMarkdownFlags, effectiveMarkdownMode,
      sanitizeHtml, buildHtmlBody, buildMailOpts, formatMarkdownLogNotes, formatCommandParams,
      formatLogStatus, toLogAction
    }
  };

})();

function onTrigger()      { A8S.onTrigger(); }
function setup()          { A8S.setup(); }
function installTrigger() { A8S.installTrigger(); }
function removeTrigger()  { A8S.removeTrigger(); }
function testConnection() { A8S.testConnection(); }
function testMarkdown() { A8S.testMarkdown(); }
function testMarkdownDetection() { A8S.testMarkdownDetection(); }
function testMarkdownPipeline() { A8S.testMarkdownPipeline(); }
function enableLogging() { A8S.enableLogging(); }
function disableLogging() { A8S.disableLogging(); }
