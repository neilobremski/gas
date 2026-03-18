/*
 * GAS Bridge v2.0 — Turn Google Apps Script Into a Key-Based API
 *
 * Deploys as a Web App and exposes Google Workspace services (Gmail, Drive,
 * Sheets, Calendar, Docs, Contacts, Translate, and Tasks) via simple JSON POST
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

  // --- Action Handlers (alphabetized) ---

  var HANDLERS = {
    'calendar.calendars': _calendarCalendars,
    'calendar.create':    _calendarCreate,
    'calendar.delete':    _calendarDelete,
    'calendar.list':      _calendarList,
    'config.get':         _configGet,
    'config.set':         _configSet,
    'contacts.list':      _contactsList,
    'docs.create':        _docsCreate,
    'drive.create':       _driveCreate,
    'drive.download':     _driveDownload,
    'drive.list':         _driveList,
    'drive.upload':       _driveUpload,
    'fetch':              _fetch,
    'gemini.ask':         _geminiAsk,
    'gmail.archive':      _gmailArchive,
    'gmail.check':        _gmailSearch,  // alias for backwards compatibility
    'gmail.attachments':  _gmailAttachments,
    'gmail.draft.create': _gmailDraftCreate,
    'gmail.draft.delete': _gmailDraftDelete,
    'gmail.draft.get':    _gmailDraftGet,
    'gmail.draft.list':   _gmailDraftList,
    'gmail.draft.send':   _gmailDraftSend,
    'gmail.get':          _gmailGet,
    'gmail.label':        _gmailLabel,
    'gmail.read':         _gmailRead,
    'gmail.reply':        _gmailReply,
    'gmail.search':       _gmailSearch,
    'gmail.send':         _gmailSend,
    'info':               _info,
    'sheets.append':      _sheetsAppend,
    'sheets.create':      _sheetsCreate,
    'sheets.read':        _sheetsRead,
    'sheets.update':      _sheetsUpdate,
    'tasks.create':       _tasksCreate,
    'tasks.list':         _tasksList,
    'tasks.update':       _tasksUpdate,
    'token.get':          _tokenGet,
    'translate':          _translate,
  };

  // =========================================================================
  //  Calendar
  // =========================================================================

  function _calendarCalendars(req) {
    var calendars = CalendarApp.getAllCalendars().map(function(cal) {
      return {
        id: cal.getId(),
        name: cal.getName(),
        description: cal.getDescription(),
        selected: cal.isSelected(),
        owned: cal.isOwnedByMe()
      };
    });
    return _json({calendars: calendars, count: calendars.length});
  }

  function _calendarCreate(req) {
    if (!req.title) return _json({error: 'missing title'});
    if (!req.start) return _json({error: 'missing start'});
    if (!req.end) return _json({error: 'missing end'});
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

  function _calendarList(req) {
    var now = new Date(), end = new Date(now.getTime() + (req.days || 7) * 86400000);
    var cal = req.calendarId ? CalendarApp.getCalendarById(req.calendarId) : CalendarApp.getDefaultCalendar();
    var events = cal.getEvents(now, end).map(function(ev) {
      return {
        id: ev.getId(), title: ev.getTitle(),
        description: ev.getDescription(),
        start: ev.getStartTime().toISOString(), end: ev.getEndTime().toISOString(),
        location: ev.getLocation()
      };
    });
    return _json({events: events, count: events.length});
  }

  // =========================================================================
  //  Config (disabled by default — run Bridge.enableConfig() to enable)
  // =========================================================================

  var PROTECTED_KEYS = ['BRIDGE_KEY'];

  function _configGet(req) {
    if (!_isEnabled('CONFIG_ENABLED')) {
      return _json({error: 'config.get is disabled. Run Bridge.enableConfig() from the Apps Script editor to enable it.'});
    }
    var props = PropertiesService.getScriptProperties().getProperties();
    // Never expose protected keys
    PROTECTED_KEYS.forEach(function(k) { delete props[k]; });
    if (req.key) {
      if (PROTECTED_KEYS.indexOf(req.key) !== -1) return _json({error: 'access denied'});
      var val = PropertiesService.getScriptProperties().getProperty(req.key);
      return _json({key: req.key, value: val});
    }
    return _json({config: props, count: Object.keys(props).length});
  }

  function _configSet(req) {
    if (!_isEnabled('CONFIG_ENABLED')) {
      return _json({error: 'config.set is disabled. Run Bridge.enableConfig() from the Apps Script editor to enable it.'});
    }
    if (!req.config || typeof req.config !== 'object') return _json({error: 'missing config object'});
    var props = PropertiesService.getScriptProperties();
    var set = 0;
    for (var k in req.config) {
      if (PROTECTED_KEYS.indexOf(k) !== -1) continue; // silently skip protected keys
      props.setProperty(k, req.config[k]);
      set++;
    }
    return _json({status: 'ok', properties_set: set});
  }

  // =========================================================================
  //  Contacts
  // =========================================================================

  function _contactsList(req) {
    var contacts = ContactsApp.getContacts();
    var count = req.count || 20;
    var results = contacts.slice(0, count).map(function(c) {
      var emails = c.getEmails();
      var phones = c.getPhones();
      return {
        name: c.getFullName(),
        email: emails.length > 0 ? emails[0].getAddress() : null,
        phone: phones.length > 0 ? phones[0].getPhoneNumber() : null
      };
    });
    return _json({contacts: results, count: results.length});
  }

  // =========================================================================
  //  Docs
  // =========================================================================

  function _docsCreate(req) {
    if (!req.title) return _json({error: 'missing title'});
    var doc = DocumentApp.create(req.title);
    if (req.body) doc.getBody().appendParagraph(req.body);
    return _json({id: doc.getId(), title: req.title, url: doc.getUrl()});
  }

  // =========================================================================
  //  Drive
  // =========================================================================

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

  function _driveDownload(req) {
    if (!req.id && req.name) req.id = _resolveByName(req.name);
    if (!req.id) return _json({error: 'missing id or name'});
    var file = DriveApp.getFileById(req.id);
    var blob = file.getBlob();
    return _json({
      id: req.id,
      name: file.getName(),
      mimeType: blob.getContentType(),
      size: file.getSize(),
      data: Utilities.base64Encode(blob.getBytes())
    });
  }

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

  function _driveUpload(req) {
    if (!req.name) return _json({error: 'missing name'});
    if (!req.data_base64) return _json({error: 'missing data_base64'});
    var blob = Utilities.newBlob(Utilities.base64Decode(req.data_base64), req.mime || 'application/octet-stream', req.name);
    var folder = req.folder_id ? DriveApp.getFolderById(req.folder_id) : DriveApp.getRootFolder();
    var file = folder.createFile(blob);
    return _json({id: file.getId(), name: file.getName(), url: file.getUrl(), size: file.getSize()});
  }

  // =========================================================================
  //  Gmail
  // =========================================================================

  // =========================================================================
  //  Gemini (uses API key from Script Properties, or falls back to OAuth)
  // =========================================================================

  function _geminiAsk(req) {
    if (!req.prompt) return _json({error: 'missing prompt'});
    var model = req.model || 'gemini-2.0-flash';
    var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
    var headers = {};
    if (apiKey) {
      url += '?key=' + apiKey;
    } else {
      headers['Authorization'] = 'Bearer ' + ScriptApp.getOAuthToken();
    }
    var body = {contents: [{parts: [{text: req.prompt}]}]};
    if (req.system) {
      body.systemInstruction = {parts: [{text: req.system}]};
    }
    body.generationConfig = {maxOutputTokens: req.maxTokens || 2048, temperature: req.temperature || 0.7};
    var resp = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      headers: headers, payload: JSON.stringify(body), muteHttpExceptions: true
    });
    var data = JSON.parse(resp.getContentText());
    var text = '';
    try { text = data.candidates[0].content.parts[0].text; } catch (e) {}
    return _json({text: text, model: model, usage: data.usageMetadata || {}});
  }

  // =========================================================================
  //  Gmail
  // =========================================================================

  function _gmailArchive(req) {
    if (!req.thread_id) return _json({error: 'missing thread_id'});
    var thread = GmailApp.getThreadById(req.thread_id);
    thread.markRead();
    thread.moveToArchive();
    return _json({status: 'archived', thread_id: req.thread_id});
  }

  function _gmailAttachments(req) {
    if (!req.message_id && !req.thread_id) return _json({error: 'missing message_id or thread_id'});
    var messages = [];
    if (req.message_id) {
      messages.push(GmailApp.getMessageById(req.message_id));
    } else {
      messages = GmailApp.getThreadById(req.thread_id).getMessages();
    }
    var attachments = [];
    messages.forEach(function(msg) {
      var msgId = msg.getId();
      msg.getAttachments().forEach(function(a) {
        var item = {
          filename: a.getName(),
          mimeType: a.getContentType(),
          size: a.getSize(),
          message_id: msgId
        };
        if (a.getSize() <= 1048576) {
          item.data = Utilities.base64Encode(a.getBytes());
        }
        if (req.save_to_drive) {
          var folder = req.folder_id ? DriveApp.getFolderById(req.folder_id) : DriveApp.getRootFolder();
          var saved = folder.createFile(a);
          item.drive_id = saved.getId();
          item.drive_url = saved.getUrl();
        }
        attachments.push(item);
      });
    });
    return _json({attachments: attachments, count: attachments.length});
  }

  function _gmailDraftCreate(req) {
    if (!req.to) return _json({error: 'missing "to"'});
    var draft = GmailApp.createDraft(req.to, req.subject || '(no subject)', req.body || '',
      req.html ? {htmlBody: req.body} : {});
    var msg = draft.getMessage();
    return _json({id: draft.getId(), message_id: msg.getId(), to: req.to, subject: req.subject});
  }

  function _gmailDraftDelete(req) {
    if (!req.draft_id) return _json({error: 'missing draft_id'});
    var drafts = GmailApp.getDrafts();
    for (var i = 0; i < drafts.length; i++) {
      if (drafts[i].getId() === req.draft_id) {
        drafts[i].deleteDraft();
        return _json({status: 'deleted', draft_id: req.draft_id});
      }
    }
    return _json({error: 'draft not found', draft_id: req.draft_id});
  }

  function _gmailDraftGet(req) {
    if (!req.draft_id) return _json({error: 'missing draft_id'});
    var drafts = GmailApp.getDrafts();
    for (var i = 0; i < drafts.length; i++) {
      if (drafts[i].getId() === req.draft_id) {
        var msg = drafts[i].getMessage();
        return _json({
          id: drafts[i].getId(),
          message_id: msg.getId(),
          subject: msg.getSubject(),
          to: msg.getTo(),
          body: msg.getPlainBody(),
          html: msg.getBody(),
          date: msg.getDate().toISOString()
        });
      }
    }
    return _json({error: 'draft not found', draft_id: req.draft_id});
  }

  function _gmailDraftList(req) {
    var drafts = GmailApp.getDrafts();
    var count = req.count || 10;
    var results = drafts.slice(0, count).map(function(d) {
      var msg = d.getMessage();
      return {
        id: d.getId(),
        message_id: msg.getId(),
        subject: msg.getSubject(),
        to: msg.getTo(),
        date: msg.getDate().toISOString()
      };
    });
    return _json({drafts: results, count: results.length});
  }

  function _gmailDraftSend(req) {
    if (!req.draft_id) return _json({error: 'missing draft_id'});
    var drafts = GmailApp.getDrafts();
    for (var i = 0; i < drafts.length; i++) {
      if (drafts[i].getId() === req.draft_id) {
        var msg = drafts[i].send();
        return _json({status: 'sent', message_id: msg.getId(), subject: msg.getSubject()});
      }
    }
    return _json({error: 'draft not found', draft_id: req.draft_id});
  }

  function _gmailGet(req) {
    if (!req.thread_id) return _json({error: 'missing thread_id'});
    var thread = GmailApp.getThreadById(req.thread_id);
    var messages = thread.getMessages().map(function(m) {
      return {
        id: m.getId(),
        subject: m.getSubject(),
        from: m.getFrom(),
        to: m.getTo(),
        cc: m.getCc(),
        date: m.getDate().toISOString(),
        plain: m.getPlainBody().substring(0, 300),
        html: m.getBody(),
        attachments: m.getAttachments().map(function(a) {
          return {name: a.getName(), type: a.getContentType(), size: a.getSize()};
        }),
        starred: m.isStarred()
      };
    });
    return _json({thread_id: req.thread_id, messages: messages, count: messages.length});
  }

  function _gmailLabel(req) {
    if (!req.thread_id) return _json({error: 'missing thread_id'});
    var thread = GmailApp.getThreadById(req.thread_id);
    if (req.add) {
      var addLabel = GmailApp.getUserLabelByName(req.add) || GmailApp.createLabel(req.add);
      thread.addLabel(addLabel);
    }
    if (req.remove) {
      var removeLabel = GmailApp.getUserLabelByName(req.remove);
      if (removeLabel) thread.removeLabel(removeLabel);
    }
    return _json({status: 'labeled', thread_id: req.thread_id});
  }

  function _gmailRead(req) {
    if (!req.thread_id) return _json({error: 'missing thread_id'});
    var thread = GmailApp.getThreadById(req.thread_id);
    thread.markRead();
    return _json({status: 'marked_read', thread_id: req.thread_id});
  }

  function _gmailReply(req) {
    if (!req.thread_id) return _json({error: 'missing thread_id'});
    if (!req.body) return _json({error: 'missing body'});
    var thread = GmailApp.getThreadById(req.thread_id);
    var msgs = thread.getMessages();
    var me = Session.getActiveUser().getEmail().toLowerCase();
    var msg = msgs[msgs.length - 1];
    for (var i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].getFrom().toLowerCase().indexOf(me) === -1) {
        msg = msgs[i];
        break;
      }
    }
    var opts = {};
    if (req.html) opts.htmlBody = _escapeAstral(req.body);
    if (req.cc) opts.cc = req.cc;
    if (req.inlineImages) {
      var imgs = {};
      for (var k in req.inlineImages) {
        var img = req.inlineImages[k];
        imgs[k] = Utilities.newBlob(Utilities.base64Decode(img.data), img.mimeType || 'image/png', k);
      }
      opts.inlineImages = imgs;
    }
    _attachDriveImages(req, opts);
    msg.reply(req.body, opts);
    return _json({status: 'replied', thread_id: req.thread_id, subject: msg.getSubject()});
  }

  function _gmailSearch(req) {
    var threads = GmailApp.search(req.query || 'is:unread', 0, req.count || 10);
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

  function _gmailSend(req) {
    if (!req.to) return _json({error: 'missing "to"'});
    var opts = {};
    if (req.cc) opts.cc = req.cc;
    if (req.bcc) opts.bcc = req.bcc;
    if (req.html) opts.htmlBody = _escapeAstral(req.body);
    if (req.replyTo) opts.replyTo = req.replyTo;
    // Client-side inline images (base64 from caller)
    if (req.inlineImages) {
      var imgs = {};
      for (var k in req.inlineImages) {
        var img = req.inlineImages[k];
        imgs[k] = Utilities.newBlob(Utilities.base64Decode(img.data), img.mimeType || 'image/png', k);
      }
      opts.inlineImages = imgs;
    }
    // Server-side Drive images (zero transfer cost — pulled from Drive by GAS)
    // Small files (<0.5MB): inlined as CID. Large files: set public and embedded as URL.
    // In HTML body, use {{img0}}, {{img1}} as placeholders; if absent, images are appended.
    _attachDriveImages(req, opts);
    if (req.attachments) {
      opts.attachments = req.attachments.map(function(a) {
        return Utilities.newBlob(Utilities.base64Decode(a.data), a.mimeType || 'application/octet-stream', a.name);
      });
    }
    GmailApp.sendEmail(req.to, req.subject || '(no subject)', req.body || '', opts);
    return _json({status: 'sent', to: req.to, subject: req.subject});
  }

  // =========================================================================
  //  Info
  // =========================================================================

  function _info(req) {
    return _json({
      service: 'GAS Bridge',
      version: '2.0',
      account: Session.getActiveUser().getEmail(),
      actions: Object.keys(HANDLERS),
      timestamp: new Date().toISOString()
    });
  }

  // =========================================================================
  //  Sheets
  // =========================================================================

  function _sheetsAppend(req) {
    if (!req.spreadsheet_id && req.name) req.spreadsheet_id = _resolveByName(req.name, 'application/vnd.google-apps.spreadsheet');
    if (!req.spreadsheet_id) return _json({error: 'missing spreadsheet_id or name'});
    if (!req.rows || !req.rows.length) return _json({error: 'no rows'});
    var sheet = SpreadsheetApp.openById(req.spreadsheet_id).getSheetByName(req.sheet || 'Sheet1');
    if (!sheet) return _json({error: 'sheet not found'});
    req.rows.forEach(function(row) { sheet.appendRow(row); });
    return _json({status: 'appended', rows_added: req.rows.length});
  }

  function _sheetsCreate(req) {
    if (!req.name) return _json({error: 'missing name'});
    var ss = SpreadsheetApp.create(req.name);
    if (req.headers) ss.getActiveSheet().appendRow(req.headers);
    return _json({id: ss.getId(), name: req.name, url: ss.getUrl()});
  }

  function _sheetsRead(req) {
    if (!req.spreadsheet_id && req.name) req.spreadsheet_id = _resolveByName(req.name, 'application/vnd.google-apps.spreadsheet');
    if (!req.spreadsheet_id) return _json({error: 'missing spreadsheet_id or name'});
    var data = SpreadsheetApp.openById(req.spreadsheet_id)
      .getRange(req.range || 'Sheet1!A1:Z100').getValues();
    while (data.length > 0 && data[data.length - 1].every(function(c) { return c === ''; })) data.pop();
    return _json({rows: data, count: data.length});
  }

  function _sheetsUpdate(req) {
    if (!req.spreadsheet_id && req.name) req.spreadsheet_id = _resolveByName(req.name, 'application/vnd.google-apps.spreadsheet');
    if (!req.spreadsheet_id) return _json({error: 'missing spreadsheet_id or name'});
    if (!req.range) return _json({error: 'missing range'});
    if (!req.values) return _json({error: 'missing values (2D array)'});
    SpreadsheetApp.openById(req.spreadsheet_id).getRange(req.range).setValues(req.values);
    return _json({status: 'updated', range: req.range});
  }

  // =========================================================================
  //  Tasks
  // =========================================================================

  function _tasksCreate(req) {
    try {
      if (!req.title) return _json({error: 'missing title'});
      var listId = req.list_id;
      if (!listId) {
        var lists = Tasks.Tasklists.list();
        listId = lists.items[0].id;
      }
      var resource = {title: req.title};
      if (req.notes) resource.notes = req.notes;
      if (req.due) resource.due = req.due;
      if (req.status) resource.status = req.status;
      var t = Tasks.Tasks.insert(resource, listId);
      return _json({id: t.id, title: t.title, status: t.status, listId: listId});
    } catch (e) {
      return _json({error: 'Tasks API not enabled. Add via Services > Tasks API.', detail: e.message});
    }
  }

  function _tasksList(req) {
    try {
      var taskLists = Tasks.Tasklists.list();
      var results = taskLists.items.map(function(list) {
        var tasks = Tasks.Tasks.list(list.id);
        return {
          list: list.title,
          list_id: list.id,
          tasks: (tasks.items || []).map(function(t) {
            return {id: t.id, title: t.title, status: t.status, due: t.due || null, notes: t.notes || null};
          })
        };
      });
      return _json({taskLists: results});
    } catch (e) {
      return _json({error: 'Tasks API not enabled. Add via Services > Tasks API.', detail: e.message});
    }
  }

  function _tasksUpdate(req) {
    try {
      if (!req.task_id) return _json({error: 'missing task_id'});
      if (!req.list_id) return _json({error: 'missing list_id'});
      var resource = {};
      if (req.title) resource.title = req.title;
      if (req.notes) resource.notes = req.notes;
      if (req.status) resource.status = req.status;
      if (req.due) resource.due = req.due;
      var t = Tasks.Tasks.patch(resource, req.list_id, req.task_id);
      return _json({id: t.id, title: t.title, status: t.status});
    } catch (e) {
      return _json({error: 'Tasks API not enabled. Add via Services > Tasks API.', detail: e.message});
    }
  }

  // =========================================================================
  //  Translate
  // =========================================================================

  function _translate(req) {
    if (!req.text) return _json({error: 'missing text'});
    var result = LanguageApp.translate(req.text, req.from || 'auto', req.to || 'en');
    return _json({translated: result, from: req.from || 'auto', to: req.to || 'en'});
  }

  // =========================================================================
  //  Fetch (disabled by default — run Bridge.enableFetch() to enable)
  // =========================================================================

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

  // =========================================================================
  //  Token (disabled by default — run Bridge.enableTokenGet() to enable)
  // =========================================================================

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

  // =========================================================================
  //  Helpers
  // =========================================================================

  // Pull images from Google Drive and attach inline. Zero transfer cost from the client.
  // driveImages: array of Drive file IDs. Small files (<0.5MB) become CID inline attachments.
  // Large files are set to public and embedded as <img src="URL">.
  // In HTML body, use {{img0}}, {{img1}} etc. as placeholders. If absent, images are appended.
  function _attachDriveImages(req, opts) {
    if (!req.driveImages || !req.driveImages.length) return;
    var inlineImgs = opts.inlineImages || {};
    var htmlBody = opts.htmlBody || req.body || '';
    for (var i = 0; i < req.driveImages.length; i++) {
      var fileId = req.driveImages[i];
      var key = 'img' + i;
      try {
        var file = DriveApp.getFileById(fileId);
        var blob = file.getBlob();
        if (blob.getBytes().length < 524288) { // < 0.5 MB
          inlineImgs[key] = blob;
          if (htmlBody.indexOf('{{' + key + '}}') !== -1) {
            htmlBody = htmlBody.replace('{{' + key + '}}', '<img src="cid:' + key + '">');
          } else {
            htmlBody += '<br><img src="cid:' + key + '" style="max-width:500px;">';
          }
        } else {
          file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
          var url = 'https://drive.google.com/uc?export=view&id=' + fileId;
          if (htmlBody.indexOf('{{' + key + '}}') !== -1) {
            htmlBody = htmlBody.replace('{{' + key + '}}', '<img src="' + url + '">');
          } else {
            htmlBody += '<br><img src="' + url + '" style="max-width:500px;">';
          }
        }
      } catch (e) {
        Logger.log('driveImages error for ' + fileId + ': ' + e);
      }
    }
    opts.htmlBody = htmlBody;
    if (Object.keys(inlineImgs).length) opts.inlineImages = inlineImgs;
  }

  // Convert 4-byte emoji (astral plane, U+10000+) to HTML numeric entities.
  // GAS's JS runtime uses UCS-2 and mangles surrogate pairs. Email clients
  // render &#x1F419; as the octopus emoji correctly.
  function _resolveByName(name, mimeType) {
    // Search Drive by name (and optionally MIME type). Returns newest match or null.
    var query = "title = '" + name.replace(/'/g, "\\'") + "'";
    if (mimeType) query += " and mimeType = '" + mimeType + "'";
    var iter = DriveApp.searchFiles(query);
    var best = null;
    while (iter.hasNext()) {
      var f = iter.next();
      if (!best || f.getLastUpdated() > best.getLastUpdated()) best = f;
    }
    return best ? best.getId() : null;
  }

  function _escapeAstral(str) {
    if (!str) return str;
    return str.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, function(pair) {
      var code = (pair.charCodeAt(0) - 0xD800) * 0x400 + (pair.charCodeAt(1) - 0xDC00) + 0x10000;
      return '&#x' + code.toString(16).toUpperCase() + ';';
    });
  }

  function _isEnabled(property) {
    return PropertiesService.getScriptProperties().getProperty(property) === 'true';
  }

  function _json(obj) {
    // ContentService defaults to UTF-8. Do NOT call setCharset() — it has caused
    // bridge-down crashes in production (see commit 7b9ca9e). The default is correct.
    return ContentService.createTextOutput(JSON.stringify(obj))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // =========================================================================
  //  Setup Functions (run from the Apps Script editor)
  // =========================================================================

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

  function enableConfig() {
    PropertiesService.getScriptProperties().setProperty('CONFIG_ENABLED', 'true');
    Logger.log('config.get and config.set actions ENABLED. BRIDGE_KEY is always protected.');
  }

  function disableConfig() {
    PropertiesService.getScriptProperties().deleteProperty('CONFIG_ENABLED');
    Logger.log('config.get and config.set actions DISABLED.');
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
    disableTokenGet: disableTokenGet,
    enableConfig: enableConfig,
    disableConfig: disableConfig
  };

})();

// Top-level entry points required by Google Apps Script Web App
function doGet(e)  { return Bridge.doGet(e); }
function doPost(e) { return Bridge.doPost(e); }
