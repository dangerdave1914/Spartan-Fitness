/**
 * Spartan Coach — server
 * DigitalOcean App Platform (Node 20+)
 *
 * Sheet access goes through the Apps Script bridge (Code.gs), not a service
 * account. Three sheets: curriculum, conditioning programming, staff ops.
 *
 * Env vars (App Platform → Settings → App-Level Environment Variables):
 *   APPS_SCRIPT_URL      the /exec URL from the Apps Script deployment
 *   APPS_SCRIPT_SECRET   must match SHARED_SECRET in the script properties (mark Encrypt)
 *   CURRICULUM_ADMINS    (optional) extra admins; normally set in the Staff tab Role column
 *   APPROVERS            (optional) extra approvers; normally set in the Staff tab Role column
 *   PAY_PERIOD           "semimonthly" (1st–15th, 16th–end; default) or "biweekly"
 *   PAY_ANCHOR           biweekly only: any pay-period start date, YYYY-MM-DD
 *   SESSION_SECRET       (optional) signs login sessions; defaults to one derived from APPS_SCRIPT_SECRET.
 *                        Changing it signs everyone out.
 *   OPEN_SIGNUP          "1" lets any email register; by default only emails on the Staff tab can
 *   TZ_NAME              gym time zone (default America/Chicago)
 *   PORT                 (App Platform sets this automatically)
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const SCRIPT_SECRET = process.env.APPS_SCRIPT_SECRET;
const emails = v => (v || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const ADMINS = emails(process.env.CURRICULUM_ADMINS);
const APPROVERS = emails(process.env.APPROVERS);
const OPEN_SIGNUP = process.env.OPEN_SIGNUP === '1';
const TZ = process.env.TZ_NAME || 'America/Chicago';
const PAY_PERIOD = (process.env.PAY_PERIOD || 'semimonthly').toLowerCase();
const PAY_ANCHOR = process.env.PAY_ANCHOR || '';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const HOUR_TYPES = ['Class', 'Private Lesson', 'Competition Coaching', 'Other'];

/* ---------------------------------------------------------------- bridge */

/**
 * Apps Script answers a POST with a 302 whose target only accepts GET; fetch
 * downgrades POST to GET on a 302 per spec, so plain redirect following works.
 */
async function rpc(payload) {
  if (!SCRIPT_URL) throw new Error('APPS_SCRIPT_URL is not set');
  const res = await fetch(SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids a CORS preflight
    body: JSON.stringify({ ...payload, secret: SCRIPT_SECRET }),
    redirect: 'follow',
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const clue = /accounts\.google\.com|sign in|signin/i.test(text)
      ? 'Got a Google sign-in page: set "Who has access" to Anyone, then redeploy as a NEW version.'
      : `Got ${res.status}: ${text.slice(0, 140).replace(/\s+/g, ' ')}`;
    throw new Error('Bridge returned non-JSON. ' + clue);
  }
  if (data.error) {
    if (data.error === 'unknown_action') {
      throw new Error('The Apps Script bridge is running an old version. In the editor: ' +
        'Deploy \u2192 Manage deployments \u2192 pencil \u2192 Version: New version \u2192 Deploy.');
    }
    throw new Error('Bridge: ' + data.error);
  }
  return data;
}

/* ---------------------------------------------------------------- cache */

const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}
const bust = prefix => { for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k); };

/** Rows → objects keyed by header, so a reordered column doesn't break parsing. */
function table(values) {
  if (!values || !values.length) return [];
  const head = values[0].map(h => String(h).trim());
  return values.slice(1).map((r, i) => {
    const o = { _row: i + 2 };
    head.forEach((h, j) => { o[h] = String(r[j] ?? '').trim(); });
    return o;
  }).filter(o => Object.keys(o).some(k => k !== '_row' && o[k] !== ''));
}

/* ---------------------------------------------------------------- dates */

const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
function parseIso(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)) : null;
}
function todayIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const mondayOf = d => addDays(d, -((d.getUTCDay() + 6) % 7));
function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || '');
  return m ? +m[1] * 60 + +m[2] : null;
}
function label(hhmm) {
  const t = minutesOf(hhmm);
  if (t == null) return hhmm || '';
  const h = Math.floor(t / 60), mm = t % 60;
  return `${((h + 11) % 12) + 1}${mm ? ':' + pad(mm) : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

function payPeriod(d) {
  if (PAY_PERIOD === 'biweekly' && parseIso(PAY_ANCHOR)) {
    const a = parseIso(PAY_ANCHOR);
    const k = Math.floor((d - a) / (14 * 86400000));
    const from = addDays(a, k * 14);
    return { from: iso(from), to: iso(addDays(from, 13)) };
  }
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (d.getUTCDate() <= 15) return { from: iso(new Date(Date.UTC(y, m, 1, 12))), to: iso(new Date(Date.UTC(y, m, 15, 12))) };
  return { from: iso(new Date(Date.UTC(y, m, 16, 12))), to: iso(new Date(Date.UTC(y, m + 1, 0, 12))) };
}

/* ---------------------------------------------------------------- data */

function curriculum() {
  return cached('cur', 5 * 60000, async () => {
    const { grids } = await rpc({ sheet: 'curriculum', action: 'grids', tabs: ['Programs', 'Lessons', 'Blocks'] });
    const [programs, lessons, blocks] = grids.map(table);
    const byLesson = new Map();
    for (const b of blocks) {
      const k = b.Program + '|' + b.Key;
      if (!byLesson.has(k)) byLesson.set(k, []);
      byLesson.get(k).push(b);
    }
    for (const list of byLesson.values()) list.sort((a, b) => Number(a.Order) - Number(b.Order));
    const order = new Map(programs.map(p => [p.Program, Number(p.Order) || 99]));
    lessons.sort((a, b) => (order.get(a.Program) ?? 99) - (order.get(b.Program) ?? 99) || Number(a.Seq) - Number(b.Seq));
    return { programs, lessons, byLesson };
  });
}

function ops() {
  return cached('ops', 60000, async () => {
    const { grids } = await rpc({ sheet: 'ops', action: 'grids', tabs: ['Schedule', 'Staff', 'Settings', 'Inventory', 'Members', 'Renewals', 'Commission Rules'] });
    const [schedule, staff, settings, inventory, members, renewals, rules] = grids.map(table);
    return { schedule, staff, settings, inventory, members, renewals, rules };
  });
}

function pointerFor(settings, program) {
  const row = settings.find(s => s.Key === 'pointer:' + program);
  return row ? row.Value : '';
}

function lessonSummary(cur, program, key, noGi) {
  const lesson = cur.lessons.find(l => l.Program === program && l.Key === key)
    || cur.lessons.find(l => l.Program === program);
  if (!lesson) return { program, missing: true };
  const blocks = cur.byLesson.get(program + '|' + lesson.Key) || [];
  const siblings = lesson.Week
    ? cur.lessons.filter(l => l.Program === program && l.Week === lesson.Week)
        .map(l => ({ key: l.Key, title: l.Title, day: l.Day, group: l.Group }))
    : [];
  return {
    program, key: lesson.Key, title: lesson.Title, week: lesson.Week, day: lesson.Day, group: lesson.Group,
    note: lesson.Note, siblings,
    techniques: blocks.filter(b => b.Type === 'technique' || b.Type === 'round').map(b => b.Title),
    giTechniques: noGi ? blocks.filter(b => b.Type === 'technique' && b.Gi === 'Gi').map(b => b.Title) : [],
  };
}

/** The S&C workout for a date, read from the month tab its Monday belongs to. */
async function workoutFor(d) {
  const dow = d.getUTCDay();
  if (dow === 0) return null;
  const mon = mondayOf(d);
  const month = MONTHS[mon.getUTCMonth()];
  return cached('prog|' + iso(d), 60000, async () => {
    const { tabs } = await rpc({ sheet: 'programming', action: 'tabs' });
    const tab = tabs.find(t => t.toLowerCase().startsWith(month.toLowerCase()));
    if (!tab) return { error: `No "${month}" tab in the programming sheet yet.` };
    const { values } = await rpc({ sheet: 'programming', action: 'grid', tab });
    const col = dow; // B=Mon (index 1) … G=Sat (index 6)
    for (let r = 0; r < values.length; r++) {
      if (String(values[r][0]).trim().toLowerCase() !== 'week of') continue;
      const cell = String(values[r][1] || '');
      const parsed = new Date(`${cell} ${mon.getUTCFullYear()}`);
      if (isNaN(parsed) || parsed.getMonth() !== mon.getUTCMonth() || parsed.getDate() !== mon.getUTCDate()) continue;
      const fields = {};
      for (let k = r + 1; k < values.length; k++) {
        const lab = String(values[k][0]).trim();
        if (!lab || lab.toLowerCase() === 'week of') break;
        fields[lab] = String(values[k][col] || '').trim();
      }
      const status = fields.Status || '';
      if (!/^confirmed/i.test(status)) return { pending: true, status: status || 'Draft', tab };
      return { status, fields, tab };
    }
    return { error: `No week of ${iso(mon)} in the ${tab} tab.` };
  });
}

/**
 * Staff rows are pre-loaded with an email and role; the Name cell fills in when
 * the coach first opens the app. Roles come from the Role column (e.g. "Admin",
 * "Approver", "Admin, Approver"); the env lists still work as overrides.
 */
function whoami(email, o) {
  const e = (email || '').toLowerCase().trim();
  const row = o.staff.find(s => s.Email.toLowerCase() === e);
  const role = (row ? row.Role : '').toLowerCase();
  return {
    known: !!(row && row.Name), invited: !!row, email: e, name: row ? row.Name : '',
    admin: ADMINS.includes(e) || /admin/.test(role),
    approver: APPROVERS.includes(e) || /approver/.test(role),
    inventory: /inventory|admin|approver/.test(role) || ADMINS.includes(e) || APPROVERS.includes(e),
  };
}

const wrap = fn => async (req, res, next) => {
  try { await fn(req, res, next); }
  catch (err) { console.error(err); res.status(500).json({ error: String(err.message || err) }); }
};

/* ---------------------------------------------------------------- routes */

/* ---------------------------------------------------------------- sign-in
 * Email codes: a staff member asks for a code, the bridge emails it from the
 * gym's Gmail, they type it in, and the server hands back a signed session
 * token the phone keeps. Every /api call then carries that token, and the
 * server takes the user's email from it, never from the request. So nobody can
 * act as another coach by typing their address, and the .ondigitalocean.app
 * link is useless without a code.
 */

const SESSION_SECRET = process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update('spartan-session|' + (SCRIPT_SECRET || '')).digest('hex');
const SESSION_DAYS = 180;
const CODE_TTL = 10 * 60000, RESEND_WAIT = 45000, MAX_TRIES = 5;
const codes = new Map(); // email -> { hash, exp, tries, sent }

const b64 = b => Buffer.from(b).toString('base64url');
const sign = s => crypto.createHmac('sha256', SESSION_SECRET).update(s).digest('base64url');
function makeToken(email) {
  const body = b64(JSON.stringify({ e: email, t: Date.now() }));
  return body + '.' + sign(body);
}
function readToken(tok) {
  const [body, sig] = String(tok || '').split('.');
  if (!body || !sig) return null;
  const want = sign(body);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (Date.now() - p.t > SESSION_DAYS * 86400000) return null;
    return p.e;
  } catch { return null; }
}
const hashCode = (email, code) => crypto.createHash('sha256').update(SESSION_SECRET + '|' + email + '|' + code).digest('hex');

app.post('/api/login/start', wrap(async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
  bust('ops');
  const o = await ops();
  const me = whoami(email, o);
  if (!me.invited && !OPEN_SIGNUP) {
    return res.status(403).json({ error: 'That email isn\'t on the Spartan staff list. Ask a manager to add it to the Staff tab.' });
  }
  const prev = codes.get(email);
  if (prev && Date.now() - prev.sent < RESEND_WAIT) {
    return res.status(429).json({ error: 'A code was just sent. Check your inbox (and spam), or wait a minute to resend.' });
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  codes.set(email, { hash: hashCode(email, code), exp: Date.now() + CODE_TTL, tries: 0, sent: Date.now() });
  await rpc({ action: 'mail', to: email, subject: `Spartan Coach sign-in code: ${code}`,
    text: `Your Spartan Coach sign-in code is ${code}\n\nIt expires in 10 minutes. If you didn't ask for it, ignore this email.` });
  res.json({ ok: true, needsName: !me.known });
}));

app.post('/api/login/verify', wrap(async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  const code = String(req.body.code || '').replace(/\D/g, '');
  const rec = codes.get(email);
  if (!rec || Date.now() > rec.exp) return res.status(400).json({ error: 'That code expired. Send a new one.' });
  if (rec.tries >= MAX_TRIES) { codes.delete(email); return res.status(429).json({ error: 'Too many tries. Send a new code.' }); }
  rec.tries++;
  const want = Buffer.from(rec.hash), got = Buffer.from(hashCode(email, code));
  if (!crypto.timingSafeEqual(want, got)) return res.status(400).json({ error: 'That code doesn\'t match.' });

  bust('ops');
  const o = await ops();
  let me = whoami(email, o);
  if (!me.known) {
    // First sign-in: they choose the name that shows on the schedule.
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Enter your name.', needsName: true });
    // Coaches are matched to schedule slots by display name, so two people
    // with one name would get each other's classes.
    if (o.staff.some(s => s.Name && s.Name.toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ error: `Someone is already registered as "${name}". Add a last initial.` });
    }
    const row = o.staff.find(s => s.Email.toLowerCase() === email);
    if (row) {
      await rpc({ sheet: 'ops', action: 'update', tab: 'Staff', range: `A${row._row}`, values: [[name]] });
      await rpc({ sheet: 'ops', action: 'update', tab: 'Staff', range: `D${row._row}`, values: [[todayIso()]] });
    } else if (OPEN_SIGNUP) {
      await rpc({ sheet: 'ops', action: 'append', tab: 'Staff', row: [name, email, 'Coach', todayIso()] });
    } else {
      return res.status(403).json({ error: 'That email isn\'t on the Spartan staff list.' });
    }
    bust('ops');
    me = whoami(email, await ops());
  }
  codes.delete(email);
  res.json({ token: makeToken(email), me });
}));

/**
 * Every other /api route needs a valid session for someone still on the Staff
 * tab. The verified email is written over whatever email the request carried,
 * so the route handlers below can keep reading req.query.email / req.body.email.
 * Deleting someone's row on the Staff tab signs them out within a minute.
 */
app.use('/api', wrap(async (req, res, next) => {
  if (req.path.startsWith('/login/')) return next();
  const tok = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const email = readToken(tok);
  if (!email) return res.status(401).json({ error: 'Please sign in.', signin: true });
  const me = whoami(email, await ops());
  if (!me.known) return res.status(401).json({ error: 'You\'re no longer on the staff list.', signin: true });
  req.query.email = email;
  if (req.body && typeof req.body === 'object') req.body.email = email;
  next();
}));

app.get('/api/whoami', wrap(async (req, res) => {
  res.json(whoami(req.query.email, await ops()));
}));

app.get('/api/day', wrap(async (req, res) => {
  const d = parseIso(req.query.date) || parseIso(todayIso());
  const dayName = DAYS[d.getUTCDay()];
  const [o, cur] = await Promise.all([ops(), curriculum()]);
  const slots = o.schedule
    .filter(s => s.Day.toLowerCase() === dayName.toLowerCase())
    .sort((a, b) => (minutesOf(a.Start) ?? 0) - (minutesOf(b.Start) ?? 0));

  let workout;
  const out = [];
  for (const s of slots) {
    const programs = s.Program.split(';').map(p => p.trim()).filter(Boolean);
    const content = [];
    for (const p of programs) {
      if (p.toLowerCase() === 'conditioning') {
        workout = workout || await workoutFor(d);
        content.push({ kind: 'workout', workout });
      } else {
        content.push({ kind: 'lesson', ...lessonSummary(cur, p, pointerFor(o.settings, p), s.Gi === 'No-Gi') });
      }
    }
    const len = (minutesOf(s.End) ?? 0) - (minutesOf(s.Start) ?? 0);
    out.push({
      row: s._row, start: s.Start, end: s.End, time: `${label(s.Start)}–${label(s.End)}`, className: s.Class,
      gi: s.Gi, coach: s.Coach, hours: len > 0 ? Math.round(len / 15) / 4 : 1, content,
    });
  }
  res.json({ date: iso(d), day: dayName, today: todayIso(), slots: out });
}));

app.get('/api/programs', wrap(async (req, res) => {
  const [o, cur] = await Promise.all([ops(), curriculum()]);
  res.json({
    programs: cur.programs.map(p => ({
      name: p.Program, keyedBy: p['Keyed by'], notes: p.Notes, pointer: pointerFor(o.settings, p.Program),
      lessons: cur.lessons.filter(l => l.Program === p.Program).map(l => ({
        key: l.Key, title: l.Title, week: l.Week, day: l.Day, group: l.Group,
        empty: !(cur.byLesson.get(p.Program + '|' + l.Key) || []).length,
      })),
    })),
  });
}));

app.get('/api/lesson', wrap(async (req, res) => {
  const cur = await curriculum();
  const { program, key } = req.query;
  const list = cur.lessons.filter(l => l.Program === program);
  const i = list.findIndex(l => l.Key === key);
  if (i < 0) return res.status(404).json({ error: 'No such lesson.' });
  const l = list[i];
  const blocks = (cur.byLesson.get(program + '|' + key) || []).map(b => ({
    type: b.Type, title: b.Title, minutes: b.Minutes, gi: b.Gi, preview: b.Preview, explain: b.Explain,
    mistakes: b.Mistakes, demonstrate: b.Demonstrate, involve: b.Involve, body: b.Body,
  }));
  res.json({
    program, key, title: l.Title, week: l.Week, day: l.Day, group: l.Group, source: l.Source, note: l.Note,
    prev: list[i - 1] ? list[i - 1].Key : null, next: list[i + 1] ? list[i + 1].Key : null, blocks,
  });
}));

app.post('/api/pointer', wrap(async (req, res) => {
  const email = String(req.body.email || '').toLowerCase();
  if (!ADMINS.includes(email)) return res.status(403).json({ error: 'Only curriculum admins can change the running lesson.' });
  const { program, key } = req.body;
  const cur = await curriculum();
  if (!cur.lessons.some(l => l.Program === program && l.Key === key)) return res.status(400).json({ error: 'Unknown lesson.' });
  const o = await ops();
  const row = o.settings.find(s => s.Key === 'pointer:' + program);
  if (row) {
    await rpc({ sheet: 'ops', action: 'update', tab: 'Settings', range: `B${row._row}`, values: [[key]] });
  } else {
    await rpc({ sheet: 'ops', action: 'append', tab: 'Settings', row: ['pointer:' + program, key, `Set by ${email}`] });
  }
  bust('ops');
  res.json({ ok: true });
}));

/* ---- claiming classes */

const coachList = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);

/** Toggles the caller's name on a schedule row. Checked against day, start and class so a shifted row can't be edited by mistake. */
app.post('/api/claim', wrap(async (req, res) => {
  bust('ops');
  const o = await ops();
  const me = whoami(req.body.email, o);
  if (!me.known) return res.status(403).json({ error: 'Register first.' });
  const s = o.schedule.find(x => x._row === Number(req.body.row));
  if (!s || s.Start !== req.body.start || s.Class !== req.body.className) {
    return res.status(409).json({ error: 'The schedule changed. Refresh and try again.' });
  }
  const list = coachList(s.Coach);
  const i = list.findIndex(n => n.toLowerCase() === me.name.toLowerCase());
  if (i >= 0) list.splice(i, 1); else list.push(me.name);
  await rpc({ sheet: 'ops', action: 'update', tab: 'Schedule', range: `G${s._row}`, values: [[list.join(', ')]] });
  bust('ops');
  res.json({ ok: true, coach: list.join(', ') });
}));

/* ---- settings helpers */

function setting(o, key, dflt) {
  const r = o.settings.find(s => s.Key === key);
  const n = r ? Number(r.Value) : NaN;
  return Number.isFinite(n) ? n : dflt;
}

/* ---- inventory
 * Inventory tab columns: A Item, B Variant, C Category, D Zen Planner Name,
 * E On Hand, F Reorder At, G Lead Time (days), H Last Counted, I Counted By, J Notes
 */

const invKey = r => `${r.Item}|${r.Variant}`;
function invView(r) {
  const onHand = Number(r['On Hand']) || 0, reorderAt = Number(r['Reorder At']);
  return {
    row: r._row, item: r.Item, variant: r.Variant, category: r.Category, onHand,
    reorderAt: Number.isFinite(reorderAt) && r['Reorder At'] !== '' ? reorderAt : null,
    leadDays: r['Lead Time (days)'], zenName: r['Zen Planner Name'],
    lastCounted: normDate(r['Last Counted']), countedBy: r['Counted By'], notes: r.Notes,
    low: r['Reorder At'] !== '' && onHand <= Number(r['Reorder At']),
  };
}

app.get('/api/inventory', wrap(async (req, res) => {
  const o = await ops();
  const me = whoami(req.query.email, o);
  if (!me.known) return res.status(403).json({ error: 'Register first.' });
  const items = o.inventory.map(invView).sort((a, b) => (b.low - a.low) || a.item.localeCompare(b.item) || a.variant.localeCompare(b.variant));
  res.json({ canEdit: me.inventory, low: items.filter(i => i.low).length, items });
}));

/**
 * One endpoint for every stock change. Count sets the number outright (a
 * physical count); Restock adds; Sold and Adjust subtract. Every change also
 * lands in the Inventory Log, which is the audit trail when counts disagree.
 */
app.post('/api/inventory/change', wrap(async (req, res) => {
  bust('ops');
  const o = await ops();
  const me = whoami(req.body.email, o);
  if (!me.inventory) return res.status(403).json({ error: 'Your role can view inventory but not change it.' });
  const r = o.inventory.find(x => x._row === Number(req.body.row));
  if (!r || invKey(r) !== req.body.key) return res.status(409).json({ error: 'The inventory sheet changed. Refresh and try again.' });
  const kind = req.body.kind, qty = Number(req.body.qty);
  if (!['Count', 'Restock', 'Sold', 'Adjust'].includes(kind)) return res.status(400).json({ error: 'Unknown change type.' });
  if (!(Number.isInteger(qty) && qty >= 0 && qty <= 10000)) return res.status(400).json({ error: 'Enter a whole number.' });
  const before = Number(r['On Hand']) || 0;
  const after = kind === 'Count' ? qty : kind === 'Restock' ? before + qty : Math.max(0, before - qty);
  const today = todayIso();
  await rpc({ sheet: 'ops', action: 'update', tab: 'Inventory', range: `E${r._row}`, values: [[String(after)]] });
  if (kind === 'Count') await rpc({ sheet: 'ops', action: 'update', tab: 'Inventory', range: `H${r._row}:I${r._row}`, values: [[today, me.name]] });
  const reorderAt = r['Reorder At'] === '' ? null : Number(r['Reorder At']);
  const crossed = reorderAt != null && before > reorderAt && after <= reorderAt;
  await rpc({
    sheet: 'ops', action: 'append', tab: 'Inventory Log',
    row: [new Date().toISOString(), r.Item, r.Variant, kind, kind === 'Count' ? `=${qty}` : (kind === 'Restock' ? '+' : '-') + qty, after, me.name, String(req.body.note || '')],
    notify: crossed ? { subject: `Low stock: ${r.Item}${r.Variant ? ' (' + r.Variant + ')' : ''}`,
      body: `${after} left, reorder point is ${reorderAt}.${r['Lead Time (days)'] ? ` Lead time ${r['Lead Time (days)']} days.` : ''}\nLogged by ${me.name} in Spartan Coach.` } : null,
  });
  bust('ops');
  res.json({ ok: true, onHand: after, low: reorderAt != null && after <= reorderAt });
}));

app.post('/api/inventory/item', wrap(async (req, res) => {
  const o = await ops();
  const me = whoami(req.body.email, o);
  if (!me.inventory) return res.status(403).json({ error: 'Your role can view inventory but not change it.' });
  const item = String(req.body.item || '').trim(), variant = String(req.body.variant || '').trim();
  if (!item) return res.status(400).json({ error: 'Name the item.' });
  if (o.inventory.some(x => x.Item.toLowerCase() === item.toLowerCase() && x.Variant.toLowerCase() === variant.toLowerCase())) {
    return res.status(409).json({ error: 'That item and size already exist.' });
  }
  const n = v => (v === '' || v == null) ? '' : String(Math.max(0, Math.floor(Number(v)) || 0));
  await rpc({ sheet: 'ops', action: 'append', tab: 'Inventory',
    row: [item, variant, String(req.body.category || ''), String(req.body.zenName || ''), n(req.body.onHand), n(req.body.reorderAt), n(req.body.leadDays), todayIso(), me.name, ''] });
  bust('ops');
  res.json({ ok: true });
}));

/* ---- members and renewals */

function addMonths(d, n) {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n, day = d.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0, 12)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, last), 12));
}

/**
 * The anniversary a member is "in" right now: the first term date after they
 * joined that hasn't passed by more than the grace window. Renewals are keyed
 * by member + anniversary, so each year is its own renewal and its own credit.
 */
function memberView(m, o, today) {
  const joined = parseIso(normDate(m.Joined));
  const term = Math.max(1, Number(m['Term (months)']) || 12);
  const flagDays = setting(o, 'renewal_flag_days', 30), grace = setting(o, 'renewal_grace_days', 30);
  const base = { row: m._row, name: m.Member, coach: m.Coach, plan: m.Plan, joined: joined ? iso(joined) : m.Joined, term,
    status: m.Status || 'Active', lastContacted: normDate(m['Last Contacted']), notes: m.Notes };
  if (!joined) return { ...base, problem: 'Joined date unreadable' };
  let k = 1, ann = addMonths(joined, term);
  while (addDays(ann, grace) < today) { k++; ann = addMonths(joined, term * k); }
  const annIso = iso(ann);
  const rec = o.renewals.find(r => r.Member === m.Member && normDate(r.Anniversary) === annIso);
  const days = Math.round((ann - today) / 86400000);
  const inactive = /lapsed|cancel/i.test(base.status);
  return { ...base, anniversary: annIso, cycle: k, daysUntil: days, outcome: rec ? rec.Outcome : '',
    flagged: !inactive && !rec && days <= flagDays };
}

function canSeeMember(me, m) {
  if (me.admin || me.approver) return true;
  return String(m.Coach || '').split(',').some(n => n.trim().toLowerCase() === me.name.toLowerCase());
}

app.get('/api/members', wrap(async (req, res) => {
  const o = await ops();
  const me = whoami(req.query.email, o);
  if (!me.known) return res.status(403).json({ error: 'Register first.' });
  const today = parseIso(todayIso());
  const all = me.admin || me.approver;
  const list = o.members.filter(m => canSeeMember(me, m)).map(m => memberView(m, o, today))
    .sort((a, b) => (b.flagged - a.flagged) || ((a.daysUntil ?? 9999) - (b.daysUntil ?? 9999)));
  res.json({ all, canManage: all, flagged: list.filter(m => m.flagged).length, members: list,
    coaches: all ? o.staff.filter(s => s.Name).map(s => s.Name) : [] });
}));

app.post('/api/members', wrap(async (req, res) => {
  const o = await ops();
  const me = whoami(req.body.email, o);
  if (!(me.admin || me.approver)) return res.status(403).json({ error: 'Only managers can add members.' });
  const name = String(req.body.name || '').trim(), joined = req.body.joined;
  if (!name || !parseIso(joined)) return res.status(400).json({ error: 'Name and join date are required.' });
  if (o.members.some(m => m.Member.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: `"${name}" is already listed. Add a last initial if it's a different person.` });
  }
  await rpc({ sheet: 'ops', action: 'append', tab: 'Members',
    row: [name, joined, String(req.body.plan || ''), String(Number(req.body.term) || 12), String(req.body.coach || ''), 'Active', '', String(req.body.notes || '')] });
  bust('ops');
  res.json({ ok: true });
}));

app.post('/api/members/contact', wrap(async (req, res) => {
  bust('ops');
  const o = await ops();
  const me = whoami(req.body.email, o);
  const m = o.members.find(x => x._row === Number(req.body.row));
  if (!m || m.Member !== req.body.name) return res.status(409).json({ error: 'The member list changed. Refresh and try again.' });
  if (!me.known || !canSeeMember(me, m)) return res.status(403).json({ error: 'Not your member.' });
  const note = String(req.body.note || '').trim();
  const notes = note ? [m.Notes, `${todayIso()} ${me.name}: ${note}`].filter(Boolean).join('\n') : m.Notes;
  await rpc({ sheet: 'ops', action: 'update', tab: 'Members', range: `G${m._row}:H${m._row}`, values: [[todayIso(), notes]] });
  bust('ops');
  res.json({ ok: true });
}));

/** Managers only: a renewal is what the bonus pays on, so the coach who earns it doesn't record it. */
app.post('/api/renewals', wrap(async (req, res) => {
  bust('ops');
  const o = await ops();
  const me = whoami(req.body.email, o);
  if (!(me.admin || me.approver)) return res.status(403).json({ error: 'Only managers can record renewals.' });
  const m = o.members.find(x => x._row === Number(req.body.row));
  if (!m || m.Member !== req.body.name) return res.status(409).json({ error: 'The member list changed. Refresh and try again.' });
  const outcome = req.body.outcome;
  if (!['Renewed', 'Lapsed'].includes(outcome)) return res.status(400).json({ error: 'Outcome must be Renewed or Lapsed.' });
  const v = memberView(m, o, parseIso(todayIso()));
  if (v.outcome) return res.status(409).json({ error: `Already recorded as ${v.outcome} for ${v.anniversary}.` });
  await rpc({ sheet: 'ops', action: 'append', tab: 'Renewals',
    row: [new Date().toISOString(), m.Member, m.Coach, v.anniversary, todayIso(), outcome, me.email] });
  if (outcome === 'Lapsed') await rpc({ sheet: 'ops', action: 'update', tab: 'Members', range: `F${m._row}`, values: [['Lapsed']] });
  bust('ops');
  res.json({ ok: true });
}));

/** Renewals per coach for a year. Every renewal counts, every year, so a coach's book compounds. */
app.get('/api/retention', wrap(async (req, res) => {
  const o = await ops();
  const me = whoami(req.query.email, o);
  if (!me.known) return res.status(403).json({ error: 'Register first.' });
  const year = String(Number(req.query.year) || Number(todayIso().slice(0, 4)));
  const bonus = setting(o, 'bonus_per_renewal', 0);
  const by = {};
  for (const r of o.renewals) {
    const d = normDate(r['Renewed On']);
    if (!d.startsWith(year)) continue;
    for (const c of String(r.Coach || '').split(',').map(x => x.trim()).filter(Boolean)) {
      if (!(me.admin || me.approver) && c.toLowerCase() !== me.name.toLowerCase()) continue;
      const t = by[c] = by[c] || { renewed: 0, lapsed: 0 };
      if (r.Outcome === 'Renewed') t.renewed++; else t.lapsed++;
    }
  }
  res.json({ year, bonusPerRenewal: bonus, coaches: Object.entries(by).map(([coach, t]) => ({
    coach, ...t, rate: t.renewed + t.lapsed ? Math.round(100 * t.renewed / (t.renewed + t.lapsed)) : null,
    bonus: bonus ? t.renewed * bonus : null })) });
}));

/* ---- sales commissions
 * Sales tab: A Logged, B Date, C Staff, D Email, E Type, F Item / Member, G Amount,
 * H Commission, I Status, J Approved By, K Source, L Note
 * Commission Rules tab: Type | Rate % | Flat $ | Note. Commission = amount x rate + flat,
 * frozen onto the row when it's logged so later rule changes don't rewrite past pay.
 */

const money = n => Math.round(n * 100) / 100;
function rulesOf(o) {
  return o.rules.filter(r => r.Type).map(r => ({
    type: r.Type, rate: Number(String(r['Rate %']).replace('%', '')) || 0,
    flat: Number(String(r['Flat $']).replace('$', '')) || 0, note: r.Note,
  }));
}

async function salesRows() {
  const { values } = await rpc({ sheet: 'ops', action: 'grid', tab: 'Sales' });
  return table(values).map(r => ({ ...r, Date: normDate(r.Date) }));
}

app.get('/api/sales', wrap(async (req, res) => {
  const o = await ops();
  const me = whoami(req.query.email, o);
  if (!me.known) return res.status(403).json({ error: 'Register first.' });
  const base = parseIso(req.query.date) || parseIso(todayIso());
  const period = payPeriod(base);
  const all = me.approver && req.query.all === '1';
  const rows = (await salesRows())
    .filter(r => r.Date >= period.from && r.Date <= period.to)
    .filter(r => all || r.Email.toLowerCase() === me.email)
    .sort((a, b) => a.Date.localeCompare(b.Date) || a.Logged.localeCompare(b.Logged));
  const totals = {};
  for (const r of rows) {
    if (/rejected/i.test(r.Status)) continue;
    const t = totals[r.Staff] = totals[r.Staff] || { commission: 0, approved: 0, sales: 0 };
    const c = Number(r.Commission) || 0;
    t.commission = money(t.commission + c); t.sales++;
    if (/approved/i.test(r.Status)) t.approved = money(t.approved + c);
  }
  res.json({
    period, all, totals, rules: rulesOf(o),
    rows: rows.map(r => ({ row: r._row, logged: r.Logged, date: r.Date, staff: r.Staff, type: r.Type, item: r['Item / Member'],
      amount: r.Amount, commission: r.Commission, status: r.Status, approvedBy: r['Approved By'], source: r.Source, note: r.Note,
      mine: r.Email.toLowerCase() === me.email })),
  });
}));

app.post('/api/sales', wrap(async (req, res) => {
  const o = await ops();
  const me = whoami(req.body.email, o);
  if (!me.known) return res.status(403).json({ error: 'Register first.' });
  const rule = rulesOf(o).find(r => r.type === req.body.type);
  if (!rule) return res.status(400).json({ error: 'Pick a sale type.' });
  const amount = Number(req.body.amount);
  if (!(amount > 0 && amount < 100000)) return res.status(400).json({ error: 'Enter the sale amount.' });
  if (!parseIso(req.body.date)) return res.status(400).json({ error: 'Pick a date.' });
  const item = String(req.body.item || '').trim();
  if (!item) return res.status(400).json({ error: 'Say what was sold, or which member signed up.' });
  const commission = money(amount * rule.rate / 100 + rule.flat);
  await rpc({ sheet: 'ops', action: 'append', tab: 'Sales',
    row: [new Date().toISOString(), req.body.date, me.name, me.email, rule.type, item, money(amount).toFixed(2), commission.toFixed(2), 'Pending', '', 'App', String(req.body.note || '').trim()] });
  res.json({ ok: true, commission });
}));

async function findSale(row, logged) {
  const r = (await salesRows()).find(x => x._row === Number(row));
  if (!r || r.Logged !== logged) throw new Error('That entry changed or moved. Refresh and try again.');
  return r;
}

/** Approvers check a claimed sale against Zen Planner before approving it; that's the only thing standing between a typo and a paycheck. */
app.post('/api/sales/review', wrap(async (req, res) => {
  const o = await ops();
  const me = whoami(req.body.email, o);
  if (!me.approver) return res.status(403).json({ error: 'Only approvers can review sales.' });
  const r = await findSale(req.body.row, req.body.logged);
  const v = { approve: ['Approved', me.email], reject: ['Rejected', me.email], undo: ['Pending', ''] }[req.body.action];
  if (!v) return res.status(400).json({ error: 'Unknown action.' });
  await rpc({ sheet: 'ops', action: 'update', tab: 'Sales', range: `I${r._row}:J${r._row}`, values: [v] });
  res.json({ ok: true });
}));

app.post('/api/sales/delete', wrap(async (req, res) => {
  const o = await ops();
  const me = whoami(req.body.email, o);
  const r = await findSale(req.body.row, req.body.logged);
  const own = r.Email.toLowerCase() === me.email && /pending/i.test(r.Status);
  if (!own && !me.approver) return res.status(403).json({ error: 'You can only delete your own sales before they are reviewed.' });
  await rpc({ sheet: 'ops', action: 'delete', tab: 'Sales', rowIndex: r._row });
  res.json({ ok: true });
}));

/* ---- hours */

/** Rows typed by hand in the sheet may show dates as 9/22/2026; normalise to ISO. */
function normDate(s) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  return m ? `${m[3]}-${pad(m[1])}-${pad(m[2])}` : s;
}
async function hoursRows() {
  const { values } = await rpc({ sheet: 'ops', action: 'grid', tab: 'Hours' });
  return table(values).map(r => ({ ...r, Date: normDate(r.Date) }));
}

app.get('/api/hours', wrap(async (req, res) => {
  const o = await ops();
  const me = whoami(req.query.email, o);
  if (!me.known) return res.status(403).json({ error: 'Register first.' });
  const base = parseIso(req.query.date) || parseIso(todayIso());
  const period = req.query.from && req.query.to ? { from: req.query.from, to: req.query.to } : payPeriod(base);
  const all = me.approver && req.query.all === '1';
  const rows = (await hoursRows())
    .filter(r => r.Date >= period.from && r.Date <= period.to)
    .filter(r => all || r.Email.toLowerCase() === me.email)
    .sort((a, b) => a.Date.localeCompare(b.Date) || a.Logged.localeCompare(b.Logged));
  const totals = {};
  for (const r of rows) {
    const t = totals[r.Coach] = totals[r.Coach] || { total: 0, approved: 0, byType: {} };
    const h = Number(r.Hours) || 0;
    t.total += h; if (/approved/i.test(r.Status)) t.approved += h;
    t.byType[r.Type] = (t.byType[r.Type] || 0) + h;
  }
  const prevBase = addDays(parseIso(period.from), -1), nextBase = addDays(parseIso(period.to), 1);
  res.json({
    period, prev: iso(prevBase), next: iso(nextBase), all, types: HOUR_TYPES, totals,
    rows: rows.map(r => ({
      row: r._row, logged: r.Logged, date: r.Date, coach: r.Coach, type: r.Type, detail: r['Class / Detail'],
      hours: r.Hours, note: r.Note, status: r.Status, approvedBy: r['Approved By'],
      mine: r.Email.toLowerCase() === me.email,
    })),
  });
}));

app.post('/api/hours', wrap(async (req, res) => {
  const o = await ops();
  const me = whoami(req.body.email, o);
  if (!me.known) return res.status(403).json({ error: 'Register first.' });
  const { date, type, detail, note } = req.body;
  const hours = Number(req.body.hours);
  if (!parseIso(date)) return res.status(400).json({ error: 'Pick a date.' });
  if (!HOUR_TYPES.includes(type)) return res.status(400).json({ error: 'Pick a type.' });
  if (!(hours > 0 && hours <= 12)) return res.status(400).json({ error: 'Hours must be between 0 and 12.' });
  if (!String(detail || '').trim()) return res.status(400).json({ error: 'Say which class, student or event.' });
  const logged = new Date().toISOString();
  await rpc({
    sheet: 'ops', action: 'append', tab: 'Hours',
    row: [logged, date, me.name, me.email, type, String(detail).trim(), hours, String(note || '').trim(), 'Pending', ''],
    notify: type !== 'Class' ? { subject: `Hours logged: ${me.name}, ${type}`, body: `${date} · ${hours}h · ${detail}\n${note || ''}` } : null,
  });
  res.json({ ok: true });
}));

/** Row numbers shift when rows are deleted, so every edit re-checks the row's timestamp first. */
async function findRow(row, logged) {
  const rows = await hoursRows();
  const r = rows.find(x => x._row === Number(row));
  if (!r || r.Logged !== logged) throw new Error('That entry changed or moved. Refresh and try again.');
  return r;
}

app.post('/api/hours/approve', wrap(async (req, res) => {
  const o = await ops();
  const me = whoami(req.body.email, o);
  if (!me.approver) return res.status(403).json({ error: 'Only approvers can approve hours.' });
  const r = await findRow(req.body.row, req.body.logged);
  const approve = req.body.undo ? ['Pending', ''] : ['Approved', me.email];
  await rpc({ sheet: 'ops', action: 'update', tab: 'Hours', range: `I${r._row}:J${r._row}`, values: [approve] });
  res.json({ ok: true });
}));

app.post('/api/hours/delete', wrap(async (req, res) => {
  const o = await ops();
  const me = whoami(req.body.email, o);
  const r = await findRow(req.body.row, req.body.logged);
  const own = r.Email.toLowerCase() === me.email && !/approved/i.test(r.Status);
  if (!own && !me.approver) return res.status(403).json({ error: 'You can only delete your own entries before they are approved.' });
  await rpc({ sheet: 'ops', action: 'delete', tab: 'Hours', rowIndex: r._row });
  res.json({ ok: true });
}));

app.post('/api/refresh', (req, res) => { cache.clear(); res.json({ ok: true }); }); // behind the sign-in middleware
app.get('/healthz', (_, res) => res.send('ok'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Spartan Coach on :${PORT}`));
