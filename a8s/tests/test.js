'use strict';

process.env.TZ = 'America/Los_Angeles';

const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

// --- Load the real Code.js under mocked GAS globals -------------------------
// The command handlers and push loop are tested against the production code,
// not hand-kept mirrors; only GAS services are stubbed.

global.marked = marked;
global.Logger = { log: () => {} };
global._testProperties = {};
global.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: key => Object.prototype.hasOwnProperty.call(global._testProperties, key)
      ? global._testProperties[key]
      : null,
    setProperty: (key, value) => { global._testProperties[key] = value; },
    deleteProperty: key => { delete global._testProperties[key]; },
    getProperties: () => Object.assign({}, global._testProperties)
  })
};
global.Utilities = {
  newBlob: s => ({ getBytes: () => Buffer.from(String(s), 'utf8') }),
  formatDate: d => d.toISOString().slice(0, 10)
};
global._testActiveEmail = '';
global._testEffectiveEmail = '';
global._testActiveThrows = false;
global.Session = {
  getActiveUser: () => {
    if (global._testActiveThrows) throw new Error('identity restricted');
    return { getEmail: () => global._testActiveEmail };
  },
  getEffectiveUser: () => ({ getEmail: () => global._testEffectiveEmail })
};
global.GmailApp = null; // set per test

// `const A8S = ...` inside eval stays in the eval scope; the trailing
// expression hands the object out as the eval's completion value.
const realA8S = eval(
  fs.readFileSync(path.join(__dirname, '..', 'Code.js'), 'utf8') + '\nA8S;'
)._testing;

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

function normalizeEmailAddress(fromHeader) {
  if (!fromHeader) return '';
  let s = String(fromHeader).trim();
  const angle = s.match(/<([^>]+)>/);
  if (angle) s = angle[1].trim();
  if (s.toLowerCase().indexOf('mailto:') === 0) s = s.slice(7).trim();
  return s.toLowerCase();
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

function resolveCalendarDestination(title, config) {
  const route = parseSubjectRoute(title || '');
  return route.agent || config.defaultAgent;
}

function outboundEmailSubject(fromAgent) {
  return '@' + (fromAgent || 'unknown');
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

// The production implementations, loaded above — no mirrors to drift.
const { describeAge, formatMessageTag } = realA8S;
const formatEmailForAgent = realA8S.formatEmailForAgent;
const splitOversizeMessage = realA8S.splitOversizeMessage;
const sanitizeEmailBody = realA8S.sanitizeEmailBody;
const stripQuotedReply = realA8S.stripQuotedReply;

function pushNewEmails(gmailApp, config, outbox, filesFolder) {
  global.GmailApp = gmailApp;
  return realA8S.pushNewEmails(config, outbox, filesFolder);
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
    // Drive's documented limits, so the overload choice is pinned by
    // behaviour rather than by counting arguments: createFile(name, content,
    // mimeType) throws above 10MB, createFile(name, content) allows 50MB.
    // https://developers.google.com/apps-script/reference/drive/folder
    createFile: (name, content, mimeType) => {
      const size = typeof content === 'string' ? content.length : 0;
      if (mimeType !== undefined && size > 10 * 1024 * 1024) {
        throw new Error('Argument too large: content');
      }
      if (size > 50 * 1024 * 1024) throw new Error('Argument too large: content');
      files.push({ name, content, mimeType });
    }
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

function createMockGmailApp({ threads = [], unreadCount = 0, aliases = [], onSendEmail, onReply } = {}) {
  return {
    search: () => threads,
    getAliases: () => aliases,
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

function createMockMessage({ from, subject, date, body, unread = false, attachments = [], onReply, onMarkRead } = {}) {
  let isUnread = unread;
  return {
    getFrom: () => from,
    getSubject: () => subject,
    getDate: () => new Date(date),
    getPlainBody: () => body,
    isUnread: () => isUnread,
    markRead: () => {
      isUnread = false;
      if (onMarkRead) onMarkRead();
    },
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

function createMockDriveRoot(name, id) {
  const folders = {};
  return {
    getName: () => name,
    getId: () => id,
    getFoldersByName: folderName => {
      const folder = folders[folderName];
      return { hasNext: () => !!folder, next: () => folder };
    },
    createFolder: folderName => {
      const folder = createMockOutbox();
      folder.getId = () => `${id}-${folderName}`;
      folder.getName = () => folderName;
      folders[folderName] = folder;
      return folder;
    },
    _folders: folders
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

// --- normalizeEmailAddress / parseSubjectRoute / resolveEmailPush ---

(() => {
  assertEqual(normalizeEmailAddress('human@example.com'), 'human@example.com', 'normalizeEmail: bare');
  assertEqual(normalizeEmailAddress('Alice <Human@Example.com>'), 'human@example.com', 'normalizeEmail: angle + case');
  assertEqual(normalizeEmailAddress('mailto:bob@example.com'), 'bob@example.com', 'normalizeEmail: mailto');
  assertEqual(normalizeEmailAddress(''), '', 'normalizeEmail: empty');
})();

(() => {
  const r = parseSubjectRoute('RE: @bob the thing');
  assertEqual(r.agent, 'bob', 'parseSubjectRoute: Re: @bob');
  assertEqual(r.subjectRest, 'the thing', 'parseSubjectRoute: rest after @bob');
})();

(() => {
  const r = parseSubjectRoute('Re: Fwd: @alice-laptop hello');
  assertEqual(r.agent, 'alice-laptop', 'parseSubjectRoute: strips Re/Fwd');
  assertEqual(r.subjectRest, 'hello', 'parseSubjectRoute: multiword rest');
})();

(() => {
  const r = parseSubjectRoute('plain subject');
  assertEqual(r.agent, null, 'parseSubjectRoute: no @');
  assertEqual(r.subjectRest, 'plain subject', 'parseSubjectRoute: keeps subject');
})();

(() => {
  const r = parseSubjectRoute('@bob');
  assertEqual(r.agent, 'bob', 'parseSubjectRoute: bare @agent');
  assertEqual(r.subjectRest, '', 'parseSubjectRoute: empty rest');
})();

(() => {
  const map = parseEmailMap('{"Human@Example.com":"neil-email"}');
  assertEqual(map['human@example.com'], 'neil-email', 'parseEmailMap: normalizes keys');
  assertDeepEqual(parseEmailMap('not-json'), {}, 'parseEmailMap: invalid JSON');
  assertDeepEqual(
    parseRoutes('owner-mail=Owner@Example.com; team=a@example.com,b@example.com,a@example.com'),
    { 'owner-mail': ['owner@example.com'], team: ['a@example.com', 'b@example.com'] },
    'parseRoutes: parses names, normalizes addresses, and deduplicates recipients'
  );
  assertDeepEqual(parseRoutes('bad name=x@example.com;empty=;also-bad=not-an-email'), {}, 'parseRoutes: drops invalid entries');
  assertDeepEqual(parseCommandAgents('neil-phone, neil-email', 'neil-email'), ['neil-phone', 'neil-email'], 'parseCommandAgents: list');
  assertDeepEqual(parseCommandAgents(null, 'neil-email'), ['neil-email'], 'parseCommandAgents: unset falls back to device');
  assertDeepEqual(parseCommandAgents('', 'neil-email'), [], 'parseCommandAgents: explicit empty removes command surface');
})();

(() => {
  const config = {
    device: 'my-google',
    defaultAgent: 'bob',
    emailMap: { 'human@example.com': 'neil-email' }
  };
  const hit = resolveEmailPush('Alice <human@example.com>', 'RE: @carol hi', config);
  assert(hit.ok, 'resolveEmailPush: mapped ok');
  assertEqual(hit.to, 'carol', 'resolveEmailPush: @ override');
  assertEqual(hit.fromAgent, 'neil-email', 'resolveEmailPush: fromAgent from map');
  assertEqual(hit.subjectRest, 'hi', 'resolveEmailPush: subject rest');

  const sticky = resolveEmailPush('human@example.com', 'hello', config);
  assertEqual(sticky.to, 'bob', 'resolveEmailPush: sticky default');
  assertEqual(sticky.fromAgent, 'neil-email', 'resolveEmailPush: sticky fromAgent');

  const miss = resolveEmailPush('other@example.com', '@bob x', config);
  assert(!miss.ok, 'resolveEmailPush: unmapped');
  assertEqual(miss.reason, 'unmapped', 'resolveEmailPush: unmapped reason');
})();

(() => {
  const config = {
    device: 'my-google',
    emailMap: { 'human@example.com': 'neil-email', 'alt@example.com': 'other-email' }
  };
  assertEqual(addressForEmailAgent('neil-email', config), 'human@example.com', 'addressForEmailAgent: match');
  assertEqual(addressForEmailAgent('missing', config), '', 'addressForEmailAgent: miss');
  assert(isEmailPrincipal('neil-email', config), 'isEmailPrincipal: yes');
  assert(!isEmailPrincipal('my-google', config), 'isEmailPrincipal: device is not email principal');
  assertEqual(outboundEmailSubject('bob'), '@bob', 'outboundEmailSubject: @from');
  assertEqual(resolveCalendarDestination('@alice standup', { defaultAgent: 'bob' }), 'alice', 'calendar dest: @');
  assertEqual(resolveCalendarDestination('standup', { defaultAgent: 'bob' }), 'bob', 'calendar dest: sticky');
})();

(() => {
  const config = {
    device: 'my-google',
    emailMap: { 'human@example.com': 'neil-email' },
    routes: { team: ['a@example.com', 'b@example.com'] }
  };
  assertEqual(decideInboxRoute({ to: 'neil-email' }, config), 'email', 'decideInboxRoute: email principal');
  assertEqual(decideInboxRoute({ to: 'my-google' }, config), 'device', 'decideInboxRoute: device');
  assertEqual(decideInboxRoute({ to: 'team' }, config), 'route', 'decideInboxRoute: named route');
  assertEqual(decideInboxRoute({ to: '' }, config), 'device', 'decideInboxRoute: empty to = device');
  assertEqual(decideInboxRoute({ to: 'unknown-agent' }, config), 'drop', 'decideInboxRoute: unknown');
})();

(() => {
  assert(isCommandAgent('neil-phone', { commandAgents: ['neil-phone', 'my-google'] }), 'isCommandAgent: allowed');
  assert(!isCommandAgent('intruder', { commandAgents: ['neil-phone'] }), 'isCommandAgent: denied');
})();

// --- formatEmailForAgent() ---

(() => {
  const now = new Date('2026-01-15T12:00:00Z');
  const msg = createMockMessage({
    from: 'alice@example.com',
    subject: 'Test Subject',
    date: '2026-01-15T10:30:00Z',
    body: 'Hello there'
  });
  const result = formatEmailForAgent(msg, 'the thing', {}, now);
  assertEqual(
    result,
    'Date: 2026-01-15T10:30:00.000Z (today)\n\nthe thing\n\nHello there',
    'formatEmail: header + subject rest + body, no From line'
  );
})();

(() => {
  const now = new Date('2026-01-18T10:30:00Z');
  const msg = createMockMessage({
    from: 'alice@example.com',
    subject: 'Test',
    date: '2026-01-15T10:30:00Z',
    body: 'Hello there'
  });
  assertEqual(
    formatEmailForAgent(msg, '', {}, now),
    'Date: 2026-01-15T10:30:00.000Z (3 days ago)\n\nHello there',
    'formatEmail: header + body only when no rest, no From line'
  );
})();

// --- describeAge() / formatMessageTag() ---
// Dates without Z are local wall times; TZ is pinned to America/Los_Angeles.

(() => {
  const now = new Date('2026-08-21T14:00:00');
  assertEqual(describeAge(new Date('2026-08-21T04:00:00'), now), 'today', 'describeAge: same calendar day');
  assertEqual(describeAge(new Date('2026-08-20T10:00:00'), now), 'yesterday', 'describeAge: yesterday');
  assertEqual(describeAge(new Date('2026-08-19T12:19:52'), now), '2 days ago', 'describeAge: two days');
  assertEqual(describeAge(new Date('2026-07-31T14:00:00'), now), '21 days ago', 'describeAge: weeks old');
})();

(() => {
  assertEqual(
    describeAge(new Date('2026-08-20T23:55:00'), new Date('2026-08-21T00:05:00')),
    'yesterday',
    'describeAge: ten minutes across midnight is yesterday, not today'
  );
  assertEqual(
    describeAge(new Date('2026-03-08T01:59:00'), new Date('2026-03-09T01:30:00')),
    'yesterday',
    'describeAge: spring-forward 23h day still counts one calendar day'
  );
  assertEqual(
    describeAge(new Date('2026-08-22T09:00:00'), new Date('2026-08-21T10:00:00')),
    'tomorrow',
    'describeAge: future-dated mail is named, not clamped to today'
  );
  assertEqual(
    describeAge(new Date('2026-08-25T10:00:00'), new Date('2026-08-21T10:00:00')),
    '4 days from now',
    'describeAge: far-future skew is named'
  );
})();

(() => {
  const now = new Date('2026-08-21T14:00:00Z');
  const selves = { 'agent@example.com': true, 'alias@example.com': true };
  assertEqual(
    formatMessageTag('Agent <Agent@Example.com>', new Date('2026-08-19T12:00:00Z'), selves, now),
    '[your own sent mail, 2 days ago]',
    'formatMessageTag: own address is marked, case/angle-insensitive'
  );
  assertEqual(
    formatMessageTag('Alias <alias@example.com>', new Date('2026-08-19T12:00:00Z'), selves, now),
    '[your own sent mail, 2 days ago]',
    'formatMessageTag: send-as alias is marked'
  );
  assertEqual(
    formatMessageTag('other@example.com', new Date('2026-08-20T12:00:00Z'), selves, now),
    '[yesterday]',
    'formatMessageTag: other sender gets age only'
  );
  assertEqual(
    formatMessageTag('agent@example.com', new Date('2026-08-21T12:00:00Z'), {}, now),
    '[today]',
    'formatMessageTag: unknown self never marks'
  );
})();

// --- selfEmailAddresses(): installable-trigger identity, aliases, guards ---

(() => {
  global._testActiveEmail = '';
  global._testEffectiveEmail = 'Agent <Agent@Example.com>';
  global.GmailApp = createMockGmailApp({ aliases: ['Alias@Example.com'] });
  let selves = realA8S.selfEmailAddresses();
  assert(selves['agent@example.com'], 'selfEmailAddresses: blank active user still yields effective user');
  assert(selves['alias@example.com'], 'selfEmailAddresses: send-as aliases are self');

  global._testActiveEmail = 'active@example.com';
  selves = realA8S.selfEmailAddresses();
  assert(selves['active@example.com'] && selves['agent@example.com'], 'selfEmailAddresses: active and effective both collected');

  global._testActiveThrows = true;
  selves = realA8S.selfEmailAddresses();
  assert(selves['agent@example.com'], 'selfEmailAddresses: a throwing active lookup does not suppress the effective user');
  assert(selves['alias@example.com'], 'selfEmailAddresses: a throwing active lookup does not suppress aliases');
  global._testActiveThrows = false;

  global.GmailApp = null;
  selves = realA8S.selfEmailAddresses();
  assert(selves['agent@example.com'], 'selfEmailAddresses: unavailable GmailApp does not suppress Session identities');

  global._testActiveEmail = '';
  global._testEffectiveEmail = '';
})();

// --- real /check, /search, /read: mapped-only switchboard visibility ---

(() => {
  global._testActiveEmail = '';
  global._testEffectiveEmail = 'agent@example.com';
  const now = new Date();
  const twoDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2, 12, 0, 0);
  const mappedOld = createMockMessage({
    from: 'human@example.com', subject: 'Mapped conversation', date: twoDaysAgo, body: 'hello', unread: false
  });
  const own = createMockMessage({
    from: 'agent@example.com', subject: 'Old note', date: twoDaysAgo, body: 'mine', unread: true
  });
  const other = createMockMessage({
    from: 'human@example.com', subject: 'Hi', date: now, body: 'yo', unread: true
  });
  const mappedAlt = createMockMessage({
    from: 'alt@example.com', subject: 'Alias conversation', date: twoDaysAgo, body: 'hello', unread: false
  });
  const alias = createMockMessage({
    from: 'robot@example.com', subject: 'Alias note', date: twoDaysAgo, body: 'also mine', unread: true
  });
  const unmapped = createMockMessage({
    from: 'news@example.org', subject: 'Private promo', date: now, body: 'not for the agent', unread: true
  });
  const mixedMapped = createMockMessage({
    from: 'human@example.com', subject: 'Mixed thread', date: twoDaysAgo, body: 'mapped part', unread: false
  });
  const mixedUnmapped = createMockMessage({
    from: 'outsider@example.org', subject: 'Mixed private part', date: now, body: 'secret', unread: false
  });
  global.GmailApp = createMockGmailApp({
    threads: [
      createMockThread('t1', [mappedOld, own]),
      createMockThread('t2', [other]),
      createMockThread('t3', [mappedAlt, alias]),
      createMockThread('t4', [unmapped]),
      createMockThread('t5', [mixedMapped, mixedUnmapped])
    ],
    aliases: ['robot@example.com']
  });
  const config = {
    capabilities: ['gmail'],
    markdownAuto: false,
    emailMap: { 'human@example.com': 'human-mail', 'alt@example.com': 'alt-mail' }
  };
  const outbox = createMockOutbox();
  const filesFolder = createMockFilesFolder();

  const check = realA8S.handleGmail('/check', [], '', {}, filesFolder, outbox, config, {});
  assert(check.startsWith('1 unread\n'), 'real /check: counts only mapped unread threads');
  assert(check.includes('| [today]'), 'real /check: other sender tagged with age only');
  assert(!check.includes('Private promo'), 'real /check: unmapped subject is invisible');

  const read = realA8S.handleGmail('/read', ['t1'], '', {}, filesFolder, outbox, config, {});
  assert(read.includes('[your own sent mail, 2 days ago] ---'), 'real /read: message header marks own mail');

  const aliasRead = realA8S.handleGmail('/read', ['t3'], '', {}, filesFolder, outbox, config, {});
  assert(aliasRead.includes('[your own sent mail, 2 days ago] ---'), 'real /read: send-as alias marked as own mail');

  const search = realA8S.handleGmail('/search', ['note'], '', {}, filesFolder, outbox, config, {});
  assert(search.includes('[your own sent mail, 2 days ago]'), 'real /search: own sent mail tagged');
  assert(!search.includes('Private promo'), 'real /search: unmapped-only thread is invisible');
  assert(!search.includes('Mixed private part'), 'real /search: mixed external-sender thread is invisible');

  const unmappedRead = realA8S.handleGmail('/read', ['t4'], '', {}, filesFolder, outbox, config, {});
  assertEqual(unmappedRead, 'refused: thread is outside the mapped switchboard', 'real /read: unmapped thread refused');
  const mixedRead = realA8S.handleGmail('/read', ['t5'], '', {}, filesFolder, outbox, config, {});
  assertEqual(mixedRead, 'refused: thread is outside the mapped switchboard', 'real /read: mixed external-sender thread refused');

  global._testEffectiveEmail = '';
  global.GmailApp = null;
})();

// --- pushNewEmails(): unmapped unread stays unread by default ---

(() => {
  const unmapped = createMockMessage({
    from: 'news@example.org', subject: 'promo', date: new Date(), body: 'buy things', unread: true
  });
  const gmailApp = createMockGmailApp({ threads: [createMockThread('t1', [unmapped])] });
  const config = {
    capabilities: ['gmail'],
    defaultAgent: 'bob',
    emailMap: { 'human@example.com': 'neil-email' },
    resolveUnmapped: false
  };
  const count = pushNewEmails(gmailApp, config, createMockOutbox(), createMockFilesFolder());
  assertEqual(count, 0, 'pushNewEmails: unmapped not pushed');
  assert(unmapped.isUnread(), 'pushNewEmails: unmapped stays unread when resolveUnmapped is off');
})();

// --- pushNewEmails(): opt-in resolveUnmapped marks read, mapped is pushed ---

(() => {
  const config = {
    capabilities: ['gmail'],
    defaultAgent: 'bob',
    emailMap: { 'human@example.com': 'neil-email' },
    resolveUnmapped: true
  };
  let unmappedRead = false;
  const mapped = createMockMessage({
    from: 'human@example.com',
    subject: 'status',
    date: '2026-08-21T10:00:00Z',
    body: 'hi',
    unread: true
  });
  const unmapped = createMockMessage({
    from: 'notifications@example.org',
    subject: 'promo',
    date: '2026-08-10T10:00:00Z',
    body: 'buy things',
    unread: true,
    onMarkRead: () => { unmappedRead = true; }
  });
  const gmailApp = createMockGmailApp({
    threads: [createMockThread('t1', [mapped]), createMockThread('t2', [unmapped])]
  });
  const outbox = createMockOutbox();
  const count = pushNewEmails(gmailApp, config, outbox, createMockFilesFolder());
  assertEqual(count, 1, 'pushNewEmails: only mapped mail is pushed');
  assert(unmappedRead, 'pushNewEmails: unmapped mail is marked read');
  assert(!unmapped.isUnread(), 'pushNewEmails: unmapped no longer unread');
  assert(!mapped.isUnread(), 'pushNewEmails: mapped marked read after route');
  assertEqual(outbox.getFiles().length, 1, 'pushNewEmails: one envelope written');
  assert(!outbox.getFiles()[0].content.includes('From:'), 'pushNewEmails: envelope content has no From header (opaque push)');
  assert(outbox.getFiles()[0].content.includes('Date: 2026-08-21T10:00:00.000Z'), 'pushNewEmails: envelope content carries date header');
})();

// --- an ordinary email is not truncated ---------------------------------
// 4000 characters is about 600 words. A cap there cut normal mail in half.

(() => {
  const longBody = 'x'.repeat(5000);
  const msg = createMockMessage({
    from: 'bob@example.com',
    subject: 'Long',
    date: '2026-01-15T10:30:00Z',
    body: longBody
  });
  const result = formatEmailForAgent(msg, '', {});
  assert(result.includes(longBody), 'formatEmail: a 5000-char body arrives whole');
  assert(!result.includes('truncated'), 'formatEmail: and is not marked truncated');
})();

// --- splitOversizeMessage(): nothing is discarded, only moved -------------

(() => {
  const body = 'y'.repeat(60000);
  const split = splitOversizeMessage(body, []);
  assert(split.overflow !== null, 'split: a 60k body overflows');
  assertEqual(split.overflow.filename, 'message.md', 'split: names the file message.md');
  assertEqual(split.overflow.text, body, 'split: the file holds the WHOLE message, not the tail');
  assert(split.content.includes('truncated'), 'split: the body says it was truncated');
  assert(split.content.includes('message.md'), 'split: and names the file to open');
  assert(split.content.startsWith('y'.repeat(50000)), 'split: keeps the first 50k');
  assert(split.content.indexOf('10000 more characters') !== -1,
         'split: says how much moved');
})();

(() => {
  const body = 'z'.repeat(50000);
  const split = splitOversizeMessage(body, []);
  assertEqual(split.overflow, null, 'split: exactly at the cap does not overflow');
  assertEqual(split.content, body, 'split: and is passed through untouched');
})();

(() => {
  // A real attachment already called message.md must not be shadowed.
  const split = splitOversizeMessage('w'.repeat(60000), ['message.md']);
  assertEqual(split.overflow.filename, 'message-2.md',
              'split: steps aside when the name is taken');
  assert(split.content.includes('message-2.md'), 'split: the note names the file it used');
})();

// --- a message too big for the 3-argument createFile still arrives ---------

(() => {
  const config = {
    defaultAgent: 'agent',
    capabilities: ['gmail'],
    emailMap: { 'bob@example.com': 'bob-mail' },
    routes: {},
    commandAgents: []
  };
  const huge = 'h'.repeat(11 * 1024 * 1024);
  const msg = createMockMessage({
    from: 'bob@example.com',
    subject: 'Everything',
    date: '2026-08-27T10:00:00Z',
    body: huge,
    unread: true
  });
  const gmailApp = createMockGmailApp({ threads: [createMockThread('t1', [msg])] });
  const outbox = createMockOutbox();
  const count = pushNewEmails(gmailApp, config, outbox, createMockFilesFolder());
  assertEqual(count, 1, 'huge body: the envelope is still written');
  assert(!msg.isUnread(), 'huge body: and the mail is marked read, so it does not repeat');
  const envelope = JSON.parse(outbox.getFiles()[0].content);
  const stored = outbox._subfolders[envelope.id].getFilesByName('message.md');
  assert(stored.hasNext(), 'huge body: the whole message reached the bundle');
  assert(stored.next().getBlob().includes(huge),
         'huge body: intact, not clipped to the 10MB overload limit');
})();

// --- sanitize runs BEFORE the size split, at both old and new boundaries --
// The order is the fix, not an implementation detail. stripQuotedReply matches
// "On <date> <person> wrote:" as one marker; a cut landing inside it leaves the
// marker unmatched and the quoted chain leaks into the agent's message. These
// put the marker exactly where each cap would land.

(() => {
  const config = { emailMap: { 'neil@example.com': 'neil-email' }, device: 'my-google' };
  const marker = '\n\nOn Wed, Aug 26, 2026, at 6:24 PM, agent@example.com\nwrote:\n\n';
  const quoted = '> prior thread content the agent must never see';

  // Straddling the OLD 4000-char cap.
  const msgOld = createMockMessage({
    from: 'neil@example.com',
    subject: 'Re: plan',
    date: '2026-08-27T10:00:00Z',
    body: 'a'.repeat(3980) + marker + quoted
  });
  const oldCut = formatEmailForAgent(msgOld, '', config);
  assert(!oldCut.includes('prior thread content'),
         'ordering: quoted chain stripped when the marker straddles 4000');
  assert(!/On Wed, Aug 26/.test(oldCut),
         'ordering: and no marker fragment survives at 4000');

  // Straddling the NEW 50000-char cap. The marker must sit across the point a
  // raw cut would land, or the cut falls harmlessly inside the quote below it
  // and the wrong order looks correct.
  const msgNew = createMockMessage({
    from: 'neil@example.com',
    subject: 'Re: plan',
    date: '2026-08-27T10:00:00Z',
    body: 'b'.repeat(49980) + marker + quoted
  });
  const split = splitOversizeMessage(formatEmailForAgent(msgNew, '', config), []);
  assert(!split.content.includes('prior thread content'),
         'ordering: quoted chain stripped when the marker straddles 50000');
  assert(!/On Wed, Aug 26/.test(split.content),
         'ordering: and no marker fragment survives at 50000');
  assert(!split.overflow || !/On Wed, Aug 26/.test(split.overflow.text),
         'ordering: nor into the overflow file, which carries the whole message');
})();

// --- the push writes the overflow into the bundle, not into .files --------

(() => {
  const config = {
    defaultAgent: 'agent',
    capabilities: ['gmail'],
    emailMap: { 'bob@example.com': 'bob-mail' },
    routes: {},
    commandAgents: []
  };
  const msg = createMockMessage({
    from: 'bob@example.com',
    subject: 'War and Peace',
    date: '2026-08-27T10:00:00Z',
    body: 'q'.repeat(70000),
    unread: true
  });
  const gmailApp = createMockGmailApp({ threads: [createMockThread('t1', [msg])] });
  const outbox = createMockOutbox();
  const filesFolder = createMockFilesFolder();
  const count = pushNewEmails(gmailApp, config, outbox, filesFolder);
  assertEqual(count, 1, 'push oversize: one envelope written');
  const envelope = JSON.parse(outbox.getFiles()[0].content);
  assertEqual(envelope.files.length, 1, 'push oversize: envelope lists one file');
  assertEqual(envelope.files[0].filename, 'message.md', 'push oversize: named message.md');
  assert(!('text' in envelope.files[0]),
         'push oversize: the inline text does not leak into the envelope JSON');
  const bundle = outbox._subfolders[envelope.id];
  assert(bundle, 'push oversize: a bundle folder was created');
  const stored = bundle.getFilesByName('message.md');
  assert(stored.hasNext(), 'push oversize: the whole message is in the bundle');
  const storedText = stored.next().getBlob();
  assert(storedText.includes('q'.repeat(70000)),
         'push oversize: the file holds the whole body, not the tail');
  assert(storedText.startsWith('Date: '),
         'push oversize: and the message as the agent would read it, header and all');
  assert(!filesFolder.getFilesByName('message.md').hasNext(),
         'push oversize: nothing was staged in the shared .files folder');
  assert(envelope.content.includes('message.md'),
         'push oversize: the body points at the file');
})();

// --- sanitizeEmailBody() / stripQuotedReply(): opaque push, no transport leakage ---

(() => {
  const config = { emailMap: { 'neil@example.com': 'neil-email' }, device: 'my-google' };
  const body = 'Just fine thanks\n\n-N\n\nOn Mon, Aug 24, 2026, at 6:24 PM, agent@example.com\nwrote:\n\n> Hey, how is it going?';
  const result = sanitizeEmailBody(body, config);
  assertEqual(
    result,
    'Just fine thanks\n\n-N',
    'sanitizeEmailBody: everything from the "On ... wrote:" marker on is stripped'
  );
})();

(() => {
  const body = 'New content here.\n\n-----Original Message-----\nFrom: someone@example.com\nSubject: Re: hi\n\n> quoted text';
  const result = sanitizeEmailBody(body, {});
  assertEqual(
    result,
    'New content here.',
    'sanitizeEmailBody: "-----Original Message-----" marker cuts the reply chain'
  );
})();

(() => {
  const config = { emailMap: { 'neil@example.com': 'neil-email' }, device: 'my-google' };
  const body = 'neil@example.com mailto:neil@example.com';
  const result = sanitizeEmailBody(body, config);
  assertEqual(result, 'neil-email', 'sanitizeEmailBody: mailto token removed, mapped address replaced');
})();

(() => {
  global._testActiveEmail = '';
  global._testEffectiveEmail = 'agent@example.com';
  const config = { device: 'my-google' };
  const body = 'Please loop in agent@example.com on this.';
  const result = sanitizeEmailBody(body, config);
  assertEqual(
    result,
    'Please loop in my-google on this.',
    'sanitizeEmailBody: a self address is replaced with the device name'
  );
  global._testEffectiveEmail = '';
})();

(() => {
  const body = 'Some intro.\n> quoted line one\n> quoted line two\nMore text.';
  const result = sanitizeEmailBody(body, {});
  assertEqual(
    result,
    'Some intro.\nMore text.',
    'sanitizeEmailBody: bare ">" quoted lines dropped even without a marker'
  );
})();

(() => {
  const body = 'Paragraph one.\n\n\n\nParagraph two.';
  const result = sanitizeEmailBody(body, {});
  assertEqual(
    result,
    'Paragraph one.\n\nParagraph two.',
    'sanitizeEmailBody: 3+ newlines collapse to a single blank line'
  );
})();

// --- pushUnmappedDigest(): opt-in, informational, daily, non-destructive ---

(() => {
  const now = new Date('2026-08-24T18:00:00Z');
  const previous = '2026-08-22T18:00:00.000Z';
  global._testProperties = { _a8s_unmapped_digest_at: previous };
  global._testEffectiveEmail = 'agent@example.com';
  const unmapped = createMockMessage({
    from: 'News <news@example.org>', subject: 'Daily brief', date: '2026-08-23T18:30:00Z', body: 'info', unread: true
  });
  const mapped = createMockMessage({
    from: 'human@example.com', subject: 'Mapped note', date: '2026-08-23T19:00:00Z', body: 'work', unread: true
  });
  const own = createMockMessage({
    from: 'agent@example.com', subject: 'Sent copy', date: '2026-08-23T20:00:00Z', body: 'mine'
  });
  global.GmailApp = createMockGmailApp({
    threads: [createMockThread('d1', [unmapped]), createMockThread('d2', [mapped]), createMockThread('d3', [own])]
  });
  const config = {
    unmappedDigest: true,
    defaultAgent: 'agent',
    capabilities: ['gmail'],
    emailMap: { 'human@example.com': 'human-mail' }
  };
  const outbox = createMockOutbox();
  assertEqual(realA8S.pushUnmappedDigest(config, outbox, now), 1, 'digest: pushes one summary');
  assertEqual(outbox.getFiles().length, 1, 'digest: exactly one envelope written');
  const digest = JSON.parse(outbox.getFiles()[0].content);
  assertEqual(digest.to, 'agent', 'digest: sent to default agent');
  assert(digest.content.includes('Informational only'), 'digest: explicitly informational');
  assert(digest.content.includes('news@example.org') && digest.content.includes('Daily brief'), 'digest: summarizes unmapped sender and subject');
  assert(!digest.content.includes('Mapped note') && !digest.content.includes('Sent copy'), 'digest: excludes mapped and own mail');
  assert(unmapped.isUnread(), 'digest: leaves unmapped mail unread');
  assertEqual(global._testProperties._a8s_unmapped_digest_at, now.toISOString(), 'digest: checkpoints after successful write');

  assertEqual(
    realA8S.pushUnmappedDigest(config, outbox, new Date('2026-08-24T19:00:00Z')),
    0,
    'digest: does not re-serve inside the daily interval'
  );
  assertEqual(outbox.getFiles().length, 1, 'digest: second check writes no envelope');

  global._testEffectiveEmail = '';
  global.GmailApp = null;
  global._testProperties = {};
})();

(() => {
  const previous = '2026-08-20T00:00:00.000Z';
  global._testProperties = { _a8s_unmapped_digest_at: previous };
  global.GmailApp = createMockGmailApp({
    threads: [createMockThread('d1', [createMockMessage({
      from: 'news@example.org', subject: 'Brief', date: '2026-08-23T00:00:00Z', body: 'info'
    })])]
  });
  const config = { unmappedDigest: true, defaultAgent: 'agent', capabilities: ['gmail'], emailMap: {} };
  let threw = false;
  try {
    realA8S.pushUnmappedDigest(config, { createFile: () => { throw new Error('Drive unavailable'); } }, new Date('2026-08-24T00:00:00Z'));
  } catch (e) {
    threw = true;
  }
  assert(threw, 'digest: surfaces outbox failure for trigger logging');
  assertEqual(global._testProperties._a8s_unmapped_digest_at, previous, 'digest: failed write does not advance checkpoint');
  global.GmailApp = null;
  global._testProperties = {};
})();

(() => {
  const previous = '2026-08-20T00:00:00.000Z';
  const now = new Date('2026-08-24T00:00:00Z');
  global._testProperties = { _a8s_unmapped_digest_at: previous };
  global.GmailApp = createMockGmailApp({ threads: [] });
  const base = { defaultAgent: 'agent', capabilities: ['gmail'], emailMap: {} };
  assertEqual(realA8S.pushUnmappedDigest(Object.assign({ unmappedDigest: false }, base), createMockOutbox(), now), 0, 'digest: off by default');
  assertEqual(global._testProperties._a8s_unmapped_digest_at, previous, 'digest: disabled mode does not touch checkpoint');
  assertEqual(realA8S.pushUnmappedDigest(Object.assign({ unmappedDigest: true }, base), createMockOutbox(), now), 0, 'digest: no activity writes no envelope');
  assertEqual(global._testProperties._a8s_unmapped_digest_at, now.toISOString(), 'digest: empty daily scan advances checkpoint');
  global.GmailApp = null;
  global._testProperties = {};
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
  assert(!env.from, 'writeEnvelope: omits from when unset');
  assertEqual(outbox.getFiles().length, 1, 'writeEnvelope: creates file in outbox');
})();

(() => {
  const outbox = createMockOutbox();
  const env = writeEnvelope(outbox, 'bob', 'hi', null, null, 'neil-email');
  assertEqual(env.from, 'neil-email', 'writeEnvelope: sets from for email principal');
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

// --- processInboxEnvelope(): named routes are address nodes, not commands ---

(() => {
  let sent = null;
  global.GmailApp = createMockGmailApp({ onSendEmail: mail => { sent = mail; } });
  const config = {
    device: 'my-google',
    capabilities: ['gmail'],
    emailMap: {},
    routes: { team: ['a@example.com', 'b@example.com'] },
    commandAgents: []
  };
  const filesFolder = createMockFilesFolder();
  filesFolder.createFile('brief.txt', 'attachment bytes', 'text/plain');
  const outbox = createMockOutbox();
  realA8S.processInboxEnvelope({
    id: 'route-message',
    from: 'agent',
    to: 'team',
    content: 'Status update\nFirst line of body\nSecond line',
    files: [{ filename: 'brief.txt' }]
  }, config, filesFolder, outbox);

  assert(sent, 'named route: sends email without command authorization');
  assertEqual(sent.to, 'a@example.com,b@example.com', 'named route: sends to every mapped recipient');
  assertEqual(sent.subject, 'Status update', 'named route: first content line is subject');
  assertEqual(sent.body, 'First line of body\nSecond line', 'named route: remaining content is body');
  assertEqual(sent.opts.attachments.length, 1, 'named route: carries attachments through existing path');
  assertEqual(outbox.getFiles().length, 0, 'named route: success is silent');

  realA8S.processInboxEnvelope({ from: 'agent', to: 'my-google', content: '/check' }, config, filesFolder, outbox);
  assertEqual(outbox.getFiles().length, 0, 'named route sender: command remains rejected and unanswered');
  global.GmailApp = null;
})();

(() => {
  global.GmailApp = createMockGmailApp({ onSendEmail: () => { throw new Error('mail quota'); } });
  const config = {
    device: 'my-google',
    capabilities: ['gmail'],
    emailMap: {},
    routes: { owner: ['owner@example.com'] },
    commandAgents: []
  };
  const outbox = createMockOutbox();
  realA8S.processInboxEnvelope(
    { from: 'agent', to: 'owner', content: 'Hello\nBody' },
    config,
    createMockFilesFolder(),
    outbox
  );
  assertEqual(outbox.getFiles().length, 1, 'named route failure: sends one error response');
  const response = JSON.parse(outbox.getFiles()[0].content);
  assertEqual(response.to, 'agent', 'named route failure: responds to sender');
  assert(response.content.includes('error: send failed: mail quota'), 'named route failure: reports delivery error');
  global.GmailApp = null;
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

// --- scheduler outbox: calendar gets a distinct filesystem identity ---

(() => {
  const mainOutbox = createMockOutbox();
  const schedulerRoot = createMockDriveRoot('scheduler-root', 'sched-folder');
  global.DriveApp = {
    getFolderById: id => {
      if (id !== 'sched-folder') throw new Error('folder not found');
      return schedulerRoot;
    }
  };
  const selected = realA8S.resolveCalendarOutbox({ schedFolderId: 'sched-folder' }, mainOutbox);
  assert(selected !== mainOutbox, 'scheduler outbox: configured folder selects distinct outbox');
  assertEqual(selected, schedulerRoot._folders['.outbox'], 'scheduler outbox: uses .outbox under scheduler root');
  assertEqual(realA8S.resolveCalendarOutbox({ schedFolderId: '' }, mainOutbox), mainOutbox, 'scheduler outbox: unset preserves main outbox');

  const start = new Date(Date.now() + 5 * 60000);
  const event = createMockEvent({
    id: 'scheduler-event',
    title: 'Timed instruction',
    start,
    end: new Date(start.getTime() + 30 * 60000),
    description: 'Run the scheduled task'
  });
  global.CalendarApp = { getDefaultCalendar: () => ({ getEvents: () => [event] }) };
  global._testProperties = {};
  const count = realA8S.pushUpcomingEvents(
    { defaultAgent: 'agent', capabilities: ['calendar'] },
    selected,
    null
  );
  assertEqual(count, 1, 'scheduler outbox: calendar event pushed');
  assertEqual(selected.getFiles().length, 1, 'scheduler outbox: calendar envelope written to scheduler');
  assertEqual(mainOutbox.getFiles().length, 0, 'scheduler outbox: main outbox receives no calendar envelope');

  delete global.CalendarApp;
  delete global.DriveApp;
  global._testProperties = {};
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

(() => {
  global._testProperties = {
    A8S_ROOT_FOLDER_ID: 'root',
    A8S_SCHED_FOLDER_ID: 'scheduler',
    A8S_DEVICE: 'my-google',
    A8S_DEFAULT_AGENT: 'agent',
    A8S_EMAIL_MAP: '{"Human@Example.com":"human-mail"}',
    A8S_ROUTES: 'owner-mail=owner@example.com;team=a@example.com,b@example.com',
    A8S_COMMAND_AGENTS: '',
    A8S_UNMAPPED_DIGEST: 'true',
    CAPABILITIES: 'gmail,calendar'
  };
  const config = realA8S.getConfig();
  assertEqual(config.schedFolderId, 'scheduler', 'getConfig: scheduler folder property');
  assertDeepEqual(config.routes.team, ['a@example.com', 'b@example.com'], 'getConfig: named routes parsed');
  assertDeepEqual(config.commandAgents, [], 'getConfig: explicit empty command-agent property is preserved');
  assert(config.unmappedDigest, 'getConfig: unmapped digest opt-in');
  global._testProperties = {};
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

// --- Outbound email renders markdown on every path, not just /send ---

(() => {
  // The named route (`tell neil-email ...`) is how an agent mails a human
  // since v1.3. It skipped the markdown conversion `/send` had all along, so
  // moving an agent off the command surface silently took its formatting away.
  const sent = [];
  global.GmailApp = createMockGmailApp({ onSendEmail: (m) => sent.push(m) });
  const config = {
    capabilities: ['gmail'],
    markdownAuto: true,
    routes: { 'neil-email': ['human@example.com'] }
  };
  const envelope = {
    to: 'neil-email',
    from: 'agent',
    content: 'Morning Report\n\n## Headline\n\n- first\n- second'
  };
  assertEqual(
    realA8S.sendNamedRouteEmail(envelope, config, null),
    null,
    'route email: sends without error'
  );
  assertEqual(sent.length, 1, 'route email: one message');
  assertEqual(sent[0].subject, 'Morning Report', 'route email: first line is the subject');
  assert(sent[0].opts.htmlBody, 'route email: carries an htmlBody');
  assert(sent[0].opts.htmlBody.includes('<h2>'), 'route email: heading became HTML');
  assert(sent[0].opts.htmlBody.includes('<li>'), 'route email: list became HTML');
  assert(sent[0].body.includes('## Headline'), 'route email: plain part keeps the markdown');
  global.GmailApp = null;
})();

(() => {
  const sent = [];
  global.GmailApp = createMockGmailApp({ onSendEmail: (m) => sent.push(m) });
  const config = {
    capabilities: ['gmail'],
    markdownAuto: true,
    emailMap: { 'human@example.com': 'neil-mail' }
  };
  realA8S.sendOutboundEmail(
    { to: 'neil-mail', from: 'agent', content: '**bold** and `code`' },
    config,
    null
  );
  assertEqual(sent.length, 1, 'principal email: one message');
  assert(sent[0].opts.htmlBody, 'principal email: carries an htmlBody');
  assert(sent[0].opts.htmlBody.includes('<strong>'), 'principal email: bold became HTML');
  global.GmailApp = null;
})();

(() => {
  // Plain prose is left plain on both paths — the detector, not the path,
  // decides, exactly as it does for /send.
  const sent = [];
  global.GmailApp = createMockGmailApp({ onSendEmail: (m) => sent.push(m) });
  const config = {
    capabilities: ['gmail'],
    markdownAuto: true,
    routes: { 'neil-email': ['human@example.com'] }
  };
  realA8S.sendNamedRouteEmail(
    { to: 'neil-email', from: 'agent', content: 'Subject line\n\nJust a sentence.' },
    config,
    null
  );
  assert(!sent[0].opts.htmlBody, 'route email: no html for plain prose');
  global.GmailApp = null;
})();

(() => {
  // MARKDOWN_AUTO=false still turns it off everywhere.
  const sent = [];
  global.GmailApp = createMockGmailApp({ onSendEmail: (m) => sent.push(m) });
  const config = {
    capabilities: ['gmail'],
    markdownAuto: false,
    routes: { 'neil-email': ['human@example.com'] }
  };
  realA8S.sendNamedRouteEmail(
    { to: 'neil-email', from: 'agent', content: 'Subject\n\n## Heading' },
    config,
    null
  );
  assert(!sent[0].opts.htmlBody, 'route email: markdownAuto off disables conversion');
  global.GmailApp = null;
})();

// --- Report ---

console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
