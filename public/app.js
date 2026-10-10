/* Sales Force Dashboard - single-page front end (no libraries) */
'use strict';

// ============================================================== utilities
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const sum = (a, f) => a.reduce((t, r) => t + (f ? num(f(r)) : num(r)), 0);
const uniq = a => [...new Set(a.filter(v => v !== null && v !== undefined && v !== ''))];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nfq = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
const money = v => nf2.format(num(v));
const int = v => nf0.format(num(v));
const qty = v => nfq.format(num(v));
const pct = v => (Number.isFinite(v) ? (Math.round(v * 10) / 10) + '%' : '–');
function compact(v) {
  v = num(v); const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(1) + 'K';
  return nf0.format(v);
}
const rs = v => 'Rs ' + compact(v);

function localISO(d = new Date()) { return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function daysBetween(a, b) { if (!a || !b) return null; return Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86400000); }
function dLabel(iso) { if (!iso) return ''; const [y, m, d] = iso.slice(0, 10).split('-'); return `${+d} ${MON[+m - 1]}`; }
function dFull(iso) { if (!iso) return ''; const [y, m, d] = String(iso).slice(0, 10).split('-'); return d ? `${d} ${MON[+m - 1]} ${y}` : esc(iso); }
const today = () => localISO();
const ageDays = iso => daysBetween(iso, today());

const store = {
  get(k, d) { try { const v = localStorage.getItem('sfd.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sfd.' + k, JSON.stringify(v)); } catch { /* storage off */ } },
};

function toast(msg, ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), ms);
}

// ============================================================== state
const S = {
  preset: store.get('preset', 'last7'),
  from: store.get('from', null),
  to: store.get('to', null),
  rep: store.get('rep', ''),
  cust: '',
  force: false,
};
let MAX_DAYS = 800;          // replaced by the server's MAX_RANGE_DAYS at start
let ALL_FROM = '2025-01-01'; // first date of the "All dates" option (server ALL_FROM)

function applyPreset(p) {
  const t = today();
  const first = t.slice(0, 8) + '01';
  switch (p) {
    case 'today': return [t, t];
    case 'yesterday': return [addDays(t, -1), addDays(t, -1)];
    case 'last7': return [addDays(t, -6), t];
    case 'mtd': return [first, t];
    case 'last30': return [addDays(t, -29), t];
    case 'last90': return [addDays(t, -89), t];
    case 'ytd': return [t.slice(0, 4) + '-01-01', t];
    case 'all': return [ALL_FROM, t];
    case 'lastmonth': { const lmEnd = addDays(first, -1); return [lmEnd.slice(0, 8) + '01', lmEnd]; }
    default: return [S.from || addDays(t, -6), S.to || t];
  }
}
function rangeLabel() { return S.from === S.to ? dFull(S.from) : `${dFull(S.from)} – ${dFull(S.to)}`; }

// ============================================================== API & loading
class AuthError extends Error {}
let ME = null; // the signed-in user: pages, data limits, export / refresh rights
async function api(path, method = 'GET', data) {
  const opt = { credentials: 'same-origin', method, headers: {} };
  if (method !== 'GET') { opt.headers['X-SFD'] = '1'; opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(data || {}); }
  const r = await fetch(path, opt);
  let body = null;
  try { body = await r.json(); } catch { /* not json */ }
  if (r.status === 401 && path !== '/auth/password') { showLogin(); throw new AuthError('Not signed in'); }
  if (r.status === 403 && body && body.mustChangePassword) { showPassword(true); throw new AuthError('Password change required'); }
  if (!r.ok) throw new Error((body && body.error) || `HTTP ${r.status}`);
  return body;
}
const allowed = page => !!ME && (page === 'admin' ? ME.isAdmin : ME.isAdmin || ME.pages.includes(page));
const myReps = () => (ME && !ME.isAdmin ? ME.scope.reps : []);

const P = { total: 0, done: 0 };
function progress(addTotal, addDone, label) {
  P.total += addTotal; P.done += addDone;
  const box = $('#progress');
  if (P.total && P.done < P.total) {
    box.hidden = false;
    $('#progressBar').style.width = Math.round((P.done / P.total) * 100) + '%';
    $('#progressText').textContent = `Loading from SAP… ${P.done}/${P.total} parts${label ? ' · ' + label : ''}`;
  } else { box.hidden = true; P.total = P.done = 0; }
}

const dataCache = new Map();
const meta = { fetchedAt: null, failed: [], stale: [] };
const DS_LABEL = { orders: 'sales orders', invoices: 'invoices', returns: 'return requests', returnCreditNotes: 'return credit notes', quotations: 'quotations' };

function loadRange(ds) {
  const key = `${ds}|${S.from}|${S.to}`;
  if (!S.force && dataCache.has(key)) return dataCache.get(key);
  const force = S.force;
  const chunks = [];
  for (let d = S.from; d <= S.to; d = addDays(d, 3)) {
    const e = addDays(d, 2) < S.to ? addDays(d, 2) : S.to;
    chunks.push([d, e]);
  }
  progress(chunks.length, 0, DS_LABEL[ds]);
  const p = (async () => {
    const out = new Array(chunks.length);
    let next = 0;
    const worker = async () => {
      while (next < chunks.length) {
        const i = next++;
        try {
          out[i] = await api(`/data/${ds}?from=${chunks[i][0]}&to=${chunks[i][1]}${force ? '&refresh=1' : ''}`);
        } finally { progress(0, 1, DS_LABEL[ds]); }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    const res = { rows: [], failed: [], stale: [], fetchedAt: null };
    for (const r of out) {
      res.rows.push(...r.rows); res.failed.push(...r.failed.map(f => ({ ...f, ds }))); res.stale.push(...r.stale);
      if (r.fetchedAt && (!res.fetchedAt || r.fetchedAt < res.fetchedAt)) res.fetchedAt = r.fetchedAt;
    }
    meta.failed.push(...res.failed); meta.stale.push(...res.stale);
    if (res.fetchedAt && (!meta.fetchedAt || res.fetchedAt < meta.fetchedAt)) meta.fetchedAt = res.fetchedAt;
    learn(ds, res.rows);
    return res;
  })();
  p.catch(() => dataCache.delete(key));
  dataCache.set(key, p);
  return p;
}

const liveCache = new Map();
function live(path) {
  if (!S.force && liveCache.has(path)) return liveCache.get(path);
  progress(1, 0);
  const p = api(path + (S.force ? (path.includes('?') ? '&' : '?') + 'refresh=1' : '')).finally(() => progress(0, 1));
  p.then(body => { if (path.startsWith('/live/pending')) learn('pending', body); }, () => liveCache.delete(path));
  liveCache.set(path, p);
  return p;
}

// ------------------------------------------------ directories learnt from data
const REPS = new Map();      // slpCode -> {name, short}
const CUSTS = new Map();     // cardCode -> name
const BRANCHES = new Map([['4', 'Anura Trading Lanka'], ['5', 'Anura Lubricants']]);
function addRep(code, name, short) {
  if (code === null || code === undefined || code === '') return;
  code = String(code);
  const r = REPS.get(code) || {};
  if (name && !r.name) r.name = name;
  if (short && !r.short) r.short = short;
  REPS.set(code, r);
}
function learn(ds, rows) {
  for (const r of rows || []) {
    if (ds === 'orders') { addRep(r.repCode, null, r.uRepCode); CUSTS.set(r.cardCode, r.cardName); }
    else if (ds === 'invoices' || ds === 'returnCreditNotes') {
      addRep(r.slpCode, r.repName); CUSTS.set(r.cardCode, r.cardName);
      if (r.bplId && r.bplName) BRANCHES.set(String(r.bplId), r.bplName);
    } else if (ds === 'returns') { addRep(r.repCode, null, r.uRepCode); CUSTS.set(r.cardCode, r.cardName); }
    else if (ds === 'pending') { addRep(r.SalesPersonCode, r.RepName); CUSTS.set(r.CardCode, r.CardName); }
  }
  refreshFilterLists();
}
// the pending-orders list carries full rep names for reps with no invoices in range
const repNames = () => live('/live/pending').catch(() => null);
function repName(code, short) {
  const r = REPS.get(String(code ?? '')) || {};
  return r.name || short || r.short || (code ? 'Rep ' + code : '–');
}
function branchName(id) { return BRANCHES.get(String(id)) || (id ? 'Branch ' + id : '–'); }

let filterListTimer;
function refreshFilterLists() {
  clearTimeout(filterListTimer);
  filterListTimer = setTimeout(() => {
    const sel = $('#fRep');
    const mine = myReps();
    for (const c of mine) if (!REPS.has(c)) REPS.set(c, {});
    const reps = [...REPS.entries()].filter(([c]) => !mine.length || mine.includes(c)).map(([c, r]) => [c, r.name || r.short || 'Rep ' + c]).sort((a, b) => a[1].localeCompare(b[1]));
    sel.innerHTML = (mine.length === 1 ? '' : `<option value="">${mine.length ? 'All my reps' : 'All reps'}</option>`) + reps.map(([c, n]) => `<option value="${esc(c)}">${esc(n)}</option>`).join('');
    if (mine.length === 1) S.rep = mine[0];
    if (S.rep && !REPS.has(S.rep)) sel.insertAdjacentHTML('beforeend', `<option value="${esc(S.rep)}">Rep ${esc(S.rep)}</option>`);
    sel.value = S.rep;
    $('#custList').innerHTML = [...CUSTS.entries()].slice(0, 3000).map(([c, n]) => `<option value="${esc(c)}">${esc(n)}</option>`).join('');
  }, 150);
}

// filters
const repOK = code => !S.rep || String(code) === S.rep;
const custOK = (code, name) => {
  if (!S.cust) return true;
  const q = S.cust.toLowerCase();
  return String(code || '').toLowerCase() === q || `${code || ''} ${name || ''}`.toLowerCase().includes(q);
};

// ============================================================== status vocab
const SO_ST = {
  'Pending Approvel': { label: 'Pending approval', cls: 'warning', color: 'var(--warning)' },
  'Pending Approval': { label: 'Pending approval', cls: 'warning', color: 'var(--warning)' },
  'Processing': { label: 'Processing', cls: 'info', color: 'var(--info)' },
  'Invoice Generated': { label: 'Invoiced', cls: 'good', color: 'var(--good)' },
  'Credit Note Generated': { label: 'Credit note issued', cls: 'good', color: 'var(--good)' },
  'Rejected': { label: 'Rejected', cls: 'critical', color: 'var(--critical)' },
  'Cancelled': { label: 'Cancelled', cls: '', color: 'var(--neutral)' },
  'Quotation Open': { label: 'Quotation open', cls: 'warning', color: 'var(--warning)' },
  'Quotation Closed': { label: 'Quotation closed', cls: '', color: 'var(--neutral)' },
  'Quotation Cancelled': { label: 'Quotation cancelled', cls: 'critical', color: 'var(--critical)' },
  'Fully converted': { label: 'Fully converted', cls: 'good', color: 'var(--good)' },
  'Partly converted': { label: 'Partly converted', cls: 'serious', color: 'var(--serious)' },
  'Open lines': { label: 'Open lines', cls: 'warning', color: 'var(--warning)' },
  'FULL': { label: 'Delivered', cls: 'good' }, 'PARTIAL': { label: 'Partly delivered', cls: 'serious' }, 'NOT_DELIVERED': { label: 'Not delivered', cls: 'warning' },
  'Paid': { label: 'Paid', cls: 'good' }, 'Part paid': { label: 'Part paid', cls: 'serious' }, 'Unpaid': { label: 'Unpaid', cls: 'warning' },
};
const stLabel = s => (SO_ST[s] && SO_ST[s].label) || s || '–';
const chip = s => s ? `<span class="chip ${(SO_ST[s] || {}).cls || ''}"><span class="dot"></span>${esc(stLabel(s))}</span>` : '';
const SO_ORDER = ['Pending Approvel', 'Processing', 'Invoice Generated', 'Rejected', 'Cancelled'];
const RR_ORDER = ['Pending Approval', 'Processing', 'Credit Note Generated', 'Rejected', 'Cancelled'];
const isLive = o => o.status !== 'Rejected' && o.status !== 'Cancelled';
// rep / customer on a quotation come from its sales order, so unconverted quotations drop out while a filter is set
const quotOK = q => (!S.rep || String(q.repCode) === S.rep) && (!S.cust || custOK(q.cardCode, q.cardName));

// ============================================================== tooltip
document.addEventListener('mouseover', e => {
  const t = e.target.closest && e.target.closest('[data-tip]');
  const tip = $('#tip');
  if (!t) { tip.hidden = true; return; }
  tip.innerHTML = t.getAttribute('data-tip'); tip.hidden = false; placeTip(e);
});
document.addEventListener('mousemove', e => { if (!$('#tip').hidden) placeTip(e); });
function placeTip(e) {
  const tip = $('#tip'), w = tip.offsetWidth, h = tip.offsetHeight;
  let x = e.clientX + 14, y = e.clientY + 14;
  if (x + w > innerWidth - 8) x = e.clientX - w - 14;
  if (y + h > innerHeight - 8) y = e.clientY - h - 14;
  tip.style.left = Math.max(8, x) + 'px'; tip.style.top = Math.max(8, y) + 'px';
}
const tipAttr = html => `data-tip="${esc(html)}"`;

// ============================================================== charts
// axis top = 4 round steps, so every gridline label is a round number
function niceMax(v, integer) {
  if (!(v > 0)) return integer ? 4 : 1;
  const raw = v / 4, e = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / e;
  let step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(c => f <= c + 1e-9) * e;
  if (integer) step = Math.max(1, Math.ceil(step));
  return step * 4;
}
const observers = new WeakMap();
function onResize(el, draw) {
  draw();
  if (observers.has(el)) observers.get(el).disconnect();
  let w = el.clientWidth;
  const ro = new ResizeObserver(() => { if (Math.abs(el.clientWidth - w) > 4) { w = el.clientWidth; draw(); } });
  ro.observe(el); observers.set(el, ro);
}

/** Column chart, optionally stacked. data: [{x, v:{key:value}}]; series: [{key,label,color}] */
function columnChart(el, { data, series, fmt = compact, tipFmt = money, height = 220 }) {
  if (!data.length) { el.innerHTML = '<div class="empty">No data in this range</div>'; return; }
  onResize(el, () => {
    const W = Math.max(280, el.clientWidth), H = height, pl = 52, pr = 6, pt = 8, pb = 24;
    const iw = W - pl - pr, ih = H - pt - pb;
    const totals = data.map(d => series.reduce((a, s) => a + num(d.v[s.key]), 0));
    const max = niceMax(Math.max(...totals), fmt === int);
    const n = data.length, slot = iw / n, bw = Math.max(3, Math.min(42, slot * 0.68));
    let g = '';
    for (let i = 0; i <= 4; i++) {
      const y = pt + ih - (ih * i) / 4;
      g += `<line class="${i ? 'grid-line' : 'base-line'}" x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}"/>`;
      g += `<text x="${pl - 8}" y="${y + 4}" text-anchor="end">${esc(fmt((max * i) / 4))}</text>`;
    }
    const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(iw / 58))));
    data.forEach((d, i) => {
      const x = pl + slot * i + (slot - bw) / 2;
      let y0 = pt + ih;
      const segs = series.map(s => ({ s, v: num(d.v[s.key]) })).filter(z => z.v > 0);
      segs.forEach((z, j) => {
        const h = (ih * z.v) / max, y = y0 - h, top = j === segs.length - 1;
        if (top) {
          const r = Math.min(4, bw / 2, h);
          g += `<path d="M${x},${y0} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + bw - r},${y} Q${x + bw},${y} ${x + bw},${y + r} L${x + bw},${y0} Z" fill="${z.s.color}" stroke="var(--surface)" stroke-width="1"/>`;
        } else g += `<rect x="${x}" y="${y}" width="${bw}" height="${h}" fill="${z.s.color}" stroke="var(--surface)" stroke-width="1"/>`;
        y0 = y;
      });
      if (i % every === 0) g += `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(d.label || dLabel(d.x))}</text>`;
      const tip = `<b>${esc(d.tip || dFull(d.x))}</b><br>` + (series.length > 1
        ? series.map(s => `${esc(s.label)}: ${esc(tipFmt(d.v[s.key] || 0))}`).join('<br>') + `<br><b>Total: ${esc(tipFmt(totals[i]))}</b>`
        : esc(tipFmt(totals[i])));
      g += `<rect x="${pl + slot * i}" y="${pt}" width="${slot}" height="${ih}" fill="transparent" ${tipAttr(tip)}/>`;
    });
    const legend = series.length > 1 ? `<div class="legend">${series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('')}</div>` : '';
    el.innerHTML = `<div class="chart"><svg viewBox="0 0 ${W} ${H}" height="${H}" role="img">${g}</svg></div>${legend}`;
  });
}

/** Horizontal bars: items [{label, value, sub, key}] */
function hbars(el, items, { fmt = rs, color = 'var(--s1)', onClick, max: fixedMax, limit = 10, valueTip = money } = {}) {
  items = items.filter(i => num(i.value) > 0).slice(0, limit);
  if (!items.length) { el.innerHTML = '<div class="empty">No data in this range</div>'; return; }
  const max = fixedMax || Math.max(...items.map(i => num(i.value)), 1);
  el.innerHTML = `<div class="hbar">${items.map((it, i) => {
    const w = Math.max(0.5, (num(it.value) / max) * 100);
    const tip = `<b>${esc(it.label)}</b><br>${esc(valueTip(it.value))}${it.sub ? '<br>' + esc(it.sub) : ''}`;
    return `<div class="l" title="${esc(it.label)}">${onClick ? `<span class="link" data-hb="${i}">${esc(it.label)}</span>` : esc(it.label)}</div>
      <div class="track" ${tipAttr(tip)}><div class="fill" style="width:${w}%;background:${it.color || color}"></div></div>
      <div class="v">${esc(fmt(it.value))}</div>`;
  }).join('')}</div>`;
  if (onClick) $$('[data-hb]', el).forEach(a => a.addEventListener('click', () => onClick(items[+a.dataset.hb])));
}

/** Part-of-whole bar with legend: parts [{label, value, color, sub}] */
function stackBar(el, parts, { fmt = int, onClick } = {}) {
  parts = parts.filter(p => num(p.value) > 0);
  const total = sum(parts, p => p.value);
  if (!total) { el.innerHTML = '<div class="empty">No data in this range</div>'; return; }
  el.innerHTML = `<div class="stack">${parts.map(p => `<div style="flex:${num(p.value)};background:${p.color}" ${tipAttr(`<b>${esc(p.label)}</b><br>${esc(fmt(p.value))} · ${esc(pct((p.value / total) * 100))}${p.sub ? '<br>' + esc(p.sub) : ''}`)}></div>`).join('')}</div>
    <div class="legend">${parts.map((p, i) => `<span${onClick ? ` class="link" data-sb="${i}"` : ''}><i style="background:${p.color}"></i>${esc(p.label)} <b>${esc(fmt(p.value))}</b> <span class="muted">${esc(pct((p.value / total) * 100))}</span></span>`).join('')}</div>`;
  if (onClick) $$('[data-sb]', el).forEach(a => a.addEventListener('click', () => onClick(parts[+a.dataset.sb])));
}

function dailySeries(rows, dateKey, valueFn, keyFn) {
  const days = [];
  for (let d = S.from; d <= S.to; d = addDays(d, 1)) days.push({ x: d, v: {} });
  const idx = new Map(days.map((d, i) => [d.x, i]));
  for (const r of rows) {
    const i = idx.get(String(r[dateKey]).slice(0, 10));
    if (i === undefined) continue;
    const k = keyFn ? keyFn(r) : 'v';
    days[i].v[k] = (days[i].v[k] || 0) + valueFn(r);
  }
  return bucketize(days);
}

// up to 62 days: one bar a day; up to 30 weeks: one a week (Monday start); longer: one a month
function grain(from = S.from, to = S.to) { const n = daysBetween(from, to) + 1; return n <= 62 ? 'day' : n <= 210 ? 'week' : 'month'; }
const grainWord = () => ({ day: 'Daily', week: 'Weekly', month: 'Monthly' }[grain()]);
function bucketize(days, avgKeys = []) {
  const g = grain();
  if (g === 'day') return days;
  const out = new Map();
  for (const d of days) {
    let k = d.x;
    if (g === 'week') { const dow = (new Date(d.x + 'T00:00:00Z').getUTCDay() + 6) % 7; k = addDays(d.x, -dow); }
    else k = d.x.slice(0, 7) + '-01';
    const b = out.get(k) || { x: k, v: {}, n: 0, end: d.x };
    for (const [key, val] of Object.entries(d.v)) b.v[key] = (b.v[key] || 0) + num(val);
    b.n++; b.end = d.x;
    out.set(k, b);
  }
  return [...out.values()].map(b => {
    for (const key of avgKeys) if (b.v[key] !== undefined) b.v[key] /= b.n;
    const [y, m] = b.x.split('-');
    return g === 'week'
      ? { x: b.x, v: b.v, label: dLabel(b.x), tip: `Week of ${dFull(b.x)}` }
      : { x: b.x, v: b.v, label: `${MON[+m - 1]} ${y.slice(2)}`, tip: `${MON[+m - 1]} ${y}` };
  });
}

// ============================================================== table
function cmp(a, b) {
  const an = a === null || a === undefined || a === '', bn = b === null || b === undefined || b === '';
  if (an || bn) return an && bn ? 0 : an ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/**
 * cols: [{key, label, num, fmt(v,row)->html, val(row)->sortable, csv(row)->text}]
 * opts: rows, pageSize, name, onRow(row), sort {key, dir}, footer(rows)->{key: html}, tools: extra html
 */
function table(el, opt) {
  const cols = opt.cols;
  const saved = store.get('pageSize', null); // 0 = all rows
  let ps = saved === 0 ? 0 : Math.max(saved || 25, opt.pageSize || 25);
  let q = '', sortKey = opt.sort ? opt.sort.key : null, dir = opt.sort ? opt.sort.dir || 'desc' : 'desc', page = 0, view = [];
  const valOf = (c, r) => (c.val ? c.val(r) : r[c.key]);
  const textOf = (c, r) => { const v = c.csv ? c.csv(r) : valOf(c, r); return v === null || v === undefined ? '' : Array.isArray(v) ? v.join(' ') : String(v); };
  el.innerHTML = `<div class="tbl-tools"><span class="count"></span>${opt.tools || ''}<label class="small muted">Rows <select data-ps aria-label="Rows per page">${[25, 50, 100, 0].map(n => `<option value="${n}">${n || 'All'}</option>`).join('')}</select></label><input type="search" placeholder="Search this table" aria-label="Search table">${ME && !ME.canExport ? '' : '<button class="btn sm" data-csv>⭳ Excel (CSV)</button>'}</div>
    <div class="tbl-wrap"><table><thead><tr>${cols.map(c => `<th class="${c.num ? 'num' : ''}" data-k="${esc(c.key)}">${esc(c.label)}</th>`).join('')}</tr></thead><tbody></tbody><tfoot></tfoot></table></div>
    <div class="pager"></div>`;
  const tbody = $('tbody', el), tfoot = $('tfoot', el), pager = $('.pager', el), count = $('.count', el);
  function render() {
    let rows = opt.rows;
    if (q) { const ql = q.toLowerCase(); rows = rows.filter(r => cols.some(c => textOf(c, r).toLowerCase().includes(ql))); }
    if (sortKey) { const c = cols.find(x => x.key === sortKey); if (c) rows = [...rows].sort((a, b) => cmp(valOf(c, a), valOf(c, b)) * (dir === 'asc' ? 1 : -1)); }
    view = rows;
    const size = ps || rows.length || 1;
    const pages = Math.max(1, Math.ceil(rows.length / size)); page = Math.min(page, pages - 1);
    const slice = rows.slice(page * size, page * size + size);
    tbody.innerHTML = slice.length ? slice.map((r, i) => `<tr data-i="${i}" class="${opt.onRow ? 'click' : ''}">${cols.map(c => {
      const v = valOf(c, r);
      return `<td class="${c.num ? 'num' : ''} ${c.cls || ''}">${c.fmt ? c.fmt(v, r) : esc(Array.isArray(v) ? v.join(', ') : v ?? '')}</td>`;
    }).join('')}</tr>`).join('') : `<tr><td colspan="${cols.length}" class="empty">${esc(opt.empty || 'Nothing to show')}</td></tr>`;
    if (opt.footer && rows.length) {
      const f = opt.footer(rows);
      tfoot.innerHTML = `<tr>${cols.map((c, i) => `<td class="${c.num ? 'num' : ''}">${i === 0 && f[c.key] === undefined ? 'Total' : f[c.key] ?? ''}</td>`).join('')}</tr>`;
    } else tfoot.innerHTML = '';
    count.textContent = `${int(rows.length)} row${rows.length === 1 ? '' : 's'}${q ? ' (filtered)' : ''}`;
    pager.innerHTML = pages > 1 ? `<button class="btn sm" data-p="-1" ${page ? '' : 'disabled'}>‹ Prev</button><span>Page ${page + 1} of ${pages}</span><button class="btn sm" data-p="1" ${page < pages - 1 ? '' : 'disabled'}>Next ›</button>` : '';
    $$('th', el).forEach(th => { th.classList.toggle('sorted', th.dataset.k === sortKey); th.classList.toggle('asc', th.dataset.k === sortKey && dir === 'asc'); });
    tbody.onclick = opt.onRow ? e => {
      if (e.target.closest('[data-open],a,button')) return;
      const tr = e.target.closest('tr[data-i]'); if (tr) opt.onRow(slice[+tr.dataset.i]);
    } : null;
  }
  $('thead', el).addEventListener('click', e => {
    const th = e.target.closest('th'); if (!th) return;
    if (sortKey === th.dataset.k) dir = dir === 'asc' ? 'desc' : 'asc'; else { sortKey = th.dataset.k; dir = cols.find(c => c.key === sortKey).num ? 'desc' : 'asc'; }
    render();
  });
  let t; $('input[type=search]', el).addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => { q = e.target.value.trim(); page = 0; render(); }, 200); });
  pager.addEventListener('click', e => { const b = e.target.closest('[data-p]'); if (b) { page += +b.dataset.p; render(); } });
  const psSel = $('[data-ps]', el);
  if (![25, 50, 100, 0].includes(ps)) psSel.insertAdjacentHTML('afterbegin', `<option value="${ps}">${ps}</option>`);
  psSel.value = String(ps);
  psSel.addEventListener('change', () => { ps = +psSel.value; store.set('pageSize', ps); page = 0; render(); });
  const csvBtn = $('[data-csv]', el);
  if (csvBtn) csvBtn.addEventListener('click', () => downloadCSV(opt.name || 'export', cols, view, textOf));
  render();
  return { setRows(r) { opt.rows = r; page = 0; render(); } };
}

function downloadCSV(name, cols, rows, textOf) {
  const q = s => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const lines = [cols.map(c => q(c.label)).join(',')].concat(rows.map(r => cols.map(c => q(textOf(c, r))).join(',')));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `${name}_${S.from}_${S.to}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// links that open a drawer: data-open="order:123"
const openLink = (kind, id, text) => id ? `<span class="link" data-open="${kind}:${esc(id)}">${esc(text ?? id)}</span>` : '';
const openLinks = (kind, ids) => (ids || []).map(id => openLink(kind, id)).join(', ');
document.addEventListener('click', e => {
  const a = e.target.closest('[data-open]'); if (!a) return;
  e.preventDefault();
  const i = a.dataset.open.indexOf(':');
  openDoc(a.dataset.open.slice(0, i), a.dataset.open.slice(i + 1));
});

// ============================================================== layout helpers
const tile = (label, value, sub, opts = {}) => `<div class="tile ${opts.href ? 'click' : ''}" ${opts.href ? `data-href="${esc(opts.href)}" role="link" tabindex="0"` : ''}>
  <div class="lbl">${esc(label)}</div><div class="val" title="${esc(opts.title || value)}">${esc(value)}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
// money tile: short figure on the card, exact amount on hover
const rsTile = (label, v, sub, opts = {}) => tile(label, rs(v), sub, { ...opts, title: 'Rs ' + money(v) });
const card = (id, title, sub = '', right = '') => `<section class="card"><div class="card-head"><h2>${esc(title)}</h2>${sub ? `<span class="sub">${sub}</span>` : ''}${right ? `<span class="right">${right}</span>` : ''}</div><div id="${id}"></div></section>`;
document.addEventListener('click', e => { const t = e.target.closest('.tile[data-href]'); if (t) location.hash = t.dataset.href; });
document.addEventListener('keydown', e => { if (e.key === 'Enter') { const t = e.target.closest && e.target.closest('.tile[data-href]'); if (t) location.hash = t.dataset.href; } });
const spinner = (txt = 'Loading…') => `<div class="empty"><span class="spinner"></span> ${esc(txt)}</div>`;
const errorBox = msg => `<section class="card"><div class="alert crit"><b>Could not load data.</b> ${esc(msg)}</div><p><button class="btn sm" onclick="route()">Try again</button></p></section>`;

function tabs(el, items, current, onPick) {
  el.innerHTML = `<div class="tabs">${items.map(t => `<button class="tab ${t.key === current ? 'on' : ''}" data-t="${esc(t.key)}">${esc(t.label)}${t.n !== undefined ? `<span class="n">${int(t.n)}</span>` : ''}</button>`).join('')}</div>`;
  $$('[data-t]', el).forEach(b => b.addEventListener('click', () => { $$('.tab', el).forEach(x => x.classList.toggle('on', x === b)); onPick(b.dataset.t); }));
}

// ============================================================== pages
const PAGES = {};
let seq = 0;

PAGES.overview = {
  title: 'Overview',
  async render(main, alive) {
    main.innerHTML = `<div class="tiles" id="kpis">${spinner('Loading sales, orders and returns for ' + rangeLabel())}</div>`;
    const [O0, I0, C0, R0] = await Promise.all([loadRange('orders'), loadRange('invoices'), loadRange('returnCreditNotes'), loadRange('returns'), repNames()]);
    if (!alive()) return;
    const O = O0.rows.filter(o => repOK(o.repCode) && custOK(o.cardCode, o.cardName));
    const I = I0.rows.filter(i => repOK(i.slpCode) && custOK(i.cardCode, i.cardName));
    const C = C0.rows.filter(c => repOK(c.slpCode) && custOK(c.cardCode, c.cardName));
    const R = R0.rows.filter(r => repOK(r.repCode) && custOK(r.cardCode, r.cardName));

    const sales = sum(I, i => i.docTotal), vat = sum(I, i => i.vat), paid = sum(I, i => i.paid);
    const liveO = O.filter(isLive);
    const pend = O.filter(o => o.status === 'Pending Approvel');
    const approved = O.filter(o => o.status === 'Processing' || o.status === 'Invoice Generated');
    const soQ = sum(approved, o => o.soQty), delQ = sum(approved, o => o.deliveredQty);
    const niLines = sum(approved, o => o.notIssuedLines);
    const retVal = sum(C, c => c.docTotal);
    const lead = O.filter(o => o.firstInvoiceDate).map(o => daysBetween(o.docDate, o.firstInvoiceDate));
    const sameDay = lead.filter(d => d === 0).length;
    const rrPend = R.filter(r => r.status === 'Pending Approval');

    $('#kpis').innerHTML = [
      rsTile('Invoiced sales', sales, `${int(I.length)} invoices · Rs ${compact(sales - vat)} before VAT`, { href: '#/invoices' }),
      tile('Sales orders', int(O.length), `Rs ${compact(sum(liveO, o => o.docTotal))} open value (not rejected/cancelled)`, { href: '#/orders' }),
      tile('Awaiting approval', int(pend.length), `Rs ${compact(sum(pend, o => o.docTotal))} · oldest ${pend.length ? Math.max(...pend.map(o => ageDays(o.docDate))) + ' days' : '–'}`, { href: '#/pending' }),
      tile('Order fulfilment', soQ ? pct((delQ / soQ) * 100) : '–', `delivered qty of approved orders · ${int(niLines)} lines not issued`, { href: '#/orders?tab=ni' }),
      tile('Order → invoice', lead.length ? (sum(lead) / lead.length).toFixed(1) + ' days' : '–', `average · ${int(sameDay)} of ${int(lead.length)} invoiced same day`),
      tile('Collected', sales ? pct((paid / sales) * 100) : '–', `Rs ${compact(paid)} paid of invoices in range`),
      rsTile('Return credit notes', retVal, `${int(C.length)} notes · ${sales ? pct((retVal / sales) * 100) : '–'} of sales`, { href: '#/returns?tab=cn' }),
      tile('Return requests', int(R.length), `${int(rrPend.length)} awaiting approval`, { href: '#/returns' }),
      `<div id="qTile">${tile('Quotations', '…', '<span class="spinner"></span> loading quotations', { href: '#/quotations' })}</div>`,
    ].join('');
    // quotations are the slowest dataset, so this tile fills in after the rest of the page
    loadRange('quotations').then(res => {
      const el = alive() && $('#qTile'); if (!el) return;
      const Q = res.rows.filter(quotOK);
      const lines = sum(Q, q => q.lines), conv = sum(Q, q => q.convertedLines);
      const open = Q.filter(q => q.status === 'Open lines').length;
      el.outerHTML = tile('Quotations', int(Q.length), `${lines ? pct((conv / lines) * 100) : '–'} of lines converted to orders · ${int(open)} with open lines`, { href: '#/quotations' });
    }, e => { const el = alive() && $('#qTile'); if (el) el.outerHTML = tile('Quotations', '–', 'could not load: ' + esc(e.message), { href: '#/quotations' }); });

    main.insertAdjacentHTML('beforeend', `
      <div class="grid g2">${card('cDailySales', grainWord() + ' invoiced sales', 'Invoice total incl. VAT')}${card('cDailyOrders', grainWord() + ' sales orders by status', 'Count of orders')}</div>
      <div class="grid g3">${card('cStatus', 'Order status', rangeLabel())}${card('cPipe', 'Order pipeline', 'Orders reaching each stage')}${card('cAttn', 'Needs attention', '')}</div>
      <div class="grid g2">${card('cReps', 'Top sales reps', 'Invoiced value · click to filter')}${card('cCust', 'Top customers', 'Invoiced value · click for details')}</div>`);

    columnChart($('#cDailySales'), { data: dailySeries(I, 'docDate', i => i.docTotal), series: [{ key: 'v', label: 'Invoiced', color: 'var(--s1)' }], tipFmt: v => 'Rs ' + money(v) });
    const stSeries = SO_ORDER.map(k => ({ key: k, label: stLabel(k), color: SO_ST[k].color }));
    columnChart($('#cDailyOrders'), { data: dailySeries(O, 'docDate', () => 1, o => o.status), series: stSeries, fmt: int, tipFmt: int });

    const byStatus = SO_ORDER.map(k => { const g = O.filter(o => o.status === k); return { key: k, label: stLabel(k), value: g.length, color: SO_ST[k].color, sub: 'Rs ' + money(sum(g, o => o.docTotal)) }; });
    stackBar($('#cStatus'), byStatus, { onClick: p => (location.hash = '#/orders?tab=' + encodeURIComponent(p.key)) });
    $('#cStatus').insertAdjacentHTML('beforeend', `<div class="tbl-wrap" style="margin-top:12px"><table><thead><tr><th>Status</th><th class="num">Orders</th><th class="num">Value (Rs)</th></tr></thead><tbody>${byStatus.map(s => `<tr><td>${chip(s.key)}</td><td class="num">${int(s.value)}</td><td class="num">${esc(s.sub.slice(3))}</td></tr>`).join('')}</tbody></table></div>`);

    const placed = O.length;
    const stages = [
      { label: 'Placed', value: placed },
      { label: 'Approved', value: approved.length + O.filter(o => o.status === 'Cancelled').length },
      { label: 'Delivered (any)', value: O.filter(o => o.deliveries.length).length },
      { label: 'Invoiced', value: O.filter(o => o.invoices.length).length },
      { label: 'Fully paid', value: O.filter(o => o.invoicedValue > 0 && o.paidValue >= o.invoicedValue - 0.5).length },
    ];
    const seq4 = ['var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-3)', 'var(--seq-4)'];
    hbars($('#cPipe'), stages.map((s, i) => ({ ...s, color: seq4[i], sub: placed ? pct((s.value / placed) * 100) + ' of placed' : '' })), { fmt: v => `${int(v)}  ·  ${placed ? pct((v / placed) * 100) : '–'}`, max: placed || 1, valueTip: int });

    const stuckPend = pend.filter(o => ageDays(o.docDate) >= 2);
    const stuckProc = O.filter(o => o.status === 'Processing' && !o.deliveries.length && ageDays(o.docDate) >= 2);
    const niOrders = approved.filter(o => o.notIssuedLines > 0 && o.deliveries.length);
    const adj = O.filter(o => o.adjustedLines > 0);
    const unpaidOld = I.filter(i => i.docTotal - i.paid > 1 && ageDays(i.docDate) > 30);
    const items = [
      [stuckPend.length, 'orders waiting for approval 2+ days', '#/pending', true],
      [stuckProc.length, 'approved orders with no delivery after 2+ days', '#/orders?tab=Processing', true],
      [niOrders.length, 'delivered orders with lines not fully issued', '#/orders?tab=ni', false],
      [adj.length, 'orders where quantity changed from the quotation', '#/orders?tab=adj', false],
      [rrPend.length, 'return requests awaiting approval', '#/returns', false],
      [unpaidOld.length, 'invoices in range unpaid after 30 days', '#/invoices?tab=unpaid', false],
    ];
    $('#cAttn').innerHTML = items.map(([n, t, h, crit]) => `<div class="alert ${crit && n ? 'crit' : ''}" style="margin-bottom:8px;${n ? '' : 'opacity:.6'}"><a href="${h}"><b>${int(n)}</b></a> ${esc(t)}</div>`).join('');

    const repAgg = groupSum(I, i => i.slpCode, i => i.docTotal);
    hbars($('#cReps'), repAgg.map(([k, v, n]) => ({ key: k, label: repName(k), value: v, sub: `${n} invoices` })), {
      onClick: it => { S.rep = String(it.key); $('#fRep').value = S.rep; store.set('rep', S.rep); route(); },
    });
    const custAgg = groupSum(I, i => i.cardCode, i => i.docTotal);
    hbars($('#cCust'), custAgg.map(([k, v, n]) => ({ key: k, label: `${CUSTS.get(k) || k} (${k})`, value: v, sub: `${n} invoices` })), { onClick: it => openDoc('customer', it.key) });
  },
};

function groupSum(rows, keyFn, valFn) {
  const m = new Map();
  for (const r of rows) { const k = keyFn(r); const e = m.get(k) || [k, 0, 0]; e[1] += num(valFn(r)); e[2]++; m.set(k, e); }
  return [...m.values()].sort((a, b) => b[1] - a[1]);
}

// ---------------------------------------------------------------- orders
PAGES.orders = {
  title: 'Sales orders',
  async render(main, alive, params) {
    main.innerHTML = spinner('Loading sales orders for ' + rangeLabel());
    const [res] = await Promise.all([loadRange('orders'), repNames()]);
    if (!alive()) return;
    const all = res.rows.filter(o => repOK(o.repCode) && custOK(o.cardCode, o.cardName));
    const groups = {
      all: { label: 'All', f: () => true },
      'Pending Approvel': { label: 'Pending approval', f: o => o.status === 'Pending Approvel' },
      Processing: { label: 'Processing', f: o => o.status === 'Processing' },
      'Invoice Generated': { label: 'Invoiced', f: o => o.status === 'Invoice Generated' },
      Rejected: { label: 'Rejected', f: o => o.status === 'Rejected' },
      Cancelled: { label: 'Cancelled', f: o => o.status === 'Cancelled' },
      ni: { label: 'Not fully issued', f: o => (o.status === 'Processing' || o.status === 'Invoice Generated') && o.notIssuedLines > 0 },
      adj: { label: 'Qty changed vs quotation', f: o => o.adjustedLines > 0 },
      unpaid: { label: 'Invoiced, unpaid', f: o => o.invoicedValue > 0 && o.paidValue < o.invoicedValue - 0.5 },
    };
    let cur = groups[params.tab] ? params.tab : 'all';
    const rows = () => all.filter(groups[cur].f);
    main.innerHTML = `<div class="tiles" id="okpi"></div><section class="card"><div id="otabs" style="margin-bottom:12px"></div><div id="otbl"></div></section>`;
    const live = all.filter(isLive);
    $('#okpi').innerHTML = [
      tile('Orders', int(all.length), `${int(sum(all, o => o.lines))} lines`),
      rsTile('Order value', sum(live, o => o.docTotal), 'excludes rejected & cancelled'),
      rsTile('Invoiced value', sum(all, o => o.invoicedValue), `${int(all.filter(o => o.invoices.length).length)} orders invoiced`),
      tile('Units not issued', qty(sum(all.filter(o => o.status === 'Processing' || o.status === 'Invoice Generated'), o => o.unissuedQty)), 'approved orders'),
    ].join('');
    tabs($('#otabs'), Object.entries(groups).map(([k, g]) => ({ key: k, label: g.label, n: all.filter(g.f).length })), cur, k => { cur = k; t.setRows(rows()); });
    const t = table($('#otbl'), {
      name: 'sales_orders', rows: rows(), sort: { key: 'docNum', dir: 'desc' }, onRow: o => openDoc('order', o.docNum),
      cols: [
        { key: 'docNum', label: 'SO no.', fmt: v => openLink('order', v) },
        { key: 'docDate', label: 'Date', fmt: v => dFull(v) },
        { key: 'age', label: 'Age (days)', num: true, val: o => ageDays(o.docDate) },
        { key: 'cust', label: 'Customer', val: o => `${o.cardName} (${o.cardCode})`, fmt: (v, o) => `${openLink('customer', o.cardCode, o.cardName)} <span class="muted small">${esc(o.cardCode)}</span>` },
        { key: 'rep', label: 'Rep', val: o => repName(o.repCode, o.uRepCode) },
        { key: 'docTotal', label: 'Value (Rs)', num: true, fmt: money },
        { key: 'status', label: 'Status', fmt: v => chip(v), csv: o => stLabel(o.status) },
        { key: 'lines', label: 'Lines', num: true },
        { key: 'fulfilment', label: 'Fulfilled', num: true, fmt: v => pct(v) },
        { key: 'notIssuedLines', label: 'Lines not issued', num: true, fmt: (v, o) => v && (o.status === 'Processing' || o.status === 'Invoice Generated') && o.deliveries.length ? `<b style="color:var(--bad-ink)">${int(v)}</b>` : int(v) },
        { key: 'sqNumber', label: 'Quotation', fmt: v => openLink('quotation', v) },
        { key: 'deliveries', label: 'Deliveries', fmt: v => esc((v || []).join(', ')) },
        { key: 'invoices', label: 'Invoices', fmt: v => esc((v || []).join(', ')) },
        { key: 'invoicedValue', label: 'Invoiced (Rs)', num: true, fmt: money },
        { key: 'paidValue', label: 'Paid (Rs)', num: true, fmt: money },
        { key: 'lead', label: 'Days to invoice', num: true, val: o => o.firstInvoiceDate ? daysBetween(o.docDate, o.firstInvoiceDate) : null },
      ],
      footer: r => ({ docTotal: money(sum(r, o => o.docTotal)), lines: int(sum(r, o => o.lines)), notIssuedLines: int(sum(r, o => o.notIssuedLines)), invoicedValue: money(sum(r, o => o.invoicedValue)), paidValue: money(sum(r, o => o.paidValue)) }),
    });
  },
};

// ---------------------------------------------------------------- track
PAGES.track = {
  title: 'Track a document',
  async render(main, alive, params) {
    const kinds = [
      ['order', 'Sales order no.'], ['quotation', 'Sales quotation no.'], ['return', 'Return request no.'],
      ['part', 'Part number (orders in date range)'], ['item', 'Item stock & price'], ['customer', 'Customer code'],
    ];
    const k0 = kinds.some(k => k[0] === params.type) ? params.type : 'order';
    main.innerHTML = `<section class="card"><div class="card-head"><h2>Find and follow a document</h2><span class="sub">Quotation → order → approval → delivery → invoice → payment</span></div>
      <form class="search-row" id="trackForm"><select id="tkType">${kinds.map(([k, l]) => `<option value="${k}" ${k === k0 ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <input id="tkVal" placeholder="Enter number or code" value="${esc(params.q || '')}" required><button class="btn primary">Track</button></form></section><div id="tkOut" class="grid"></div>`;
    const go = async () => {
      const type = $('#tkType').value, v = $('#tkVal').value.trim();
      if (!v) return;
      history.replaceState(null, '', `#/track?type=${type}&q=${encodeURIComponent(v)}`);
      const out = $('#tkOut');
      out.innerHTML = `<section class="card">${spinner('Looking up ' + v)}</section>`;
      try {
        if (type === 'part') return renderPartResults(out, v);
        if (type === 'item') return renderItemSearch(out, v);
        if (['order', 'quotation', 'return'].includes(type) && !/^\d+$/.test(v)) throw new Error('Enter digits only');
        out.innerHTML = '';
        await renderDoc(type, v, out);
      } catch (e) { if (!(e instanceof AuthError)) out.innerHTML = errorBox(e.message); }
    };
    $('#trackForm').addEventListener('submit', e => { e.preventDefault(); go(); });
    if (params.q) go(); else $('#tkVal').focus();
  },
};

async function renderPartResults(out, part) {
  const body = await api(`/lookup/part?part=${encodeURIComponent(part)}&from=${S.from}&to=${S.to}`);
  const orders = (body.data && body.data.orders) || [];
  out.innerHTML = `<section class="card"><div class="card-head"><h2>Orders containing part ${esc(part)}</h2><span class="sub">${esc(rangeLabel())}</span></div><div id="ptbl"></div></section>`;
  table($('#ptbl'), {
    name: 'part_' + part, rows: orders, sort: { key: 'docNum', dir: 'desc' }, onRow: o => openDoc('order', o.docNum),
    cols: [
      { key: 'docNum', label: 'SO no.', fmt: v => openLink('order', v) },
      { key: 'docDate', label: 'Date', fmt: dFull },
      { key: 'cardName', label: 'Customer' },
      { key: 'rep', label: 'Rep', val: o => repName(o.repCode, o.uRepCode) },
      { key: 'docTotal', label: 'Value (Rs)', num: true, fmt: money },
      { key: 'orderStatus', label: 'Status', fmt: chip },
      { key: 'partQty', label: 'Part qty', num: true, val: o => sum((o.lines || []).filter(l => l.partNumber === part), l => l.salesOrder && l.salesOrder.soQty) },
      { key: 'partDel', label: 'Delivered', num: true, val: o => sum((o.lines || []).filter(l => l.partNumber === part), l => l.delivery && l.delivery.deliveredQty) },
    ],
  });
}

async function renderItemSearch(out, s) {
  const items = await api(`/lookup/items?search=${encodeURIComponent(s)}`);
  out.innerHTML = `<section class="card"><div class="card-head"><h2>Items matching “${esc(s)}”</h2><span class="sub">first 50 · click an item for stock by warehouse</span></div><div id="itbl"></div></section><div id="idet"></div>`;
  table($('#itbl'), {
    name: 'items', rows: items, onRow: it => showItem(it, $('#idet')),
    cols: [
      { key: 'ItemCode', label: 'Item code' }, { key: 'ItemName', label: 'Name' }, { key: 'SupplierCatalogNo', label: 'Part no.' },
      { key: 'QuantityOnStock', label: 'In stock', num: true, fmt: qty },
      { key: 'committed', label: 'Committed', num: true, val: it => sum(it.ItemWarehouseInfoCollection || [], w => w.Committed), fmt: qty },
      { key: 'price', label: 'Price list 1 (Rs)', num: true, val: it => ((it.ItemPrices || []).find(p => p.PriceList === 1) || {}).Price ?? null, fmt: v => v === null ? '' : money(v) },
      { key: 'NI Count', label: 'Not-issued count', num: true },
      { key: 'U_Active_SFA', label: 'Active in SFA' },
    ],
  });
  if (items.length === 1) showItem(items[0], $('#idet'));
}
function showItem(it, el) {
  const wh = (it.ItemWarehouseInfoCollection || []).filter(w => w.InStock || w.Committed || w.Ordered);
  el.innerHTML = `<section class="card"><div class="card-head"><h2>${esc(it.ItemCode)}</h2><span class="sub">${esc(it.ItemName)}</span></div>
    <div class="kv" style="margin-bottom:14px"><div><span>Part no.</span><b>${esc(it.SupplierCatalogNo)}</b></div><div><span>Brand</span><b>${esc(it.U_ItemsBrandCode)}</b></div><div><span>Vehicle model</span><b>${esc(it.U_VehicleModel)}</b></div><div><span>Origin</span><b>${esc(it.U_CountryofOrigin)}</b></div><div><span>Prices</span><b>${(it.ItemPrices || []).filter(p => p.Price).map(p => `PL${p.PriceList}: ${money(p.Price)}`).join(' · ') || '–'}</b></div></div>
    <div id="whTbl"></div></section>`;
  table($('#whTbl', el), {
    name: 'stock_' + it.ItemCode, rows: wh, pageSize: 50, sort: { key: 'InStock', dir: 'desc' },
    cols: [{ key: 'WarehouseCode', label: 'Warehouse' }, { key: 'InStock', label: 'In stock', num: true, fmt: qty }, { key: 'Committed', label: 'Committed', num: true, fmt: qty }, { key: 'Ordered', label: 'Ordered', num: true, fmt: qty }, { key: 'avail', label: 'Available', num: true, val: w => num(w.InStock) - num(w.Committed), fmt: qty }],
    footer: r => ({ InStock: qty(sum(r, w => w.InStock)), Committed: qty(sum(r, w => w.Committed)), Ordered: qty(sum(r, w => w.Ordered)), avail: qty(sum(r, w => num(w.InStock) - num(w.Committed))) }),
    empty: 'No stock in any warehouse',
  });
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------- approvals
PAGES.pending = {
  title: 'Approvals',
  async render(main, alive) {
    main.innerHTML = spinner('Loading orders awaiting approval');
    const [pend, rej] = await Promise.all([live('/live/pending'), live(`/live/rejected?from=${S.from}&to=${S.to}`)]);
    if (!alive()) return;
    const P0 = pend.filter(p => repOK(p.SalesPersonCode) && custOK(p.CardCode, p.CardName)).map(p => ({ ...p, age: ageDays(p.DocDate), value: num(p.DocTotal) }));
    const R0 = rej.filter(p => repOK(p.SalesPersonCode) && custOK(p.CardCode, p.CardName)).map(p => ({ ...p, age: ageDays(p.DocDate), value: num(p.DocTotal) }));
    const ages = P0.map(p => p.age);
    main.innerHTML = `<div class="tiles">
        ${tile('Awaiting approval (all dates)', int(P0.length), `Rs ${compact(sum(P0, p => p.value))}`)}
        ${tile('Oldest waiting', ages.length ? Math.max(...ages) + ' days' : '–', ages.length ? `average ${(sum(ages) / ages.length).toFixed(1)} days` : '')}
        ${tile('Waiting over 7 days', int(ages.filter(a => a > 7).length), 'need follow-up')}
        ${tile('Rejected in range', int(R0.length), `Rs ${compact(sum(R0, p => p.value))} · ${esc(rangeLabel())}`)}
      </div>
      <div class="grid g2">${card('cAge', 'How long orders have waited', 'Orders awaiting approval by age')}${card('cPRep', 'Waiting by sales rep', 'Value awaiting approval')}</div>
      ${card('pTbl', 'Orders awaiting approval', 'All dates · not limited by the date filter')}
      ${card('rTbl', 'Rejected orders', esc(rangeLabel()))}`;
    const buckets = [['Today / 1 day', 0, 1], ['2–3 days', 2, 3], ['4–7 days', 4, 7], ['8–14 days', 8, 14], ['15–30 days', 15, 30], ['Over 30 days', 31, 1e9]];
    const seqC = ['var(--seq-1)', 'var(--seq-2)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)', 'var(--seq-4)'];
    hbars($('#cAge'), buckets.map(([l, a, b], i) => { const g = P0.filter(p => p.age >= a && p.age <= b); return { label: l, value: g.length, color: seqC[i], sub: 'Rs ' + money(sum(g, p => p.value)) }; }), { fmt: int, valueTip: v => int(v) + ' orders', max: Math.max(1, ...buckets.map(([, a, b]) => P0.filter(p => p.age >= a && p.age <= b).length)) });
    hbars($('#cPRep'), groupSum(P0, p => p.SalesPersonCode, p => p.value).map(([k, v, n]) => ({ label: repName(k), value: v, sub: `${n} orders` })));
    const cols = [
      { key: 'DocNum', label: 'Doc no.', fmt: (v, p) => p.Type === 'Order' ? openLink('order', v) : openLink('quotation', v) },
      { key: 'Type', label: 'Type' },
      { key: 'DocDate', label: 'Date', fmt: dFull },
      { key: 'age', label: 'Waiting (days)', num: true, fmt: v => v > 7 ? `<b style="color:var(--bad-ink)">${v}</b>` : v },
      { key: 'cust', label: 'Customer', val: p => `${p.CardName} (${p.CardCode})`, fmt: (v, p) => `${openLink('customer', p.CardCode, p.CardName)} <span class="muted small">${esc(p.CardCode)}</span>` },
      { key: 'RepName', label: 'Rep' },
      { key: 'branch', label: 'Branch', val: p => branchName(p.Branch) },
      { key: 'value', label: 'Value (Rs)', num: true, fmt: money },
    ];
    const open = p => openDoc(p.Type === 'Order' ? 'order' : 'quotation', p.DocNum);
    table($('#pTbl'), { name: 'awaiting_approval', rows: P0, cols, sort: { key: 'age', dir: 'desc' }, onRow: open, footer: r => ({ value: money(sum(r, p => p.value)) }), empty: 'Nothing is waiting for approval' });
    table($('#rTbl'), { name: 'rejected_orders', rows: R0, cols: cols.map(c => c.key === 'age' ? { ...c, label: 'Age (days)', fmt: v => v } : c), sort: { key: 'DocDate', dir: 'desc' }, onRow: open, footer: r => ({ value: money(sum(r, p => p.value)) }), empty: 'No rejected orders in this range' });
  },
};

// ---------------------------------------------------------------- not issued
PAGES['not-issued'] = {
  title: 'Not issued',
  async render(main, alive, params) {
    main.innerHTML = spinner('Loading order lines not fully issued');
    const [ni, lc] = await Promise.all([live('/live/not-issued'), live('/live/line-closer')]);
    if (!alive()) return;
    const prep = rows => rows.filter(r => custOK(r.CardCode, r.CardName)).map(r => ({ ...r, age: ageDays(r.OrderDate), qtyN: num(r.Quantity), short: num(r.Quantity) - num(r.PLQty) }));
    const N = prep(ni), L = prep(lc);
    main.innerHTML = `<div class="tiles">
        ${tile('Lines not issued', int(N.length), `${int(uniq(N.map(r => r.SalesOrderEntry)).length)} orders · ${int(uniq(N.map(r => r.CardCode)).length)} customers`)}
        ${tile('Units ordered on those lines', qty(sum(N, r => r.qtyN)), `${qty(sum(N, r => Math.max(0, r.short)))} units short on pick list`)}
        ${tile('Lines ready to close', int(L.length), 'picked short – eligible for line closing')}
        ${tile('Oldest line', N.length ? Math.max(...N.map(r => r.age)) + ' days' : '–', 'since order date')}
      </div>
      <p class="muted small" style="margin:0">These lists come straight from SAP and are not limited by the date or rep filter (the API has no rep on these lines). The customer filter applies.</p>
      <div class="grid g2">${card('cReason', 'Reason for not picking in full', 'Lines')}${card('cItem', 'Items most often not issued', 'Lines')}</div>
      <section class="card"><div id="niTabs" style="margin-bottom:12px"></div><div id="niTbl"></div></section>`;
    const reasons = groupSum(N, r => r.ReasonCodeNotFullPicking || '(none)', () => 1);
    hbars($('#cReason'), reasons.map(([k, v]) => ({ label: k, value: v })), { fmt: int, valueTip: v => int(v) + ' lines' });
    hbars($('#cItem'), groupSum(N, r => r.ItemCode, () => 1).map(([k, v]) => ({ label: k, value: v, sub: `${qty(sum(N.filter(r => r.ItemCode === k), r => r.qtyN))} units ordered` })), { fmt: int, valueTip: v => int(v) + ' lines', color: 'var(--s2)' });
    const cols = [
      { key: 'SalesOrderEntry', label: 'SO entry' },
      { key: 'OrderDate', label: 'Order date', fmt: dFull },
      { key: 'age', label: 'Age (days)', num: true },
      { key: 'cust', label: 'Customer', val: r => `${r.CardName} (${r.CardCode})`, fmt: (v, r) => `${openLink('customer', r.CardCode, r.CardName)} <span class="muted small">${esc(r.CardCode)}</span>` },
      { key: 'LineNum', label: 'Line', num: true },
      { key: 'ItemCode', label: 'Item', fmt: v => openLink('item', v) },
      { key: 'qtyN', label: 'Ordered', num: true, fmt: qty },
      { key: 'PPEntry', label: 'Pick plan', fmt: (v, r) => v ? `${esc(v)} <span class="muted small">${esc(r.PPStatus)} · qty ${qty(r.PPQty)} · open ${qty(r.PPOpenQty)}</span>` : '' },
      { key: 'PLEntry', label: 'Pick list', fmt: (v, r) => v ? `${esc(v)} <span class="muted small">${esc(r.PLStatus)} · picked ${qty(r.PLQty)} · open ${qty(r.PLOpenQty)}</span>` : '' },
      { key: 'ReasonCodeNotFullPicking', label: 'Reason' },
    ];
    let cur = params.tab === 'close' ? 'close' : 'ni';
    tabs($('#niTabs'), [{ key: 'ni', label: 'Not issued', n: N.length }, { key: 'close', label: 'Ready to close', n: L.length }], cur, k => { cur = k; t.setRows(cur === 'ni' ? N : L); });
    const t = table($('#niTbl'), { name: 'not_issued', rows: cur === 'ni' ? N : L, cols, sort: { key: 'age', dir: 'desc' }, footer: r => ({ qtyN: qty(sum(r, x => x.qtyN)) }) });
  },
};

// ---------------------------------------------------------------- invoices
PAGES.invoices = {
  title: 'Invoices',
  async render(main, alive, params) {
    main.innerHTML = spinner('Loading invoices for ' + rangeLabel());
    const res = await loadRange('invoices');
    if (!alive()) return;
    const all = res.rows.filter(i => repOK(i.slpCode) && custOK(i.cardCode, i.cardName)).map(i => ({
      ...i, open: Math.max(0, i.docTotal - i.paid),
      payStatus: i.paid >= i.docTotal - 0.5 ? 'Paid' : i.paid > 0 ? 'Part paid' : 'Unpaid',
      kind: i.whs === 'ATL-RTN' ? 'ATL-RTN (service)' : 'SFA',
    }));
    const groups = {
      all: { label: 'All', f: () => true },
      sfa: { label: 'SFA', f: i => i.kind === 'SFA' },
      rtn: { label: 'ATL-RTN (service)', f: i => i.kind !== 'SFA' },
      unpaid: { label: 'Not fully paid', f: i => i.payStatus !== 'Paid' },
      returned: { label: 'With returns', f: i => i.returnValue > 0 },
    };
    let cur = groups[params.tab] ? params.tab : 'all';
    const tot = sum(all, i => i.docTotal);
    main.innerHTML = `<div class="tiles">
      ${rsTile('Invoiced (incl. VAT)', tot, `${int(all.length)} invoices`)}
      ${rsTile('VAT', sum(all, i => i.vat), `Rs ${compact(tot - sum(all, i => i.vat))} before VAT`)}
      ${rsTile('Paid', sum(all, i => i.paid), tot ? pct((sum(all, i => i.paid) / tot) * 100) + ' collected' : '')}
      ${rsTile('Still open', sum(all, i => i.open), `${int(all.filter(i => i.payStatus !== 'Paid').length)} invoices`)}
      ${rsTile('Returned against these', sum(all, i => i.returnValue), `${int(all.filter(i => i.returnValue > 0).length)} invoices with returns`)}
      ${tile('Average invoice', all.length ? rs(tot / all.length) : '–', `${qty(sum(all, i => i.qty))} units`)}
    </div>
    <div class="grid g2">${card('cInvDay', grainWord() + ' invoiced value', 'By company')}${card('cInvPay', 'Payment status', 'Invoice value')}</div>
    <section class="card"><div id="iTabs" style="margin-bottom:12px"></div><div id="iTbl"></div></section>`;
    const bpls = uniq(all.map(i => String(i.bplId)));
    const colors = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)'];
    columnChart($('#cInvDay'), { data: dailySeries(all, 'docDate', i => i.docTotal, i => String(i.bplId)), series: bpls.slice(0, 4).map((b, i) => ({ key: b, label: branchName(b), color: colors[i] })), tipFmt: v => 'Rs ' + money(v) });
    stackBar($('#cInvPay'), ['Paid', 'Part paid', 'Unpaid'].map((k, i) => ({ label: k, value: sum(all.filter(x => x.payStatus === k), x => x.docTotal), color: ['var(--good)', 'var(--serious)', 'var(--warning)'][i], sub: `${all.filter(x => x.payStatus === k).length} invoices` })), { fmt: rs });
    tabs($('#iTabs'), Object.entries(groups).map(([k, g]) => ({ key: k, label: g.label, n: all.filter(g.f).length })), cur, k => { cur = k; t.setRows(all.filter(groups[cur].f)); });
    const t = table($('#iTbl'), {
      name: 'invoices', rows: all.filter(groups[cur].f), sort: { key: 'docDate', dir: 'desc' }, onRow: i => openDoc('invoice', i.docEntry),
      cols: [
        { key: 'docNum', label: 'Invoice no.', fmt: (v, i) => openLink('invoice', i.docEntry, v) },
        { key: 'docDate', label: 'Date', fmt: dFull },
        { key: 'createTime', label: 'Created', fmt: (v, i) => `<span class="small">${esc(i.createDate)} ${esc(v)}</span>` },
        { key: 'cust', label: 'Customer', val: i => `${i.cardName} (${i.cardCode})`, fmt: (v, i) => `${openLink('customer', i.cardCode, i.cardName)} <span class="muted small">${esc(i.cardCode)}</span>` },
        { key: 'repName', label: 'Rep' },
        { key: 'branch', label: 'Company', val: i => branchName(i.bplId) },
        { key: 'kind', label: 'Source' },
        { key: 'lines', label: 'Lines', num: true },
        { key: 'docTotal', label: 'Total (Rs)', num: true, fmt: money },
        { key: 'paid', label: 'Paid (Rs)', num: true, fmt: money },
        { key: 'payStatus', label: 'Payment', fmt: chip },
        { key: 'returnValue', label: 'Returned (Rs)', num: true, fmt: v => v ? money(v) : '' },
        { key: 'deliveryStatus', label: 'Delivery', fmt: (v, i) => esc([v, i.deliveryMode, i.deliveryDate].filter(Boolean).join(' · ')) },
        { key: 'salesOrders', label: 'Sales orders', fmt: v => openLinks('order', v) },
      ],
      footer: r => ({ lines: int(sum(r, i => i.lines)), docTotal: money(sum(r, i => i.docTotal)), paid: money(sum(r, i => i.paid)), returnValue: money(sum(r, i => i.returnValue)) }),
    });
  },
};

// ---------------------------------------------------------------- returns
PAGES.returns = {
  title: 'Returns',
  async render(main, alive, params) {
    main.innerHTML = spinner('Loading returns for ' + rangeLabel());
    const [R0, C0] = await Promise.all([loadRange('returns'), loadRange('returnCreditNotes')]);
    if (!alive()) return;
    const R = R0.rows.filter(r => repOK(r.repCode) && custOK(r.cardCode, r.cardName));
    const C = C0.rows.filter(c => repOK(c.slpCode) && custOK(c.cardCode, c.cardName));
    main.innerHTML = `<div class="tiles">
      ${tile('Return requests', int(R.length), `Rs ${compact(sum(R, r => r.docTotal))} requested`)}
      ${tile('Awaiting approval', int(R.filter(r => r.status === 'Pending Approval').length), `Rs ${compact(sum(R.filter(r => r.status === 'Pending Approval'), r => r.docTotal))}`)}
      ${tile('Approved, no credit note yet', int(R.filter(r => r.status === 'Processing').length), 'goods return in progress')}
      ${tile('Credit notes issued', int(C.length), `Rs ${compact(sum(C, c => c.docTotal))}`)}
    </div>
    <div class="grid g2">${card('cRR', 'Return request status', esc(rangeLabel()))}${card('cRRrep', 'Credit note value by rep', '')}</div>
    <section class="card"><div id="rTabs" style="margin-bottom:12px"></div><div id="rTbl"></div></section>`;
    stackBar($('#cRR'), RR_ORDER.map(k => ({ label: stLabel(k), value: R.filter(r => r.status === k).length, color: SO_ST[k].color, sub: 'Rs ' + money(sum(R.filter(r => r.status === k), r => r.docTotal)) })));
    hbars($('#cRRrep'), groupSum(C, c => c.slpCode, c => c.docTotal).map(([k, v, n]) => ({ label: repName(k), value: v, sub: `${n} credit notes` })), { color: 'var(--s2)' });
    const rrCols = [
      { key: 'rrNumber', label: 'RR no.', fmt: v => openLink('return', v) },
      { key: 'rrDate', label: 'Date', fmt: dFull },
      { key: 'age', label: 'Age (days)', num: true, val: r => ageDays(r.rrDate) },
      { key: 'cust', label: 'Customer', val: r => `${r.cardName} (${r.cardCode})`, fmt: (v, r) => `${openLink('customer', r.cardCode, r.cardName)} <span class="muted small">${esc(r.cardCode)}</span>` },
      { key: 'rep', label: 'Rep', val: r => repName(r.repCode, r.uRepCode) },
      { key: 'docTotal', label: 'Value (Rs)', num: true, fmt: money },
      { key: 'status', label: 'Status', fmt: chip, csv: r => stLabel(r.status) },
      { key: 'rrQty', label: 'Requested qty', num: true, fmt: qty },
      { key: 'returnQty', label: 'Returned qty', num: true, fmt: qty },
      { key: 'cnQty', label: 'Credited qty', num: true, fmt: qty },
      { key: 'basedInvoices', label: 'Invoices', fmt: v => esc((v || []).join(', ')) },
      { key: 'returnDocs', label: 'Return docs', fmt: v => esc((v || []).join(', ')) },
      { key: 'creditNotes', label: 'Credit notes', fmt: v => esc((v || []).join(', ')) },
      { key: 'returnNumAtCard', label: 'SFA ref.' },
    ];
    const cnCols = [
      { key: 'docNum', label: 'Credit note no.' },
      { key: 'docDate', label: 'Date', fmt: dFull },
      { key: 'cust', label: 'Customer', val: c => `${c.cardName} (${c.cardCode})`, fmt: (v, c) => `${openLink('customer', c.cardCode, c.cardName)} <span class="muted small">${esc(c.cardCode)}</span>` },
      { key: 'repName', label: 'Rep' },
      { key: 'branch', label: 'Company', val: c => branchName(c.bplId) },
      { key: 'lines', label: 'Lines', num: true },
      { key: 'qty', label: 'Qty', num: true, fmt: qty },
      { key: 'docTotal', label: 'Total (Rs)', num: true, fmt: money },
      { key: 'openBalance', label: 'Open (Rs)', num: true, fmt: money },
      { key: 'numAtCard', label: 'Reference' },
      { key: 'comments', label: 'Remarks', fmt: v => `<span class="trunc" title="${esc(v)}">${esc(v)}</span>` },
    ];
    let cur = params.tab === 'cn' ? 'cn' : 'rr';
    const holder = $('#rTbl');
    const show = () => cur === 'rr'
      ? table(holder, { name: 'return_requests', rows: R, cols: rrCols, sort: { key: 'rrDate', dir: 'desc' }, onRow: r => openDoc('return', r.rrNumber), footer: r => ({ docTotal: money(sum(r, x => x.docTotal)), rrQty: qty(sum(r, x => x.rrQty)), returnQty: qty(sum(r, x => x.returnQty)), cnQty: qty(sum(r, x => x.cnQty)) }) })
      : table(holder, { name: 'return_credit_notes', rows: C, cols: cnCols, sort: { key: 'docDate', dir: 'desc' }, footer: r => ({ qty: qty(sum(r, x => x.qty)), docTotal: money(sum(r, x => x.docTotal)), openBalance: money(sum(r, x => x.openBalance)) }) });
    tabs($('#rTabs'), [{ key: 'rr', label: 'Return requests', n: R.length }, { key: 'cn', label: 'Return credit notes', n: C.length }], cur, k => { cur = k; show(); });
    show();
  },
};

// ---------------------------------------------------------------- quotations
PAGES.quotations = {
  title: 'Quotations',
  async render(main, alive) {
    main.innerHTML = spinner('Loading quotations for ' + rangeLabel() + ' (this list is large; first load can take a minute)');
    const res = await loadRange('quotations');
    if (!alive()) return;
    const Q = res.rows.filter(quotOK);
    const lines = sum(Q, q => q.lines), conv = sum(Q, q => q.convertedLines);
    const stCounts = {};
    for (const q of Q) for (const [k, v] of Object.entries(q.statusCounts || {})) stCounts[k] = (stCounts[k] || 0) + v;
    main.innerHTML = `<div class="tiles">
      ${tile('Quotations', int(Q.length), `${int(lines)} lines`)}
      ${tile('Lines converted to orders', lines ? pct((conv / lines) * 100) : '–', `${int(conv)} of ${int(lines)} lines`)}
      ${rsTile('Converted order value', sum(Q, q => q.soValue), 'line totals incl. VAT')}
      ${tile('Quotations with open lines', int(Q.filter(q => q.status === 'Open lines').length), 'not yet copied to an order')}
    </div>
    ${S.rep || S.cust ? '<p class="muted small" style="margin:0">Rep / customer filter uses the linked sales order, so quotations not yet converted are hidden while a filter is set.</p>' : ''}
    ${card('cQst', 'Quotation lines by outcome', esc(rangeLabel()))}
    ${card('qTbl', 'Quotations', 'Click a row for line detail')}`;
    const order = ['Quotation Open', 'Pending Approvel', 'Processing', 'Invoice Generated', 'Quotation Closed', 'Rejected', 'Cancelled', 'Quotation Cancelled'];
    const colorFor = { 'Quotation Open': 'var(--s4)', 'Pending Approvel': 'var(--warning)', Processing: 'var(--info)', 'Invoice Generated': 'var(--good)', 'Quotation Closed': 'var(--axis)', Rejected: 'var(--critical)', Cancelled: 'var(--neutral)', 'Quotation Cancelled': 'var(--serious)' };
    stackBar($('#cQst'), order.map(k => ({ label: stLabel(k), value: stCounts[k] || 0, color: colorFor[k] })), { fmt: v => int(v) + ' lines' });
    table($('#qTbl'), {
      name: 'quotations', rows: Q, sort: { key: 'sqNumber', dir: 'desc' }, onRow: q => openDoc('quotation', q.sqNumber),
      cols: [
        { key: 'sqNumber', label: 'SQ no.', fmt: v => openLink('quotation', v) },
        { key: 'sqDate', label: 'Date', fmt: dFull },
        { key: 'cust', label: 'Customer', val: q => q.cardCode ? `${q.cardName} (${q.cardCode})` : '', fmt: (v, q) => q.cardCode ? openLink('customer', q.cardCode, q.cardName) : '<span class="muted">not converted</span>' },
        { key: 'rep', label: 'Rep', val: q => q.repCode ? repName(q.repCode, q.uRepCode) : '' },
        { key: 'lines', label: 'Lines', num: true },
        { key: 'convertedLines', label: 'Converted', num: true },
        { key: 'conv', label: 'Conversion', num: true, val: q => q.lines ? (q.convertedLines / q.lines) * 100 : 0, fmt: pct },
        { key: 'soValue', label: 'Order value (Rs)', num: true, fmt: money },
        { key: 'status', label: 'Status', fmt: chip, csv: q => stLabel(q.status) },
        { key: 'salesOrders', label: 'Sales orders', fmt: v => openLinks('order', v) },
        { key: 'invoices', label: 'Invoices', fmt: v => esc((v || []).join(', ')) },
      ],
      footer: r => ({ lines: int(sum(r, q => q.lines)), convertedLines: int(sum(r, q => q.convertedLines)), soValue: money(sum(r, q => q.soValue)) }),
    });
  },
};

// ---------------------------------------------------------------- reps
PAGES.reps = {
  title: 'Sales reps',
  async render(main, alive) {
    main.innerHTML = spinner('Loading rep performance for ' + rangeLabel());
    const [O0, I0, C0, R0] = await Promise.all([loadRange('orders'), loadRange('invoices'), loadRange('returnCreditNotes'), loadRange('returns'), repNames()]);
    if (!alive()) return;
    const cf = (c, n) => custOK(c, n);
    const m = new Map();
    const g = k => { k = String(k); if (!m.has(k)) m.set(k, { code: k, orders: 0, orderValue: 0, pending: 0, rejected: 0, soQty: 0, delQty: 0, leadSum: 0, leadN: 0, invoices: 0, invoiced: 0, paid: 0, returns: 0, rr: 0, custs: new Set() }); return m.get(k); };
    for (const o of O0.rows) if (cf(o.cardCode, o.cardName)) {
      const r = g(o.repCode); r.orders++; if (isLive(o)) r.orderValue += o.docTotal;
      if (o.status === 'Pending Approvel') r.pending++; if (o.status === 'Rejected') r.rejected++;
      if (o.status === 'Processing' || o.status === 'Invoice Generated') { r.soQty += o.soQty; r.delQty += o.deliveredQty; }
      if (o.firstInvoiceDate) { r.leadSum += daysBetween(o.docDate, o.firstInvoiceDate); r.leadN++; }
      r.custs.add(o.cardCode);
    }
    for (const i of I0.rows) if (cf(i.cardCode, i.cardName)) { const r = g(i.slpCode); r.invoices++; r.invoiced += i.docTotal; r.paid += i.paid; r.custs.add(i.cardCode); }
    for (const c of C0.rows) if (cf(c.cardCode, c.cardName)) g(c.slpCode).returns += c.docTotal;
    for (const x of R0.rows) if (cf(x.cardCode, x.cardName)) g(x.repCode).rr++;
    const rows = [...m.values()].map(r => ({ ...r, name: repName(r.code), customers: r.custs.size, fulfil: r.soQty ? (r.delQty / r.soQty) * 100 : null, lead: r.leadN ? r.leadSum / r.leadN : null, retPct: r.invoiced ? (r.returns / r.invoiced) * 100 : null, collected: r.invoiced ? (r.paid / r.invoiced) * 100 : null }));
    main.innerHTML = `<p class="muted small" style="margin:0">All reps are shown here; the rep filter is ignored on this page. Click a rep to filter the whole dashboard to them.</p>
      <div class="grid g2">${card('cRepInv', 'Invoiced value by rep', esc(rangeLabel()))}${card('cRepOrd', 'Orders by rep', 'Count of sales orders')}</div>
      ${card('repTbl', 'Rep scorecard', esc(rangeLabel()))}`;
    const pick = r => { S.rep = r.code; store.set('rep', S.rep); $('#fRep').value = S.rep; location.hash = '#/overview'; };
    hbars($('#cRepInv'), [...rows].sort((a, b) => b.invoiced - a.invoiced).map(r => ({ ...r, label: r.name, value: r.invoiced, sub: `${r.invoices} invoices` })), { limit: 15, onClick: pick });
    hbars($('#cRepOrd'), [...rows].sort((a, b) => b.orders - a.orders).map(r => ({ ...r, label: r.name, value: r.orders, sub: `${r.pending} pending · ${r.rejected} rejected` })), { limit: 15, fmt: int, valueTip: v => int(v) + ' orders', color: 'var(--s3)', onClick: pick });
    table($('#repTbl'), {
      name: 'rep_scorecard', rows, sort: { key: 'invoiced', dir: 'desc' }, onRow: pick, pageSize: 50,
      cols: [
        { key: 'name', label: 'Rep' }, { key: 'orders', label: 'Orders', num: true }, { key: 'orderValue', label: 'Order value (Rs)', num: true, fmt: money },
        { key: 'pending', label: 'Pending', num: true }, { key: 'rejected', label: 'Rejected', num: true },
        { key: 'fulfil', label: 'Fulfilment', num: true, fmt: pct }, { key: 'lead', label: 'Days to invoice', num: true, fmt: v => v === null ? '–' : v.toFixed(1) },
        { key: 'invoices', label: 'Invoices', num: true }, { key: 'invoiced', label: 'Invoiced (Rs)', num: true, fmt: money },
        { key: 'collected', label: 'Collected', num: true, fmt: pct }, { key: 'returns', label: 'Returns (Rs)', num: true, fmt: money },
        { key: 'retPct', label: 'Returns % sales', num: true, fmt: pct }, { key: 'rr', label: 'Return requests', num: true }, { key: 'customers', label: 'Customers', num: true },
      ],
      footer: r => ({ orders: int(sum(r, x => x.orders)), orderValue: money(sum(r, x => x.orderValue)), pending: int(sum(r, x => x.pending)), rejected: int(sum(r, x => x.rejected)), invoices: int(sum(r, x => x.invoices)), invoiced: money(sum(r, x => x.invoiced)), returns: money(sum(r, x => x.returns)), rr: int(sum(r, x => x.rr)) }),
    });
  },
};

// ---------------------------------------------------------------- customers
PAGES.customers = {
  title: 'Customers',
  async render(main, alive) {
    main.innerHTML = `<section class="card"><div class="card-head"><h2>Customer statement</h2><span class="sub">Outstanding, open items, grade and recent activity</span></div>
      <form class="search-row" id="cuForm"><input id="cuCode" list="custList" placeholder="Customer code (e.g. GK04)" required><button class="btn primary">Open</button></form></section>
      <div id="cuTop">${spinner('Loading customer activity for ' + rangeLabel())}</div>`;
    $('#cuForm').addEventListener('submit', e => { e.preventDefault(); const v = $('#cuCode').value.trim(); if (v) openDoc('customer', v.split(' ')[0]); });
    const [O0, I0, C0, G] = await Promise.all([loadRange('orders'), loadRange('invoices'), loadRange('returnCreditNotes'), live('/live/grades').catch(() => [])]);
    if (!alive()) return;
    const grade = new Map((G || []).map(x => [x.CardCode, x]));
    const m = new Map();
    const g = (c, n) => { if (!m.has(c)) m.set(c, { cardCode: c, cardName: n, orders: 0, orderValue: 0, pending: 0, invoices: 0, invoiced: 0, open: 0, returns: 0, last: null, reps: new Set() }); return m.get(c); };
    for (const o of O0.rows) if (repOK(o.repCode) && custOK(o.cardCode, o.cardName)) { const r = g(o.cardCode, o.cardName); r.orders++; if (isLive(o)) r.orderValue += o.docTotal; if (o.status === 'Pending Approvel') r.pending++; r.reps.add(repName(o.repCode, o.uRepCode)); }
    for (const i of I0.rows) if (repOK(i.slpCode) && custOK(i.cardCode, i.cardName)) { const r = g(i.cardCode, i.cardName); r.invoices++; r.invoiced += i.docTotal; r.open += Math.max(0, i.docTotal - i.paid); if (!r.last || i.docDate > r.last) r.last = i.docDate; }
    for (const c of C0.rows) if (repOK(c.slpCode) && custOK(c.cardCode, c.cardName)) g(c.cardCode, c.cardName).returns += c.docTotal;
    const rows = [...m.values()].map(r => { const gr = grade.get(r.cardCode) || {}; return { ...r, gradeATL: gr.ATL || '', gradeAL: gr.AL || '', repList: [...r.reps].join(', ') }; });
    $('#cuTop').innerHTML = card('cuTbl', 'Customers active in range', esc(rangeLabel()) + ' · click for statement');
    table($('#cuTbl'), {
      name: 'customers', rows, sort: { key: 'invoiced', dir: 'desc' }, onRow: r => openDoc('customer', r.cardCode),
      cols: [
        { key: 'cardCode', label: 'Code' }, { key: 'cardName', label: 'Customer' },
        { key: 'gradeATL', label: 'Grade ATL' }, { key: 'gradeAL', label: 'Grade AL' },
        { key: 'orders', label: 'Orders', num: true }, { key: 'orderValue', label: 'Order value (Rs)', num: true, fmt: money }, { key: 'pending', label: 'Pending', num: true },
        { key: 'invoices', label: 'Invoices', num: true }, { key: 'invoiced', label: 'Invoiced (Rs)', num: true, fmt: money },
        { key: 'open', label: 'Unpaid in range (Rs)', num: true, fmt: money }, { key: 'returns', label: 'Returns (Rs)', num: true, fmt: money },
        { key: 'last', label: 'Last invoice', fmt: dFull }, { key: 'repList', label: 'Reps', fmt: v => `<span class="trunc" title="${esc(v)}">${esc(v)}</span>` },
      ],
      footer: r => ({ orders: int(sum(r, x => x.orders)), orderValue: money(sum(r, x => x.orderValue)), invoices: int(sum(r, x => x.invoices)), invoiced: money(sum(r, x => x.invoiced)), open: money(sum(r, x => x.open)), returns: money(sum(r, x => x.returns)) }),
    });
  },
};

// ============================================================== document drawer
async function openDoc(kind, id) {
  const titles = { order: 'Sales order', quotation: 'Sales quotation', return: 'Return request', invoice: 'Invoice', customer: 'Customer', item: 'Item' };
  $('#drawerTitle').textContent = `${titles[kind] || kind} ${id}`;
  const body = $('#drawerBody');
  body.innerHTML = spinner();
  $('#drawer').hidden = false; $('#drawerBg').hidden = false;
  try { await renderDoc(kind, id, body); } catch (e) { if (!(e instanceof AuthError)) body.innerHTML = errorBox(e.message); }
}
function closeDrawer() { $('#drawer').hidden = true; $('#drawerBg').hidden = true; }

async function renderDoc(kind, id, el) {
  if (kind === 'order') {
    const b = await api(`/lookup/order/${encodeURIComponent(id)}`);
    if (!b.data || !b.data.order) throw new Error('Sales order not found');
    return renderOrder(b.data.order, el);
  }
  if (kind === 'quotation') { const b = await api(`/lookup/quotation/${encodeURIComponent(id)}`); return renderQuotation(b.salesQuotation, el); }
  if (kind === 'return') { const b = await api(`/lookup/return/${encodeURIComponent(id)}`); if (!b.data || !b.data.returnRequest) throw new Error('Return request not found'); return renderReturn(b.data.returnRequest, el); }
  if (kind === 'invoice') { const b = await api(`/lookup/invoice/${encodeURIComponent(id)}`); if (!b.length) throw new Error('Invoice not found (only SFA / ATL-RTN invoices are available)'); return renderInvoice(b[0], el); }
  if (kind === 'customer') return renderCustomer(id, el);
  if (kind === 'item') return showItemStatus(id, el);
  throw new Error('Unknown document type');
}

function step(t, s, d, state) { return `<div class="step ${state}"><div class="t">${esc(t)}</div><div class="s">${esc(s)}</div><div class="d">${d || ''}</div></div>`; }

function renderOrder(o, el) {
  const L = o.lines || [], sm = o.summary || {}, q = sm.quantities || {};
  const invs = new Map(); for (const l of L) if (l.invoice && l.invoice.invNumber && !invs.has(l.invoice.invNumber)) invs.set(l.invoice.invNumber, l.invoice);
  const invTot = sum([...invs.values()], i => i.invoiceTotal), invPaid = sum([...invs.values()], i => i.invoicePaidToDate);
  const delSt = L.map(l => l.delivery && l.delivery.deliveryStatus);
  const sq = (o.linkedQuotation && o.linkedQuotation.sqNumber) || (L.find(l => l.quotation && l.quotation.sqNumber) || { quotation: {} }).quotation.sqNumber;
  const sqDate = (o.linkedQuotation && o.linkedQuotation.sqDate) || null;
  const dels = uniq(L.map(l => l.delivery && l.delivery.deliveryNumber)), delDates = uniq(L.map(l => l.delivery && l.delivery.deliveryDate)).sort();
  const st = o.orderStatus;
  const appr = st === 'Pending Approvel' ? ['Awaiting approval', `waiting ${ageDays(o.docDate)} days`, 'part'] : st === 'Rejected' ? ['Rejected', '', 'fail'] : st === 'Cancelled' ? ['Cancelled', 'after approval', 'fail'] : ['Approved', '', 'done'];
  const delState = delSt.length && delSt.every(s => s === 'FULL') ? 'done' : delSt.some(s => s === 'FULL' || s === 'PARTIAL') ? 'part' : '';
  const invQ = num(q.totalInvoicedQty), soQ = num(q.totalSOQty);
  const invState = invQ && invQ >= soQ ? 'done' : invQ ? 'part' : '';
  const payState = invTot && invPaid >= invTot - 0.5 ? 'done' : invPaid ? 'part' : '';
  el.innerHTML = `
    <section class="card"><div class="kv">
      <div><span>Customer</span><b>${openLink('customer', o.cardCode, o.cardName)} (${esc(o.cardCode)})</b></div>
      <div><span>Sales rep</span><b>${esc(repName(o.repCode, o.uRepCode))}</b></div>
      <div><span>Order date</span><b>${dFull(o.docDate)}</b></div>
      <div><span>Order value</span><b>Rs ${money(o.docTotal)} ${esc(o.docCurrency || '')}</b></div>
      <div><span>Status</span><b>${chip(st)}</b></div>
      <div><span>Fulfilment</span><b>${pct(num((sm.notIssuedSummary || {}).fulfilmentRate))}</b></div>
    </div></section>
    <section class="card"><div class="card-head"><h2>Where is this order?</h2></div><div class="steps">
      ${step('Quotation', sq ? 'SQ ' + sq : 'Direct order', sq ? `${dFull(sqDate)} ${openLink('quotation', sq, 'open')}` : '', sq ? 'done' : '')}
      ${step('Order placed', 'SO ' + o.docNum, dFull(o.docDate), 'done')}
      ${step('Approval', appr[0], appr[1], appr[2])}
      ${step('Delivery', delState === 'done' ? 'Delivered' : delState ? 'Partly delivered' : 'Not delivered', `${qty(q.totalDeliveredQty)} of ${qty(soQ)} units${dels.length ? '<br>' + esc(dels.join(', ')) + ' · ' + esc(delDates.map(dLabel).join(', ')) : ''}`, delState)}
      ${step('Invoice', invState === 'done' ? 'Invoiced' : invState ? 'Partly invoiced' : 'Not invoiced', `${qty(invQ)} of ${qty(soQ)} units${invs.size ? '<br>' + esc([...invs.keys()].join(', ')) : ''}`, invState)}
      ${step('Payment', payState === 'done' ? 'Paid' : payState ? 'Part paid' : invs.size ? 'Unpaid' : '–', invs.size ? `Rs ${money(invPaid)} of Rs ${money(invTot)}` : '', payState)}
    </div></section>
    <div id="oAlerts"></div>
    <section class="card"><div class="card-head"><h2>Order lines</h2><span class="sub">${int(L.length)} rows · one row per delivery / invoice link</span></div><div id="oLines"></div></section>`;
  const al = o.alerts || {}, a1 = (al.qtyAdjusted && al.qtyAdjusted.items) || [], a2 = (al.notIssued && al.notIssued.items) || [];
  let ah = '';
  if (a1.length) ah += `<div class="alert" style="margin-bottom:8px"><b>Quantity changed from the quotation on ${a1.length} line${a1.length > 1 ? 's' : ''}:</b> ${a1.map(i => `${esc(i.itemCode)} (SQ ${qty(i.sqQty)} → SO ${qty(i.soQty)})`).join('; ')}</div>`;
  if (a2.length && st !== 'Rejected' && st !== 'Cancelled') ah += `<div class="alert ${st === 'Invoice Generated' ? '' : 'crit'}"><b>${a2.length} line${a2.length > 1 ? 's' : ''} not fully issued:</b> ${a2.map(i => `${esc(i.itemCode)} – ${qty(i.unissuedQty)} of ${qty(i.soQty)} short (${esc(stLabel(i.deliveryStatus))})`).join('; ')}</div>`;
  $('#oAlerts', el).innerHTML = ah ? `<section class="card">${ah}</section>` : '';
  table($('#oLines', el), {
    name: 'SO_' + o.docNum, rows: L, pageSize: 100,
    cols: [
      { key: 'lineNum', label: '#', num: true },
      { key: 'itemCode', label: 'Item', fmt: (v, l) => `${openLink('item', v)}<div class="muted small">${esc(l.description)}</div>`, csv: l => l.itemCode },
      { key: 'partNumber', label: 'Part no.' },
      { key: 'warehouseCode', label: 'Whs', val: l => l.warehouseCode, fmt: (v, l) => `<span title="${esc(l.warehouseName)}">${esc(v)}</span>` },
      { key: 'sqQty', label: 'SQ qty', num: true, val: l => l.quotation ? l.quotation.sqQty : null, fmt: v => v ? qty(v) : '' },
      { key: 'soQty', label: 'SO qty', num: true, val: l => l.salesOrder ? l.salesOrder.soQty : null, fmt: (v, l) => `${qty(v)}${l.qtyAdjusted ? ` <span class="muted small">(${esc(l.salesOrder.diffDirection)} ${qty(l.salesOrder.adjustedQtyDiff)})</span>` : ''}` },
      { key: 'unitPrice', label: 'Price incl. VAT', num: true, fmt: money },
      { key: 'discountPercent', label: 'Disc %', num: true, fmt: v => v ? qty(v) : '' },
      { key: 'lineTotal', label: 'Line total', num: true, fmt: money },
      { key: 'del', label: 'Delivery', val: l => l.delivery && l.delivery.deliveryNumber, fmt: (v, l) => v ? `${esc(v)}<div class="muted small">${dFull(l.delivery.deliveryDate)}</div>` : '' },
      { key: 'delQty', label: 'Delivered', num: true, val: l => l.delivery ? l.delivery.deliveredQty : null, fmt: qty },
      { key: 'delSt', label: 'Issue status', val: l => l.delivery && l.delivery.deliveryStatus, fmt: chip, csv: l => stLabel(l.delivery && l.delivery.deliveryStatus) },
      { key: 'inv', label: 'Invoice', val: l => l.invoice && l.invoice.invNumber, fmt: (v, l) => v ? `${esc(v)}<div class="muted small">${dFull(l.invoice.invDate)}</div>` : '' },
      { key: 'invQty', label: 'Inv qty', num: true, val: l => l.invoice ? l.invoice.invQty : null, fmt: v => v ? qty(v) : '' },
    ],
    footer: r => ({ lineTotal: money(sum(r, l => l.lineTotal)) }),
  });
}

function renderQuotation(q, el) {
  if (!q) throw new Error('Quotation not found');
  const L = q.lines || [];
  const so = (L.find(l => l.salesOrder) || {}).salesOrder || {};
  el.innerHTML = `<section class="card"><div class="kv">
      <div><span>Quotation date</span><b>${dFull(q.sqDate)}</b></div>
      <div><span>Customer</span><b>${so.cardCode ? openLink('customer', so.cardCode, so.cardName) : '–'}</b></div>
      <div><span>Rep</span><b>${so.repCode ? esc(repName(so.repCode, so.uRepCode)) : '–'}</b></div>
      <div><span>Cancelled</span><b>${q.cancelStatus ? 'Yes' : 'No'}</b></div>
      <div><span>Lines converted</span><b>${L.filter(l => l.salesOrder).length} of ${L.length}</b></div>
      <div><span>Sales orders</span><b>${openLinks('order', uniq(L.map(l => l.salesOrder && l.salesOrder.soNumber))) || '–'}</b></div>
    </div></section><section class="card"><div class="card-head"><h2>Quotation lines</h2></div><div id="qLines"></div></section>`;
  table($('#qLines', el), {
    name: 'SQ_' + q.sqNumber, rows: L, pageSize: 100,
    cols: [
      { key: 'itemCode', label: 'Item', fmt: (v, l) => `${openLink('item', v)}<div class="muted small">${esc(l.description)}</div>`, csv: l => l.itemCode },
      { key: 'partNumber', label: 'Part no.' },
      { key: 'sqQty', label: 'SQ qty', num: true, fmt: qty },
      { key: 'st', label: 'Status', val: l => l.quotationStatus || (l.salesOrder && l.salesOrder.soStatus), fmt: chip, csv: l => stLabel(l.quotationStatus || (l.salesOrder && l.salesOrder.soStatus)) },
      { key: 'so', label: 'Sales order', val: l => l.salesOrder && l.salesOrder.soNumber, fmt: v => openLink('order', v) },
      { key: 'soQty', label: 'SO qty', num: true, val: l => l.salesOrder ? num(l.salesOrder.soQty) : null, fmt: v => v === null ? '' : qty(v) },
      { key: 'qtyAdjusted', label: 'Qty changed', fmt: (v, l) => esc(v) + (l.adjustedQtyDiff ? ` (${esc(qty(l.adjustedQtyDiff))})` : '') },
      { key: 'delivered', label: 'Delivered', num: true, val: l => l.delivery ? num(l.delivery.deliveredQty) : null, fmt: v => v === null ? '' : qty(v) },
      { key: 'inv', label: 'Invoice', val: l => l.invoice && l.invoice.invNumber, fmt: (v, l) => v ? `${esc(v)}<div class="muted small">${dFull(l.invoice.invDate)}</div>` : '' },
      { key: 'lineTotal', label: 'Line total', num: true, val: l => l.salesOrder ? num(l.salesOrder.lineTotal) : null, fmt: v => v === null ? '' : money(v) },
    ],
  });
}

function renderReturn(r, el) {
  const L = r.lines || [];
  el.innerHTML = `<section class="card"><div class="kv">
      <div><span>Customer</span><b>${openLink('customer', r.cardCode, r.cardName)} (${esc(r.cardCode)})</b></div>
      <div><span>Rep</span><b>${esc(repName(r.repCode, r.uRepCode))}</b></div>
      <div><span>Request date</span><b>${dFull(r.rrDate)}</b></div>
      <div><span>Value</span><b>Rs ${money(r.docTotal)}</b></div>
      <div><span>Status</span><b>${chip(r.rrStatus)}</b></div>
      <div><span>SFA reference</span><b>${esc(r.returnNumAtCard)}</b></div>
    </div></section>
    <section class="card"><div class="card-head"><h2>Where is this return?</h2></div><div class="steps">
      ${step('Requested', 'RR ' + r.rrNumber, dFull(r.rrDate), 'done')}
      ${step('Approval', r.rrStatus === 'Pending Approval' ? 'Awaiting approval' : r.rrStatus === 'Rejected' || r.rrStatus === 'Cancelled' ? stLabel(r.rrStatus) : 'Approved', r.rrStatus === 'Pending Approval' ? `waiting ${ageDays(r.rrDate)} days` : '', r.rrStatus === 'Pending Approval' ? 'part' : r.rrStatus === 'Rejected' || r.rrStatus === 'Cancelled' ? 'fail' : 'done')}
      ${step('Goods returned', `${qty(r.summary.totalReturnQty)} of ${qty(r.summary.totalRRQty)} units`, esc(uniq(L.map(l => l.return && l.return.returnNumber)).join(', ')), r.summary.totalReturnQty >= r.summary.totalRRQty && r.summary.totalRRQty ? 'done' : r.summary.totalReturnQty ? 'part' : '')}
      ${step('Credit note', `${qty(r.summary.totalCreditNoteQty)} units credited`, esc(uniq(L.map(l => l.creditNote && l.creditNote.creditNoteNumber)).join(', ')), r.summary.totalCreditNoteQty && r.summary.totalCreditNoteQty >= r.summary.totalReturnQty ? 'done' : r.summary.totalCreditNoteQty ? 'part' : '')}
    </div></section>
    <section class="card"><div class="card-head"><h2>Lines</h2></div><div id="rLines"></div></section>`;
  table($('#rLines', el), {
    name: 'RR_' + r.rrNumber, rows: L, pageSize: 100,
    cols: [
      { key: 'itemCode', label: 'Item', fmt: (v, l) => `${openLink('item', v)}<div class="muted small">${esc(l.description)}</div>`, csv: l => l.itemCode },
      { key: 'basedInvNumber', label: 'Invoice' },
      { key: 'warehouseCode', label: 'Whs' },
      { key: 'rrQty', label: 'Requested', num: true, fmt: qty },
      { key: 'unitPrice', label: 'Price incl. VAT', num: true, fmt: money },
      { key: 'lineTotal', label: 'Line total', num: true, fmt: money },
      { key: 'ret', label: 'Return doc', val: l => l.return && l.return.returnNumber, fmt: (v, l) => v ? `${esc(v)}<div class="muted small">${dFull(l.return.returnDate)}</div>` : '' },
      { key: 'retQty', label: 'Returned', num: true, val: l => l.return ? l.return.returnQty : null, fmt: qty },
      { key: 'cn', label: 'Credit note', val: l => l.creditNote && l.creditNote.creditNoteNumber, fmt: (v, l) => v ? `${esc(v)}<div class="muted small">${dFull(l.creditNote.creditNoteDate)}</div>` : '' },
      { key: 'cnQty', label: 'Credited', num: true, val: l => l.creditNote ? l.creditNote.creditNoteQty : null, fmt: qty },
    ],
    footer: rows => ({ lineTotal: money(sum(rows, l => l.lineTotal)) }),
  });
}

function renderInvoice(i, el) {
  const L = i.DocumentLines || [];
  el.innerHTML = `<section class="card"><div class="kv">
      <div><span>Invoice no.</span><b>${esc(i.DocNum)}</b></div>
      <div><span>Date</span><b>${dFull(i.DocDate)} <span class="muted small">created ${esc(i.CreateDate)} ${esc(i.CreateTime)}</span></b></div>
      <div><span>Customer</span><b>${openLink('customer', i.CardCode, i.CardName)} (${esc(i.CardCode)})</b></div>
      <div><span>Rep</span><b>${esc(i.RepName)}</b></div>
      <div><span>Company</span><b>${esc(i.BPLName)}</b></div>
      <div><span>Total</span><b>Rs ${money(i.DocTotal)} <span class="muted small">VAT ${money(i.VatSum)}</span></b></div>
      <div><span>Paid</span><b>Rs ${money(i.PaidToDate)}</b></div>
      <div><span>Returned</span><b>Rs ${money(i.ReturnValueTotal)}</b></div>
      <div><span>Delivery</span><b>${esc([i['Delivery Status'], i['Delivery Mode'], i['Delivery Date']].filter(Boolean).join(' · ') || '–')}</b></div>
      <div><span>Reference</span><b class="small">${esc(i.NumAtCard)}</b></div>
    </div>${i.Comments ? `<p class="muted small" style="margin:12px 0 0">${esc(i.Comments)}</p>` : ''}</section>
    <section class="card"><div class="card-head"><h2>Lines</h2></div><div id="iLines"></div></section>`;
  table($('#iLines', el), {
    name: 'INV_' + i.DocNum, rows: L, pageSize: 100,
    cols: [
      { key: 'LineNum', label: '#', num: true },
      { key: 'ItemCode', label: 'Item', fmt: (v, l) => `${openLink('item', v)}<div class="muted small">${esc(l.ItemName)}</div>`, csv: l => l.ItemCode },
      { key: 'PartNumber', label: 'Part no.' },
      { key: 'Quantity', label: 'Qty', num: true, val: l => num(l.Quantity), fmt: qty },
      { key: 'PriceAfterVAT', label: 'Price incl. VAT', num: true, val: l => num(l.PriceAfterVAT), fmt: money },
      { key: 'DiscountPercent', label: 'Disc %', num: true, val: l => num(l.DiscountPercent), fmt: qty },
      { key: 'ReturnablePriceAfterVAT', label: 'Net price', num: true, val: l => num(l.ReturnablePriceAfterVAT), fmt: money },
      { key: 'net', label: 'Net value', num: true, val: l => num(l.ReturnablePriceAfterVAT) * num(l.Quantity), fmt: money },
      { key: 'AvailableReturnQty', label: 'Returnable qty', num: true, val: l => num(l.AvailableReturnQty), fmt: qty },
      { key: 'SalesOrderNumber', label: 'Sales order', fmt: v => openLink('order', v) },
      { key: 'TaxCode', label: 'Tax' },
    ],
    footer: r => ({ Quantity: qty(sum(r, l => l.Quantity)), net: money(sum(r, l => num(l.ReturnablePriceAfterVAT) * num(l.Quantity))) }),
  });
}

async function renderCustomer(code, el, bpl) {
  bpl = bpl || store.get('bpl', '4');
  el.innerHTML = `<section class="card"><div class="card-head"><h2 id="cuName">${esc(CUSTS.get(code) || code)}</h2><span class="sub">${esc(code)}</span>
      <span class="right"><label class="small muted">Company <select id="cuBpl">${[...BRANCHES.entries()].map(([k, n]) => `<option value="${esc(k)}" ${k === bpl ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label></span></div>
      <div class="kv" id="cuKv">${spinner()}</div></section>
    <div class="tiles" id="cuAge"></div>
    ${card('cuOut', 'Outstanding statement', `as of ${dFull(today())}`)}
    ${card('cuRec', 'Open items to reconcile', 'Open invoices, advance payments and credit notes')}
    ${card('cuAct', 'Activity in selected dates', esc(rangeLabel()))}`;
  $('#cuBpl', el).addEventListener('change', e => { store.set('bpl', e.target.value); renderCustomer(code, el, e.target.value); });
  const enc = encodeURIComponent(code);
  const [gr, out, rec, bank] = await Promise.all([
    api(`/lookup/customer/${enc}/grade`).catch(e => ({ error: e.message })),
    api(`/lookup/customer/${enc}/outstanding?asof=${today()}&bpl=${bpl}`).catch(e => ({ error: e.message })),
    api(`/lookup/customer/${enc}/reconciliation`).catch(e => ({ error: e.message })),
    api(`/lookup/customer/${enc}/bank`).catch(e => ({ error: e.message })),
  ]);
  const g = Array.isArray(gr) ? gr.find(x => x.CardCode === code) || gr[0] || {} : {};
  const outRows = Array.isArray(out) ? out : [];
  const name = (outRows[0] && outRows[0]['CUSTOMER NAME']) || CUSTS.get(code) || code;
  $('#cuName', el).textContent = name;
  const osKey = outRows.length && Object.keys(outRows[0]).find(k => /OS AMOUNT/i.test(k));
  const os = osKey ? sum(outRows, r => r[osKey]) : null;
  $('#cuKv', el).innerHTML = `
    <div><span>Grade</span><b>${Object.entries(g).filter(([k]) => k !== 'CardCode').map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(' · ') || '–'}</b></div>
    <div><span>Total outstanding</span><b>${os === null ? '–' : 'Rs ' + money(os)}</b></div>
    <div><span>Reps</span><b>${esc((outRows[0] && outRows[0].AllRepNames) || '–')}</b></div>
    <div><span>Bank accounts</span><b>${Array.isArray(bank) && bank.length ? bank.map(b => `${esc(b.BankName)} ${esc(b.Account)}`).join('<br>') : '–'}</b></div>`;
  if (osKey) {
    const ageKey = Object.keys(outRows[0]).find(k => /^AGE$/i.test(k));
    const pos = outRows.filter(r => num(r[osKey]) > 0);
    const bk = [['0–30 days', 0, 30], ['31–60 days', 31, 60], ['61–90 days', 61, 90], ['91–120 days', 91, 120], ['Over 120 days', 121, 1e9]];
    $('#cuAge', el).innerHTML = bk.map(([l, a, b]) => { const s = pos.filter(r => num(r[ageKey]) >= a && num(r[ageKey]) <= b); return tile(l, rs(sum(s, r => r[osKey])), `${s.length} documents`); }).join('');
  }
  if (out.error) $('#cuOut', el).innerHTML = `<div class="alert crit">${esc(out.error)}</div>`;
  else {
    const keys = outRows.length ? Object.keys(outRows[0]) : [];
    const want = ['SECTION', 'DOC TYPE', 'DOC NO.', 'DOC DATE', 'DOC DUE DATE', 'DESCRIPTION', 'DOC AMOUNT', 'PAID AMOUNT', 'OS AMOUNT', 'AGE', 'Rep Code'];
    const show = want.filter(k => keys.includes(k));
    const cols = (show.length ? show : keys).map(k => {
      const isNum = /AMOUNT|AGE/i.test(k), isDate = /DATE/i.test(k);
      return { key: k, label: k.replace(/\b\w+/g, w => w[0] + w.slice(1).toLowerCase()), num: isNum, val: r => isNum ? num(r[k]) : r[k], fmt: v => isNum ? (/AGE/i.test(k) ? int(v) : money(v)) : isDate ? dFull(v) : esc(v) };
    });
    table($('#cuOut', el), { name: 'outstanding_' + code, rows: outRows, cols, pageSize: 50, empty: 'Nothing outstanding', footer: r => Object.fromEntries(cols.filter(c => /AMOUNT/i.test(c.key)).map(c => [c.key, money(sum(r, x => x[c.key]))])) });
  }
  if (rec.error) $('#cuRec', el).innerHTML = `<div class="alert crit">${esc(rec.error)}</div>`;
  else table($('#cuRec', el), {
    name: 'open_items_' + code, rows: rec, pageSize: 25, empty: 'No open items',
    cols: [{ key: 'Type', label: 'Type' }, { key: 'DocNum', label: 'Doc no.' }, { key: 'DocDate', label: 'Date', fmt: dFull }, { key: 'Branch', label: 'Company', val: r => branchName(r.Branch) }, { key: 'DocTotal', label: 'Total (Rs)', num: true, val: r => num(r.DocTotal), fmt: money }, { key: 'OpenAmount', label: 'Open (Rs)', num: true, val: r => num(r.OpenAmount), fmt: money }],
    footer: r => ({ OpenAmount: money(sum(r, x => x.OpenAmount)) }),
  });
  // activity from data already loaded for the selected range
  const [O, I] = await Promise.all([loadRange('orders'), loadRange('invoices')]);
  const act = [
    ...O.rows.filter(o => o.cardCode === code).map(o => ({ type: 'Sales order', no: o.docNum, kind: 'order', id: o.docNum, date: o.docDate, value: o.docTotal, status: o.status })),
    ...I.rows.filter(i => i.cardCode === code).map(i => ({ type: 'Invoice', no: i.docNum, kind: 'invoice', id: i.docEntry, date: i.docDate, value: i.docTotal, status: i.paid >= i.docTotal - 0.5 ? 'Paid' : i.paid > 0 ? 'Part paid' : 'Unpaid' })),
  ];
  table($('#cuAct', el), {
    name: 'activity_' + code, rows: act, sort: { key: 'date', dir: 'desc' }, empty: 'No orders or invoices in the selected dates',
    cols: [{ key: 'type', label: 'Document' }, { key: 'no', label: 'No.', fmt: (v, r) => openLink(r.kind, r.id, v) }, { key: 'date', label: 'Date', fmt: dFull }, { key: 'value', label: 'Value (Rs)', num: true, fmt: money }, { key: 'status', label: 'Status', fmt: chip, csv: r => stLabel(r.status) }],
  });
}

// ============================================================== router & shell
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [page, qs] = h.split('?');
  const first = Object.keys(PAGES).find(allowed) || 'overview';
  return { page: PAGES[page] && allowed(page) ? page : first, params: Object.fromEntries(new URLSearchParams(qs || '')) };
}

async function route() {
  const { page, params } = parseHash();
  const my = ++seq;
  const alive = () => my === seq;
  const P = PAGES[page];
  $('#pageTitle').textContent = P.title;
  document.title = P.title + ' · Sales Force Dashboard';
  $$('#nav a').forEach(a => a.classList.toggle('on', a.dataset.page === page));
  $('#side').classList.remove('open');
  closeDrawer();
  meta.failed = []; meta.stale = [];
  const main = $('#main');
  try {
    await P.render(main, alive, params);
  } catch (e) {
    if (e instanceof AuthError) return;
    if (alive()) main.innerHTML = errorBox(e.message);
  } finally {
    if (alive()) { S.force = false; renderFoot(); }
  }
}

function renderFoot() {
  const parts = [`Showing ${rangeLabel()}`];
  if (S.rep) parts.push('rep: ' + repName(S.rep));
  if (S.cust) parts.push('customer: ' + S.cust);
  if (meta.fetchedAt) parts.push('data as of ' + new Date(meta.fetchedAt).toLocaleString());
  let warn = '';
  if (meta.failed.length) warn = ` · <b style="color:var(--bad-ink)">${meta.failed.length} day(s) could not be loaded (${esc(uniq(meta.failed.map(f => f.day)).slice(0, 5).join(', '))}) – press Refresh to retry</b>`;
  else if (meta.stale.length) warn = ` · <span style="color:var(--bad-ink)">some days shown from older cache: SAP did not answer</span>`;
  const src = parseHash().page.startsWith('sl-') ? 'SAP Business One Service Layer' : 'SAP Business One Sales API';
  $('#foot').innerHTML = esc(parts.join(' · ')) + warn + ' · Source: ' + src;
}

function setRange(from, to) {
  if (!from || !to || from > to) return toast('Pick a valid date range');
  if (daysBetween(from, to) + 1 > MAX_DAYS) return toast(`Please choose ${MAX_DAYS} days or fewer`);
  if (daysBetween(from, to) + 1 > 120) toast('A long range is read from SAP day by day: the first load can take several minutes, later loads are quick.', 7000);
  S.from = from; S.to = to;
  store.set('from', from); store.set('to', to);
  route();
}

function initFilters() {
  const pre = $('#fPreset');
  const hp = parseHash().params; // shareable links: #/orders?from=2026-09-01&to=2026-09-30
  if (/^\d{4}-\d{2}-\d{2}$/.test(hp.from || '') && /^\d{4}-\d{2}-\d{2}$/.test(hp.to || '') && hp.from <= hp.to) {
    S.preset = 'custom'; S.from = hp.from; S.to = hp.to;
  } else if (hp.range && $(`#fPreset option[value="${CSS.escape(hp.range)}"]`) && hp.range !== 'custom') {
    S.preset = hp.range; // shareable links: #/overview?range=all
    S.from = null;
  }
  pre.value = S.preset;
  const showCustom = () => { $('#fCustom').hidden = pre.value !== 'custom'; $('#fFrom').value = S.from; $('#fTo').value = S.to; };
  if (S.preset !== 'custom' || !S.from) [S.from, S.to] = applyPreset(S.preset);
  showCustom();
  pre.addEventListener('change', () => {
    S.preset = pre.value; store.set('preset', S.preset);
    if (pre.value === 'custom') { showCustom(); return; }
    $('#fCustom').hidden = true;
    const [f, t] = applyPreset(pre.value); setRange(f, t);
  });
  $('#fApply').addEventListener('click', () => setRange($('#fFrom').value, $('#fTo').value));
  $('#fRep').addEventListener('change', e => { S.rep = e.target.value; store.set('rep', S.rep); route(); });
  let t; $('#fCust').addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => { S.cust = e.target.value.trim(); route(); }, 450); });
  $('#refreshBtn').addEventListener('click', () => { S.force = true; dataCache.clear(); liveCache.clear(); route(); });
  $('#menuBtn').addEventListener('click', () => $('#side').classList.toggle('open'));
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#drawerBg').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
  $('#themeBtn').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    store.set('theme', document.documentElement.dataset.theme);
  });
  $('#logoutBtn').addEventListener('click', async () => { await fetch('/auth/logout', { method: 'POST', headers: { 'X-SFD': '1' } }); location.reload(); });
  $('#pwBtn').addEventListener('click', () => showPassword(false));
  // refresh "today" data every 10 minutes while open
  setInterval(() => { if (document.visibilityState === 'visible' && S.to === today() && $('#drawer').hidden) { dataCache.clear(); liveCache.clear(); route(); } }, 10 * 60e3);
}

function showLogin() {
  $('#app').hidden = true; $('#login').hidden = false; closeDrawer();
  setTimeout(() => $('#loginForm [name=user]').focus(), 50);
}
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const r = await fetch('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SFD': '1' }, body: JSON.stringify({ user: f.get('user'), password: f.get('password') }) });
  const b = await r.json().catch(() => ({}));
  if (r.ok) { $('#login').hidden = true; $('#loginErr').hidden = true; e.target.reset(); ME = b.user; if (ME.mustChangePassword) showPassword(true); else start(); }
  else { $('#loginErr').textContent = b.error || 'Sign in failed'; $('#loginErr').hidden = false; }
});

function showPassword(forced) {
  const m = $('#pwModal');
  m.hidden = false;
  $('#pwTitle').textContent = forced ? 'Choose a new password' : 'Change password';
  $('#pwNote').textContent = forced ? 'Your administrator set a temporary password. Choose your own to continue.' : 'At least 8 characters, with letters and numbers.';
  $('#pwCancel').hidden = forced;
  $('#pwErr').hidden = true;
  $('#pwForm').reset();
  setTimeout(() => $('#pwForm [name=current]').focus(), 50);
}
$('#pwCancel').addEventListener('click', () => { $('#pwModal').hidden = true; });
$('#pwForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target), err = $('#pwErr');
  if (f.get('password') !== f.get('confirm')) { err.textContent = 'The two new passwords are different.'; err.hidden = false; return; }
  try {
    await api('/auth/password', 'POST', { current: f.get('current'), password: f.get('password') });
    $('#pwModal').hidden = true;
    ME = await api('/auth/me');
    toast('Password changed');
    start();
  } catch (x) { if (!(x instanceof AuthError)) { err.textContent = x.message; err.hidden = false; } }
});

function applyAccess() {
  $$('#nav a[data-page]').forEach(a => { a.hidden = !allowed(a.dataset.page); });
  $$('#nav .nav-sec').forEach(sec => { // hide a section heading when none of its links are visible
    let n = sec.nextElementSibling, any = false;
    while (n && !n.classList.contains('nav-sec')) { if (n.matches('a') && !n.hidden) any = true; n = n.nextElementSibling; }
    sec.hidden = !any;
  });
  $('#refreshBtn').hidden = !(ME.isAdmin || ME.canRefresh);
  const lim = [ME.scope.reps.length ? `${ME.scope.reps.length} rep${ME.scope.reps.length > 1 ? 's' : ''}` : '', ME.scope.companies.length ? ME.scope.companies.map(c => ({ 4: 'ATL', 5: 'AL' }[c] || c)).join('+') : ''].filter(Boolean);
  $('#meBox').innerHTML = `<b>${esc(ME.name)}</b><span>${esc(ME.roleLabel)}${!ME.isAdmin && lim.length ? ' · ' + esc(lim.join(', ')) : ''}</span>`;
  refreshFilterLists();
}

let started = false;
async function start() {
  $('#app').hidden = false;
  $('#pwModal').hidden = true;
  applyAccess();
  if (myReps().length && S.rep && !myReps().includes(S.rep)) S.rep = '';
  if (!started) {
    started = true;
    try { const st = await api('/status'); MAX_DAYS = st.maxRangeDays || MAX_DAYS; ALL_FROM = st.allFrom || ALL_FROM; } catch { /* keep defaults */ }
    $('#fPreset option[value=all]').textContent = `All dates (since ${dFull(ALL_FROM)})`;
    initFilters(); window.addEventListener('hashchange', route);
  }
  route();
}

(async function boot() {
  const th = store.get('theme', null); if (th) document.documentElement.dataset.theme = th;
  const r = await fetch('/auth/me');
  if (!r.ok) return showLogin();
  ME = await r.json();
  if (ME.mustChangePassword) { $('#app').hidden = true; showPassword(true); } else start();
})();
