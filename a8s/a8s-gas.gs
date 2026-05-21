var A8S = (function() {

  var CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

  function ulid() {
    var ts = Date.now();
    var chars = [];
    for (var i = 9; i >= 0; i--) {
      chars[i] = CROCKFORD.charAt(ts & 0x1f);
      ts = Math.floor(ts / 32);
    }
    for (var j = 10; j < 26; j++) {
      chars[j] = CROCKFORD.charAt(Math.floor(Math.random() * 32));
    }
    return chars.join('');
  }

  function getConfig() {
    var props = PropertiesService.getScriptProperties();
    return {
      rootFolderId: props.getProperty('A8S_ROOT_FOLDER_ID'),
      participants: JSON.parse(props.getProperty('A8S_PARTICIPANTS') || '{}'),
      agent: props.getProperty('A8S_AGENT') || ''
    };
  }

  function getOrCreateSubfolder(root, name) {
    var iter = root.getFoldersByName(name);
    if (iter.hasNext()) return iter.next();
    return root.createFolder(name);
  }

  function writeEnvelope(outbox, to, content, files) {
    var envelope = {
      id: ulid(),
      date: new Date().toISOString(),
      to: to,
      content: content
    };
    if (files && files.length) envelope.files = files;
    outbox.createFile(envelope.id + '.json', JSON.stringify(envelope, null, 2), 'application/json');
    return envelope;
  }

  // --- Gmail Handler ---

  function handleGmail(command, args, body, envelope, filesFolder, outbox, config) {
    if (command === '/check') {
      var threads = GmailApp.search('is:unread', 0, 5);
      var subjects = threads.map(function(t) {
        var msg = t.getMessages()[t.getMessageCount() - 1];
        return t.getId() + ' | ' + msg.getSubject() + ' | ' + msg.getFrom();
      });
      var total = GmailApp.getInboxUnreadCount();
      return total + ' unread\n' + subjects.join('\n');
    }

    if (command === '/search') {
      var query = args.join(' ');
      if (!query) return 'error: /search requires a query';
      var results = GmailApp.search(query, 0, 10);
      if (!results.length) return 'no results for: ' + query;
      var lines = results.map(function(t) {
        var msg = t.getMessages()[t.getMessageCount() - 1];
        return t.getId() + ' | ' + msg.getSubject() + ' | ' + msg.getFrom() + ' | ' + msg.getDate().toISOString();
      });
      return lines.join('\n');
    }

    if (command === '/read') {
      var threadId = args[0];
      if (!threadId) return 'error: /read requires a thread ID';
      try {
        var thread = GmailApp.getThreadById(threadId);
        var messages = thread.getMessages();
        var parts = messages.map(function(m) {
          return '--- ' + m.getFrom() + ' (' + m.getDate().toISOString() + ') ---\n' + m.getPlainBody();
        });
        return 'thread_id: ' + threadId + '\n\n' + parts.join('\n\n');
      } catch (e) {
        return 'error: ' + e.message;
      }
    }

    if (command === '/send' || command === '/reply') {
      if (command === '/reply') {
        var replyThreadId = args[0];
        if (!replyThreadId) return 'error: /reply requires a thread_id';
        try {
          var replyThread = GmailApp.getThreadById(replyThreadId);
          var lastMsg = replyThread.getMessages()[replyThread.getMessageCount() - 1];
          var attachments = collectFileAttachments(envelope, filesFolder);
          var opts = {};
          if (attachments.length) opts.attachments = attachments;
          lastMsg.reply(body || '', opts);
          return 'replied to thread ' + replyThreadId;
        } catch (e) {
          return 'error: ' + e.message;
        }
      }

      if (args.length < 2) return 'error: /send <to> <subject>';
      var to = args[0];
      var subject = args.slice(1).join(' ');
      var attachments = collectFileAttachments(envelope, filesFolder);
      var opts = {};
      if (attachments.length) opts.attachments = attachments;
      GmailApp.sendEmail(to, subject, body || '', opts);
      return 'sent to ' + to + ': ' + subject;
    }

    return 'unknown: ' + command + '\navailable: /check, /search, /read, /send, /reply';
  }

  function collectFileAttachments(envelope, filesFolder) {
    var attachments = [];
    if (!envelope.files || !envelope.files.length) return attachments;
    envelope.files.forEach(function(f) {
      var filename = f.filename || f.path.split('/').pop();
      var iter = filesFolder.getFilesByName(filename);
      if (iter.hasNext()) {
        attachments.push(iter.next().getBlob());
      }
    });
    return attachments;
  }

  // --- Email Push (UNREAD → mark READ → tell agent) ---

  function pushNewEmails(config, outbox, filesFolder) {
    if (!config.agent) return;

    var threads = GmailApp.search('is:unread', 0, 10);
    if (!threads.length) return;

    threads.forEach(function(thread) {
      var messages = thread.getMessages();
      var unread = messages.filter(function(m) { return m.isUnread(); });

      unread.forEach(function(msg) {
        var content = formatEmailForAgent(msg, thread.getId());
        var files = saveAttachmentsToFiles(msg, filesFolder);
        writeEnvelope(outbox, config.agent, content, files);
        msg.markRead();
      });
    });
  }

  function formatEmailForAgent(msg, threadId) {
    var from = msg.getFrom();
    var subject = msg.getSubject();
    var date = msg.getDate().toISOString();
    var body = msg.getPlainBody();
    if (body.length > 4000) body = body.substring(0, 4000) + '\n[truncated]';

    return 'New email\n' +
      'thread_id: ' + threadId + '\n' +
      'from: ' + from + '\n' +
      'subject: ' + subject + '\n' +
      'date: ' + date + '\n' +
      '---\n' + body;
  }

  function saveAttachmentsToFiles(msg, filesFolder) {
    var attachments = msg.getAttachments();
    if (!attachments.length) return [];

    var fileRefs = [];
    attachments.forEach(function(att) {
      var filename = att.getName();
      var file = filesFolder.createFile(att.copyBlob().setName(filename));
      fileRefs.push({ filename: filename, path: './.files/' + filename });
    });
    return fileRefs;
  }

  // --- Calendar Handler ---

  function handleCalendar(command, args) {
    var cal = CalendarApp.getDefaultCalendar();

    if (command === '/today') {
      var now = new Date();
      var end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
      var events = cal.getEvents(now, end);
      if (!events.length) return 'no events today';
      return events.map(function(ev) {
        var start = ev.getStartTime();
        var time = pad(start.getHours()) + ':' + pad(start.getMinutes());
        return time + ' ' + ev.getTitle();
      }).join('\n');
    }

    if (command === '/week') {
      var now = new Date();
      var end = new Date(now.getTime() + 7 * 86400000);
      var events = cal.getEvents(now, end);
      if (!events.length) return 'no events this week';
      return events.map(function(ev) {
        var start = ev.getStartTime();
        var dateStr = (start.getMonth() + 1) + '/' + start.getDate();
        var time = pad(start.getHours()) + ':' + pad(start.getMinutes());
        return dateStr + ' ' + time + ' ' + ev.getTitle();
      }).join('\n');
    }

    if (command === '/create') {
      if (args.length < 2) return 'error: /create <title> <datetime>';
      var title = args[0];
      var dateStr = args.slice(1).join(' ');
      try {
        var start = new Date(dateStr);
        if (isNaN(start.getTime())) return 'error: invalid datetime: ' + dateStr;
        cal.createEvent(title, start, new Date(start.getTime() + 3600000));
        return 'created: ' + title + ' at ' + start.toISOString();
      } catch (e) {
        return 'error: ' + e.message;
      }
    }

    return 'unknown: ' + command + '\navailable: /today, /week, /create';
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // --- Command Routing ---

  function parseCommand(content) {
    var lines = content.split('\n');
    var firstLine = lines[0].trim();
    if (!firstLine.startsWith('/')) return null;
    var parts = firstLine.split(/\s+/);
    return { command: parts[0], args: parts.slice(1), body: lines.slice(1).join('\n').trim() };
  }

  function routeMessage(envelope, config, filesFolder, outbox) {
    var to = envelope.to;
    var participantServices = config.participants[to];

    if (!participantServices) {
      return 'error: unknown participant "' + to + '". configured: ' + Object.keys(config.participants).join(', ');
    }

    var parsed = parseCommand(envelope.content || '');
    if (!parsed) return 'error: message must start with a /command';

    var service = participantServices[0];
    if (service === 'gmail') {
      return handleGmail(parsed.command, parsed.args, parsed.body, envelope, filesFolder, outbox, config);
    }
    if (service === 'calendar') {
      return handleCalendar(parsed.command, parsed.args);
    }

    return 'error: no handler for service "' + service + '"';
  }

  // --- Main Trigger ---

  function onTrigger() {
    var config = getConfig();
    if (!config.rootFolderId) {
      console.log('A8S_ROOT_FOLDER_ID not configured');
      return;
    }

    var root;
    try {
      root = DriveApp.getFolderById(config.rootFolderId);
    } catch (e) {
      console.log('cannot access root folder: ' + e.message);
      return;
    }

    var inbox = getOrCreateSubfolder(root, '.inbox');
    var outbox = getOrCreateSubfolder(root, '.outbox');
    var filesFolder = getOrCreateSubfolder(root, '.files');

    var files = inbox.getFiles();
    while (files.hasNext()) {
      var file = files.next();
      if (!file.getName().endsWith('.json')) continue;

      try {
        var envelope = JSON.parse(file.getBlob().getDataAsString());
        var response = routeMessage(envelope, config, filesFolder, outbox);
        writeEnvelope(outbox, envelope.from || config.agent, response);
      } catch (e) {
        console.log('error processing ' + file.getName() + ': ' + e.message);
      }

      file.setTrashed(true);
    }

    try {
      pushNewEmails(config, outbox, filesFolder);
    } catch (e) {
      console.log('email push failed: ' + e.message);
    }
  }

  // --- Setup ---

  function setup() {
    var props = PropertiesService.getScriptProperties();
    if (!props.getProperty('A8S_ROOT_FOLDER_ID')) {
      Logger.log('Set Script Properties:');
      Logger.log('  A8S_ROOT_FOLDER_ID — Drive folder ID');
      Logger.log('  A8S_PARTICIPANTS — e.g. {"my-email": ["gmail"], "my-calendar": ["calendar"]}');
      Logger.log('  A8S_AGENT — agent to push notifications to');
      return;
    }
    Logger.log('Configuration OK. Run installTrigger() to activate.');
  }

  function installTrigger() {
    ScriptApp.getProjectTriggers().forEach(function(t) {
      if (t.getHandlerFunction() === 'onTrigger') ScriptApp.deleteTrigger(t);
    });
    ScriptApp.newTrigger('onTrigger').timeBased().everyMinutes(5).create();
    Logger.log('Trigger installed: every 5 minutes.');
  }

  function removeTrigger() {
    var removed = 0;
    ScriptApp.getProjectTriggers().forEach(function(t) {
      if (t.getHandlerFunction() === 'onTrigger') {
        ScriptApp.deleteTrigger(t);
        removed++;
      }
    });
    Logger.log('Removed ' + removed + ' trigger(s).');
  }

  function testConnection() {
    var config = getConfig();
    if (!config.rootFolderId) { Logger.log('ERROR: A8S_ROOT_FOLDER_ID not set'); return; }
    try {
      var root = DriveApp.getFolderById(config.rootFolderId);
      Logger.log('Root: ' + root.getName() + ' (' + root.getId() + ')');
      Logger.log('.inbox: ' + getOrCreateSubfolder(root, '.inbox').getId());
      Logger.log('.outbox: ' + getOrCreateSubfolder(root, '.outbox').getId());
      Logger.log('.files: ' + getOrCreateSubfolder(root, '.files').getId());
      Logger.log('Participants: ' + JSON.stringify(config.participants));
      Logger.log('Agent: ' + (config.agent || '(not set)'));
      Logger.log('OK');
    } catch (e) {
      Logger.log('ERROR: ' + e.message);
    }
  }

  return {
    onTrigger: onTrigger,
    setup: setup,
    installTrigger: installTrigger,
    removeTrigger: removeTrigger,
    testConnection: testConnection
  };

})();

function onTrigger()      { A8S.onTrigger(); }
function setup()          { A8S.setup(); }
function installTrigger() { A8S.installTrigger(); }
function removeTrigger()  { A8S.removeTrigger(); }
function testConnection() { A8S.testConnection(); }
