/*
 * GasBridge - Web API Gateway for Google Apps Script
 * by Neil C. Obremski & Knobert, February 2026
 *
 * Turns a Google Apps Script project into a RESTful web service that exposes
 * Google Workspace APIs (Gmail, Drive, Sheets, Calendar, Docs, Contacts,
 * Translate) via simple JSON POST requests. Includes an OAuth token endpoint
 * and an HTTP proxy for calling external APIs from Google's servers.
 *
 * Usage:
 *
 * 1. Copy this file into your Apps Script project as GasBridge.gs
 * 2. Run Bridge.initKey() once to generate an auth key (check Execution Log)
 * 3. Run Bridge.activateScopes() to authorize all Google services
 * 4. Deploy as Web App: Execute as Me, Access: Anyone
 * 5. POST JSON to the deployment URL with {"action": "...", "key": "..."}
 *
 * Example (curl):
 *
 *   curl -L -X POST 'https://script.google.com/.../exec' \
 *     -H 'Content-Type: application/json' \
 *     -d '{"action":"gmail.send","key":"YOUR_KEY","to":"me@example.com",
 *          "subject":"Hello","body":"From GasBridge!"}'
 *
 * Actions:
 *
 *   gmail.send     - Send email (to, subject, body, cc, bcc, html, replyTo)
 *   gmail.check    - Search inbox (query, count)
 *   sheets.read    - Read spreadsheet (spreadsheet_id, range)
 *   sheets.append  - Append rows (spreadsheet_id, sheet, rows)
 *   drive.list     - List/search files (query, count)
 *   drive.create   - Create file (name, type, content, mime)
 *   docs.create    - Create Google Doc (title, body)
 *   calendar.list  - List events (days)
 *   contacts.list  - List contacts (count)
 *   tasks.list     - List Google Tasks (requires Tasks API enabled)
 *   translate      - Translate text (text, from, to)
 *   fetch          - HTTP proxy (url, method, headers, payload, contentType)
 *   token.get      - Get OAuth access token for direct API calls
 *   info           - Health check / list available actions
 *
 * Security:
 *
 *   All requests require a shared secret key stored in Script Properties.
 *   Generate with Bridge.initKey(). The key is checked on every POST.
 *
 * Notes:
 *
 *   - The token from token.get inherits scopes from services used by the
 *     script. Run activateScopes() to ensure all scopes are authorized.
 *   - The fetch action proxies HTTP requests through Google's servers,
 *     useful for calling APIs from environments with network restrictions.
 *   - Deploy updates: Manage Deployments > Edit > New Version > Deploy
 *     (the URL stays the same when updating an existing deployment).
 */

var Bridge = (function() {

  // --- Router ---

  function doPost(e) {
    try {
      var req = JSON.parse(e.postData.contents);
      var storedKey = PropertiesService.getScriptProperties().getProperty('BRIDGE_KEY');
      if (!storedKey || req.key !== storedKey) {
        return _json({error: 'unauthorized'});
      }

      var handlers = {
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
        'info':            _info,
      };

      var handler = handlers[req.action || ''];
      if (!handler) {
        return _json({error: 'unknown action', available: Object.keys(handlers)});
      }
      return handler(req);
    } catch (err) {
      return _json({error: err.message});
    }
  }

  // --- Gmail ---

  function _gmailSend(req) {
    if (!req.to) return _json({error: 'missing "to"'});
    var opts = {};
    if (req.cc) opts.cc = req.cc;
    if (req.bcc) opts.bcc = req.bcc;
    if (req.html) opts.htmlBody = req.body;
    if (req.replyTo) opts.replyTo = req.replyTo;
    GmailApp.sendEmail(req.to, req.subject || '(no subject)', req.body || '', opts);
    return _json({status: 'sent', to: req.to, subject: req.subject});
  }

  function _gmailCheck(req) {
    var threads = GmailApp.search(req.query || 'is:unread', 0, req.count || 5);
    var results = threads.map(function(thread) {
      var msg = thread.getMessages()[thread.getMessageCount()-1];
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
    while (data.length > 0 && data[data.length-1].every(function(c) { return c === ''; })) data.pop();
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
      files.push({id: f.getId(), name: f.getName(), type: f.getMimeType(),
                  size: f.getSize(), url: f.getUrl(), updated: f.getLastUpdated().toISOString()});
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
    var events = CalendarApp.getDefaultCalendar().getEvents(now, end).map(function(ev) {
      return {title: ev.getTitle(), start: ev.getStartTime().toISOString(),
              end: ev.getEndTime().toISOString(), location: ev.getLocation()};
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
    } catch(e) {
      return _json({error: 'Tasks API not enabled. Add via Services menu.', detail: e.message});
    }
  }

  // --- Translate ---

  function _translate(req) {
    if (!req.text) return _json({error: 'missing text'});
    var result = LanguageApp.translate(req.text, req.from || 'auto', req.to || 'en');
    return _json({translated: result, from: req.from || 'auto', to: req.to || 'en'});
  }

  // --- HTTP Proxy ---

  function _fetch(req) {
    if (!req.url) return _json({error: 'missing url'});
    var opts = {muteHttpExceptions: true, method: req.method || 'get'};
    if (req.headers) opts.headers = req.headers;
    if (req.payload) opts.payload = req.payload;
    if (req.contentType) opts.contentType = req.contentType;
    var resp = UrlFetchApp.fetch(req.url, opts);
    var body = resp.getContentText();
    try { body = JSON.parse(body); } catch(e) {}
    return _json({status: resp.getResponseCode(), headers: resp.getHeaders(), body: body});
  }

  // --- Token ---

  function _tokenGet(req) {
    return _json({
      access_token: ScriptApp.getOAuthToken(),
      expires_in: 3600,
      note: 'Scopes depend on which services have been activated.'
    });
  }

  // --- Info ---

  function _info(req) {
    return _json({
      service: 'GasBridge', version: '1.0',
      account: Session.getActiveUser().getEmail(),
      actions: ['gmail.send','gmail.check','sheets.read','sheets.append',
                'drive.list','drive.create','calendar.list','docs.create',
                'contacts.list','tasks.list','translate','fetch','token.get','info'],
      timestamp: new Date().toISOString()
    });
  }

  // --- Helpers ---

  function _json(obj) {
    return ContentService.createTextOutput(JSON.stringify(obj))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // --- Setup ---

  function initKey() {
    var key = Utilities.getUuid();
    PropertiesService.getScriptProperties().setProperty('BRIDGE_KEY', key);
    Logger.log('Key: ' + key);
  }

  function getKey() {
    Logger.log('Key: ' + PropertiesService.getScriptProperties().getProperty('BRIDGE_KEY'));
  }

  function activateScopes() {
    var results = [];
    try { GmailApp.search('subject:test', 0, 1); results.push('Gmail: OK'); } catch(e) { results.push('Gmail: ' + e.message); }
    try { DriveApp.getFiles(); results.push('Drive: OK'); } catch(e) { results.push('Drive: ' + e.message); }
    try { var s = SpreadsheetApp.create('_scope_test'); DriveApp.getFileById(s.getId()).setTrashed(true); results.push('Sheets: OK'); } catch(e) { results.push('Sheets: ' + e.message); }
    try { var d = DocumentApp.create('_scope_test'); DriveApp.getFileById(d.getId()).setTrashed(true); results.push('Docs: OK'); } catch(e) { results.push('Docs: ' + e.message); }
    try { CalendarApp.getDefaultCalendar(); results.push('Calendar: OK'); } catch(e) { results.push('Calendar: ' + e.message); }
    try { ContactsApp.getContacts(); results.push('Contacts: OK'); } catch(e) { results.push('Contacts: ' + e.message); }
    try { UrlFetchApp.fetch('https://httpbin.org/get', {muteHttpExceptions:true}); results.push('UrlFetch: OK'); } catch(e) { results.push('UrlFetch: ' + e.message); }
    try { LanguageApp.translate('hello', 'en', 'es'); results.push('Translate: OK'); } catch(e) { results.push('Translate: ' + e.message); }
    try { Maps.newGeocoder().geocode('New York'); results.push('Maps: OK'); } catch(e) { results.push('Maps: ' + e.message); }
    try { results.push('Quota: ' + MailApp.getRemainingDailyQuota() + ' emails/day'); } catch(e) { results.push('MailApp: ' + e.message); }
    try { Tasks.Tasklists.list(); results.push('Tasks: OK'); } catch(e) { results.push('Tasks: enable in Services'); }
    results.push('Token: ' + (ScriptApp.getOAuthToken() ? 'OK' : 'NONE'));
    Logger.log('=== Scope Activation ===\n' + results.join('\n'));
    return results;
  }

  // Public API
  return {
    doPost: doPost,
    initKey: initKey,
    getKey: getKey,
    activateScopes: activateScopes
  };

})();

// Top-level doPost required by GAS web app
function doPost(e) { return Bridge.doPost(e); }
