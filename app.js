/* app.js — Duty Hours: plan every hour of the month, send what's been worked to e-value.
 *
 * Model (synced across devices via the proxy, localStorage "dh.plan2"):
 *   types     [{id, name, segs:[{s:'HH:MM', e:'HH:MM', act?, task?}]}]   day templates
 *   days      {'YYYY-MM-DD': {t: typeId} | {segs:[...]}}                planned work; absent = off
 *   rotations [{from, to, act}]                                          where you are (e-value activity)
 *   weekly    [{dow, s, e, act, task?}]   recurring blocks (Academic Afternoon) that replace that
 *                                         window on any day you're working
 *   fillOff   every hour not worked is logged as Non Duty Hours, split at midnight
 * A segment with no act uses the day's rotation; no task = Planned Work Hours.
 * A day is "logged" once e-value has entries for it; those are edited/deleted in place.
 */
'use strict';

const DEFAULT_PROXY = 'https://dh-api.robbiemed.org';
const DEFAULT_AMION = ''; // Amion "Lo" code; blank = the proxy's AMION_LO
const DEFAULT_ACCENT = '#0d47a1';
const WORK = '21295';            // Planned Work Hours
const NONDUTY = '21296';         // Non Duty Hours
const NC_ACT = '938';            // e-value activity "NC" (night call) — Amion NC / SAT. CALL / SUN. CALL…
// Tasks e-value treats as not-duty: activity optional, not counted toward work hours.
const NON_DH = new Set(['21296', '21297', '21298', '21299']);
const VACAY = new Set(['21297', '21298', '21299']); // may be logged ahead of time
const TASKS_FALLBACK = [
  { id: '21295', name: 'Planned Work Hours' }, { id: '21296', name: 'Non Duty Hours' },
  { id: '21297', name: 'Vacation' }, { id: '21298', name: 'Sick Day' },
  { id: '21299', name: 'Leave of Absence' }, { id: '21300', name: 'Called In From Home' },
];
const DEFAULT_TYPES = [
  { id: 'rot', name: 'Rotation day', segs: [{ s: '07:30', e: '12:00' }, { s: '13:00', e: '17:00' }] }, // 12–1 lunch
  { id: 'clinam', name: 'Clinic AM', segs: [{ s: '08:00', e: '12:00', act: '918' }, { s: '13:00', e: '17:00' }] },
  { id: 'clinpm', name: 'Clinic PM', segs: [{ s: '07:30', e: '12:00' }, { s: '13:00', e: '17:00', act: '918' }] },
  { id: 'night', name: 'Night', segs: [{ s: '19:00', e: '07:00' }] },
  { id: 'call', name: '24h call', segs: [{ s: '07:00', e: '07:00' }] },
  { id: 'vac', name: 'Vacation', segs: [{ s: '00:00', e: '00:00', task: '21297' }] },
];
const DEFAULT_WEEKLY = [{ dow: 4, s: '12:00', e: '17:00', act: '894' }]; // Thu Academic Afternoon
const COLORS = ['#1e88e5', '#5e35b1', '#43a047', '#e53935', '#fb8c00', '#00897b', '#8e24aa', '#6d4c41'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS = new Set(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
  'sun', 'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat']);

const $ = id => document.getElementById(id);
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// ---------- storage ----------
const store = {
  get(k, fb) {
    try { const v = localStorage.getItem('dh.' + k); return v == null ? fb : JSON.parse(v); } catch { return fb; }
  },
  set(k, v) { try { localStorage.setItem('dh.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const freshPlan = () => ({
  version: 2, types: structuredClone(DEFAULT_TYPES), days: {}, rotations: [],
  weekly: structuredClone(DEFAULT_WEEKLY), fillOff: true, updated: 0,
  map: {},                                                   // Amion name/code -> {act, task, skip, s, e}
  colors: {},                                                // rotation label -> '#rrggbb'
  sessions: { am: { s: '08:00', e: '12:00' }, pm: { s: '13:00', e: '17:00' } }, // Amion clinic half-days
});
function upgrade(p) {
  const out = { ...freshPlan(), ...p };
  // Earlier builds: Rotation day had no lunch; phones were logged as duty.
  const rot = out.types.find(t => t.id === 'rot');
  if (rot && JSON.stringify(rot.segs) === JSON.stringify([{ s: '07:30', e: '17:00' }])) rot.segs = structuredClone(DEFAULT_TYPES[0].segs);
  Object.entries(out.map).forEach(([k, v]) => {
    if (/PHONE/.test(k) && v.task === '21300') v.task = NONDUTY;
    if ((k === 'NC' || /CALL/.test(k)) && !/PHONE/.test(k) && !v.act && !v.skip) v.act = NC_ACT; // call was defaulting to rotation
  });
  return out;
}
let settings = store.get('settings', { proxy: DEFAULT_PROXY, username: '', password: '' });
let session = store.get('session', null);
let lookups = store.get('lookups', null);
let ev = store.get('ev', {});
let dh = upgrade(store.get('plan2', null) || {});
let amionCache = store.get('amion', {}); // 'YYYY-MM' -> last /amion/me payload (re-applied when mappings change)

let month = null;   // "YYYY-MM" on screen
let brush = 'rot';  // type id | 'off' | 'edit'
let stroke = null;  // active paint drag
let editing = null; // date open in the editor

// ---------- time helpers ----------
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMin = m => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
const minsBetween = (s, e) => { const d = toMin(e) - toMin(s); return d <= 0 ? d + 1440 : d; };
const fmtH = mins => { const h = mins / 60; return Number.isInteger(h) ? String(h) : h.toFixed(1); };
const dateOf = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = dateOf(s); d.setDate(d.getDate() + n); return iso(d); };

/** "19:30" -> "7:30p" */
function short(t) {
  const [h, m] = t.split(':').map(Number);
  return (h % 12 || 12) + (m ? ':' + pad(m) : '') + (h < 12 ? 'a' : 'p');
}

/** "1pm-10pm" / "7:30am–7:30pm" -> { s:'13:00', e:'22:00' } or null */
function parseRange(str) {
  const m = String(str).toLowerCase()
    .match(/^(\d{1,2})(?::(\d{2}))?\s?(am|pm)\s?[-–]\s?(\d{1,2})(?::(\d{2}))?\s?(am|pm)$/);
  if (!m) return null;
  const t = (h, mm, ap) => pad((+h % 12) + (ap === 'pm' ? 12 : 0)) + ':' + (mm || '00');
  return { s: t(m[1], m[2], m[3]), e: t(m[4], m[5], m[6]) };
}

/** Pasted schedule -> [{day, label} | {day, range}]. Weekday words are ignored. */
function parseSchedule(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim().split(/\s+/).filter(w => w && !WEEKDAYS.has(w.toLowerCase().replace(/,$/, '')));
    if (!/^\d{1,2}$/.test(t[0] || '')) continue;
    const day = +t[0];
    if (day < 1 || day > 31 || t.length < 2) continue;
    const range = t.slice(1).map(parseRange).find(Boolean);
    out.push(range ? { day, range } : { day, label: t.slice(1).join(' ') });
  }
  return out;
}

let toastTimer = null;
function toast(msg, ms = 4000) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
const setStatus = text => { $('status').textContent = text; };

// ---------- proxy API ----------
async function api(path, { method = 'GET', body, params } = {}, retried = false) {
  let url = (settings.proxy || DEFAULT_PROXY).replace(/\/+$/, '') + path;
  if (params) url += '?' + new URLSearchParams(params);
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (session && path !== '/login') headers['X-Session'] = session.token;
  let res;
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('Network error — is the proxy reachable?');
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (res.status === 401 && data && data.reason === 'SESSION_EXPIRED' && !retried) {
    await login(); // silent re-login with the stored credentials, once
    return api(path, { method, body, params }, true);
  }
  if (data && data.ok) return data;
  const err = new Error((data && data.reason) || `HTTP ${res.status}`);
  err.violation = !!(data && data.violation);
  throw err;
}

async function login() {
  if (!settings.username || !settings.password) throw new Error('Add your e-value login in Settings.');
  const d = await api('/login', { method: 'POST', body: { username: settings.username, password: settings.password } }, true);
  session = { token: d.session, userID: d.userID };
  store.set('session', session);
}

const loggedIn = () => !!(settings.username && settings.password);

async function loadLookups() {
  const d = await api('/lookups');
  lookups = { tasks: d.tasks || [], activities: d.activities || [] };
  store.set('lookups', lookups);
}

async function loadMonth(m) {
  const d = await api('/month', { params: { m } });
  ev[m] = d.entries || [];
  store.set('ev', ev);
}

// ---------- plan persistence + sync ----------
let syncTimer = null;
function save() {
  dh.updated = Date.now();
  store.set('plan2', dh);
  clearTimeout(syncTimer);
  if (loggedIn()) syncTimer = setTimeout(push, 1500);
}

async function push() {
  try { await api('/plan', { method: 'POST', body: dh }); }
  catch (err) { setStatus('Not synced: ' + err.message); }
}

// ponytail: last-write-wins on the whole plan; fine for one person on two devices.
async function pull() {
  const { plan } = await api('/plan');
  if (plan && plan.version === 2 && plan.updated > dh.updated) {
    dh = upgrade(plan);
    store.set('plan2', dh);
  } else if (!plan || plan.version !== 2 || plan.updated < dh.updated) {
    await push();
  }
}

// ---------- lookups ----------
const tasks = () => (lookups && lookups.tasks && lookups.tasks.length ? lookups.tasks : TASKS_FALLBACK);
const acts = () => (lookups && lookups.activities) || [];
const actName = id => { const a = acts().find(x => String(x.id) === String(id)); return a ? a.name : ''; };
const taskName = id => { const t = tasks().find(x => String(x.id) === String(id)); return t ? t.name : ''; };
const idByName = (list, name) => { const x = list.find(i => i.name.toLowerCase() === String(name).toLowerCase()); return x ? String(x.id) : ''; };
const isWork = task => !NON_DH.has(String(task));
const typeById = id => dh.types.find(t => t.id === id);

function rotationAt(date) {
  return dh.rotations.filter(x => x.from && x.to && x.from <= date && date <= x.to).pop() || null;
}
function rotationOn(date) { const r = rotationAt(date); return r && r.act ? String(r.act) : ''; }
const rotLabel = r => (r.amion || actName(r.act) || '?');

function rotColor(r) {
  if (dh.colors[rotLabel(r)]) return dh.colors[rotLabel(r)];
  const keys = [...new Set(dh.rotations.map(rotLabel))];
  const i = keys.indexOf(rotLabel(r));
  return i < 0 ? '#757575' : COLORS[i % COLORS.length];
}

/** Short calendar tag for a block's activity (Academic Afternoon -> "Acad"). */
const TAGS = { 894: 'Acad', 918: 'Clinic' };
const tagFor = act => TAGS[act] || (actName(act) || '').split(/[\s-]/)[0].slice(0, 7);

// ---------- resolving a day ----------
const span = sg => [toMin(sg.s), toMin(sg.s) + minsBetween(sg.s, sg.e)];

/** Put block `w` on top of `segs`: whatever was in w's window is cut out. */
function overlay(segs, w) {
  const [ws, we] = span(w);
  return segs.flatMap(sg => {
    const [a, b] = span(sg);
    const out = [];
    if (a < ws) out.push({ ...sg, s: fromMin(a), e: fromMin(Math.min(b, ws)) });
    if (b > we) out.push({ ...sg, s: fromMin(Math.max(a, we)), e: fromMin(b) });
    return out;
  }).concat([w]).sort((p, q) => toMin(p.s) - toMin(q.s));
}

/** Planned work blocks for a date (type or custom), weekly blocks applied. Raw act/task. */
function daySegs(date) {
  const x = dh.days[date];
  let segs = structuredClone((x && (x.segs || (typeById(x.t) || {}).segs)) || []);
  const dow = dateOf(date).getDay();
  for (const w of dh.weekly.filter(w => +w.dow === dow && w.s && w.e)) {
    const [ws, we] = span(w);
    const hits = segs.filter(sg => { const [a, b] = span(sg); return a < we && b > ws; });
    // Only on days you're working through that window, and never over an explicit Amion block (EX, clinic…).
    if (!hits.some(sg => isWork(sg.task || WORK)) || hits.some(sg => sg.tag)) continue;
    segs = overlay(segs, { s: w.s, e: w.e, act: w.act, task: w.task });
  }
  return segs.sort((p, q) => toMin(p.s) - toMin(q.s));
}

/** Blocks as minutes from this date's midnight, with act/task resolved. */
function relSegs(date, offset = 0) {
  const rot = rotationOn(date);
  return daySegs(date).map(sg => {
    const a = toMin(sg.s) + offset;
    const task = String(sg.task || WORK);
    return { a, b: a + minsBetween(sg.s, sg.e), task, act: String(sg.act || (isWork(task) ? rot : '') || '-1'), tag: sg.tag };
  });
}

/**
 * Every e-value entry this date needs: work blocks that start today, plus (fillOff) Non Duty Hours
 * for each uncovered stretch of today — including the tail of last night's shift.
 * ponytail: minutes assume 24 h days; a shift across a DST change is off by an hour in the gap math.
 */
function entriesFor(date) {
  const own = relSegs(date);
  if (!dh.fillOff) return own;
  const busy = own.concat(relSegs(addDays(date, -1), -1440))
    .map(x => [Math.max(0, x.a), Math.min(1440, x.b)]).filter(([a, b]) => b > a)
    .sort((p, q) => p[0] - q[0]);
  const rot = rotationOn(date) || '-1';
  const gaps = [];
  let cur = 0;
  for (const [a, b] of busy) {
    if (a > cur) gaps.push({ a: cur, b: a, task: NONDUTY, act: rot });
    cur = Math.max(cur, b);
  }
  if (cur < 1440) gaps.push({ a: cur, b: 1440, task: NONDUTY, act: rot });
  return own.concat(gaps).sort((p, q) => p.a - q.a);
}

const inScope = date => !!(dh.days[date] || rotationOn(date));
const evOn = date => (ev[date.slice(0, 7)] || []).filter(x => x.date === date);
const logged = date => evOn(date).length > 0;
const workMins = list => list.filter(x => isWork(x.task)).reduce((n, x) => n + x.b - x.a, 0);

/** e-value entries for a date in the same shape as entriesFor(). */
function evRel(date) {
  return evOn(date).filter(x => x.s && x.e).map(x => {
    const a = toMin(x.s);
    return { a, b: a + minsBetween(x.s, x.e), task: idByName(tasks(), x.task) || WORK, act: idByName(acts(), x.activity) || '-1', dhid: x.dhid, raw: x };
  });
}

function dueAt(date, list) {
  const d = dateOf(date);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, Math.max(1440, ...list.map(x => x.b)));
}

function isDue(date, now = new Date()) {
  if (!inScope(date) || logged(date)) return false;
  const list = entriesFor(date);
  return dueAt(date, list) <= now || list.every(x => VACAY.has(x.task));
}

const dueDays = () => {
  const dates = new Set([...Object.keys(dh.days), ...dh.rotations.flatMap(r => rangeDates(r.from, r.to))]);
  return [...dates].sort().filter(d => isDue(d));
};

function rangeDates(from, to) {
  const out = [];
  if (!from || !to || from > to) return out;
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

const describe = x => `${short(fromMin(x.a % 1440))}–${short(fromMin(x.b % 1440))} ${x.task === NONDUTY ? 'off' : (actName(x.act) || taskName(x.task))}`;

// ---------- rendering ----------
function render() {
  if (!month) month = iso(new Date()).slice(0, 7);
  $('month').value = month;
  if (!['off', 'edit'].includes(brush) && !typeById(brush)) brush = dh.types.length ? dh.types[0].id : 'edit';
  renderBrushes();
  renderGrid();
  renderRotations();
  renderTypes();
  renderWeekly();
  renderMap();
  renderSubmit();
  $('jitter').textContent = monthDates().some(d => dh.days[d] && dh.days[d].jit && !logged(d)) ? 'Remove jitter' : 'Add jitter';
}

function actSelect(current, blankLabel) {
  const sel = el('select');
  const blank = el('option', '', blankLabel);
  blank.value = '';
  sel.appendChild(blank);
  const list = acts();
  [['On your schedule', list.filter(a => a.scheduled)], ['All activities', list.filter(a => !a.scheduled)]]
    .forEach(([label, items]) => {
      if (!items.length) return;
      const g = el('optgroup');
      g.label = label;
      items.forEach(a => { const o = el('option', '', a.name); o.value = a.id; g.appendChild(o); });
      sel.appendChild(g);
    });
  // keep an id we can't name yet (lists not loaded) selectable
  if (current && !list.some(a => String(a.id) === String(current))) {
    const o = el('option', '', 'Activity #' + current);
    o.value = current;
    sel.appendChild(o);
  }
  sel.value = current || '';
  sel.setAttribute('aria-label', 'e-value activity');
  return sel;
}

function taskSelect(current) {
  const sel = el('select');
  tasks().forEach(t => { const o = el('option', '', t.name); o.value = t.id; sel.appendChild(o); });
  sel.value = current || WORK;
  sel.setAttribute('aria-label', 'e-value task');
  return sel;
}

function timeInput(v, label) {
  const i = el('input');
  i.type = 'time';
  i.step = 900;
  i.value = v || '';
  i.setAttribute('aria-label', label);
  return i;
}

function renderBrushes() {
  const box = $('brushes');
  box.innerHTML = '';
  const add = (id, label) => {
    const b = el('button', 'chip brush' + (brush === id ? ' active' : ''), label);
    b.type = 'button';
    b.onclick = () => { brush = id; renderBrushes(); };
    box.appendChild(b);
  };
  dh.types.forEach(t => add(t.id, t.name));
  add('off', '⌫ Off');
  add('edit', '✎ Open day');
}

function renderGrid() {
  const g = $('grid');
  g.innerHTML = '';
  ['S', 'M', 'T', 'W', 'T', 'F', 'S', 'hrs'].forEach(d => g.appendChild(el('div', 'head', d)));
  const [y, m] = month.split('-').map(Number);
  const lead = new Date(y, m - 1, 1).getDay();
  const cells = Math.ceil((lead + new Date(y, m, 0).getDate()) / 7) * 7;
  const today = iso(new Date());
  const now = new Date();
  let week = 0;

  for (let i = 0; i < cells; i++) {
    const date = iso(new Date(y, m - 1, 1 - lead + i));
    const isLogged = logged(date);
    const list = isLogged ? evRel(date) : inScope(date) ? entriesFor(date) : [];
    week += workMins(list); // includes spill-over days from adjacent months

    if (date.slice(0, 7) !== month) {
      g.appendChild(el('div', 'cell blank'));
    } else {
      const c = el('div', 'cell');
      c.dataset.date = date;
      if (date === today) c.classList.add('today');
      const rot = rotationAt(date);
      const top = el('div', 'top');
      top.appendChild(el('span', 'day', String(+date.slice(8))));
      if (rot) {
        const r = el('span', 'rot', rotLabel(rot));
        r.style.background = rotColor(rot);
        r.title = rotLabel(rot) + (rot.act ? ' → ' + actName(rot.act) : ' (no e-value activity mapped)');
        top.appendChild(r);
      }
      c.appendChild(top);
      const wm = workMins(list);
      if (isLogged) c.classList.add('logged');
      else if (inScope(date)) c.classList.add(isDue(date, now) ? 'due' : 'planned');
      // Everything that isn't plain rotation time gets its own line: Acad 12–5p, Clinic 1–5p, SAT CALL 6a–6a…
      const rotAct = rotationOn(date);
      list.filter(x => (isWork(x.task) && (x.tag || x.act !== rotAct)) || (x.tag && x.task === NONDUTY)).forEach(x => {
        const t = el('span', 'tag', `${x.tag || tagFor(x.act) || taskName(x.task)} ${short(fromMin(x.a % 1440))}–${short(fromMin(x.b % 1440))}`);
        if (String(x.act) === '894') t.classList.add('acad');
        if (!isWork(x.task)) t.classList.add('nd');
        c.appendChild(t);
      });
      list.filter(x => VACAY.has(x.task)).slice(0, 1).forEach(x => c.appendChild(el('span', 'tag', taskName(x.task))));
      if (isLogged) c.appendChild(el('span', 'time', '✓ ' + (wm ? fmtH(wm) + ' h' : 'off')));
      else if (inScope(date)) c.appendChild(el('span', 'time', wm ? fmtH(wm) + ' h' : 'off'));
      g.appendChild(c);
    }
    if (i % 7 === 6) {
      g.appendChild(el('div', 'week' + (week > 80 * 60 ? ' over' : ''), week ? fmtH(week) : ''));
      week = 0;
    }
  }
}

function renderSubmit() {
  const due = dueDays();
  const b = $('submit');
  b.disabled = !due.length;
  b.textContent = due.length ? `Send ${due.length} finished day${due.length > 1 ? 's' : ''} to e-value` : 'Nothing to send yet';
}

/** Editable list rows; each row gets ✕. `fields` picks which columns show. */
function listEditor(box, items, makeRow, onChange, show = () => true) {
  box.innerHTML = '';
  items.forEach((item, idx) => {
    if (!show(item)) return;
    const row = el('div', 'row');
    const inputs = makeRow(item, row);
    const del = el('button', 'btn secondary del', '✕');
    del.type = 'button';
    del.setAttribute('aria-label', 'Remove');
    del.onclick = () => { items.splice(idx, 1); onChange(true); };
    inputs.forEach(i => i.addEventListener('change', () => onChange(false)));
    row.appendChild(del);
    box.appendChild(row);
  });
}

function segRowMaker(rotLabel) {
  return (sg, row) => {
    const s = timeInput(sg.s, 'Start'), e = timeInput(sg.e, 'End');
    const a = actSelect(sg.act, rotLabel), t = taskSelect(sg.task);
    const sync = () => {
      sg.s = s.value; sg.e = e.value;
      if (a.value) sg.act = a.value; else delete sg.act;
      if (t.value !== WORK) sg.task = t.value; else delete sg.task;
    };
    [s, e, a, t].forEach(i => i.addEventListener('change', sync));
    row.classList.add('seg');
    row.append(s, e, a, t);
    return [s, e, a, t];
  };
}

function renderRotations() {
  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`, last = iso(new Date(y, m, 0));
  listEditor($('rotations'), dh.rotations, (r, row) => {
    const name = el('label', 'rotname');
    const swatch = el('input');
    swatch.type = 'color';
    swatch.value = rotColor(r);
    swatch.setAttribute('aria-label', 'Colour for ' + rotLabel(r));
    swatch.addEventListener('input', () => { dh.colors[rotLabel(r)] = swatch.value; save(); renderGrid(); });
    name.append(swatch, el('span', '', r.amion || 'Manual'));
    const from = el('input'); from.type = 'date'; from.value = r.from || ''; from.setAttribute('aria-label', 'From');
    const to = el('input'); to.type = 'date'; to.value = r.to || ''; to.setAttribute('aria-label', 'To');
    const a = actSelect(r.act, lookups ? '— pick e-value activity —' : 'Log in to load activities');
    [from, to, a].forEach(i => i.addEventListener('change', () => {
      r.from = from.value; r.to = to.value; r.act = a.value;
      if (r.amion) { // one Amion rotation name = one e-value activity, everywhere
        dh.map[r.amion] = { ...(dh.map[r.amion] || {}), act: a.value };
        dh.rotations.forEach(x => { if (x.amion === r.amion) x.act = a.value; });
      }
    }));
    row.classList.add('rotrow');
    row.append(name, from, to, a);
    return [from, to, a];
  }, () => { save(); render(); }, r => r.from <= last && r.to >= first);
}

/** Amion names/codes -> e-value activity/task. Changes re-apply the cached Amion month. */
function renderMap() {
  const box = $('amion-map');
  box.innerHTML = '';
  Object.keys(dh.map).sort().forEach(k => {
    const mp = dh.map[k];
    const row = el('div', 'row maprow');
    const a = actSelect(mp.act, 'Rotation');
    const skip = el('option', '', 'Ignore (not work)');
    skip.value = 'skip';
    a.insertBefore(skip, a.children[1]);
    a.value = mp.skip ? 'skip' : (mp.act || '');
    const t = taskSelect(mp.task);
    const change = () => {
      const next = { ...mp, act: a.value === 'skip' ? '' : a.value, skip: a.value === 'skip' };
      if (t.value === WORK) delete next.task; else next.task = t.value;
      dh.map[k] = next;
      dh.rotations.forEach(x => { if (x.amion === k) x.act = next.act; });
      reapplyAmion();
    };
    [a, t].forEach(i => i.addEventListener('change', change));
    row.append(el('span', 'mapkey', k), a, t);
    box.appendChild(row);
  });
  ['am', 'pm'].forEach(k => ['s', 'e'].forEach(f => { $(`sess-${k}-${f}`).value = dh.sessions[k][f]; }));
}

function renderTypes() {
  const box = $('types');
  box.innerHTML = '';
  dh.types.forEach(t => {
    const card = el('div', 'type');
    const head = el('div', 'type-head');
    const name = el('input'); name.type = 'text'; name.value = t.name; name.setAttribute('aria-label', 'Day type name');
    name.addEventListener('change', () => { if (name.value.trim()) { t.name = name.value.trim(); save(); renderBrushes(); renderGrid(); } });
    const del = el('button', 'btn secondary del', '✕');
    del.type = 'button';
    del.setAttribute('aria-label', 'Delete ' + t.name);
    del.onclick = () => {
      // Days using this type keep their blocks as custom days.
      Object.values(dh.days).forEach(x => { if (x.t === t.id) { delete x.t; x.segs = structuredClone(t.segs); } });
      dh.types = dh.types.filter(q => q !== t);
      save();
      render();
    };
    head.append(name, del);
    const segs = el('div');
    const redraw = () => listEditor(segs, t.segs, segRowMaker('Rotation'), rerender => {
      save(); if (rerender) redraw(); renderGrid(); renderSubmit();
    });
    redraw();
    const addSeg = el('button', 'btn secondary small', '+ block');
    addSeg.type = 'button';
    addSeg.onclick = () => { t.segs.push({ s: '13:00', e: '17:00' }); save(); redraw(); renderGrid(); };
    card.append(head, segs, addSeg);
    box.appendChild(card);
  });
}

function renderWeekly() {
  listEditor($('weekly'), dh.weekly, (w, row) => {
    const d = el('select');
    DOW.forEach((n, i) => { const o = el('option', '', n); o.value = i; d.appendChild(o); });
    d.value = w.dow;
    d.setAttribute('aria-label', 'Day of week');
    const s = timeInput(w.s, 'Start'), e = timeInput(w.e, 'End');
    const a = actSelect(w.act, 'Rotation');
    [d, s, e, a].forEach(i => i.addEventListener('change', () => { w.dow = +d.value; w.s = s.value; w.e = e.value; w.act = a.value; }));
    row.classList.add('weekrow');
    row.append(d, s, e, a);
    return [d, s, e, a];
  }, rerender => { save(); if (rerender) renderWeekly(); renderGrid(); renderSubmit(); });
  $('fill-off').checked = dh.fillOff;
}

// ---------- painting ----------
function cellAt(e) {
  const n = document.elementFromPoint(e.clientX, e.clientY);
  return n && n.closest('.cell[data-date]');
}

function applyStroke(cell) {
  const date = cell.dataset.date;
  if (stroke.seen.has(date)) return;
  stroke.seen.add(date);
  if (logged(date)) return; // already in e-value — open the day to change it
  if (stroke.mode === 'off') delete dh.days[date];
  else dh.days[date] = { t: brush };
  renderGrid();
}

function endStroke() {
  if (!stroke) return;
  stroke = null;
  save();
  renderSubmit();
}

// ---------- day sheet ----------
function openDay(date) {
  editing = date;
  $('ed-title').textContent = dateOf(date).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const rot = rotationAt(date);
  $('ed-rot').textContent = rot ? rotLabel(rot) + (rot.act ? ' → ' + (actName(rot.act) || '#' + rot.act) : '') : '';
  $('ed-ev').classList.toggle('hidden', !logged(date));
  $('ed-plan').classList.toggle('hidden', logged(date));
  if (logged(date)) renderEvEditor(date); else renderPlanEditor(date);
  $('editor').classList.remove('hidden');
}

function closeDay() { $('editor').classList.add('hidden'); editing = null; render(); }

let draft = null; // segs being edited for a planned day
function renderPlanEditor(date) {
  const x = dh.days[date];
  draft = structuredClone((x && (x.segs || (typeById(x.t) || {}).segs)) || []);
  const sel = $('ed-type');
  sel.innerHTML = '';
  dh.types.forEach(t => { const o = el('option', '', t.name); o.value = t.id; sel.appendChild(o); });
  [['custom', 'Custom'], ['off', 'Off (all non-duty)']].forEach(([v, n]) => { const o = el('option', '', n); o.value = v; sel.appendChild(o); });
  sel.value = x ? (x.t || 'custom') : 'off';
  drawDraft(date);
}

function drawDraft(date) {
  const rotLabel = rotationOn(date) ? 'Rotation (' + (actName(rotationOn(date)) || 'set') + ')' : 'Rotation';
  listEditor($('ed-segs'), draft, segRowMaker(rotLabel), rerender => {
    $('ed-type').value = draft.length ? 'custom' : 'off';
    if (rerender) drawDraft(date); else previewDraft(date);
  });
  previewDraft(date);
}

/** Show exactly what this day would send, using the draft. */
function previewDraft(date) {
  const saved = dh.days[date];
  dh.days[date] = { segs: draft };
  const list = entriesFor(date);
  if (saved) dh.days[date] = saved; else delete dh.days[date];
  const box = $('ed-preview');
  box.innerHTML = '';
  list.forEach(x => box.appendChild(el('div', x.task === NONDUTY ? 'pv off' : 'pv',
    `${short(fromMin(x.a % 1440))}–${short(fromMin(x.b % 1440))}${x.b > 1440 ? ' (+1d)' : ''}  ${taskName(x.task)}${x.act !== '-1' ? ' · ' + (actName(x.act) || '#' + x.act) : ''}`)));
  if (!list.length) box.appendChild(el('div', 'pv', 'Nothing (day not in a rotation and no blocks).'));
}

function saveDay() {
  const v = $('ed-type').value;
  if (v === 'off' || !draft.length) delete dh.days[editing];
  else if (v !== 'custom' && JSON.stringify(draft) === JSON.stringify((typeById(v) || {}).segs)) dh.days[editing] = { t: v };
  else dh.days[editing] = { segs: draft.filter(sg => sg.s && sg.e) };
  save();
  closeDay();
}

/** Entries already in e-value: edit / delete each, or add one. */
function renderEvEditor(date) {
  const box = $('ed-ev-list');
  box.innerHTML = '';
  const rows = evRel(date).map(x => ({ dhid: x.dhid, s: x.raw.s, e: x.raw.e, task: x.task, act: x.act === '-1' ? '' : x.act }));
  rows.push({ dhid: null, s: '', e: '', task: WORK, act: '' });
  rows.forEach(r => {
    const row = el('div', 'row seg evrow');
    const s = timeInput(r.s, 'Start'), e = timeInput(r.e, 'End');
    const a = actSelect(r.act, 'No activity'), t = taskSelect(r.task);
    const go = el('button', 'btn ' + (r.dhid ? 'secondary' : 'primary') + ' small', r.dhid ? 'Save' : '+ Add');
    go.type = 'button';
    go.onclick = () => evWrite(date, r.dhid ? '/edit' : '/shift',
      { dhid: r.dhid || undefined, date, start: s.value, end: e.value, taskID: t.value, activityID: a.value || '-1', vacay: VACAY.has(t.value) });
    row.append(s, e, a, t, go);
    if (r.dhid) {
      const del = el('button', 'btn secondary del', '🗑');
      del.type = 'button';
      del.setAttribute('aria-label', 'Delete entry');
      del.onclick = () => { if (confirm('Delete this entry from e-value?')) evWrite(date, '/delete', { dhid: r.dhid, date }); };
      row.appendChild(del);
    }
    box.appendChild(row);
  });
}

async function evWrite(date, path, body) {
  if (path !== '/delete' && (!body.start || !body.end)) return toast('Set a start and end time.');
  const st = $('ed-ev-status');
  st.textContent = 'Saving to e-value…';
  try {
    await api(path, { method: 'POST', body });
    await loadMonth(date.slice(0, 7));
    st.textContent = 'Saved.';
  } catch (err) {
    st.textContent = (err.violation ? 'e-value flags a violation — finish this one on e-value: ' : 'Failed: ') + err.message;
  }
  if (logged(date)) renderEvEditor(date); else openDay(date);
}

// ---------- bulk ----------
function monthDates() {
  const [y, m] = month.split('-').map(Number);
  return Array.from({ length: new Date(y, m, 0).getDate() }, (_, i) => iso(new Date(y, m - 1, i + 1)));
}

function fill(weekdaysOnly) {
  if (!typeById(brush)) return toast('Pick a day type first.');
  let n = 0;
  monthDates().forEach(date => {
    const dow = dateOf(date).getDay();
    if (weekdaysOnly && (dow === 0 || dow === 6)) return;
    if (!dh.days[date] && !logged(date)) { dh.days[date] = { t: brush }; n++; }
  });
  save();
  render();
  toast(`Filled ${n} empty day(s).`);
}

function typeFor(name, segs) {
  let t = dh.types.find(q => q.name.toLowerCase() === name.toLowerCase());
  if (!t) {
    t = { id: 't' + Date.now().toString(36) + dh.types.length, name, segs };
    dh.types.push(t);
  }
  return t;
}

/** Best-guess e-value activity for an Amion name: CARDIO -> CARDI, FMIS-II -> FMIS II, GYN-CALVERT -> GYN-Calvert. */
function guessActivity(name) {
  const norm = x => String(x).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const n = norm(name);
  if (!n) return '';
  const list = acts().map(a => ({ id: String(a.id), n: norm(a.name) })).filter(a => a.n);
  const hit = list.find(a => a.n === n)
    || list.filter(a => n.startsWith(a.n) && a.n.length >= 4).sort((p, q) => q.n.length - p.n.length)[0]
    || list.filter(a => a.n.startsWith(n) && n.length >= 3).sort((p, q) => p.n.length - q.n.length)[0];
  return hit ? hit.id : '';
}

/** First sighting of an Amion name/code: a sensible default the user can change in the table. */
function mapFor(key, kind) {
  if (!dh.map[key]) {
    let mp = { act: guessActivity(key) };
    if (key === 'AA') mp = { act: '894', s: '12:00', e: '17:00' };             // Academic Afternoon
    else if (kind === 'clinic' && /^(CL|P\d|WI)/.test(key)) mp = { act: '918' }; // continuity clinic
    else if (/^VA/.test(key)) mp = { act: '', task: '21297' };                  // vacation
    else if (/PHONE/.test(key)) mp = { act: '', task: NONDUTY };                // phones: logged, not duty
    else if (key === 'NC' || /CALL/.test(key)) mp = { act: NC_ACT };            // night/weekend call -> e-value NC
    dh.map[key] = mp;
  }
  return dh.map[key];
}

/** Build a month from Amion: rotation per day, weekday base day, clinic half-days, call/shifts on top. */
function applyAmion(m, data) {
  const [y, mo] = m.split('-').map(Number);
  const first = `${m}-01`, last = iso(new Date(y, mo, 0));
  // Rotations: consecutive days with the same block name become one range.
  dh.rotations = dh.rotations.filter(r => !(r.src === 'amion' && r.from <= last && r.to >= first));
  data.rotations.forEach(({ date, name }) => {
    const prev = dh.rotations[dh.rotations.length - 1];
    if (prev && prev.src === 'amion' && prev.amion === name && addDays(prev.to, 1) === date) prev.to = date;
    else dh.rotations.push({ from: date, to: date, amion: name, act: mapFor(name, 'rotation').act, src: 'amion' });
  });
  const rotName = date => (data.rotations.find(r => r.date === date) || {}).name;
  const base = (typeById('rot') || DEFAULT_TYPES[0]).segs;
  const block = (k, kind, s, e) => {
    const mp = mapFor(k, kind);
    if (mp.skip) return null;
    return { s: mp.s || s, e: mp.e || e, tag: k, ...(mp.act ? { act: mp.act } : {}), ...(mp.task ? { task: mp.task } : {}) };
  };
  let n = 0, kept = 0;
  for (let d = first; d <= last; d = addDays(d, 1)) {
    if (logged(d)) continue;
    if (dh.days[d] && dh.days[d].src !== 'amion') { kept++; continue; } // never overwrite a day you set by hand
    const dow = dateOf(d).getDay();
    const rot = rotName(d);
    let segs = (rot && dow > 0 && dow < 6 && !mapFor(rot, 'rotation').skip) ? structuredClone(base) : [];
    const cl = data.clinic.find(c => c.date === d);
    if (cl) {
      [['am', cl.am], ['pm', cl.pm]].forEach(([half, code]) => {
        const k = (code || '').replace(/-$/, '');
        const b = k && block(k, 'clinic', dh.sessions[half].s, dh.sessions[half].e);
        if (!b) return;
        // The session owns its whole half of the base day: AM = everything up to its end, PM = from its start.
        const [bs, be] = span(b);
        const [cutA, cutB] = half === 'am' ? [0, be] : [bs, 1440];
        const keep = segs.filter(sg => sg.tag);
        segs = overlay(segs.filter(sg => !sg.tag), { s: fromMin(cutA), e: fromMin(cutB % 1440), cut: true })
          .filter(sg => !sg.cut).concat(keep);
        segs = overlay(segs, b);
      });
    }
    data.shifts.filter(r => r.date === d).forEach(r => {
      const b = block(r.assignment, 'shift', r.s, r.e);
      if (b) segs = overlay(segs, b);
    });
    if (segs.length) { dh.days[d] = { segs, src: 'amion' }; n++; }
    else if (dh.days[d]) delete dh.days[d];
  }
  return { n, kept };
}

function reapplyAmion() {
  if (amionCache[month]) applyAmion(month, amionCache[month]);
  save();
  render();
}

async function prefillAmion() {
  if (!settings.amionName) {
    toast('Set your Amion name in Settings first.');
    return $('nav-settings').click();
  }
  const b = $('amion');
  b.disabled = true;
  b.textContent = 'Reading Amion…';
  try {
    const data = await api('/amion/me', { params: { m: month, lo: settings.amionLo || DEFAULT_AMION, name: settings.amionName } });
    if (!data.rotations.length && !data.clinic.length && !data.shifts.length) {
      return toast(`Amion has nothing for "${settings.amionName}" in ${month}.`, 6000);
    }
    amionCache[month] = { rotations: data.rotations, clinic: data.clinic, shifts: data.shifts };
    store.set('amion', amionCache);
    const { n, kept } = applyAmion(month, amionCache[month]);
    save();
    const unmapped = [...new Set(dh.rotations.filter(r => r.amion && !r.act).map(r => r.amion))];
    if (Fun.on) Fun.burst();
    toast(`Loaded ${n} day(s) from Amion` + (kept ? `, kept ${kept} you'd set by hand` : '') + '.' +
      (unmapped.length ? ` Pick the e-value activity for: ${unmapped.join(', ')}.` : ''), 8000);
  } catch (err) {
    toast('Amion: ' + err.message, 6000);
  } finally {
    b.disabled = false;
    b.textContent = 'Pre-fill from Amion';
    render();
  }
}

/** Fill the Settings name suggestions from this month's Amion roster. */
/** Fill the name dropdown from Amion's block-schedule roster (every resident, faculty excluded). */
async function loadAmionNames(sel = $('set-amion-name')) {
  const fill = names => {
    sel.innerHTML = '';
    const blank = el('option', '', '— pick your name —');
    blank.value = '';
    sel.appendChild(blank);
    [...new Set([...names, settings.amionName].filter(Boolean))].sort()
      .forEach(n => { const o = el('option', '', n); o.value = n; sel.appendChild(o); });
    sel.value = settings.amionName || '';
  };
  fill([]);
  try {
    const { names } = await api('/amion/names', { params: { m: iso(new Date()).slice(0, 7), lo: settings.amionLo || DEFAULT_AMION } });
    fill(names);
  } catch { /* keep whatever is saved */ }
}

function applySchedule() {
  const rows = parseSchedule($('paste-text').value);
  if (!rows.length) return toast('Nothing recognised — one day per line, starting with the day number.');
  const days = monthDates().length;
  const before = new Set(dh.types.map(t => t.id));
  let n = 0;
  rows.forEach(r => {
    if (r.day > days) return;
    const date = `${month}-${pad(r.day)}`;
    if (logged(date)) return;
    if (r.range) dh.days[date] = { segs: [{ s: r.range.s, e: r.range.e }] };
    else if (r.label.toLowerCase() === 'off') delete dh.days[date];
    else dh.days[date] = { t: typeFor(r.label, [{ s: '07:30', e: '17:00' }]).id };
    n++;
  });
  const fresh = dh.types.filter(t => !before.has(t.id)).map(t => t.name);
  save();
  $('paster').classList.add('hidden');
  render();
  toast(`Loaded ${n} day(s).` + (fresh.length ? ` New day types: ${fresh.join(', ')} — check their blocks.` : ''), 7000);
  if (fresh.length) $('types-box').open = true;
}

/**
 * Jitter: each unsent planned workday's arrival and departure move by −30…+30 min in e-value's
 * 15-min steps. Only the workday's outer edges move — never a clinic/call start, never inner blocks.
 * The original day is kept so Remove jitter restores it exactly.
 */
const JITTER = [-30, -15, 0, 15, 30];
const pick = () => JITTER[Math.floor(Math.random() * JITTER.length)];
const wrap = m => ((m % 1440) + 1440) % 1440;

function jitterDay(x) {
  const segs = structuredClone(x.segs || (typeById(x.t) || {}).segs || []);
  const work = segs.filter(sg => isWork(sg.task || WORK) && sg.s && sg.e);
  if (!work.length) return null;
  const first = work.reduce((p, q) => (span(q)[0] < span(p)[0] ? q : p));
  const lastSeg = work.reduce((p, q) => (span(q)[1] > span(p)[1] ? q : p));
  let ds = first.tag ? 0 : pick(), de = pick(); // clinic/call starts are fixed (8a, 1p, call time)
  // never run into a neighbouring block (e.g. stay-late vs. PHONES at 5p)
  const others = segs.filter(sg => sg !== first && sg !== lastSeg);
  const before = Math.max(0, ...others.map(sg => span(sg)[1]).filter(e => e <= span(first)[0]));
  const after = Math.min(1440 * 2, ...others.map(sg => span(sg)[0]).filter(st => st >= span(lastSeg)[1]));
  ds = Math.max(ds, before - span(first)[0]);
  de = Math.min(de, after - span(lastSeg)[1]);
  // keep every block at least 15 min and no longer than 24 h, so a 24 h call can't wrap into 30 min
  const ok = (sg, a, b) => { const len = minsBetween(sg.s, sg.e) - a + b; return len >= 15 && len <= 1440; };
  if (first === lastSeg) {
    if (ok(first, ds, de)) { first.s = fromMin(wrap(toMin(first.s) + ds)); first.e = fromMin(wrap(toMin(first.e) + de)); }
  } else {
    if (ok(first, ds, 0)) first.s = fromMin(wrap(toMin(first.s) + ds));
    if (ok(lastSeg, 0, de)) lastSeg.e = fromMin(wrap(toMin(lastSeg.e) + de));
  }
  const { orig, ...plain } = x;
  return { segs, src: x.src, jit: true, orig: orig || plain };
}

function toggleJitter() {
  const dates = monthDates().filter(d => dh.days[d] && !logged(d));
  const jittered = dates.filter(d => dh.days[d].jit);
  if (jittered.length) {
    jittered.forEach(d => { dh.days[d] = dh.days[d].orig; });
    toast(`Removed jitter from ${jittered.length} day(s).`);
  } else {
    let n = 0;
    dates.forEach(d => { const j = jitterDay(dh.days[d]); if (j) { dh.days[d] = j; n++; } });
    toast(n ? `Jittered start/end on ${n} unsent day(s). Tap a day to see its times.` : 'No unsent work days to jitter this month.');
    if (n && window.Fun && Fun.on) Fun.burst();
  }
  save();
  render();
}

function clearMonth() {
  const dates = monthDates().filter(d => dh.days[d] && !logged(d));
  if (!dates.length || !confirm(`Clear ${dates.length} planned day(s) in ${month}? (Rotations stay.)`)) return;
  dates.forEach(d => delete dh.days[d]);
  save();
  render();
}

// ---------- submit ----------
async function submit() {
  const b = $('submit');
  b.disabled = true;
  try {
    // Read back what e-value already has, so nothing is entered twice.
    b.textContent = 'Checking e-value…';
    for (const m of new Set(dueDays().map(d => d.slice(0, 7)))) await loadMonth(m);
    const days = dueDays();
    if (!days.length) return toast('Everything finished is already in e-value.');
    const noRot = days.filter(d => entriesFor(d).some(x => isWork(x.task) && x.act === '-1'));
    if (noRot.length) return toast(`Set a rotation for ${noRot.slice(0, 4).join(', ')}${noRot.length > 4 ? '…' : ''} — work blocks need an activity.`, 7000);

    const lines = days.map(d => `${d.slice(5)}: ${entriesFor(d).map(describe).join(', ')}`);
    if (!confirm(`Send ${days.length} day(s) to e-value?\n\n${lines.slice(0, 25).join('\n')}${lines.length > 25 ? `\n…and ${lines.length - 25} more` : ''}`)) return;

    let sent = 0;
    for (const d of days) {
      for (const x of entriesFor(d)) {
        b.textContent = `Sending ${d} ${describe(x)}…`;
        try {
          await api('/shift', { method: 'POST', body: {
            date: d, start: fromMin(x.a % 1440), end: fromMin(x.b % 1440), taskID: x.task, activityID: x.act, vacay: VACAY.has(x.task),
            note: x.tag || '',
          } });
        } catch (err) {
          await loadMonth(d.slice(0, 7)).catch(() => {});
          throw new Error(`${d} ${describe(x)} — ${err.violation ? 'e-value flags a duty-hour violation; log this day on e-value (it needs your reason)' : err.message}. ` +
            (sent ? `${sent} day(s) before it went through.` : ''));
        }
      }
      sent++;
    }
    for (const m of new Set(days.map(d => d.slice(0, 7)))) await loadMonth(m).catch(() => {});
    toast(`Sent ${sent} day(s) to e-value.`);
    if (Fun.on) Fun.burst();
  } catch (err) {
    toast('Stopped: ' + err.message, 9000);
  } finally {
    render();
  }
}

// ---------- screens ----------
function show(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + name));
  window.scrollTo(0, 0);
}

/** Render now, then refresh from the proxy in the background (plan, lists, what's logged). */
async function openMonth() {
  render();
  if (!loggedIn()) { setStatus(''); return; }
  try {
    setStatus('…');
    await pull();
    if (!lookups) await loadLookups();
    await loadMonth(month);
    setStatus('');
  } catch (err) {
    setStatus('Offline: ' + err.message);
  }
  render();
}

function shiftMonth(delta) {
  const [y, m] = month.split('-').map(Number);
  month = iso(new Date(y, m - 1 + delta, 1)).slice(0, 7);
  openMonth();
}

function bind() {
  const fields = { username: 'set-username', password: 'set-password', proxy: 'set-proxy',
    amionName: 'set-amion-name', amionLo: 'set-amion-lo' };
  const readSettings = () => {
    for (const [k, id] of Object.entries(fields)) settings[k] = k === 'password' ? $(id).value : $(id).value.trim();
    settings.proxy = settings.proxy || DEFAULT_PROXY;
    settings.amionLo = settings.amionLo || DEFAULT_AMION;
    store.set('settings', settings);
  };
  $('nav-settings').onclick = () => {
    for (const [k, id] of Object.entries(fields)) $(id).value = settings[k] || '';
    $('set-proxy').value = settings.proxy || DEFAULT_PROXY;
    $('set-amion-lo').value = settings.amionLo || DEFAULT_AMION;
    $('set-theme').value = settings.theme || 'system';
    $('set-accent').value = settings.accent || DEFAULT_ACCENT;
    show('settings');
    loadAmionNames();
  };
  $('btn-back').onclick = () => { show('hours'); openMonth(); };
  Object.values(fields).forEach(id => $(id).addEventListener('change', readSettings));
  $('set-amion-lo').addEventListener('change', loadAmionNames);
  $('set-theme').addEventListener('change', () => { settings.theme = $('set-theme').value; store.set('settings', settings); applyTheme(); });
  $('set-accent').addEventListener('input', () => { settings.accent = $('set-accent').value; store.set('settings', settings); applyTheme(); });
  $('btn-login').onclick = async () => {
    readSettings();
    const st = $('login-status');
    st.textContent = 'Logging in…';
    try {
      await login();
      st.textContent = 'Logged in — loading tasks and rotations…';
      await loadLookups();
      st.textContent = `OK — ${acts().filter(a => a.scheduled).length} activities on your e-value schedule.`;
    } catch (err) {
      st.textContent = 'Failed: ' + err.message;
    }
  };

  $('prev').onclick = () => shiftMonth(-1);
  $('next').onclick = () => shiftMonth(1);
  $('month').addEventListener('change', () => { if ($('month').value) { month = $('month').value; openMonth(); } });

  const g = $('grid');
  g.addEventListener('pointerdown', e => {
    const cell = cellAt(e);
    if (!cell) return;
    e.preventDefault();
    const date = cell.dataset.date;
    if (brush === 'edit' || logged(date)) return openDay(date);
    const cur = dh.days[date];
    // Tapping a day that already has this type toggles it off (and the drag clears).
    stroke = { mode: brush === 'off' || (cur && cur.t === brush) ? 'off' : 'paint', seen: new Set() };
    applyStroke(cell);
  });
  g.addEventListener('pointermove', e => { if (stroke) { const c = cellAt(e); if (c) applyStroke(c); } });
  window.addEventListener('pointerup', endStroke);
  window.addEventListener('pointercancel', endStroke);
  g.addEventListener('dblclick', e => { const c = cellAt(e); if (c) openDay(c.dataset.date); });

  $('amion').onclick = prefillAmion;
  $('jitter').onclick = toggleJitter;
  $('fun').onclick = () => { $('fun').classList.toggle('active', Fun.toggle()); };
  $('fill-weekdays').onclick = () => fill(true);
  $('fill-all').onclick = () => fill(false);
  $('clear-month').onclick = clearMonth;
  $('paste-sched').onclick = () => { $('paster').classList.remove('hidden'); $('paste-text').focus(); };
  $('paste-apply').onclick = applySchedule;
  $('paste-cancel').onclick = () => $('paster').classList.add('hidden');
  $('submit').onclick = submit;

  $('add-rotation').onclick = () => {
    const [y, m] = month.split('-').map(Number);
    dh.rotations.push({ from: `${month}-01`, to: iso(new Date(y, m, 0)), act: '' });
    save();
    render();
  };
  $('add-type').onclick = () => {
    dh.types.push({ id: 't' + Date.now().toString(36), name: 'New day', segs: [{ s: '07:30', e: '17:00' }] });
    save();
    render();
    $('types-box').open = true;
  };
  $('add-weekly').onclick = () => { dh.weekly.push({ dow: 1, s: '12:00', e: '13:00', act: '' }); save(); renderWeekly(); };
  $('fill-off').addEventListener('change', () => { dh.fillOff = $('fill-off').checked; save(); render(); });
  ['am', 'pm'].forEach(k => ['s', 'e'].forEach(f => $(`sess-${k}-${f}`).addEventListener('change', e => {
    if (e.target.value) { dh.sessions[k][f] = e.target.value; reapplyAmion(); }
  })));

  $('ed-type').addEventListener('change', () => {
    const v = $('ed-type').value;
    if (v === 'off') draft = [];
    else if (v !== 'custom') draft = structuredClone((typeById(v) || {}).segs || []);
    drawDraft(editing);
  });
  $('ed-add-seg').onclick = () => { draft.push({ s: '13:00', e: '17:00' }); $('ed-type').value = 'custom'; drawDraft(editing); };
  $('ed-save').onclick = saveDay;
  $('ed-cancel').onclick = closeDay;
  $('editor').addEventListener('click', e => { if (e.target === $('editor')) closeDay(); });
  $('paster').addEventListener('click', e => { if (e.target === $('paster')) $('paster').classList.add('hidden'); });
}

/** Theme: system / light / OLED-black dark, plus a custom accent colour. */
function applyTheme() {
  const html = document.documentElement;
  if (settings.theme === 'light' || settings.theme === 'dark') html.dataset.theme = settings.theme;
  else delete html.dataset.theme;
  const accent = settings.accent || DEFAULT_ACCENT;
  const [r, g, b] = [1, 3, 5].map(i => parseInt(accent.slice(i, i + 2), 16));
  html.style.setProperty('--accent', accent);
  html.style.setProperty('--accent-ink', (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#000' : '#fff');
  const dark = html.dataset.theme === 'dark' || (!html.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]').content = dark ? '#000000' : accent;
}

// ---------- welcome: pick your name, log in to e-value, land on a pre-filled month ----------
function welcomeStep(n) {
  [1, 2, 3].forEach(i => {
    $('w-step' + i).classList.toggle('hidden', n !== i);
    $('w-dot' + i).classList.toggle('on', n >= i);
  });
  $('w-status').textContent = '';
  if (n === 2) markLook();
}

/** Highlight the current theme + accent on the Look step. */
function markLook() {
  document.querySelectorAll('.theme-opt').forEach(b => b.setAttribute('aria-checked', b.dataset.theme === (settings.theme || 'system')));
  const accent = settings.accent || DEFAULT_ACCENT;
  document.querySelectorAll('.accent-pick .dot').forEach(b => b.setAttribute('aria-checked', b.dataset.accent === accent));
  $('w-accent').value = accent;
}

function setLook(patch) {
  Object.assign(settings, patch);
  store.set('settings', settings);
  applyTheme();
  markLook();
}

function startWelcome() {
  show('welcome');
  welcomeStep(1);
  $('w-user').value = settings.username || '';
  loadAmionNames($('w-name'));
}

function bindWelcome() {
  $('w-next').onclick = () => {
    if (!$('w-name').value) { $('w-status').textContent = 'Pick your name.'; return; }
    settings.amionName = $('w-name').value;
    store.set('settings', settings);
    welcomeStep(2);
  };
  document.querySelectorAll('.theme-opt').forEach(b => { b.onclick = () => setLook({ theme: b.dataset.theme }); });
  document.querySelectorAll('.accent-pick .dot').forEach(b => { b.onclick = () => setLook({ accent: b.dataset.accent }); });
  $('w-accent').addEventListener('input', () => setLook({ accent: $('w-accent').value }));
  $('w-next2').onclick = () => { welcomeStep(3); $('w-user').focus(); };
  $('w-back2').onclick = () => welcomeStep(1);
  $('w-back').onclick = () => welcomeStep(2);
  $('w-pass').addEventListener('keydown', e => { if (e.key === 'Enter') $('w-login').click(); });
  $('w-login').onclick = async () => {
    const st = $('w-status');
    settings.username = $('w-user').value.trim();
    settings.password = $('w-pass').value;
    if (!settings.username || !settings.password) { st.textContent = 'Enter your e-value username and password.'; return; }
    settings.proxy = settings.proxy || DEFAULT_PROXY;
    store.set('settings', settings);
    $('w-login').disabled = true;
    try {
      st.textContent = 'Logging in…';
      await login();
      st.textContent = 'Loading your activities…';
      await loadLookups();
      show('hours');
      month = iso(new Date()).slice(0, 7);
      await openMonth();
      if (!monthDates().some(d => dh.days[d])) await prefillAmion(); // first visit: build this month from Amion
    } catch (err) {
      st.textContent = err.message === 'INVALID_CREDENTIALS' ? 'Wrong username or password.' : 'Failed: ' + err.message;
      settings.password = '';
      store.set('settings', settings);
    } finally {
      $('w-login').disabled = false;
    }
  };
}

function init() {
  applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  bind();
  bindWelcome();
  show('hours');
  openMonth();
  if (!loggedIn() || !settings.amionName) startWelcome();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', init);
