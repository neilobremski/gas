'use strict';

const { marked } = require('marked');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

function assertEqual(actual, expected, msg) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, msg) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

// --- Inline pure functions from Code.js for testing ---

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

function parseCommand(content) {
  const lines = content.split('\n');
  const firstLine = lines[0].trim();
  if (!firstLine.startsWith('/')) return null;
  const parts = firstLine.split(/\s+/);
  return { command: parts[0], args: parts.slice(1), body: lines.slice(1).join('\n').trim() };
}

// --- Markdown email helpers (mirrored from Code.js) ---

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
  try {
    let html = marked.parse(body, { breaks: true });
    html = sanitizeHtml(html);
    if (!html) return null;
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BODY_BYTES) return null;
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

function formatEmailForAgent(msg, threadId) {
  const from = msg.getFrom();
  const subject = msg.getSubject();
  const date = msg.getDate().toISOString();
  let body = msg.getPlainBody();
  if (body.length > 4000) body = body.substring(0, 4000) + '\n[truncated]';
  return `New email\nthread_id: ${threadId}\nfrom: ${from}\nsubject: ${subject}\ndate: ${date}\n---\n${body}`;
}

const pad = n => (n < 10 ? '0' : '') + n;

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

  if (filesFolder && description) {
    const fileIds = extractDriveLinks(description);
    fileIds.forEach(id => {
      try {
        files.push(mockDownloadDriveFile(id, filesFolder));
      } catch (e) {
        // skip
      }
    });
  }

  return { content, files };
}

function mockDownloadDriveFile(fileId, filesFolder) {
  const filename = `file_${fileId}.md`;
  filesFolder.createFile(filename, 'mock content', 'text/markdown');
  return { filename };
}

function createMockBundleFolder() {
  const files = [];
  return {
    getFilesByName: (name) => {
      const found = files.find(f => f.name === name);
      return {
        hasNext: () => !!found,
        next: () => ({
          getBlob: () => found.content,
          makeCopy: (copyName, dest) => dest.createFile(copyName, found.content, found.mimeType)
        })
      };
    },
    createFile: (name, content, mimeType) => files.push({ name, content, mimeType })
  };
}

function copyFileToBundle(filesFolder, bundle, filename) {
  if (!filesFolder || !bundle || !filename) return;
  const iter = filesFolder.getFilesByName(filename);
  if (!iter.hasNext()) return;
  const src = iter.next();
  const existing = bundle.getFilesByName(filename);
  if (existing.hasNext()) return;
  bundle.createFile(filename, src.content, src.mimeType);
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
  outbox.createFile(`${envelope.id}.json`, JSON.stringify(envelope, null, 2), 'application/json');
  return envelope;
}

function getOrCreateSubfolder(root, name) {
  const iter = root.getFoldersByName(name);
  if (iter.hasNext()) return iter.next();
  return root.createFolder(name);
}

const GMAIL_COMMANDS = ['/check', '/search', '/read', '/send', '/reply'];
const CALENDAR_COMMANDS = ['/today', '/week', '/create'];

function routeMessage(envelope, config, filesFolder, outbox) {
  const parsed = parseCommand(envelope.content || '');
  if (!parsed) return 'error: message must start with a /command';
  const { command } = parsed;
  if (GMAIL_COMMANDS.includes(command)) {
    if (!config.capabilities.includes('gmail')) return 'error: gmail capability not enabled';
    return handleGmail(parsed.command, parsed.args, parsed.body, envelope, filesFolder, outbox, config);
  }
  if (CALENDAR_COMMANDS.includes(command)) {
    if (!config.capabilities.includes('calendar')) return 'error: calendar capability not enabled';
    return handleCalendar(parsed.command, parsed.args);
  }
  return `error: unknown command "${command}"\navailable: ${GMAIL_COMMANDS.concat(CALENDAR_COMMANDS).join(', ')}`;
}

// --- GAS API Mocks ---

function createMockGmailApp({ threads = [], unreadCount = 0, onSendEmail, onReply } = {}) {
  return {
    search: () => threads,
    getInboxUnreadCount: () => unreadCount,
    getThreadById: (id) => {
      const t = threads.find(t => t._id === id);
      if (!t) throw new Error(`thread not found: ${id}`);
      return t;
    },
    sendEmail: (to, subject, body, opts) => {
      if (onSendEmail) onSendEmail({ to, subject, body, opts });
    }
  };
}

function createMockThread(id, messages) {
  return {
    _id: id,
    getId: () => id,
    getMessages: () => messages,
    getMessageCount: () => messages.length
  };
}

function createMockMessage({ from, subject, date, body, unread = false, attachments = [], onReply } = {}) {
  return {
    getFrom: () => from,
    getSubject: () => subject,
    getDate: () => new Date(date),
    getPlainBody: () => body,
    isUnread: () => unread,
    markRead: () => {},
    getAttachments: () => attachments,
    reply: (body, opts) => {
      if (onReply) onReply({ body, opts });
    }
  };
}

function createMockOutbox() {
  const files = [];
  const subfolders = {};
  return {
    createFile: (name, content, mimeType) => files.push({ name, content, mimeType }),
    getFiles: () => files,
    getFoldersByName: (name) => {
      const folder = subfolders[name];
      return { hasNext: () => !!folder, next: () => folder };
    },
    createFolder: (name) => {
      const folder = createMockBundleFolder();
      subfolders[name] = folder;
      return folder;
    },
    _subfolders: subfolders
  };
}

function createMockFilesFolder() {
  const created = [];
  const subfolders = {};
  return {
    getFoldersByName: (name) => {
      const folder = subfolders[name];
      return { hasNext: () => !!folder, next: () => folder };
    },
    createFolder: (name) => {
      const folder = createMockBundleFolder();
      subfolders[name] = folder;
      return folder;
    },
    getFilesByName: (name) => {
      const found = created.find(f => f.name === name);
      return {
        hasNext: () => !!found,
        next: () => ({
          getBlob: () => found.content,
          content: found.content,
          mimeType: found.mimeType
        })
      };
    },
    createFile: (nameOrBlob, content, mimeType) => {
      const entry = typeof nameOrBlob === 'string'
        ? { name: nameOrBlob, content, mimeType }
        : { name: nameOrBlob.name || 'blob', content: null, mimeType: null };
      created.push(entry);
      return entry;
    },
    _created: created,
    _subfolders: subfolders
  };
}

function createMockEvent({ id, title, start, end, location = '', description = '', recurring = false, guests = [] }) {
  return {
    getId: () => id,
    getTitle: () => title,
    getStartTime: () => new Date(start),
    getEndTime: () => new Date(end),
    getLocation: () => location,
    getDescription: () => description,
    isRecurringEvent: () => recurring,
    getGuestList: () => guests.map(email => ({ getEmail: () => email }))
  };
}

// Gmail handler (simplified for testing)
function handleGmail(command, args, body, envelope, filesFolder, outbox, config) {
  if (command === '/check') {
    return '0 unread\n';
  }
  if (command === '/search') {
    const query = args.join(' ');
    if (!query) return 'error: /search requires a query';
    return `no results for: ${query}`;
  }
  if (command === '/read') {
    const threadId = args[0];
    if (!threadId) return 'error: /read requires a thread ID';
    return `thread_id: ${threadId}\n\n--- test (2026-01-01T00:00:00.000Z) ---\nhello`;
  }
  if (command === '/send' || command === '/reply') {
    const attachments = [];
    const { remainingArgs, opts } = buildMailOpts(body, args, config, attachments);
    if (command === '/reply') {
      const replyThreadId = remainingArgs[0];
      if (!replyThreadId) return 'error: /reply requires a thread_id';
      const mode = opts.htmlBody ? ' (html)' : '';
      return `replied to thread ${replyThreadId}${mode}`;
    }
    if (remainingArgs.length < 2) return 'error: /send <to> <subject>';
    const mode = opts.htmlBody ? ' (html)' : '';
    return `sent to ${remainingArgs[0]}: ${remainingArgs.slice(1).join(' ')}${mode}`;
  }
  return `unknown: ${command}\navailable: /check, /search, /read, /send, /reply`;
}

function handleCalendar(command, args) {
  if (command === '/today') return 'no events today';
  if (command === '/week') return 'no events this week';
  if (command === '/create') {
    if (args.length < 2) return 'error: /create <title> <datetime>';
    return `created: ${args[0]} at mock-time`;
  }
  return `unknown: ${command}\navailable: /today, /week, /create`;
}

// ===== TESTS =====

// --- ulid() ---

(() => {
  const id = ulid();
  assertEqual(id.length, 26, 'ulid is 26 chars');
  assert(/^[0-9A-TV-Z]+$/.test(id), 'ulid uses Crockford base32 chars');

  const id2 = ulid();
  assert(id !== id2, 'ulid generates unique values');

  const earlier = ulid();
  const laterTs = earlier.substring(0, 10);
  const later = ulid();
  const laterTs2 = later.substring(0, 10);
  assert(laterTs2 >= laterTs, 'ulid timestamp portion is non-decreasing');
})();

// --- parseCommand() ---

(() => {
  const result = parseCommand('/check');
  assertEqual(result.command, '/check', 'parseCommand: simple command');
  assertEqual(result.args.length, 0, 'parseCommand: no args');
  assertEqual(result.body, '', 'parseCommand: no body');
})();

(() => {
  const result = parseCommand('/send alice@example.com Hello World\nThis is the body');
  assertEqual(result.command, '/send', 'parseCommand: command with args');
  assertEqual(result.args[0], 'alice@example.com', 'parseCommand: first arg');
  assertEqual(result.args.length, 3, 'parseCommand: arg count');
  assertEqual(result.body, 'This is the body', 'parseCommand: body extracted');
})();

(() => {
  const result = parseCommand('/reply thread123\nLine 1\nLine 2');
  assertEqual(result.command, '/reply', 'parseCommand: /reply command');
  assertEqual(result.args[0], 'thread123', 'parseCommand: thread_id arg');
  assertEqual(result.body, 'Line 1\nLine 2', 'parseCommand: multiline body');
})();

(() => {
  const result = parseCommand('not a command');
  assertEqual(result, null, 'parseCommand: non-command returns null');
})();

(() => {
  const result = parseCommand('  /check  ');
  assertEqual(result.command, '/check', 'parseCommand: trims whitespace');
})();

// --- formatEmailForAgent() ---

(() => {
  const msg = createMockMessage({
    from: 'alice@example.com',
    subject: 'Test Subject',
    date: '2026-01-15T10:30:00Z',
    body: 'Hello there'
  });
  const result = formatEmailForAgent(msg, 'thread_abc');
  assert(result.includes('New email'), 'formatEmail: starts with New email');
  assert(result.includes('thread_id: thread_abc'), 'formatEmail: includes thread_id');
  assert(result.includes('from: alice@example.com'), 'formatEmail: includes from');
  assert(result.includes('subject: Test Subject'), 'formatEmail: includes subject');
  assert(result.includes('date: 2026-01-15T10:30:00.000Z'), 'formatEmail: includes date');
  assert(result.includes('---\nHello there'), 'formatEmail: includes body after separator');
})();

(() => {
  const longBody = 'x'.repeat(5000);
  const msg = createMockMessage({
    from: 'bob@example.com',
    subject: 'Long',
    date: '2026-01-15T10:30:00Z',
    body: longBody
  });
  const result = formatEmailForAgent(msg, 'thread_long');
  assert(result.includes('[truncated]'), 'formatEmail: truncates body over 4000 chars');
  assert(!result.includes('x'.repeat(5000)), 'formatEmail: body is actually shorter');
})();

// --- writeEnvelope() ---

(() => {
  const outbox = createMockOutbox();
  const env = writeEnvelope(outbox, 'my-agent', 'hello content', null);
  assertEqual(env.to, 'my-agent', 'writeEnvelope: sets to');
  assertEqual(env.content, 'hello content', 'writeEnvelope: sets content');
  assertEqual(env.id.length, 26, 'writeEnvelope: id is ulid');
  assert(env.date.includes('T'), 'writeEnvelope: date is ISO');
  assert(!env.files, 'writeEnvelope: no files when null');
  assertEqual(outbox.getFiles().length, 1, 'writeEnvelope: creates file in outbox');
})();

(() => {
  const outbox = createMockOutbox();
  const filesFolder = createMockFilesFolder();
  filesFolder.createFile('doc.pdf', 'pdf bytes', 'application/pdf');
  const env = writeEnvelope(outbox, 'my-agent', 'with attachment', [{ filename: 'doc.pdf' }], filesFolder);
  assertEqual(env.files.length, 1, 'writeEnvelope: includes files');
  assertEqual(env.files[0].filename, 'doc.pdf', 'writeEnvelope: file reference correct');
  assert(!('path' in env.files[0]), 'writeEnvelope: filename-only entries (no path field)');
  assert(outbox._subfolders[env.id], 'writeEnvelope: stages bundle subfolder in outbox');
})();

(() => {
  const outbox = createMockOutbox();
  writeEnvelope(outbox, 'my-agent', 'test', []);
  assert(!outbox.getFiles()[0].content.includes('"files"'), 'writeEnvelope: empty files array omitted');
})();

// --- routeMessage() ---

(() => {
  const config = { capabilities: ['gmail', 'calendar'], participant: 'test-agent' };
  const outbox = createMockOutbox();
  const filesFolder = createMockFilesFolder();

  const result = routeMessage(
    { to: 'test-agent', content: '/unknown-cmd' },
    config, filesFolder, outbox
  );
  assert(result.includes('error: unknown command'), 'route: unknown command returns error');
  assert(result.includes('/check'), 'route: error lists available commands');
})();

(() => {
  const config = { capabilities: ['gmail'], participant: 'test-agent' };
  const outbox = createMockOutbox();
  const filesFolder = createMockFilesFolder();

  const result = routeMessage(
    { to: 'my-email', content: '/check' },
    config, filesFolder, outbox
  );
  assert(result.includes('unread'), 'route: /check routes to gmail handler');
})();

(() => {
  const config = { capabilities: ['gmail'], participant: 'test-agent' };
  const outbox = createMockOutbox();
  const filesFolder = createMockFilesFolder();

  const result = routeMessage(
    { to: 'my-email', content: '/reply' },
    config, filesFolder, outbox
  );
  assertEqual(result, 'error: /reply requires a thread_id', 'route: /reply without thread_id returns error');
})();

(() => {
  const config = { capabilities: ['gmail'], participant: 'test-agent' };
  const outbox = createMockOutbox();
  const filesFolder = createMockFilesFolder();

  const result = routeMessage(
    { to: 'my-email', content: '/send alice@example.com' },
    config, filesFolder, outbox
  );
  assertEqual(result, 'error: /send <to> <subject>', 'route: /send without enough args returns error');
})();

(() => {
  const config = { capabilities: ['gmail'], participant: 'test-agent' };
  const outbox = createMockOutbox();
  const filesFolder = createMockFilesFolder();

  const result = routeMessage(
    { to: 'my-email', content: 'plain text no command' },
    config, filesFolder, outbox
  );
  assertEqual(result, 'error: message must start with a /command', 'route: non-command content returns error');
})();

(() => {
  const config = { capabilities: ['calendar'], participant: 'test-agent' };
  const outbox = createMockOutbox();
  const filesFolder = createMockFilesFolder();

  const result = routeMessage(
    { to: 'my-cal', content: '/today' },
    config, filesFolder, outbox
  );
  assertEqual(result, 'no events today', 'route: /today routes to calendar handler');
})();

(() => {
  const config = { capabilities: [], participant: 'test-agent' };
  const outbox = createMockOutbox();
  const filesFolder = createMockFilesFolder();

  const result = routeMessage(
    { to: 'test-agent', content: '/check' },
    config, filesFolder, outbox
  );
  assert(result.includes('gmail capability not enabled'), 'route: disabled capability returns error');
})();

// --- pad() ---

(() => {
  assertEqual(pad(0), '00', 'pad: zero');
  assertEqual(pad(5), '05', 'pad: single digit');
  assertEqual(pad(10), '10', 'pad: double digit unchanged');
  assertEqual(pad(23), '23', 'pad: larger double digit');
})();

// --- extractDriveLinks() ---

(() => {
  const ids = extractDriveLinks('Check this doc: https://docs.google.com/document/d/1abc_DEF-123/edit');
  assertDeepEqual(ids, ['1abc_DEF-123'], 'extractDriveLinks: Google Doc URL');
})();

(() => {
  const ids = extractDriveLinks('https://drive.google.com/file/d/0BxHZ7abc123/view?usp=sharing');
  assertDeepEqual(ids, ['0BxHZ7abc123'], 'extractDriveLinks: Drive file URL');
})();

(() => {
  const ids = extractDriveLinks('https://docs.google.com/spreadsheets/d/sp123ABC/edit#gid=0');
  assertDeepEqual(ids, ['sp123ABC'], 'extractDriveLinks: Sheets URL');
})();

(() => {
  const ids = extractDriveLinks('https://docs.google.com/presentation/d/pres_XYZ/edit');
  assertDeepEqual(ids, ['pres_XYZ'], 'extractDriveLinks: Slides URL');
})();

(() => {
  const text = 'Doc: https://docs.google.com/document/d/abc123/edit\nSheet: https://docs.google.com/spreadsheets/d/def456/edit';
  const ids = extractDriveLinks(text);
  assertDeepEqual(ids, ['abc123', 'def456'], 'extractDriveLinks: multiple URLs');
})();

(() => {
  const text = 'https://docs.google.com/document/d/same_id/edit and https://docs.google.com/document/d/same_id/preview';
  const ids = extractDriveLinks(text);
  assertDeepEqual(ids, ['same_id'], 'extractDriveLinks: deduplicates same ID');
})();

(() => {
  const ids = extractDriveLinks('no links here, just text');
  assertDeepEqual(ids, [], 'extractDriveLinks: no links returns empty');
})();

(() => {
  const ids = extractDriveLinks(null);
  assertDeepEqual(ids, [], 'extractDriveLinks: null returns empty');
})();

(() => {
  const ids = extractDriveLinks('');
  assertDeepEqual(ids, [], 'extractDriveLinks: empty string returns empty');
})();

(() => {
  const ids = extractDriveLinks('https://www.google.com/search?q=test');
  assertDeepEqual(ids, [], 'extractDriveLinks: non-Drive Google URL ignored');
})();

// --- formatEventForAgent() ---

(() => {
  const ev = createMockEvent({
    id: 'evt_123',
    title: 'Daily Standup',
    start: '2026-05-22T14:30:00.000Z',
    end: '2026-05-22T14:45:00.000Z',
    location: 'Zoom https://zoom.us/j/123',
    description: 'Stand up meeting notes',
    recurring: true,
    guests: ['alice@example.com', 'bob@example.com']
  });
  const { content, files } = formatEventForAgent(ev, null);
  assert(content.startsWith('Calendar event starting soon'), 'formatEvent: starts with header');
  assert(content.includes('event_id: evt_123'), 'formatEvent: includes event_id');
  assert(content.includes('title: Daily Standup'), 'formatEvent: includes title');
  assert(content.includes('start: 2026-05-22T14:30:00.000Z'), 'formatEvent: includes start ISO');
  assert(content.includes('end: 2026-05-22T14:45:00.000Z'), 'formatEvent: includes end ISO');
  assert(content.includes('location: Zoom https://zoom.us/j/123'), 'formatEvent: includes location');
  assert(content.includes('recurring: yes'), 'formatEvent: includes recurring flag');
  assert(content.includes('attendees: alice@example.com, bob@example.com'), 'formatEvent: includes attendees');
  assert(content.includes('---\nStand up meeting notes'), 'formatEvent: includes description after separator');
  assertDeepEqual(files, [], 'formatEvent: no files when filesFolder is null');
})();

(() => {
  const ev = createMockEvent({
    id: 'evt_minimal',
    title: 'Quick Chat',
    start: '2026-05-22T09:00:00.000Z',
    end: '2026-05-22T09:30:00.000Z'
  });
  const { content } = formatEventForAgent(ev, null);
  assert(!content.includes('location:'), 'formatEvent: omits location when empty');
  assert(content.includes('recurring: no'), 'formatEvent: recurring no for non-recurring');
  assert(!content.includes('attendees:'), 'formatEvent: omits attendees when none');
  assert(content.endsWith('---'), 'formatEvent: ends with separator when no description');
})();

(() => {
  const ev = createMockEvent({
    id: 'recurring_abc',
    title: 'Morning Briefing',
    start: '2026-05-22T07:00:00.000Z',
    end: '2026-05-22T07:15:00.000Z',
    description: 'Check email, review calendar, prepare daily plan',
    recurring: true
  });
  const { content } = formatEventForAgent(ev, null);
  assert(content.includes('recurring: yes'), 'formatEvent: recurring event for scheduling');
  assert(content.includes('Check email, review calendar, prepare daily plan'), 'formatEvent: description carries the prompt');
})();

// --- formatEventForAgent with Drive links ---

(() => {
  const ev = createMockEvent({
    id: 'evt_drive',
    title: 'Review Meeting',
    start: '2026-05-22T10:00:00.000Z',
    end: '2026-05-22T11:00:00.000Z',
    description: 'Agenda: https://docs.google.com/document/d/doc_abc123/edit\nSlides: https://docs.google.com/presentation/d/pres_xyz/edit'
  });
  const filesFolder = createMockFilesFolder();
  const { content, files } = formatEventForAgent(ev, filesFolder);
  assertEqual(files.length, 2, 'formatEvent+drive: downloads 2 files');
  assertEqual(files[0].filename, 'file_doc_abc123.md', 'formatEvent+drive: first file named correctly');
  assertEqual(files[1].filename, 'file_pres_xyz.md', 'formatEvent+drive: second file named correctly');
  assert(content.includes('https://docs.google.com/document/d/doc_abc123/edit'), 'formatEvent+drive: content still has URLs');
})();

(() => {
  const ev = createMockEvent({
    id: 'evt_no_drive',
    title: 'Lunch',
    start: '2026-05-22T12:00:00.000Z',
    end: '2026-05-22T13:00:00.000Z',
    description: 'Meet at the cafeteria'
  });
  const filesFolder = createMockFilesFolder();
  const { files } = formatEventForAgent(ev, filesFolder);
  assertDeepEqual(files, [], 'formatEvent+drive: no drive links means no files');
})();

// --- Trigger interval config ---

(() => {
  const valid = [1, 5, 10, 15, 30];
  assert(valid.includes(1), 'triggerConfig: 1 is valid');
  assert(valid.includes(5), 'triggerConfig: 5 is valid');
  assert(valid.includes(10), 'triggerConfig: 10 is valid');
  assert(valid.includes(15), 'triggerConfig: 15 is valid');
  assert(valid.includes(30), 'triggerConfig: 30 is valid');
  assert(!valid.includes(2), 'triggerConfig: 2 is not valid');
  assert(!valid.includes(7), 'triggerConfig: 7 is not valid');
  assert(!valid.includes(60), 'triggerConfig: 60 is not valid');

  // Simulate getConfig logic
  const parseInterval = (raw) => {
    const n = parseInt(raw || '5', 10);
    return valid.includes(n) ? n : 5;
  };
  assertEqual(parseInterval('1'), 1, 'triggerConfig: parses 1');
  assertEqual(parseInterval('5'), 5, 'triggerConfig: parses 5');
  assertEqual(parseInterval('30'), 30, 'triggerConfig: parses 30');
  assertEqual(parseInterval(''), 5, 'triggerConfig: empty defaults to 5');
  assertEqual(parseInterval(null), 5, 'triggerConfig: null defaults to 5');
  assertEqual(parseInterval('3'), 5, 'triggerConfig: invalid falls back to 5');
  assertEqual(parseInterval('abc'), 5, 'triggerConfig: NaN falls back to 5');
})();

// --- detectMarkdown() ---

(() => {
  assert(!detectMarkdown(''), 'detectMarkdown: empty body');
  assert(!detectMarkdown('plain text only'), 'detectMarkdown: plain text');
  assert(detectMarkdown('Please review the **API changes**'), 'detectMarkdown: bold');
  assert(detectMarkdown('- item one\n- item two'), 'detectMarkdown: list');
  assert(detectMarkdown('# Heading'), 'detectMarkdown: heading');
  assert(detectMarkdown('[docs](https://example.com)'), 'detectMarkdown: link');
  assert(detectMarkdown('use `code` here'), 'detectMarkdown: inline code');
  assert(detectMarkdown('```\ncode block\n```'), 'detectMarkdown: fence');
})();

(() => {
  const body = 'New reply\n\n**Important**\n\nOn Jan 1, 2026, alice@example.com wrote:\n> old quote';
  assert(detectMarkdown(body), 'detectMarkdown: detects before quote block');
  const quotedOnly = 'Thanks!\n\nOn Jan 1, 2026, bob@example.com wrote:\n**quoted bold**';
  assert(!detectMarkdown(quotedOnly), 'detectMarkdown: ignores markers inside quote block');
})();

// --- parseMarkdownFlags() ---

(() => {
  const r = parseMarkdownFlags(['--markdown', 'a@b.com', 'Hi']);
  assertEqual(r.markdownMode, 'force', 'parseMarkdownFlags: --markdown');
  assertDeepEqual(r.remainingArgs, ['a@b.com', 'Hi'], 'parseMarkdownFlags: strips flag');
})();

(() => {
  const r = parseMarkdownFlags(['--no-markdown', 'thread1']);
  assertEqual(r.markdownMode, 'disable', 'parseMarkdownFlags: --no-markdown');
  assertDeepEqual(r.remainingArgs, ['thread1'], 'parseMarkdownFlags: strips no-markdown');
})();

// --- effectiveMarkdownMode() ---

(() => {
  const cfg = { markdownAuto: false };
  assertEqual(effectiveMarkdownMode(null, cfg), 'disable', 'effectiveMarkdownMode: opt-out via config');
  assertEqual(effectiveMarkdownMode('force', cfg), 'force', 'effectiveMarkdownMode: force wins');
  assertEqual(effectiveMarkdownMode('disable', { markdownAuto: true }), 'disable', 'effectiveMarkdownMode: disable wins');
  assertEqual(effectiveMarkdownMode(null, { markdownAuto: true }), 'auto', 'effectiveMarkdownMode: auto by default');
})();

// --- sanitizeHtml() ---

(() => {
  const clean = sanitizeHtml('<p>ok</p><script>alert(1)</script>');
  assert(clean.includes('<p>ok</p>'), 'sanitizeHtml: keeps safe tags');
  assert(!clean.includes('script'), 'sanitizeHtml: removes script');
})();

(() => {
  const clean = sanitizeHtml('<a href="https://example.com">link</a>');
  assert(clean.includes('href="https://example.com"'), 'sanitizeHtml: https link');
  const bad = sanitizeHtml('<a href="javascript:alert(1)">x</a>');
  assert(!bad.includes('<a'), 'sanitizeHtml: blocks javascript href');
  const img = sanitizeHtml('<img src="https://example.com/x.png">');
  assert(!img.includes('<img'), 'sanitizeHtml: strips img');
})();

// --- buildHtmlBody() ---

(() => {
  const cfg = { markdownAuto: false };
  assertEqual(buildHtmlBody('plain text', 'disable', cfg), null, 'buildHtmlBody: disabled');
  assertEqual(buildHtmlBody('plain text', 'auto', cfg), null, 'buildHtmlBody: auto off, plain text');
  const html = buildHtmlBody('**bold** text', 'force', cfg);
  assert(html && html.includes('<strong>'), 'buildHtmlBody: force converts bold');
})();

(() => {
  const cfg = { markdownAuto: true };
  const html = buildHtmlBody('- one\n- two', 'auto', cfg);
  assert(html && html.includes('<li>'), 'buildHtmlBody: auto converts list');
})();

// --- buildMailOpts() / route send+reply ---

(() => {
  const cfg = { capabilities: ['gmail'], markdownAuto: false };
  const outbox = createMockOutbox();
  const filesFolder = createMockFilesFolder();
  const result = routeMessage(
    { to: 'my-email', content: '/send --markdown alice@example.com Hello\n**bold**' },
    cfg, filesFolder, outbox
  );
  assert(result.includes('(html)'), 'route: /send --markdown adds html mode');
})();

(() => {
  const cfg = { capabilities: ['gmail'], markdownAuto: true };
  const outbox = createMockOutbox();
  const filesFolder = createMockFilesFolder();
  const result = routeMessage(
    { to: 'my-email', content: '/reply --no-markdown thread1\n**no html**' },
    cfg, filesFolder, outbox
  );
  assertEqual(result, 'replied to thread thread1', 'route: /reply --no-markdown stays plain');
})();

(() => {
  const cfg = { capabilities: ['gmail'], markdownAuto: true };
  const outbox = createMockOutbox();
  const filesFolder = createMockFilesFolder();
  const result = routeMessage(
    { to: 'my-email', content: '/send alice@example.com Hi\n**bold** item' },
    cfg, filesFolder, outbox
  );
  assert(result.includes('(html)'), 'route: auto-detect bold markdown');
})();

// --- transaction log formatters ---

(() => {
  assertEqual(toLogAction('/send'), 'a8s.send', 'toLogAction: /send');
  assertEqual(toLogAction('/reply'), 'a8s.reply', 'toLogAction: /reply');
})();

(() => {
  const parsed = parseCommand('/send alice@example.com Hello World\nbody');
  const params = formatCommandParams(parsed, { from: 'my-agent' });
  assert(params.includes('from=my-agent'), 'formatCommandParams: from');
  assert(params.includes('to=alice@example.com'), 'formatCommandParams: to');
  assert(params.includes('subject'), 'formatCommandParams: subject');
})();

(() => {
  const parsed = parseCommand('/send --markdown bob@example.com Hi\n**bold**');
  const params = formatCommandParams(parsed, { from: 'agent' });
  assert(params.includes('--markdown'), 'formatCommandParams: markdown flag');
  const notes = formatMarkdownLogNotes('**bold**', parsed.args, { markdownAuto: true }, true);
  assert(notes.includes('md=detected'), 'formatMarkdownLogNotes: detected');
  assert(notes.includes('html=yes'), 'formatMarkdownLogNotes: html sent');
  assert(notes.includes('mode=force'), 'formatMarkdownLogNotes: force mode');
})();

(() => {
  assertEqual(formatLogStatus('sent to a: b (html)'), 'ok', 'formatLogStatus: ok');
  assertEqual(formatLogStatus('error: missing thread_id'), 'error: missing thread_id', 'formatLogStatus: error');
})();

// --- Report ---

console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
