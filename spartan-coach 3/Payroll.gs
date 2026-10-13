/**
 * Spartan Payroll — menu and side panel for the Staff Ops sheet.
 *
 * This is NOT the bridge. It lives inside the Staff Ops spreadsheet itself:
 *   Staff Ops sheet → Extensions → Apps Script → paste this file → Save.
 * Then reload the sheet. A "Spartan Payroll" menu appears next to Help.
 * The first time Casey uses it, Google asks her to authorize it (Advanced →
 * Go to … → Allow), same as the bridge.
 *
 * Pay periods are semimonthly: 1st–15th and 16th–end of month, matching the app.
 * Statuses: Pending → Approved → Paid. Paid entries are locked in the app.
 */

const PAY = {
  HOURS: 'Hours', SALES: 'Sales', SCHEDULE: 'Schedule',
  SUMMARY: 'Payroll Summary', DETAIL: 'Staff Detail', CHECK: 'Payroll Check', EXPORT: 'Payroll Export',
  TYPES: ['Class', 'Private Lesson', 'Competition Coaching', 'Other'],
  MAX_DAY_HOURS: 10,
};

/* ---------------------------------------------------------------- menu */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Spartan Payroll')
    .addItem('Open payroll panel', 'payrollOpenPanel')
    .addSeparator()
    .addItem('Approve selected rows', 'payrollApproveSelection')
    .addToUi();
}

function payrollOpenPanel() {
  const html = HtmlService.createHtmlOutput(payrollPanelHtml_()).setTitle('Spartan Payroll');
  SpreadsheetApp.getUi().showSidebar(html);
}

/* ---------------------------------------------------------------- pure helpers (tested outside Sheets) */

function pad2_(n) { return String(n).padStart(2, '0'); }
function isoOf_(d) { return d.getFullYear() + '-' + pad2_(d.getMonth() + 1) + '-' + pad2_(d.getDate()); }

/** Dates arrive as text the app wrote ("2026-10-03"), as Date objects, or as typed "10/3/2026". */
function normDate_(v) {
  if (v instanceof Date && !isNaN(v)) return isoOf_(v);
  const s = String(v == null ? '' : v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  return m ? m[3] + '-' + pad2_(m[1]) + '-' + pad2_(m[2]) : s;
}

/** The semimonthly period containing date d, shifted by `back` periods. */
function periodOf_(d, back) {
  let y = d.getFullYear(), m = d.getMonth(), half = d.getDate() <= 15 ? 0 : 1;
  let idx = y * 24 + m * 2 + half - (back || 0);
  y = Math.floor(idx / 24); m = Math.floor((idx % 24) / 2); half = idx % 2;
  const from = new Date(y, m, half ? 16 : 1), to = half ? new Date(y, m + 1, 0) : new Date(y, m, 15);
  return { from: isoOf_(from), to: isoOf_(to) };
}

/** Header-keyed row objects. `_row` is the 1-based sheet row. */
function tableOf_(values) {
  if (!values.length) return [];
  const head = values[0].map(h => String(h).trim());
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const o = { _row: i + 1 };
    head.forEach((h, j) => { o[h] = values[i][j]; });
    if (Object.keys(o).some(k => k !== '_row' && String(o[k]).trim() !== '')) out.push(o);
  }
  return out;
}

const isPaid_ = s => /paid/i.test(String(s));
const isApproved_ = s => /approved|paid/i.test(String(s));
const isRejected_ = s => /rejected/i.test(String(s));
const num_ = v => { const n = Number(String(v).replace(/[$,]/g, '')); return isFinite(n) ? n : 0; };
const round2_ = n => Math.round(n * 100) / 100;

function inPeriod_(rows, p) { return rows.filter(r => { const d = normDate_(r.Date); return d >= p.from && d <= p.to; }); }

/** Per-person totals for a period. */
function summarize_(hours, sales, p) {
  const by = {};
  const get = (name, email) => {
    const k = String(email || name).toLowerCase();
    return by[k] = by[k] || { name: name, email: email, byType: {}, total: 0, approved: 0, pending: 0, privates: 0,
      commission: 0, commApproved: 0, commPending: 0, sales: 0 };
  };
  inPeriod_(hours, p).forEach(r => {
    if (isRejected_(r.Status)) return;
    const t = get(r.Coach, r.Email), h = num_(r.Hours), type = PAY.TYPES.indexOf(r.Type) >= 0 ? r.Type : 'Other';
    t.byType[type] = round2_((t.byType[type] || 0) + h);
    t.total = round2_(t.total + h);
    if (isApproved_(r.Status)) t.approved = round2_(t.approved + h); else t.pending = round2_(t.pending + h);
    if (r.Type === 'Private Lesson') t.privates++;
  });
  inPeriod_(sales, p).forEach(r => {
    if (isRejected_(r.Status)) return;
    const t = get(r.Staff, r.Email), c = num_(r.Commission);
    t.commission = round2_(t.commission + c); t.sales++;
    if (isApproved_(r.Status)) t.commApproved = round2_(t.commApproved + c); else t.commPending = round2_(t.commPending + c);
  });
  return Object.keys(by).map(k => by[k]).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function minutes_(hhmm) {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?/i.exec(String(hhmm || '').trim());
  if (!m) return null;
  let h = +m[1];
  if (m[3]) { const pm = /^p/i.test(m[3]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
  return h * 60 + +m[2];
}

/**
 * Problems worth a look before paying. Each issue: { level, who, date, sheet, row, issue }.
 * `schedule` rows (Day, Start, Class, Coach) let it spot classes logged by
 * someone who isn't on that class.
 */
function checks_(hours, sales, schedule, p, todayIso) {
  const out = [], add = (level, r, sheet, issue) => out.push({ level: level, who: r.Coach || r.Staff, date: normDate_(r.Date), sheet: sheet, row: r._row, issue: issue });
  const hp = inPeriod_(hours, p).filter(r => !isRejected_(r.Status));
  const sp = inPeriod_(sales, p).filter(r => !isRejected_(r.Status));

  // Duplicates
  const seen = {};
  hp.forEach(r => {
    const k = [String(r.Email).toLowerCase(), normDate_(r.Date), r.Type, String(r['Class / Detail']).trim().toLowerCase(), num_(r.Hours), String(r.Start || '')].join('|');
    if (seen[k]) add('Fix', r, PAY.HOURS, 'Looks like a duplicate of row ' + seen[k] + '.'); else seen[k] = r._row;
  });
  // Long days
  const day = {};
  hp.forEach(r => { const k = String(r.Email).toLowerCase() + '|' + normDate_(r.Date); (day[k] = day[k] || []).push(r); });
  Object.keys(day).forEach(k => {
    const tot = day[k].reduce((n, r) => n + num_(r.Hours), 0);
    if (tot > PAY.MAX_DAY_HOURS) add('Check', day[k][0], PAY.HOURS, round2_(tot) + ' hours logged in one day.');
  });
  // Overlapping privates
  Object.keys(day).forEach(k => {
    const pv = day[k].filter(r => r.Type === 'Private Lesson' && minutes_(r.Start) != null)
      .map(r => ({ r: r, s: minutes_(r.Start), e: minutes_(r.Start) + num_(r.Hours) * 60 })).sort((a, b) => a.s - b.s);
    for (let i = 1; i < pv.length; i++) if (pv[i].s < pv[i - 1].e) add('Check', pv[i].r, PAY.HOURS, 'Private overlaps the one in row ' + pv[i - 1].r._row + '.');
  });
  // Future dates, odd amounts, missing start
  hp.forEach(r => {
    if (normDate_(r.Date) > todayIso) add('Check', r, PAY.HOURS, 'Dated in the future.');
    if (num_(r.Hours) <= 0 || num_(r.Hours) > 12) add('Fix', r, PAY.HOURS, 'Hours look wrong: ' + r.Hours + '.');
    if (r.Type === 'Private Lesson' && !String(r.Start || '').trim()) add('Info', r, PAY.HOURS, 'Private lesson with no start time.');
  });
  // Classes logged by someone not on that class in the schedule
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  hp.filter(r => r.Type === 'Class').forEach(r => {
    const d = normDate_(r.Date), dt = new Date(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
    const detail = String(r['Class / Detail']).toLowerCase();
    const match = schedule.filter(s => String(s.Day).toLowerCase() === days[dt.getDay()].toLowerCase()
      && detail.indexOf(String(s.Class).toLowerCase()) === 0);
    if (!match.length) return;  // free-text class; nothing to compare against
    const listed = match.some(s => String(s.Coach || '').split(',').some(n => n.trim().toLowerCase() === String(r.Coach).toLowerCase()));
    if (!listed) add('Check', r, PAY.HOURS, 'Logged "' + match[0].Class + '" but isn\'t listed as its coach on the Schedule tab.');
  });
  // Still pending
  hp.filter(r => !isApproved_(r.Status)).forEach(r => add('Info', r, PAY.HOURS, 'Not approved yet.'));
  sp.filter(r => !isApproved_(r.Status)).forEach(r => add('Info', r, PAY.SALES, 'Sale not approved yet.'));
  sp.forEach(r => { if (num_(r.Amount) <= 0) add('Fix', r, PAY.SALES, 'Sale amount is zero or missing.'); });

  const rank = { Fix: 0, Check: 1, Info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level] || String(a.who).localeCompare(String(b.who)) || a.date.localeCompare(b.date));
}

/* ---------------------------------------------------------------- sheet plumbing */

function ss_() { return SpreadsheetApp.getActive(); }
function rows_(name) { const sh = ss_().getSheetByName(name); return sh ? tableOf_(sh.getDataRange().getValues()) : []; }
function me_() { return Session.getActiveUser().getEmail() || 'Spartan Payroll menu'; }
function periodFrom_(choice) {
  if (choice && choice.from && choice.to) return { from: choice.from, to: choice.to };
  return periodOf_(new Date(), Number(choice && choice.back) || 0);
}

/** Replaces a report tab's contents. Report tabs are rebuilt every time; never type in them. */
function writeTab_(name, title, header, body, notes) {
  let sh = ss_().getSheetByName(name);
  if (!sh) sh = ss_().insertSheet(name);
  sh.clear();
  sh.getRange(1, 1).setValue(title).setFontWeight('bold').setFontSize(13);
  sh.getRange(2, 1).setValue(notes || 'Rebuilt by the Spartan Payroll menu ' + new Date().toLocaleString() + '. Don\'t edit this tab; changes are overwritten.').setFontColor('#666666');
  sh.getRange(4, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#111111').setFontColor('#ffffff');
  if (body.length) sh.getRange(5, 1, body.length, header.length).setValues(body);
  sh.setFrozenRows(4);
  sh.autoResizeColumns(1, header.length);
  return sh;
}

/* ---------------------------------------------------------------- panel actions (called from the sidebar) */

function payrollStaffList() {
  const names = {};
  rows_(PAY.HOURS).concat(rows_(PAY.SALES)).forEach(r => { const n = r.Coach || r.Staff; if (n) names[n] = true; });
  return Object.keys(names).sort();
}

function payrollSummary(choice) {
  const p = periodFrom_(choice), list = summarize_(rows_(PAY.HOURS), rows_(PAY.SALES), p);
  const header = ['Staff', 'Class hrs', 'Private hrs', 'Competition hrs', 'Other hrs', 'Total hrs', 'Approved hrs', 'Pending hrs',
    'Privates', 'Sales', 'Commission approved', 'Commission pending'];
  const body = list.map(t => [t.name, t.byType['Class'] || 0, t.byType['Private Lesson'] || 0, t.byType['Competition Coaching'] || 0,
    t.byType['Other'] || 0, t.total, t.approved, t.pending, t.privates, t.sales, t.commApproved, t.commPending]);
  if (body.length) {
    const sum = c => round2_(body.reduce((n, r) => n + Number(r[c]), 0));
    body.push(['TOTAL', sum(1), sum(2), sum(3), sum(4), sum(5), sum(6), sum(7), sum(8), sum(9), sum(10), sum(11)]);
  }
  const sh = writeTab_(PAY.SUMMARY, 'Payroll summary · ' + p.from + ' to ' + p.to, header, body);
  if (body.length) {
    sh.getRange(5, 11, body.length, 2).setNumberFormat('$#,##0.00');
    sh.getRange(4 + body.length, 1, 1, header.length).setFontWeight('bold').setBackground('#f2f2f2');
  }
  sh.activate();
  return body.length ? (body.length - 1) + ' staff, ' + body[body.length - 1][5] + ' hours total.' : 'Nothing logged in this period.';
}

function payrollDetail(choice, name) {
  const p = periodFrom_(choice), lc = String(name || '').toLowerCase();
  if (!lc) throw new Error('Pick a staff member.');
  const hours = inPeriod_(rows_(PAY.HOURS), p).filter(r => String(r.Coach).toLowerCase() === lc);
  const sales = inPeriod_(rows_(PAY.SALES), p).filter(r => String(r.Staff).toLowerCase() === lc);
  const header = ['Date', 'Kind', 'Type', 'Detail', 'Start', 'Hours', 'Sale $', 'Commission $', 'Status', 'Sheet row'];
  const body = hours.map(r => [normDate_(r.Date), 'Hours', r.Type, r['Class / Detail'], r.Start || '', num_(r.Hours), '', '', r.Status, PAY.HOURS + ' ' + r._row])
    .concat(sales.map(r => [normDate_(r.Date), 'Sale', r.Type, r['Item / Member'], '', '', num_(r.Amount), num_(r.Commission), r.Status, PAY.SALES + ' ' + r._row]))
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const t = summarize_(hours, sales, p)[0];
  if (t) body.push(['', '', '', 'TOTAL (excl. rejected)', '', t.total, '', t.commission, '', '']);
  const sh = writeTab_(PAY.DETAIL, name + ' · ' + p.from + ' to ' + p.to, header, body);
  sh.activate();
  return body.length ? hours.length + ' hour entries, ' + sales.length + ' sales.' : 'Nothing logged for ' + name + ' in this period.';
}

function payrollCheck(choice) {
  const p = periodFrom_(choice);
  const list = checks_(rows_(PAY.HOURS), rows_(PAY.SALES), rows_(PAY.SCHEDULE), p, isoOf_(new Date()));
  const body = list.map(i => [i.level, i.who, i.date, i.sheet + ' row ' + i.row, i.issue]);
  const sh = writeTab_(PAY.CHECK, 'Payroll check · ' + p.from + ' to ' + p.to, ['Level', 'Staff', 'Date', 'Where', 'Issue'], body,
    'Fix = almost certainly wrong. Check = worth a look. Info = for awareness. Rebuilt ' + new Date().toLocaleString() + '.');
  const colors = { Fix: '#f8d7da', Check: '#fff3cd', Info: '#ffffff' };
  if (body.length) sh.getRange(5, 1, body.length, 1).setBackgrounds(body.map(r => [colors[r[0]]]));
  sh.activate();
  const fix = list.filter(i => i.level === 'Fix').length, chk = list.filter(i => i.level === 'Check').length;
  return list.length ? fix + ' to fix, ' + chk + ' to check, ' + (list.length - fix - chk) + ' info.' : 'No issues found.';
}

/** Approves the highlighted rows on the Hours or Sales tab. Paid and rejected rows are left alone. */
function payrollApproveSelection() {
  const sh = ss_().getActiveSheet(), name = sh.getName();
  const ui = SpreadsheetApp.getUi();
  if (name !== PAY.HOURS && name !== PAY.SALES) { ui.alert('Go to the Hours or Sales tab, highlight the rows to approve, then run this again.'); return; }
  const ranges = sh.getActiveRangeList() ? sh.getActiveRangeList().getRanges() : [];
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const cs = head.indexOf('Status') + 1, cb = head.indexOf('Approved By') + 1;
  if (!cs || !cb) { ui.alert('Couldn\'t find the Status and Approved By columns on this tab.'); return; }
  const rows = {};
  ranges.forEach(r => { for (let i = r.getRow(); i < r.getRow() + r.getNumRows(); i++) if (i > 1) rows[i] = true; });
  let done = 0, skipped = 0;
  Object.keys(rows).forEach(i => {
    const cell = sh.getRange(+i, cs), st = String(cell.getValue());
    if (!st || isPaid_(st) || isRejected_(st) || /approved/i.test(st)) { skipped++; return; }
    sh.getRange(+i, cs, 1, 1).setNumberFormat('@').setValue('Approved');
    sh.getRange(+i, cb, 1, 1).setNumberFormat('@').setValue(me_());
    done++;
  });
  ui.alert(done + ' approved.' + (skipped ? ' ' + skipped + ' skipped (already approved, paid, rejected, or empty).' : ''));
}

/** Marks every Approved hours row and sale in the period as Paid. Paid rows are locked in the app. */
function payrollMarkPaid(choice) {
  const p = periodFrom_(choice);
  let n = 0, left = 0;
  [PAY.HOURS, PAY.SALES].forEach(tab => {
    const sh = ss_().getSheetByName(tab); if (!sh) return;
    const values = sh.getDataRange().getValues(), head = values[0].map(String);
    const cd = head.indexOf('Date'), cs = head.indexOf('Status');
    for (let i = 1; i < values.length; i++) {
      const d = normDate_(values[i][cd]);
      if (d < p.from || d > p.to) continue;
      const st = String(values[i][cs]);
      if (/^approved/i.test(st)) { sh.getRange(i + 1, cs + 1).setNumberFormat('@').setValue('Paid'); n++; }
      else if (!isPaid_(st) && !isRejected_(st) && st) left++;
    }
  });
  return n + ' entries marked Paid and locked.' + (left ? ' ' + left + ' still pending were NOT marked; approve them first or they roll forward unpaid.' : '');
}

/** Builds the export tab and returns CSV text for the panel to download. */
function payrollExport(choice) {
  const p = periodFrom_(choice), list = summarize_(rows_(PAY.HOURS), rows_(PAY.SALES), p);
  const header = ['Staff', 'Email', 'Class hrs', 'Private hrs', 'Competition hrs', 'Other hrs', 'Approved hrs (total)', 'Approved commission', 'Pending hrs (not included)'];
  // Approved only: what's actually being paid. Pending shown so nothing is silently dropped.
  const approvedBy = {};
  inPeriod_(rows_(PAY.HOURS), p).filter(r => isApproved_(r.Status)).forEach(r => {
    const k = String(r.Email || r.Coach).toLowerCase(); const t = approvedBy[k] = approvedBy[k] || {};
    const type = PAY.TYPES.indexOf(r.Type) >= 0 ? r.Type : 'Other'; t[type] = round2_((t[type] || 0) + num_(r.Hours));
  });
  const body = list.map(t => { const a = approvedBy[String(t.email || t.name).toLowerCase()] || {};
    return [t.name, t.email, a['Class'] || 0, a['Private Lesson'] || 0, a['Competition Coaching'] || 0, a['Other'] || 0, t.approved, t.commApproved, t.pending]; });
  writeTab_(PAY.EXPORT, 'Payroll export · ' + p.from + ' to ' + p.to, header, body).activate();
  const csv = [header].concat(body).map(r => r.map(v => {
    const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\n');
  return { csv: csv, filename: 'spartan-payroll-' + p.from + '-to-' + p.to + '.csv', note: body.length + ' staff exported.' };
}

function payrollPeriods() {
  const now = new Date();
  return [0, 1, 2, 3].map(b => { const p = periodOf_(now, b); return { back: b, label: (b === 0 ? 'Current: ' : b === 1 ? 'Previous: ' : '') + p.from + ' to ' + p.to }; });
}

/* ---------------------------------------------------------------- panel */

function payrollPanelHtml_() {
  return '<!DOCTYPE html><html><head><base target="_top"><style>' +
    'body{font:14px Arial,sans-serif;margin:12px;color:#111}h2{font-size:16px;margin:0 0 10px}' +
    'label{display:block;font-size:12px;color:#555;margin:12px 0 4px}select,input{width:100%;box-sizing:border-box;padding:6px;font-size:14px}' +
    'button{width:100%;margin-top:8px;padding:9px;border:0;border-radius:6px;background:#111;color:#fff;font-weight:bold;cursor:pointer}' +
    'button.red{background:#c8102e}button.gold{background:#f2b705;color:#000}button:disabled{opacity:.5}' +
    '.out{margin-top:12px;padding:8px;border-radius:6px;background:#f4f4f4;font-size:13px;min-height:18px;white-space:pre-wrap}' +
    '.sec{border-top:1px solid #ddd;margin-top:14px;padding-top:4px}.hint{font-size:12px;color:#666;margin-top:4px}' +
    '</style></head><body><h2>Spartan Payroll</h2>' +
    '<label>Pay period</label><select id="per"></select>' +
    '<div id="cust" style="display:none"><label>From</label><input type="date" id="from"><label>To</label><input type="date" id="to"></div>' +
    '<div class="sec"><button id="bSum">Summary by staff</button>' +
    '<label>Staff member</label><select id="who"><option value="">Loading…</option></select><button id="bDet">Staff detail</button>' +
    '<button id="bChk">Run payroll check</button></div>' +
    '<div class="sec"><button class="gold" id="bApp">Approve selected rows</button><div class="hint">On the Hours or Sales tab, highlight rows first.</div>' +
    '<button class="red" id="bPaid">Mark period paid</button><div class="hint">Locks this period\'s approved entries. Do this after payroll runs.</div>' +
    '<button id="bExp">Export for payroll (CSV)</button></div>' +
    '<div class="out" id="out"></div>' +
    '<script>' +
    'var $=function(i){return document.getElementById(i)};' +
    'function choice(){var v=$("per").value;return v==="c"?{from:$("from").value,to:$("to").value}:{back:+v}}' +
    'function say(t){$("out").textContent=t}' +
    'function run(btn,fn,args,done){btn.disabled=true;say("Working…");var r=google.script.run.withSuccessHandler(function(x){btn.disabled=false;done?done(x):say(x)})' +
    '.withFailureHandler(function(e){btn.disabled=false;say("Error: "+e.message)});r[fn].apply(r,args)}' +
    'google.script.run.withSuccessHandler(function(ps){ps.forEach(function(p){var o=document.createElement("option");o.value=p.back;o.textContent=p.label;$("per").appendChild(o)});' +
    'var c=document.createElement("option");c.value="c";c.textContent="Custom dates…";$("per").appendChild(c)}).payrollPeriods();' +
    'google.script.run.withSuccessHandler(function(ns){$("who").innerHTML=ns.length?ns.map(function(n){return "<option>"+n.replace(/</g,"&lt;")+"</option>"}).join(""):"<option value=\\"\\">No entries yet</option>"}).payrollStaffList();' +
    '$("per").onchange=function(){$("cust").style.display=this.value==="c"?"block":"none"};' +
    '$("bSum").onclick=function(){run(this,"payrollSummary",[choice()])};' +
    '$("bDet").onclick=function(){run(this,"payrollDetail",[choice(),$("who").value])};' +
    '$("bChk").onclick=function(){run(this,"payrollCheck",[choice()])};' +
    '$("bApp").onclick=function(){run(this,"payrollApproveSelection",[],function(){say("Done. See the message in the sheet.")})};' +
    '$("bPaid").onclick=function(){if(!confirm("Mark every approved entry in this period as Paid? Paid entries can\'t be changed in the app."))return;run(this,"payrollMarkPaid",[choice()])};' +
    '$("bExp").onclick=function(){run(this,"payrollExport",[choice()],function(x){var a=document.createElement("a");' +
    'a.href="data:text/csv;charset=utf-8,"+encodeURIComponent(x.csv);a.download=x.filename;document.body.appendChild(a);a.click();a.remove();say(x.note+" Downloaded "+x.filename+".")})};' +
    '</script></body></html>';
}
