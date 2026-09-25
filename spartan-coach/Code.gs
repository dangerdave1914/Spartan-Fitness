/**
 * Spartan Coach — sheet bridge
 *
 * A standalone Apps Script web app that fronts the three Spartan sheets, so
 * the DigitalOcean server never needs a service-account key. The script runs
 * as whoever deploys it, so deploy it from the Google account that owns the
 * sheets (Spartan's, not a personal or Gauntlet account).
 *
 * ── Setup ────────────────────────────────────────────────────────────────
 * 1. Upload the three .xlsx files to that account's Drive and open each one
 *    (File → Save as Google Sheets if Drive didn't convert it). Copy each
 *    Sheet's ID from its URL: docs.google.com/spreadsheets/d/<ID>/edit
 * 2. script.google.com → New project → name it "Spartan Bridge".
 * 3. Paste this file in, replacing the default Code.gs.
 * 4. Project Settings (gear) → Script Properties → Add:
 *      SHARED_SECRET     = a long random string you invent
 *      CURRICULUM_ID     = ID of "Spartan Curriculum"
 *      PROGRAMMING_ID    = ID of "Spartan Conditioning Programming"
 *      OPS_ID            = ID of "Spartan Staff Ops"
 *      NOTIFY_TO         = (optional) emails alerted when a coach logs hours
 * 5. Deploy → New deployment → type: Web app
 *      Execute as: Me
 *      Who has access: Anyone
 *    "Anyone" means anyone with the URL can send a request, which is why the
 *    shared secret exists. Treat the URL + secret pair like a password.
 * 6. Authorize when prompted. The "unverified app" screen is normal for your
 *    own script: Advanced → Go to Spartan Bridge.
 * 7. Copy the /exec URL. That's APPS_SCRIPT_URL on the DigitalOcean side.
 *
 * Re-deploy after any edit: Deploy → Manage deployments → pencil icon →
 * Version: New version → Deploy. Editing the code alone does NOT update the
 * live URL.
 */

const PROPS = PropertiesService.getScriptProperties();
function sheetId(name) {
  return PROPS.getProperty({ curriculum: 'CURRICULUM_ID', programming: 'PROGRAMMING_ID', ops: 'OPS_ID' }[name] || '');
}

/** Tabs the app writes to. Created on first use if they're missing. */
const LOGS = {
  Staff:    ['Name', 'Email', 'Role', 'Joined'],
  Hours:    ['Logged', 'Date', 'Coach', 'Email', 'Type', 'Class / Detail', 'Hours', 'Note', 'Status', 'Approved By'],
  Settings: ['Key', 'Value', 'Note'],
  Sales:    ['Logged', 'Date', 'Staff', 'Email', 'Type', 'Item / Member', 'Amount', 'Commission', 'Status', 'Approved By', 'Source', 'Note'],
  'Inventory Log': ['Logged', 'Item', 'Variant', 'Type', 'Change', 'On Hand After', 'By', 'Note'],
  Renewals: ['Logged', 'Member', 'Coach', 'Anniversary', 'Renewed On', 'Outcome', 'Recorded By'],
};

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json({ error: 'bad_request' }); }

  const secret = PROPS.getProperty('SHARED_SECRET');
  if (!secret || body.secret !== secret) return json({ error: 'unauthorized' });

  const id = sheetId(body.sheet);
  if (!id) return json({ error: 'unknown_sheet ' + body.sheet + ' (check the *_ID script properties)' });

  try {
    switch (body.action) {
      case 'tabs':   return json({ tabs: tabs(id) });
      case 'grid':   return json({ values: grid(id, body.tab) });
      case 'grids':  return json({ grids: (body.tabs || []).map(t => grid(id, t)) });
      case 'update': return json({ ok: update(id, body.tab, body.range, body.values) });
      case 'append': return json({ ok: append(id, body.tab, body.row, body.notify) });
      case 'delete': return json({ ok: deleteRow(id, body.tab, body.rowIndex) });
      default:       return json({ error: 'unknown_action' });
    }
  } catch (err) {
    return json({ error: String(err && err.message || err) });
  }
}

const BUILD = 'spartan-build-2';
function doGet() {
  return ContentService.createTextOutput(
    'spartan bridge ok — ' + BUILD + ' — actions: tabs, grid, grids, update, append, delete');
}

function tabs(id) {
  return SpreadsheetApp.openById(id).getSheets().map(s => s.getName());
}

/** Display values, so dates and numbers arrive as coaches see them. */
function grid(id, tabName) {
  const sheet = SpreadsheetApp.openById(id).getSheetByName(tabName);
  if (!sheet) throw new Error('no tab named ' + tabName);
  const range = sheet.getDataRange();
  return range.getNumRows() ? range.getDisplayValues() : [];
}

function update(id, tabName, a1, values) {
  const sheet = SpreadsheetApp.openById(id).getSheetByName(tabName);
  if (!sheet) throw new Error('no tab named ' + tabName);
  sheet.getRange(a1).setNumberFormat('@').setValues(values);
  SpreadsheetApp.flush();
  return true;
}

function append(id, tabName, row, notify) {
  const ss = SpreadsheetApp.openById(id);
  let sheet = ss.getSheetByName(tabName);
  if (!sheet) {
    sheet = ss.insertSheet(tabName);
    const headers = LOGS[tabName];
    if (headers) {
      sheet.appendRow(headers);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
  }
  // Written as plain text: appendRow would let Sheets turn "2026-09-22" into a
  // locale date and an ISO timestamp into a datetime, and the server matches on
  // the exact strings it wrote.
  const r = sheet.getLastRow() + 1;
  sheet.getRange(r, 1, 1, row.length).setNumberFormat('@').setValues([row.map(v => v == null ? '' : String(v))]);
  SpreadsheetApp.flush();
  if (notify && notify.subject) {
    const to = PROPS.getProperty('NOTIFY_TO');
    if (to) {
      try { MailApp.sendEmail({ to: to, subject: notify.subject, body: notify.body || '' }); }
      catch (err) { console.error('notify failed: ' + err); }  // the row is the record; mail is a courtesy
    }
  }
  return true;
}

/** Removes a row outright. Row 1 is headers and is never deletable. */
function deleteRow(id, tabName, rowIndex) {
  const sheet = SpreadsheetApp.openById(id).getSheetByName(tabName);
  if (!sheet) throw new Error('no tab named ' + tabName);
  const n = Number(rowIndex);
  if (!(n > 1) || n > sheet.getLastRow()) throw new Error('bad row ' + rowIndex);
  sheet.deleteRow(n);
  SpreadsheetApp.flush();
  return true;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
