/*
 * GAS Bridge — Turn Google Apps Script Into a Key-Based API
 *
 * Deploys as a Web App and exposes Google Workspace services (Gmail, Drive,
 * Sheets, Calendar, Docs, Contacts, Translate, Tasks) via simple JSON POST
 * requests. Authentication uses a shared secret key stored in Script Properties.
 *
 * Setup:
 *   1. Copy this file into your Apps Script project as Code.gs
 *   2. Run Bridge.initKey() from the editor — copy the key from the Execution Log
 *   3. Run Bridge.activateScopes() to authorize Google services you need
 *   4. Deploy > New Deployment > Web App > Execute as: Me, Access: Anyone
 *   5. POST JSON to the deployment URL: {"action": "info", "key": "YOUR_KEY"}
 *
 * Updating:
 *   Deploy > Manage Deployments > Edit > Version: New Version > Deploy
 *   (The deployment URL stays the same.)
 *
 * Security:
 *   Every POST request must include a valid key. Generate one with Bridge.initKey().
 *   Keys are stored in Script Properties (not in source code). Rotate your key
 *   as needed — this is a shared-secret scheme, not OAuth. Anyone with the key
 *   and the deployment URL has access to whichever Google services are enabled.
 *
 *   The "fetch" and "token.get" actions are disabled by default because they
 *   expose powerful capabilities (arbitrary HTTP requests and raw OAuth tokens).
 *   Enable them explicitly by running Bridge.enableFetch() or Bridge.enableTokenGet()
 *   from the Apps Script editor.
 */

var Bridge = (function() {

  // --- Web App Entry Points ---

  function doGet(e) {
    return ContentService.createTextOutput('GAS Bridge is running.')
      .setMimeType(ContentService.MimeType.TEXT);
  }

  function doPost(e) {
    try {
      var req = JSON.parse(e.postData.contents);
      var storedKey = PropertiesService.getScriptProperties().getProperty('BRIDGE_KEY');
      if (!storedKey || req.key !== storedKey) {
        return _json({error: 'unauthorized'});
      }

      var handler = HANDLERS[req.action || ''];
      if (!handler) {
        return _json({error: 'unknown action', available: Object.keys(HANDLERS)});
      }
      return handler(req);
    } catch (err) {
      return _json({error: err.message});
    }
  }

  // --- Action Handlers ---

  var HANDLERS = {
    'info':            _info,
    'gmail.send':      _gmailSend,
    'gmail.check':     _gmailCheck,
    'sheets.read':     _sheetsRead,
    'sheets.append':   _sheetsAppend,
    'drive.list':      _driveList,
    'drive.create':    _driveCreate,
    'calendar.list':   _calendarList,
    'docs.create':     _docsCreate,
    'contacts.list':   _contactsList,
    'tasks.list':      _tasksList,
    'translate':       _translate,
    'fetch':           _fetch,
    'token.get':       _tokenGet,
    'gmail.get':           _gmailGet,
    'gmail.read':          _gmailRead,
    'gmail.archive':       _gmailArchive,
    'gmail.reply':         _gmailReply,
    'gmail.label':         _gmailLabel,
    'gmail.attachments':   _gmailAttachments,
    'sheets.create':       _sheetsCreate,
    'sheets.update':       _sheetsUpdate,
    'drive.upload':        _driveUpload,
    'drive.download':      _driveDownload,
    'calendar.get':        _calendarGet,
    'calendar.create':     _calendarCreate,
    'calendar.delete':     _calendarDelete,
    'calendar.calendars':  _calendarCalendars,
    'tasks.create':        _tasksCreate,
    'tasks.update':        _tasksUpdate,
  };

  // --- Info ---

  function _info(req) {
    return _json({
      service: 'GAS Bridge',
      version: '1.0',
      account: Session.getActiveUser().getEmail(),
      actions: Object.keys(HANDLERS),
      timestamp: new Date().toISOString()
    });
  }

  // --- Gmail ---

  function _gmailSend(req) {
    if (!req.to) return _json({error: 'missing "to"'});
    var opts = {};
    if (req.cc) opts.cc = req.cc;
    if (req.bcc) opts.bcc = req.bcc;
    if (req.html) opts.htmlBody = req.body;
    if (req.replyTo) opts.replyTo = req.replyTo;
    if (req.inlineImages) {
      var imgs = {};
      for (var k in req.inlineImages) {
        var img = req.inlineImages[k];
        imgs[k] = Utilities.newBlob(Utilities.base64Decode(img.data), img.mimeType, k);
      }
      opts.inlineImages = imgs;
    }
    if (req.attachments) {
      opts.attachments = req.attachments.map(function(a) {
        return Utilities.newBlob(Utilities.base64Decode(a.data), a.mimeType, a.name);
      });
    }
    GmailApp.sendEmail(req.to, req.subject || '(no subject)', req.body || '', opts);
    return _json({status: 'sent', to: req.to, subject: req.subject});
  }

  function _gmailCheck(req) {
    var threads = GmailApp.search(req.query || 'is:unread', 0, req.count || 5);
    var results = threads.map(function(thread) {
      var msg = thread.getMessages()[thread.getMessageCount() - 1];
      return {
        id: thread.getId(),
        subject: msg.getSubject(),
        from: msg.getFrom(),
        date: msg.getDate().toISOString(),
        snippet: msg.getPlainBody().substring(0, 300),
        unread: thread.isUnread()
      };
    });
    return _json({messages: results, count: results.length});
  }

  // --- Sheets ---

  function _sheetsRead(req) {
    if (!req.spreadsheet_id) return _json({error: 'missing spreadsheet_id'});
    var data = SpreadsheetApp.openById(req.spreadsheet_id)
      .getRange(req.range || 'Sheet1!A1:Z100').getValues();
    while (data.length > 0 && data[data.length - 1].every(function(c) { return c === ''; })) data.pop();
    return _json({rows: data, count: data.length});
  }

  function _sheetsAppend(req) {
    if (!req.spreadsheet_id) return _json({error: 'missing spreadsheet_id'});
    if (!req.rows || !req.rows.length) return _json({error: 'no rows'});
    var sheet = SpreadsheetApp.openById(req.spreadsheet_id).getSheetByName(req.sheet || 'Sheet1');
    if (!sheet) return _json({error: 'sheet not found'});
    req.rows.forEach(function(row) { sheet.appendRow(row); });
    return _json({status: 'appended', rows_added: req.rows.length});
  }

  // --- Drive ---

  function _driveList(req) {
    var iter = req.query ? DriveApp.searchFiles(req.query) : DriveApp.getFiles();
    var files = [], count = req.count || 10;
    while (iter.hasNext() && files.length < count) {
      var f = iter.next();
      files.push({
        id: f.getId(), name: f.getName(), type: f.getMimeType(),
        size: f.getSize(), url: f.getUrl(), updated: f.getLastUpdated().toISOString()
      });
    }
    return _json({files: files, count: files.length});
  }

  function _driveCreate(req) {
    if (!req.name) return _json({error: 'missing name'});
    var type = req.type || 'document';
    var file;
    if (type === 'spreadsheet') {
      file = SpreadsheetApp.create(req.name);
    } else if (type === 'document') {
      file = DocumentApp.create(req.name);
    } else {
      file = DriveApp.createFile(req.name, req.content || '', req.mime || 'text/plain');
      return _json({id: file.getId(), name: file.getName(), url: file.getUrl()});
    }
    return _json({id: file.getId(), name: req.name, url: file.getUrl()});
  }

  // --- Calendar ---

  function _calendarList(req) {
    var now = new Date(), end = new Date(now.getTime() + (req.days || 7) * 86400000);
    var cal = req.calendarId ? CalendarApp.getCalendarById(req.calendarId) : CalendarApp.getDefaultCalendar();
    var events = cal.getEvents(now, end).map(function(ev) {
      return {
        title: ev.getTitle(), start: ev.getStartTime().toISOString(),
        end: ev.getEndTime().toISOString(), location: ev.getLocation()
      };
    });
    return _json({events: events, count: events.length});
  }

  // --- Docs ---

  function _docsCreate(req) {
    if (!req.title) return _json({error: 'missing title'});
    var doc = DocumentApp.create(req.title);
    if (req.body) doc.getBody().appendParagraph(req.body);
    return _json({id: doc.getId(), title: req.title, url: doc.getUrl()});
  }

  // --- Contacts ---

  function _contactsList(req) {
    var contacts = ContactsApp.getContacts();
    var count = req.count || 20;
    var results = contacts.slice(0, count).map(function(c) {
      var emails = c.getEmails();
      return {name: c.getFullName(), email: emails.length > 0 ? emails[0].getAddress() : null};
    });
    return _json({contacts: results, count: results.length});
  }

  // --- Google Tasks ---

  function _tasksList(req) {
    try {
      var taskLists = Tasks.Tasklists.list();
      var results = taskLists.items.map(function(list) {
        var tasks = Tasks.Tasks.list(list.id);
        return {
          list: list.title,
          tasks: (tasks.items || []).map(function(t) {
            return {title: t.title, status: t.status, due: t.due || null};
          })
        };
      });
      return _json({taskLists: results});
    } catch (e) {
      return _json({error: 'Tasks API not enabled. Add via Services > Tasks API.', detail: e.message});
    }
  }

  // --- Translate ---

  function _translate(req) {
    if (!req.text) return _json({error: 'missing text'});
    var result = LanguageApp.translate(req.text, req.from || 'auto', req.to || 'en');
    return _json({translated: result, from: req.from || 'auto', to: req.to || 'en'});
  }

  // --- HTTP Proxy (disabled by default — run Bridge.enableFetch() to enable) ---

  function _fetch(req) {
    if (!_isEnabled('FETCH_ENABLED')) {
      return _json({error: 'fetch is disabled. Run Bridge.enableFetch() from the Apps Script editor to enable it.'});
    }
    if (!req.url) return _json({error: 'missing url'});
    var opts = {muteHttpExceptions: true, method: req.method || 'get'};
    if (req.headers) opts.headers = req.headers;
    if (req.payload) opts.payload = req.payload;
    if (req.contentType) opts.contentType = req.contentType;
    var resp = UrlFetchApp.fetch(req.url, opts);
    var body = resp.getContentText();
    try { body = JSON.parse(body); } catch (e) {}
    return _json({status: resp.getResponseCode(), headers: resp.getHeaders(), body: body});
  }

  // --- Token (disabled by default — run Bridge.enableTokenGet() to enable) ---

  function _tokenGet(req) {
    if (!_isEnabled('TOKEN_GET_ENABLED')) {
      return _json({error: 'token.get is disabled. Run Bridge.enableTokenGet() from the Apps Script editor to enable it.'});
    }
    return _json({
      access_token: ScriptApp.getOAuthToken(),
      expires_in: 3600,
      note: 'Scopes depend on which services have been activated via activateScopes().'
    });
  }

  // --- Gmail (extended) ---

  function _gmailGet(req) {
    if (!req.thread_id) return _json({error: 'missing thread_id'});
    var thread = GmailApp.getThreadById(req.thread_id);
    if (!thread) return _json({error: 'thread not found'});
    var msgs = thread.getMessages().map(function(m) {
      return {
        id: m.getId(), subject: m.getSubject(), from: m.getFrom(),
        to: m.getTo(), cc: m.getCc(), date: m.getDate().toISOString(),
        plain: m.getPlainBody().substring(0, 300), html: m.getBody(),
        attachments: m.getAttachments().map(function(a) {
          return {name: a.getName(), type: a.getContentType(), size: a.getSize()};
        }),
        starred: m.isStarred()
      };
    });
    return _json({thread_id: req.thread_id, messages: msgs, count: msgs.length});
  }

  function _gmailRead(req) {
    if (!req.thread_id) return _json({error: 'missing thread_id'});
    GmailApp.getThreadById(req.thread_id).markRead();
    return _json({status: 'marked_read', thread_id: req.thread_id});
  }

  function _gmailArchive(req) {
    if (!req.thread_id) return _json({error: 'missing thread_id'});
    var thread = GmailApp.getThreadById(req.thread_id);
    thread.markRead();
    thread.moveToArchive();
    return _json({status: 'archived', thread_id: req.thread_id});
  }

  function _gmailReply(req) {
    if (!req.thread_id) return _json({error: 'missing thread_id'});
    if (!req.body) return _json({error: 'missing body'});
    var me = Session.getActiveUser().getEmail();
    var msgs = GmailApp.getThreadById(req.thread_id).getMessages();
    var msg = msgs[msgs.length - 1];
    for (var i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].getFrom().indexOf(me) === -1) { msg = msgs[i]; break; }
    }
    var opts = {};
    if (req.html) opts.htmlBody = req.body;
    if (req.cc) opts.cc = req.cc;
    if (req.inlineImages) {
      var imgs = {};
      for (var k in req.inlineImages) {
        var img = req.inlineImages[k];
        imgs[k] = Utilities.newBlob(Utilities.base64Decode(img.data), img.mimeType, k);
      }
      opts.inlineImages = imgs;
    }
    msg.reply(req.body, opts);
    return _json({status: 'replied', thread_id: req.thread_id, replied_to: msg.getId()});
  }

  function _gmailLabel(req) {
    if (!req.thread_id) return _json({error: 'missing thread_id'});
    var thread = GmailApp.getThreadById(req.thread_id);
    if (req.add) {
      var label = GmailApp.getUserLabelByName(req.add) || GmailApp.createLabel(req.add);
      thread.addLabel(label);
    }
    if (req.remove) {
      var rlabel = GmailApp.getUserLabelByName(req.remove);
      if (rlabel) thread.removeLabel(rlabel);
    }
    return _json({status: 'labeled', thread_id: req.thread_id, add: req.add || null, remove: req.remove || null});
  }

  function _gmailAttachments(req) {
    var msgs;
    if (req.message_id) {
      msgs = [GmailApp.getMessageById(req.message_id)];
    } else if (req.thread_id) {
      msgs = GmailApp.getThreadById(req.thread_id).getMessages();
    } else {
      return _json({error: 'missing message_id or thread_id'});
    }
    var results = [];
    msgs.forEach(function(m) {
      m.getAttachments().forEach(function(a) {
        var item = {filename: a.getName(), mimeType: a.getContentType(), size: a.getSize(), message_id: m.getId()};
        if (a.getSize() <= 1048576) {
          item.data = Utilities.base64Encode(a.getBytes());
        } else {
          item.truncated = true;
        }
        if (req.save_to_drive) {
          var file = DriveApp.createFile(a);
          item.drive_id = file.getId();
          item.drive_url = file.getUrl();
        }
        results.push(item);
      });
    });
    return _json({attachments: results, count: results.length});
  }

  // --- Sheets (extended) ---

  function _sheetsCreate(req) {
    if (!req.name) return _json({error: 'missing name'});
    var ss = SpreadsheetApp.create(req.name);
    if (req.headers) ss.getActiveSheet().appendRow(req.headers);
    return _json({id: ss.getId(), name: req.name, url: ss.getUrl()});
  }

  function _sheetsUpdate(req) {
    if (!req.spreadsheet_id) return _json({error: 'missing spreadsheet_id'});
    if (!req.range) return _json({error: 'missing range'});
    if (!req.values) return _json({error: 'missing values'});
    SpreadsheetApp.openById(req.spreadsheet_id).getRange(req.range).setValues(req.values);
    return _json({status: 'updated', range: req.range});
  }

  // --- Drive (extended) ---

  function _driveUpload(req) {
    if (!req.name) return _json({error: 'missing name'});
    if (!req.data_base64) return _json({error: 'missing data_base64'});
    var blob = Utilities.newBlob(Utilities.base64Decode(req.data_base64), req.mime || 'application/octet-stream', req.name);
    var file;
    if (req.folder_id) {
      file = DriveApp.getFolderById(req.folder_id).createFile(blob);
    } else {
      file = DriveApp.createFile(blob);
    }
    return _json({id: file.getId(), name: file.getName(), url: file.getUrl(), size: file.getSize()});
  }

  function _driveDownload(req) {
    if (!req.id) return _json({error: 'missing id'});
    var file = DriveApp.getFileById(req.id);
    var blob = file.getBlob();
    return _json({
      id: file.getId(), name: file.getName(), mimeType: blob.getContentType(),
      size: file.getSize(), data: Utilities.base64Encode(blob.getBytes())
    });
  }

  // --- Calendar (extended) ---

  function _calendarGet(req) {
    if (!req.event_id) return _json({error: 'missing event_id'});
    var cal = req.calendarId ? CalendarApp.getCalendarById(req.calendarId) : CalendarApp.getDefaultCalendar();
    var ev = cal.getEventById(req.event_id);
    if (!ev) return _json({error: 'event not found'});
    return _json({
      id: ev.getId(), title: ev.getTitle(),
      start: ev.getStartTime().toISOString(), end: ev.getEndTime().toISOString(),
      description: ev.getDescription(), location: ev.getLocation(),
      attendees: ev.getGuestList().map(function(g) { return g.getEmail(); }),
      allDay: ev.isAllDayEvent()
    });
  }

  function _calendarCreate(req) {
    if (!req.title) return _json({error: 'missing title'});
    if (!req.start || !req.end) return _json({error: 'missing start or end'});
    var cal = req.calendarId ? CalendarApp.getCalendarById(req.calendarId) : CalendarApp.getDefaultCalendar();
    var opts = {};
    if (req.description) opts.description = req.description;
    if (req.location) opts.location = req.location;
    if (req.guests) opts.guests = req.guests;
    var ev = cal.createEvent(req.title, new Date(req.start), new Date(req.end), opts);
    return _json({status: 'created', id: ev.getId(), title: req.title, start: req.start, end: req.end});
  }

  function _calendarDelete(req) {
    if (!req.event_id) return _json({error: 'missing event_id'});
    var cal = req.calendarId ? CalendarApp.getCalendarById(req.calendarId) : CalendarApp.getDefaultCalendar();
    var ev = cal.getEventById(req.event_id);
    if (!ev) return _json({error: 'event not found'});
    ev.deleteEvent();
    return _json({status: 'deleted', event_id: req.event_id});
  }

  function _calendarCalendars(req) {
    var cals = CalendarApp.getAllCalendars().map(function(c) {
      return {
        id: c.getId(), name: c.getName(), description: c.getDescription(),
        selected: c.isSelected(), owned: c.isOwnedByMe()
      };
    });
    return _json({calendars: cals, count: cals.length});
  }

  // --- Tasks (extended) ---

  function _tasksCreate(req) {
    if (!req.title) return _json({error: 'missing title'});
    try {
      var listId = req.list_id || Tasks.Tasklists.list().items[0].id;
      var resource = {title: req.title};
      if (req.notes) resource.notes = req.notes;
      if (req.due) resource.due = req.due;
      if (req.status) resource.status = req.status;
      var task = Tasks.Tasks.insert(resource, listId);
      return _json({id: task.id, title: task.title, status: task.status, listId: listId});
    } catch (e) {
      return _json({error: 'Tasks API error', detail: e.message});
    }
  }

  function _tasksUpdate(req) {
    if (!req.task_id) return _json({error: 'missing task_id'});
    try {
      var listId = req.list_id || Tasks.Tasklists.list().items[0].id;
      var resource = {};
      if (req.title) resource.title = req.title;
      if (req.notes !== undefined) resource.notes = req.notes;
      if (req.status) resource.status = req.status;
      if (req.due) resource.due = req.due;
      var task = Tasks.Tasks.patch(resource, listId, req.task_id);
      return _json({id: task.id, title: task.title, status: task.status});
    } catch (e) {
      return _json({error: 'Tasks API error', detail: e.message});
    }
  }

  // --- Helpers ---

  function _isEnabled(property) {
    return PropertiesService.getScriptProperties().getProperty(property) === 'true';
  }

  function _json(obj) {
    return ContentService.createTextOutput(JSON.stringify(obj))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // --- Setup Functions (run from the Apps Script editor) ---

  function initKey() {
    var key = Utilities.getUuid();
    PropertiesService.getScriptProperties().setProperty('BRIDGE_KEY', key);
    Logger.log('Your bridge key: ' + key);
    Logger.log('Store this securely. Use it in the "key" field of every POST request.');
  }

  function getKey() {
    var key = PropertiesService.getScriptProperties().getProperty('BRIDGE_KEY');
    Logger.log(key ? 'Current key: ' + key : 'No key set. Run Bridge.initKey() first.');
  }

  function activateScopes() {
    var results = [];
    try { GmailApp.search('subject:test', 0, 1); results.push('Gmail: OK'); } catch (e) { results.push('Gmail: ' + e.message); }
    try { DriveApp.getFiles(); results.push('Drive: OK'); } catch (e) { results.push('Drive: ' + e.message); }
    try { var s = SpreadsheetApp.create('_scope_test'); DriveApp.getFileById(s.getId()).setTrashed(true); results.push('Sheets: OK'); } catch (e) { results.push('Sheets: ' + e.message); }
    try { var d = DocumentApp.create('_scope_test'); DriveApp.getFileById(d.getId()).setTrashed(true); results.push('Docs: OK'); } catch (e) { results.push('Docs: ' + e.message); }
    try { CalendarApp.getDefaultCalendar(); results.push('Calendar: OK'); } catch (e) { results.push('Calendar: ' + e.message); }
    try { ContactsApp.getContacts(); results.push('Contacts: OK'); } catch (e) { results.push('Contacts: ' + e.message); }
    try { UrlFetchApp.fetch('https://httpbin.org/get', {muteHttpExceptions: true}); results.push('UrlFetch: OK'); } catch (e) { results.push('UrlFetch: ' + e.message); }
    try { LanguageApp.translate('hello', 'en', 'es'); results.push('Translate: OK'); } catch (e) { results.push('Translate: ' + e.message); }
    try { results.push('Mail quota: ' + MailApp.getRemainingDailyQuota() + ' emails/day'); } catch (e) { results.push('MailApp: ' + e.message); }
    try { Tasks.Tasklists.list(); results.push('Tasks: OK'); } catch (e) { results.push('Tasks: enable via Services > Tasks API'); }
    results.push('OAuth token: ' + (ScriptApp.getOAuthToken() ? 'OK' : 'NONE'));
    Logger.log('=== Scope Activation ===\n' + results.join('\n'));
    return results;
  }

  // --- Enable/Disable Sensitive Actions (run from the Apps Script editor) ---

  function enableFetch() {
    PropertiesService.getScriptProperties().setProperty('FETCH_ENABLED', 'true');
    Logger.log('fetch action ENABLED.');
  }

  function disableFetch() {
    PropertiesService.getScriptProperties().deleteProperty('FETCH_ENABLED');
    Logger.log('fetch action DISABLED.');
  }

  function enableTokenGet() {
    PropertiesService.getScriptProperties().setProperty('TOKEN_GET_ENABLED', 'true');
    Logger.log('token.get action ENABLED.');
  }

  function disableTokenGet() {
    PropertiesService.getScriptProperties().deleteProperty('TOKEN_GET_ENABLED');
    Logger.log('token.get action DISABLED.');
  }

  // Public API
  return {
    doGet: doGet,
    doPost: doPost,
    initKey: initKey,
    getKey: getKey,
    activateScopes: activateScopes,
    enableFetch: enableFetch,
    disableFetch: disableFetch,
    enableTokenGet: enableTokenGet,
    disableTokenGet: disableTokenGet
  };

})();

// Top-level entry points required by Google Apps Script Web App
function doGet(e)  { return Bridge.doGet(e); }
function doPost(e) { return Bridge.doPost(e); }
