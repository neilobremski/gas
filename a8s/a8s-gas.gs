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
      agent: props.getProperty('A8S_AGENT') || '',
      tempfileUrl: props.getProperty('TEMPFILE_URL') || 'https://tempfile.org/'
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
    var filename = envelope.id + '.json';
    outbox.createFile(filename, JSON.stringify(envelope, null, 2), 'application/json');
    return envelope;
  }

  // --- Participant Handlers ---

  function handleGmail(command, args, body) {
    if (command === '/check') {
      var threads = GmailApp.search('is:unread', 0, 5);
      var subjects = threads.map(function(t) {
        var msg = t.getMessages()[t.getMessageCount() - 1];
        return msg.getSubject() + ' (from: ' + msg.getFrom() + ')';
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
        return parts.join('\n\n');
      } catch (e) {
        return 'error: ' + e.message;
      }
    }

    if (command === '/send') {
      if (args.length < 2) return 'error: /send <to> <subject>';
      var to = args[0];
      var subject = args.slice(1).join(' ');
      var emailBody = body || '';
      var opts = {};
      GmailApp.sendEmail(to, subject, emailBody, opts);
      return 'sent to ' + to + ': ' + subject;
    }

    return 'error: unknown gmail command: ' + command + '\navailable: /check, /search <query>, /read <id>, /send <to> <subject>';
  }

  function handleCalendar(command, args) {
    var cal = CalendarApp.getDefaultCalendar();

    if (command === '/today') {
      var now = new Date();
      var end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
      var events = cal.getEvents(now, end);
      if (!events.length) return 'no events today';
      var lines = events.map(function(ev) {
        var start = ev.getStartTime();
        var h = start.getHours();
        var m = start.getMinutes();
        var time = (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
        return time + ' ' + ev.getTitle();
      });
      return lines.join('\n');
    }

    if (command === '/week') {
      var now = new Date();
      var end = new Date(now.getTime() + 7 * 86400000);
      var events = cal.getEvents(now, end);
      if (!events.length) return 'no events this week';
      var lines = events.map(function(ev) {
        var start = ev.getStartTime();
        var dateStr = (start.getMonth() + 1) + '/' + start.getDate();
        var h = start.getHours();
        var m = start.getMinutes();
        var time = (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
        return dateStr + ' ' + time + ' ' + ev.getTitle();
      });
      return lines.join('\n');
    }

    if (command === '/create') {
      if (args.length < 2) return 'error: /create <title> <datetime>';
      var title = args[0];
      var dateStr = args.slice(1).join(' ');
      try {
        var start = new Date(dateStr);
        if (isNaN(start.getTime())) return 'error: invalid datetime: ' + dateStr;
        var eventEnd = new Date(start.getTime() + 3600000);
        var ev = cal.createEvent(title, start, eventEnd);
        return 'created: ' + ev.getTitle() + ' at ' + start.toISOString();
      } catch (e) {
        return 'error: ' + e.message;
      }
    }

    return 'error: unknown calendar command: ' + command + '\navailable: /today, /week, /create <title> <datetime>';
  }

  // --- Command Routing ---

  function parseCommand(content) {
    var lines = content.split('\n');
    var firstLine = lines[0].trim();
    if (!firstLine.startsWith('/')) return null;
    var parts = firstLine.split(/\s+/);
    var command = parts[0];
    var args = parts.slice(1);
    var body = lines.slice(1).join('\n').trim();
    return { command: command, args: args, body: body };
  }

  function routeMessage(envelope, config) {
    var to = envelope.to;
    var participantServices = null;

    for (var name in config.participants) {
      if (name === to) {
        participantServices = config.participants[name];
        break;
      }
    }

    if (!participantServices) {
      return 'error: unknown participant "' + to + '". configured: ' + Object.keys(config.participants).join(', ');
    }

    var parsed = parseCommand(envelope.content || '');
    if (!parsed) {
      return 'error: message must start with a /command';
    }

    var service = participantServices[0];
    if (service === 'gmail') {
      return handleGmail(parsed.command, parsed.args, parsed.body);
    } else if (service === 'calendar') {
      return handleCalendar(parsed.command, parsed.args);
    }

    return 'error: no handler for service "' + service + '"';
  }

  // --- Push Mode ---

  function checkUpcomingEvents(config, outbox) {
    if (!config.agent) return;
    var cal = CalendarApp.getDefaultCalendar();
    var now = new Date();
    var soon = new Date(now.getTime() + 15 * 60000);
    var events = cal.getEvents(now, soon);
    if (!events.length) return;

    var props = PropertiesService.getScriptProperties();
    var notifiedKey = '_a8s_notified_events';
    var notified = JSON.parse(props.getProperty(notifiedKey) || '{}');

    var newEvents = [];
    events.forEach(function(ev) {
      var id = ev.getId();
      if (!notified[id]) {
        var start = ev.getStartTime();
        var h = start.getHours();
        var m = start.getMinutes();
        var time = (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
        newEvents.push(time + ' ' + ev.getTitle());
        notified[id] = now.toISOString();
      }
    });

    if (newEvents.length) {
      writeEnvelope(outbox, config.agent, 'upcoming in 15min:\n' + newEvents.join('\n'));
    }

    var cutoff = now.getTime() - 3600000;
    for (var id in notified) {
      if (new Date(notified[id]).getTime() < cutoff) delete notified[id];
    }
    props.setProperty(notifiedKey, JSON.stringify(notified));
  }

  // --- Tempfile Support ---

  function downloadTempfile(url, filesFolder, config) {
    var downloadUrl = url.replace(/\/?$/, '/') + 'download';
    var resp = UrlFetchApp.fetch(downloadUrl, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return null;
    var blob = resp.getBlob();
    var filename = url.split('/').filter(function(s) { return s; }).pop() || 'file';
    blob.setName(filename);
    return filesFolder.createFile(blob);
  }

  function uploadTempfile(file, config) {
    var baseUrl = config.tempfileUrl.replace(/\/?$/, '/');
    var blob = file.getBlob();
    var resp = UrlFetchApp.fetch(baseUrl + 'api/upload/local', {
      method: 'post',
      payload: { file: blob },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) return null;
    try {
      var data = JSON.parse(resp.getContentText());
      return data.url || null;
    } catch (e) {
      return resp.getContentText().trim();
    }
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
    getOrCreateSubfolder(root, '.files');

    var files = inbox.getFiles();
    while (files.hasNext()) {
      var file = files.next();
      if (!file.getName().endsWith('.json')) continue;

      try {
        var envelope = JSON.parse(file.getBlob().getDataAsString());
        var response = routeMessage(envelope, config);
        writeEnvelope(outbox, envelope.from || config.agent, response);
      } catch (e) {
        console.log('error processing ' + file.getName() + ': ' + e.message);
        try {
          writeEnvelope(outbox, config.agent, 'error processing message ' + file.getName() + ': ' + e.message);
        } catch (e2) {
          console.log('failed to write error envelope: ' + e2.message);
        }
      }

      file.setTrashed(true);
    }

    try {
      checkUpcomingEvents(config, outbox);
    } catch (e) {
      console.log('push check failed: ' + e.message);
    }
  }

  // --- Setup Functions ---

  function setup() {
    var props = PropertiesService.getScriptProperties();
    if (!props.getProperty('A8S_ROOT_FOLDER_ID')) {
      Logger.log('Set A8S_ROOT_FOLDER_ID in Script Properties to the Drive folder ID.');
      Logger.log('Set A8S_PARTICIPANTS to a JSON map, e.g.: {"my-email": ["gmail"], "my-calendar": ["calendar"]}');
      Logger.log('Set A8S_AGENT to the agent name for push notifications (e.g. "claude")');
      return;
    }
    Logger.log('Configuration OK. Run installTrigger() to activate polling.');
  }

  function installTrigger() {
    var existing = ScriptApp.getProjectTriggers();
    existing.forEach(function(t) {
      if (t.getHandlerFunction() === 'onTrigger') ScriptApp.deleteTrigger(t);
    });
    ScriptApp.newTrigger('onTrigger').timeBased().everyMinutes(5).create();
    Logger.log('Trigger installed: onTrigger every 5 minutes.');
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
    if (!config.rootFolderId) {
      Logger.log('ERROR: A8S_ROOT_FOLDER_ID not set');
      return;
    }
    try {
      var root = DriveApp.getFolderById(config.rootFolderId);
      Logger.log('Root folder: ' + root.getName() + ' (' + root.getId() + ')');
      var inbox = getOrCreateSubfolder(root, '.inbox');
      var outbox = getOrCreateSubfolder(root, '.outbox');
      var filesDir = getOrCreateSubfolder(root, '.files');
      Logger.log('.inbox: ' + inbox.getId());
      Logger.log('.outbox: ' + outbox.getId());
      Logger.log('.files: ' + filesDir.getId());
      Logger.log('Participants: ' + JSON.stringify(config.participants));
      Logger.log('Agent: ' + (config.agent || '(not set)'));
      Logger.log('Connection OK.');
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
