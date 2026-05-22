const A8S = (() => {

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
      triggerMinutes
    };
  }

  function getOrCreateSubfolder(root, name) {
    const iter = root.getFoldersByName(name);
    if (iter.hasNext()) return iter.next();
    return root.createFolder(name);
  }

  const _logs = [];

  function writeEnvelope(outbox, to, content, files) {
    const envelope = {
      id: ulid(),
      date: new Date().toISOString(),
      to,
      content
    };
    if (files && files.length) envelope.files = files;
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
      if (iter.hasNext()) return { filename, path: `./.files/${filename}` };
      filesFolder.createFile(filename, content, 'text/markdown');
      return { filename, path: `./.files/${filename}` };
    }

    const filename = `${prefix}-${name}`;
    const iter = filesFolder.getFilesByName(filename);
    if (iter.hasNext()) return { filename, path: `./.files/${filename}` };
    const blob = file.getBlob();
    filesFolder.createFile(blob.setName(filename));
    return { filename, path: `./.files/${filename}` };
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

  // --- Gmail Handler ---

  function handleGmail(command, args, body, envelope, filesFolder, outbox, config) {
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
      if (command === '/reply') {
        const replyThreadId = args[0];
        if (!replyThreadId) return 'error: /reply requires a thread_id';
        try {
          const replyThread = GmailApp.getThreadById(replyThreadId);
          const lastMsg = replyThread.getMessages()[replyThread.getMessageCount() - 1];
          const attachments = collectFileAttachments(envelope, filesFolder);
          const opts = {};
          if (attachments.length) opts.attachments = attachments;
          lastMsg.reply(body || '', opts);
          return `replied to thread ${replyThreadId}`;
        } catch (e) {
          return `error: ${e.message}`;
        }
      }

      if (args.length < 2) return 'error: /send <to> <subject>';
      const to = args[0];
      const subject = args.slice(1).join(' ');
      const attachments = collectFileAttachments(envelope, filesFolder);
      const opts = {};
      if (attachments.length) opts.attachments = attachments;
      GmailApp.sendEmail(to, subject, body || '', opts);
      return `sent to ${to}: ${subject}`;
    }

    return `unknown: ${command}\navailable: /check, /search, /read, /send, /reply`;
  }

  function collectFileAttachments(envelope, filesFolder) {
    const attachments = [];
    if (!envelope.files || !envelope.files.length) return attachments;
    envelope.files.forEach(f => {
      const filename = f.filename || f.path.split('/').pop();
      const iter = filesFolder.getFilesByName(filename);
      if (iter.hasNext()) {
        attachments.push(iter.next().getBlob());
      }
    });
    return attachments;
  }

  // --- Email Push (UNREAD → mark READ → tell agent) ---

  function pushNewEmails(config, outbox, filesFolder) {
    if (!config.participant || !config.capabilities.includes('gmail')) return;

    const threads = GmailApp.search('is:unread', 0, 10);
    if (!threads.length) return;

    threads.forEach(thread => {
      const messages = thread.getMessages();
      const unread = messages.filter(m => m.isUnread());

      unread.forEach(msg => {
        const content = formatEmailForAgent(msg, thread.getId());
        const files = saveAttachmentsToFiles(msg, filesFolder);
        writeEnvelope(outbox, config.participant, content, files);
        msg.markRead();
      });
    });
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
      return { filename, path: `./.files/${filename}` };
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
    if (!config.participant || !config.capabilities.includes('calendar')) return;

    const cal = CalendarApp.getDefaultCalendar();
    const now = new Date();
    const soon = new Date(now.getTime() + 15 * 60000);
    const events = cal.getEvents(now, soon);
    if (!events.length) return;

    const props = PropertiesService.getScriptProperties();
    const notifiedKey = '_a8s_notified_events';
    const notified = JSON.parse(props.getProperty(notifiedKey) || '{}');

    events.forEach(ev => {
      const start = ev.getStartTime();
      const key = `${ev.getId()}@${start.getTime()}`;
      if (!notified[key]) {
        const { content, files } = formatEventForAgent(ev, filesFolder);
        writeEnvelope(outbox, config.participant, content, files);
        notified[key] = now.toISOString();
      }
    });

    const cutoff = now.getTime() - 3600000;
    for (const id in notified) {
      if (new Date(notified[id]).getTime() < cutoff) delete notified[id];
    }
    props.setProperty(notifiedKey, JSON.stringify(notified));
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
    if (!parsed) return 'error: message must start with a /command';

    const { command } = parsed;

    if (GMAIL_COMMANDS.includes(command)) {
      if (!config.capabilities.includes('gmail')) return `error: gmail capability not enabled`;
      return handleGmail(parsed.command, parsed.args, parsed.body, envelope, filesFolder, outbox, config);
    }

    if (CALENDAR_COMMANDS.includes(command)) {
      if (!config.capabilities.includes('calendar')) return `error: calendar capability not enabled`;
      return handleCalendar(parsed.command, parsed.args);
    }

    return `error: unknown command "${command}"\navailable: ${GMAIL_COMMANDS.concat(CALENDAR_COMMANDS).join(', ')}`;
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
        } else {
          const response = routeMessage(envelope, config, filesFolder, outbox);
          writeEnvelope(outbox, config.participant, response);
        }
      } catch (e) {
        console.log(`error processing ${file.getName()}: ${e.message}`);
      }

      file.setTrashed(true);
    }

    try {
      pushNewEmails(config, outbox, filesFolder);
    } catch (e) {
      console.log(`email push failed: ${e.message}`);
    }

    try {
      pushUpcomingEvents(config, outbox, filesFolder);
    } catch (e) {
      console.log(`calendar push failed: ${e.message}`);
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
      Logger.log(`Root: ${root.getName()} (${root.getId()})`);
      Logger.log(`.inbox: ${getOrCreateSubfolder(root, '.inbox').getId()}`);
      Logger.log(`.outbox: ${getOrCreateSubfolder(root, '.outbox').getId()}`);
      Logger.log(`.files: ${getOrCreateSubfolder(root, '.files').getId()}`);
      Logger.log(`Participant: ${config.participant || '(not set)'}`);
      Logger.log(`Capabilities: ${config.capabilities.join(', ') || '(none)'}`);
      Logger.log(`Trigger interval: ${config.triggerMinutes} minutes`);
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
    _testing: { ulid, parseCommand, formatEmailForAgent, formatEventForAgent, writeEnvelope, routeMessage, pad, extractDriveLinks, exportDocAsMarkdown, downloadDriveFile, hashPrefix, getConfig }
  };

})();

function onTrigger()      { A8S.onTrigger(); }
function setup()          { A8S.setup(); }
function installTrigger() { A8S.installTrigger(); }
function removeTrigger()  { A8S.removeTrigger(); }
function testConnection() { A8S.testConnection(); }
