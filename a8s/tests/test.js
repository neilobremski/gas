'use strict';

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

function formatEmailForAgent(msg, threadId) {
  const from = msg.getFrom();
  const subject = msg.getSubject();
  const date = msg.getDate().toISOString();
  let body = msg.getPlainBody();
  if (body.length > 4000) body = body.substring(0, 4000) + '\n[truncated]';
  return `New email\nthread_id: ${threadId}\nfrom: ${from}\nsubject: ${subject}\ndate: ${date}\n---\n${body}`;
}

const pad = n => (n < 10 ? '0' : '') + n;

function writeEnvelope(outbox, to, content, files) {
  const envelope = {
    id: ulid(),
    date: new Date().toISOString(),
    to,
    content
  };
  if (files && files.length) envelope.files = files;
  outbox.createFile(`${envelope.id}.json`, JSON.stringify(envelope, null, 2), 'application/json');
  return envelope;
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

function createMockGmailApp({ threads = [], unreadCount = 0 } = {}) {
  return {
    search: () => threads,
    getInboxUnreadCount: () => unreadCount,
    getThreadById: (id) => {
      const t = threads.find(t => t._id === id);
      if (!t) throw new Error(`thread not found: ${id}`);
      return t;
    },
    sendEmail: () => {}
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

function createMockMessage({ from, subject, date, body, unread = false, attachments = [] }) {
  return {
    getFrom: () => from,
    getSubject: () => subject,
    getDate: () => new Date(date),
    getPlainBody: () => body,
    isUnread: () => unread,
    markRead: () => {},
    getAttachments: () => attachments,
    reply: () => {}
  };
}

function createMockOutbox() {
  const files = [];
  return {
    createFile: (name, content, mimeType) => files.push({ name, content, mimeType }),
    getFiles: () => files
  };
}

function createMockFilesFolder() {
  return {
    getFilesByName: () => ({ hasNext: () => false }),
    createFile: (blob) => blob
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
    if (command === '/reply') {
      const replyThreadId = args[0];
      if (!replyThreadId) return 'error: /reply requires a thread_id';
      return `replied to thread ${replyThreadId}`;
    }
    if (args.length < 2) return 'error: /send <to> <subject>';
    return `sent to ${args[0]}: ${args.slice(1).join(' ')}`;
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
  const files = [{ filename: 'doc.pdf', path: './.files/doc.pdf' }];
  const env = writeEnvelope(outbox, 'my-agent', 'with attachment', files);
  assertEqual(env.files.length, 1, 'writeEnvelope: includes files');
  assertEqual(env.files[0].filename, 'doc.pdf', 'writeEnvelope: file reference correct');
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

// --- Report ---

console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
