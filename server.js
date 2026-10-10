// Sales Force Management Dashboard - backend
// Holds the Sales API key, fetches the API day by day, caches to disk and
// serves trimmed data + the single-page dashboard in ./public.
// Node 18+ only, no npm packages.

'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { URL } = require('url');

// ---------------------------------------------------------------- config
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv(path.join(__dirname, '.env'));

const CFG = {
  apiBase: (process.env.API_BASE || '').replace(/\/+$/, ''),
  apiKey: process.env.API_KEY || '',
  port: Number(process.env.PORT || 8080),
  cacheDir: path.resolve(__dirname, process.env.CACHE_DIR || 'cache'),
  concurrency: Number(process.env.UPSTREAM_CONCURRENCY || 4),
  timeoutMs: Number(process.env.UPSTREAM_TIMEOUT_SEC || 300) * 1000,
  maxRangeDays: Number(process.env.MAX_RANGE_DAYS || 800),
  allFrom: process.env.ALL_FROM || '2025-01-01', // first date offered by the "All dates" option
  warmDays: Number(process.env.WARM_DAYS || 7),
  warmEveryMin: Number(process.env.WARM_EVERY_MIN || 10),
  users: parseUsers(process.env.DASH_USERS || ''),   // only used to create the first administrator(s)
  sessionHours: Number(process.env.SESSION_HOURS || 12),
  dataDir: path.resolve(__dirname, process.env.DATA_DIR || 'data'),
  defaultBpl: process.env.DEFAULT_BPL_ID || '4',
  sl: {
    base: process.env.SL_BASE || '',
    company: process.env.SL_COMPANY || '',
    user: process.env.SL_USER || '',
    password: process.env.SL_PASSWORD || '',
    concurrency: Number(process.env.SL_CONCURRENCY || 4),
    timeoutMs: Number(process.env.UPSTREAM_TIMEOUT_SEC || 300) * 1000,
    maxRangeDays: Number(process.env.MAX_RANGE_DAYS || 800),
    cacheDir: path.resolve(__dirname, process.env.CACHE_DIR || 'cache', 'sl'),
  },
};

function parseUsers(s) {
  // "user:password,user2:sha256:<hex>"
  const out = {};
  for (const part of s.split(',').map(x => x.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

if (!CFG.apiBase || !CFG.apiKey) {
  console.error('API_BASE and API_KEY must be set in .env');
  process.exit(1);
}

// ---------------------------------------------------------------- upstream
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: CFG.concurrency + 2 });

let active = 0;
const queue = [];
function limited(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      active++;
      fn().then(resolve, reject).finally(() => { active--; if (queue.length) queue.shift()(); });
    };
    active < CFG.concurrency ? run() : queue.push(run);
  });
}

function apiGet(pathAndQuery) {
  return limited(() => new Promise((resolve, reject) => {
    const u = new URL(CFG.apiBase + pathAndQuery);
    const mod = u.protocol === 'https:' ? https : http;
    const started = Date.now();
    const req = mod.request(u, {
      method: 'GET',
      agent: u.protocol === 'https:' ? agent : undefined,
      headers: { 'x-api-key': CFG.apiKey, 'Accept': 'application/json', 'Accept-Encoding': 'gzip' },
      timeout: CFG.timeoutMs,
    }, res => {
      let stream = res;
      if (res.headers['content-encoding'] === 'gzip') stream = res.pipe(zlib.createGunzip());
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('error', reject);
      stream.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body;
        try { body = JSON.parse(text); } catch { body = text; }
        log(`${res.statusCode} ${pathAndQuery} ${(Date.now() - started) / 1000}s ${(text.length / 1024).toFixed(0)}KB`);
        if (res.statusCode >= 400) {
          const msg = (body && (body.error || body.details)) || String(text).slice(0, 300);
          return reject(Object.assign(new Error(msg), { status: res.statusCode, body }));
        }
        resolve(body);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Upstream timeout')));
    req.on('error', reject);
    req.end();
  }));
}

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

// ---------------------------------------------------------------- helpers
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const d10 = v => (v ? String(v).slice(0, 10) : null);
const uniq = a => [...new Set(a.filter(v => v !== null && v !== undefined && v !== ''))];
const ymd = d => d.replace(/-/g, '');
function isoDay(dt) { return dt.toISOString().slice(0, 10); }
function todayLocal() { const d = new Date(); return isoDay(new Date(d.getTime() - d.getTimezoneOffset() * 60000)); }
function daysBetween(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }
function dayList(from, to) {
  const out = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86400000) out.push(isoDay(new Date(t)));
  return out;
}
function validDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(Date.parse(s)); }

// ---------------------------------------------------------------- slimmers
// Each range dataset is fetched one day at a time and reduced to what the UI needs.
const DATASETS = {
  orders: {
    url: d => `/api/SO_Status?from_date=${ymd(d)}&to_date=${ymd(d)}`,
    rows: body => (body && body.data && body.data.orders) || [],
    slim: o => {
      const lines = o.lines || [];
      const s = o.summary || {}, q = s.quantities || {}, ol = s.orderLines || {}, ni = s.notIssuedSummary || {}, qa = s.qtyAdjustedSummary || {};
      const invMap = new Map();
      for (const l of lines) {
        const iv = l.invoice;
        if (iv && iv.invNumber && !invMap.has(iv.invNumber)) invMap.set(iv.invNumber, iv);
      }
      const invs = [...invMap.values()];
      const delDates = uniq(lines.map(l => l.delivery && l.delivery.deliveryDate)).sort();
      const invDates = uniq(invs.map(i => i.invDate)).sort();
      return {
        docNum: o.docNum, docDate: d10(o.docDate), cardCode: o.cardCode, cardName: o.cardName,
        repCode: o.repCode, uRepCode: o.uRepCode, docTotal: num(o.docTotal), currency: o.docCurrency,
        status: o.orderStatus, cancel: o.cancelStatus,
        sqNumber: (o.linkedQuotation && o.linkedQuotation.sqNumber) || uniq(lines.map(l => l.quotation && l.quotation.sqNumber))[0] || null,
        lines: ol.totalLines || lines.length, adjustedLines: ol.adjustedLines || 0, notIssuedLines: ol.notIssuedLines || 0,
        partialLines: ni.totalPartialLines || 0, notDeliveredLines: ni.totalNotDeliveredLines || 0,
        soQty: num(q.totalSOQty), sqQty: num(q.totalSQQty), deliveredQty: num(q.totalDeliveredQty),
        invoicedQty: num(q.totalInvoicedQty), returnQty: num(q.totalReturnQty), unissuedQty: num(ni.totalUnissuedQty),
        fulfilment: num(ni.fulfilmentRate), netQtyDiff: num(qa.netQtyDiff),
        deliveries: uniq(lines.map(l => l.delivery && l.delivery.deliveryNumber)),
        invoices: invs.map(i => i.invNumber),
        invoicedValue: invs.reduce((a, i) => a + num(i.invoiceTotal), 0),
        paidValue: invs.reduce((a, i) => a + num(i.invoicePaidToDate), 0),
        firstDeliveryDate: delDates[0] || null, firstInvoiceDate: invDates[0] || null, lastInvoiceDate: invDates[invDates.length - 1] || null,
        parts: uniq(lines.map(l => l.partNumber)).slice(0, 30),
        items: uniq(lines.map(l => l.itemCode)).slice(0, 30),
        warehouses: uniq(lines.map(l => l.warehouseCode)),
      };
    },
  },
  invoices: {
    url: d => `/api/invoices?from_date=${ymd(d)}&to_date=${ymd(d)}`,
    rows: body => (Array.isArray(body) ? body : []),
    slim: i => {
      const ls = i.DocumentLines || [];
      return {
        docEntry: i.DocEntry, docNum: i.DocNum, docDate: d10(i.DocDate), cardCode: i.CardCode, cardName: i.CardName,
        slpCode: i.SalesPersonCode, repName: i.RepName, numAtCard: i.NumAtCard,
        docTotal: num(i.DocTotal), vat: num(i.VatSum), paid: num(i.PaidToDate), returnValue: num(i.ReturnValueTotal),
        currency: i.DocCurrency, bplId: i.BPL_IDAssignedToInvoice, bplName: i.BPLName,
        source: i.U_Source || '', whs: i.U_INVWHS || '', docType: i.DocType,
        createDate: i.CreateDate, createTime: i.CreateTime,
        deliveryStatus: i['Delivery Status'] || '', deliveryDate: i['Delivery Date'] || '', deliveryMode: i['Delivery Mode'] || '', barcode: i.Barcode || '',
        periodDisc: num(i.PeriodDiscountPercent), discPct: num(i.DiscountPercent),
        lines: ls.length, qty: ls.reduce((a, l) => a + num(l.Quantity), 0),
        salesOrders: uniq(ls.map(l => l.SalesOrderNumber)),
        comments: (i.Comments || '').slice(0, 200),
      };
    },
  },
  returns: {
    url: d => `/api/RR_Status?from_date=${ymd(d)}&to_date=${ymd(d)}`,
    rows: body => (body && body.data && body.data.returnRequests) || [],
    slim: r => {
      const ls = r.lines || [], s = r.summary || {};
      return {
        rrNumber: r.rrNumber, rrDate: d10(r.rrDate), cardCode: r.cardCode, cardName: r.cardName,
        repCode: r.repCode, uRepCode: r.uRepCode, docTotal: num(r.docTotal), currency: r.docCurrency,
        status: r.rrStatus, confirmed: r.rrConfirmed, cancel: r.cancelStatus,
        returnNumAtCard: r.returnNumAtCard, invoiceNumAtCard: r.invoiceNumAtCard,
        lines: s.totalLines || ls.length, rrQty: num(s.totalRRQty), returnQty: num(s.totalReturnQty), cnQty: num(s.totalCreditNoteQty),
        adjustedLines: (s.qtyAdjustedSummary && s.qtyAdjustedSummary.totalAdjustedLines) || 0,
        basedInvoices: uniq(ls.map(l => l.basedInvNumber)),
        returnDocs: uniq(ls.map(l => l.return && l.return.returnNumber)),
        creditNotes: uniq(ls.map(l => l.creditNote && l.creditNote.creditNoteNumber)),
        items: uniq(ls.map(l => l.itemCode)).slice(0, 30),
      };
    },
  },
  returnCreditNotes: {
    url: d => `/api/return-credit-notes?from_date=${ymd(d)}&to_date=${ymd(d)}`,
    rows: body => (Array.isArray(body) ? body : []),
    slim: c => ({
      docEntry: c.DocEntry, docNum: c.DocNum, docDate: d10(c.DocDate), cardCode: c.CardCode, cardName: c.CardName,
      slpCode: c.SalesPersonCode, repName: c.RepName, numAtCard: c.NumAtCard,
      docTotal: num(c.DocTotal), vat: num(c.VatSum), openBalance: num(c.OpenBalance), currency: c.DocCurrency,
      bplId: c.BPL_IDAssignedToInvoice, bplName: c.BPLName,
      lines: (c.DocumentLines || []).length, qty: (c.DocumentLines || []).reduce((a, l) => a + num(l.Quantity), 0),
      comments: (c.Comments || '').slice(0, 200),
    }),
  },
  quotations: {
    url: d => `/api/sales-quotations?from_date=${ymd(d)}&to_date=${ymd(d)}`,
    rows: body => (Array.isArray(body) ? body : []),
    slim: q => {
      const ls = q.lines || [];
      const withSo = ls.filter(l => l.salesOrder && l.salesOrder.soNumber);
      const so0 = withSo[0] && withSo[0].salesOrder;
      const st = {};
      for (const l of ls) {
        const k = l.quotationStatus || (l.salesOrder && l.salesOrder.soStatus) || 'Unknown';
        st[k] = (st[k] || 0) + 1;
      }
      return {
        sqNumber: q.sqNumber, sqDate: d10(q.sqDate), cancel: q.cancelStatus,
        cardCode: so0 ? so0.cardCode : null, cardName: so0 ? so0.cardName : null,
        repCode: so0 ? so0.repCode : null, uRepCode: so0 ? so0.uRepCode : null,
        lines: ls.length, convertedLines: withSo.length,
        sqQty: ls.reduce((a, l) => a + num(l.sqQty), 0),
        soValue: withSo.reduce((a, l) => a + num(l.salesOrder.lineTotal), 0),
        salesOrders: uniq(withSo.map(l => l.salesOrder.soNumber)),
        invoices: uniq(ls.map(l => l.invoice && l.invoice.invNumber)),
        statusCounts: st,
        status: ls.some(l => l.quotationStatus === 'Quotation Open') ? 'Open lines'
          : withSo.length === ls.length ? 'Fully converted'
          : withSo.length ? 'Partly converted' : (Object.keys(st)[0] || 'Unknown'),
      };
    },
  },
};

// ---------------------------------------------------------------- day cache
const mem = new Map();      // key -> {fetchedAt, rows}
const inflight = new Map(); // key -> promise

function ttlFor(day) {
  const age = daysBetween(day, todayLocal());
  if (age <= 0) return 5 * 60e3;        // today: 5 min
  if (age <= 3) return 30 * 60e3;       // last 3 days: 30 min
  if (age <= 30) return 3 * 3600e3;     // last month: 3 h
  return 24 * 3600e3;                   // older: 1 day
}

function cacheFile(ds, day) { return path.join(CFG.cacheDir, ds, day + '.json'); }

async function getDay(ds, day, force) {
  const key = ds + '|' + day;
  let hit = mem.get(key);
  if (!hit) {
    const f = cacheFile(ds, day);
    if (fs.existsSync(f)) {
      try { hit = JSON.parse(fs.readFileSync(f, 'utf8')); mem.set(key, hit); } catch { /* ignore corrupt */ }
    }
  }
  if (hit && !force && Date.now() - hit.fetchedAt < ttlFor(day)) return { ...hit, cached: true };
  if (inflight.has(key)) return inflight.get(key);

  const def = DATASETS[ds];
  const p = (async () => {
    try {
      const body = await apiGet(def.url(day));
      const rows = def.rows(body).map(def.slim);
      const entry = { fetchedAt: Date.now(), rows };
      mem.set(key, entry);
      fs.mkdirSync(path.dirname(cacheFile(ds, day)), { recursive: true });
      fs.writeFileSync(cacheFile(ds, day), JSON.stringify(entry));
      return { ...entry, cached: false };
    } catch (e) {
      if (hit) return { ...hit, cached: true, stale: true, error: e.message };
      throw e;
    } finally { inflight.delete(key); }
  })();
  inflight.set(key, p);
  return p;
}

async function getRange(ds, from, to, force) {
  const days = dayList(from, to);
  const results = await Promise.all(days.map(d => getDay(ds, d, force).then(r => ({ d, r }), e => ({ d, e }))));
  const rows = [], failed = [], stale = [];
  let oldest = Infinity;
  for (const { d, r, e } of results) {
    if (e) { failed.push({ day: d, error: e.message }); continue; }
    rows.push(...r.rows);
    if (r.stale) stale.push(d);
    oldest = Math.min(oldest, r.fetchedAt);
  }
  return { dataset: ds, from, to, rows, failed, stale, fetchedAt: oldest === Infinity ? null : oldest };
}

// short-lived cache for live / lookup calls
const shortCache = new Map();
async function cachedGet(p, ttlMs, force) {
  const hit = shortCache.get(p);
  if (hit && !force && Date.now() - hit.t < ttlMs) return hit.body;
  const body = await apiGet(p);
  shortCache.set(p, { t: Date.now(), body });
  return body;
}

// ---------------------------------------------------------------- Service Layer
const SL = CFG.sl.base && CFG.sl.company && CFG.sl.user
  ? require('./sl')(CFG.sl, { log, todayLocal, ttlFor, dayList, daysBetween, isoDay, validDate })
  : null;

// ---------------------------------------------------------------- access control
const ACCESS = require('./access')({ dataDir: CFG.dataDir, sessionHours: CFG.sessionHours, bootstrap: CFG.users, log });
const DENIED = Object.assign(new Error('Your account does not have access to this.'), { status: 403 });

// limits a user to some sales reps (SlpCode) and/or companies (BPL 4 / 5)
function scopeOf(user) {
  const reps = ACCESS.repScope(user), cos = ACCESS.coScope(user);
  return { reps, cos, any: reps.length > 0 || cos.length > 0, repOk: r => !reps.length || reps.includes(String(r)), coOk: b => !cos.length || cos.includes(String(b)) };
}
// warehouse -> company (BPL), from the Service Layer; used to hide the other company's stock from company-limited users
let whsCoCache = null;
async function whsCompanies() {
  if (!SL) return new Map();
  if (!whsCoCache || Date.now() - whsCoCache.t > 6 * 3600e3) whsCoCache = { t: Date.now(), m: new Map((await SL.warehouses()).map(w => [w.WarehouseCode, String(w.BusinessPlaceID)])) };
  return whsCoCache.m;
}
async function whsScope(item, F) {
  if (!item || !item.ItemWarehouseInfoCollection) return item;
  const co = await whsCompanies();
  const whs = item.ItemWarehouseInfoCollection.filter(w => F.coOk(co.get(w.WarehouseCode)));
  return { ...item, ItemWarehouseInfoCollection: whs, QuantityOnStock: whs.reduce((a, w) => a + (w.InStock || 0), 0) };
}
// Sales API orders and return requests carry no company, so only the rep limit applies to them
const ROW_SCOPE = {
  orders: (r, F) => F.repOk(r.repCode),
  invoices: (r, F) => F.repOk(r.slpCode) && F.coOk(r.bplId),
  returns: (r, F) => F.repOk(r.repCode),
  returnCreditNotes: (r, F) => F.repOk(r.slpCode) && F.coOk(r.bplId),
  quotations: (r, F) => !F.reps.length || (r.repCode !== null && F.repOk(r.repCode)),
};

// ---------------------------------------------------------------- http
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };

function send(req, res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra };
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    buf = zlib.gzipSync(buf);
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(status, headers);
  res.end(buf);
}

function readBody(req, limit = 1e5) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > limit) req.destroy(); });
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(__dirname, 'public', rel));
  if (!file.startsWith(path.join(__dirname, 'public'))) return send(req, res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(req, res, 404, { error: 'Not found' });
    send(req, res, 200, data, MIME[path.extname(file)] || 'application/octet-stream', { 'Cache-Control': 'no-cache' });
  });
}

const enc = encodeURIComponent;

async function handleApi(req, res, url, user) {
  const p = url.pathname, q = url.searchParams;
  if (!user.isAdmin && !user.canRefresh) q.delete('refresh');   // re-reading SAP is a permission of its own
  const force = q.get('refresh') === '1';
  const F = scopeOf(user);
  const deny = () => { throw DENIED; };

  // range datasets: /data/orders?from=YYYY-MM-DD&to=YYYY-MM-DD
  let m = p.match(/^\/data\/(\w+)$/);
  if (m) {
    const ds = m[1];
    if (!DATASETS[ds]) return send(req, res, 404, { error: 'Unknown dataset' });
    const from = q.get('from'), to = q.get('to');
    if (!validDate(from) || !validDate(to) || from > to) return send(req, res, 400, { error: 'from/to must be YYYY-MM-DD and from <= to' });
    if (daysBetween(from, to) + 1 > CFG.maxRangeDays) return send(req, res, 400, { error: `Range limited to ${CFG.maxRangeDays} days` });
    const out = await getRange(ds, from, to, force);
    if (F.any) out.rows = out.rows.filter(r => ROW_SCOPE[ds](r, F));
    return send(req, res, 200, out);
  }

  // live lists (no date splitting needed - small)
  if (p === '/live/pending') {
    const qs = new URLSearchParams();
    for (const k of ['from', 'to']) if (validDate(q.get(k))) qs.set(k + '_date', ymd(q.get(k)));
    const rows = await cachedGet('/api/pending-orders' + (qs.toString() ? '?' + qs : ''), 2 * 60e3, force);
    return send(req, res, 200, F.any ? rows.filter(r => F.repOk(r.SalesPersonCode) && F.coOk(r.Branch)) : rows);
  }
  if (p === '/live/rejected') {
    const from = q.get('from'), to = q.get('to');
    if (!validDate(from) || !validDate(to)) return send(req, res, 400, { error: 'from/to required' });
    const rows = await cachedGet(`/api/rejected-orders?from_date=${ymd(from)}&to_date=${ymd(to)}`, 5 * 60e3, force);
    return send(req, res, 200, F.any ? rows.filter(r => F.repOk(r.SalesPersonCode) && F.coOk(r.Branch)) : rows);
  }
  // these lines carry no rep or company, so users with a data limit cannot see them
  if (p === '/live/not-issued') return F.any ? deny() : send(req, res, 200, await cachedGet('/api/not-issued-details', 5 * 60e3, force));
  if (p === '/live/line-closer') return F.any ? deny() : send(req, res, 200, await cachedGet('/api/sales-order-line-closer', 5 * 60e3, force));
  if (p === '/live/grades') return send(req, res, 200, await cachedGet('/api/customer-grade', 60 * 60e3, force));

  // single-document lookups
  if ((m = p.match(/^\/lookup\/order\/(\d+)$/))) {
    const b = await cachedGet(`/api/SO_Status?doc_num=${m[1]}`, 60e3, force);
    if (F.reps.length && !(b.data && b.data.order && F.repOk(b.data.order.repCode))) deny();
    return send(req, res, 200, b);
  }
  if ((m = p.match(/^\/lookup\/order-chain\/(\d+)$/))) {
    const b = await cachedGet(`/api/sales-orders?doc_num=${m[1]}`, 60e3, force);
    if (F.reps.length && !(b.salesOrder && F.repOk(b.salesOrder.repCode))) deny();
    return send(req, res, 200, b);
  }
  if ((m = p.match(/^\/lookup\/quotation\/(\d+)$/))) {
    const b = await cachedGet(`/api/sales-quotations?doc_num=${m[1]}`, 60e3, force);
    // a quotation only shows its rep once a line became a sales order
    if (F.reps.length && !((b.salesQuotation && b.salesQuotation.lines) || []).some(l => l.salesOrder && F.repOk(l.salesOrder.repCode))) deny();
    return send(req, res, 200, b);
  }
  if ((m = p.match(/^\/lookup\/return\/(\d+)$/))) {
    const b = await cachedGet(`/api/RR_Status?doc_num=${m[1]}`, 60e3, force);
    if (F.reps.length && !(b.data && b.data.returnRequest && F.repOk(b.data.returnRequest.repCode))) deny();
    return send(req, res, 200, b);
  }
  if ((m = p.match(/^\/lookup\/invoice\/(\d+)$/))) {
    const b = await cachedGet(`/api/invoices?doc_entry=${m[1]}`, 60e3, force);
    const ok = F.any ? b.filter(i => F.repOk(i.SalesPersonCode) && F.coOk(i.BPL_IDAssignedToInvoice)) : b;
    if (b.length && !ok.length) deny();
    return send(req, res, 200, ok);
  }
  if ((m = p.match(/^\/lookup\/rr-lines\/(\d+)$/))) return F.any ? deny() : send(req, res, 200, await cachedGet(`/api/return-request-lines?doc_entry=${m[1]}`, 60e3, force));
  if ((m = p.match(/^\/lookup\/item\/(.+)$/))) {
    const it = await cachedGet(`/api/Items/${enc(decodeURIComponent(m[1]))}`, 60e3, force);
    return send(req, res, 200, F.cos.length ? await whsScope(it, F) : it);
  }
  // item status search: code, name or part number; "in stock only" is applied here because the API filter has no "greater than"
  if (p === '/lookup/stock-search') {
    const s = (q.get('q') || '').trim().replace(/'/g, "''").slice(0, 60);
    if (s.length < 2) return send(req, res, 400, { error: 'Type at least 2 characters' });
    const skip = Math.max(0, parseInt(q.get('skip') || '0', 10) || 0);
    const filter = `contains(ItemCode,'${s}') or contains(ItemName,'${s}') or contains(SupplierCatalogNo,'${s}')`;
    let items = await cachedGet(`/api/Items?$top=100&$skip=${skip}&$filter=${enc(filter)}`, 2 * 60e3, force);
    const more = items.length === 100;
    if (F.cos.length) items = await Promise.all(items.map(i => whsScope(i, F)));
    if (q.get('inStock') === '1') items = items.filter(i => i.QuantityOnStock > 0);
    return send(req, res, 200, { items, more, nextSkip: skip + 100 });
  }
  if ((m = p.match(/^\/lookup\/batches\/(.+)$/))) {
    let rows = await cachedGet(`/api/v2/batch-quantities?item_code=${enc(decodeURIComponent(m[1]))}`, 60e3, force);
    if (F.cos.length) { const co = await whsCompanies(); rows = rows.filter(r => F.coOk(co.get(r.WhsCode))); }
    return send(req, res, 200, rows);
  }
  if (p === '/lookup/part') {
    const part = (q.get('part') || '').trim(), from = q.get('from'), to = q.get('to');
    if (!part) return send(req, res, 400, { error: 'part required' });
    let up = `/api/SO_Status?supp_cat_num=${enc(part)}`;
    if (validDate(from) && validDate(to)) up += `&from_date=${ymd(from)}&to_date=${ymd(to)}`;
    const b = await cachedGet(up, 2 * 60e3, force);
    if (!F.reps.length || !b.data) return send(req, res, 200, b);
    const orders = (b.data.orders || []).filter(o => F.repOk(o.repCode));
    return send(req, res, 200, { ...b, data: { ...b.data, totalOrders: orders.length, orders } });
  }
  if (p === '/lookup/items') {
    const s = (q.get('search') || '').trim().replace(/'/g, "''");
    if (!s) return send(req, res, 400, { error: 'search required' });
    const filter = `contains(ItemCode,'${s}') or contains(ItemName,'${s}') or contains(SupplierCatalogNo,'${s}')`;
    return send(req, res, 200, await cachedGet(`/api/Items?$top=50&$filter=${enc(filter)}`, 5 * 60e3, force));
  }
  if ((m = p.match(/^\/lookup\/customer\/([^/]+)\/(outstanding|reconciliation|grade|bank)$/))) {
    const card = enc(decodeURIComponent(m[1]));
    const kind = m[2];
    if (kind === 'outstanding') {
      const asof = validDate(q.get('asof')) ? ymd(q.get('asof')) : ymd(todayLocal());
      let bpl = /^\d+$/.test(q.get('bpl') || '') ? q.get('bpl') : CFG.defaultBpl;
      if (!F.coOk(bpl)) bpl = F.cos[0];
      return send(req, res, 200, await cachedGet(`/api/customer-outstanding-report?asof=${asof}&card_code=${card}&bpl_id=${bpl}`, 2 * 60e3, force));
    }
    if (kind === 'reconciliation') return send(req, res, 200, await cachedGet(`/api/customer-reconciliation?card_code=${card}`, 2 * 60e3, force));
    if (kind === 'bank') return send(req, res, 200, await cachedGet(`/api/customer-bank-details?card_code=${card}`, 30 * 60e3, force));
    return send(req, res, 200, await cachedGet(`/api/customer-grade?card_code=${card}`, 30 * 60e3, force));
  }

  if (p.startsWith('/sl/')) {
    if (!SL) return send(req, res, 503, { error: 'SAP Service Layer is not configured (SL_BASE, SL_COMPANY, SL_USER, SL_PASSWORD in .env)' });
    // the SAP analytics totals are always cut to the user's reps / companies
    if (F.reps.length) { const want = (q.get('rep') || '').split(',').filter(r => F.repOk(r)); q.set('rep', (want.length ? want : F.reps).join(',')); }
    if (F.cos.length) { const want = (q.get('bpl') || '').split(',').filter(b => F.coOk(b)); q.set('bpl', (want.length ? want : F.cos).join(',')); }
    const out = await SL.handle(p, q);
    return out ? send(req, res, 200, out) : send(req, res, 404, { error: 'Not found' });
  }
  if (p === '/status') {
    return send(req, res, 200, { ok: true, today: todayLocal(), upstreamActive: active, upstreamQueued: queue.length, cachedDays: mem.size, maxRangeDays: CFG.maxRangeDays, allFrom: CFG.allFrom, serviceLayer: !!SL });
  }
  return send(req, res, 404, { error: 'Not found' });
}

const clientIp = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
const cookie = (t, maxAge) => `sfd_session=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  try {
    // every state-changing call must come from the dashboard's own script (blocks cross-site form posts)
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-sfd'] !== '1') return send(req, res, 403, { error: 'Missing request header' });

    if (p === '/auth/login' && req.method === 'POST') {
      let b = {};
      try { b = JSON.parse(await readBody(req)); } catch { /* bad body */ }
      const r = ACCESS.login(String(b.user || ''), String(b.password || ''), clientIp(req));
      if (r.error) return send(req, res, r.status, { error: r.error });
      log('login', r.user.username);
      return send(req, res, 200, { ok: true, user: r.user }, undefined, { 'Set-Cookie': cookie(r.token, CFG.sessionHours * 3600) });
    }
    if (p === '/auth/logout') {
      ACCESS.logout(req);
      return send(req, res, 200, { ok: true }, undefined, { 'Set-Cookie': cookie('', 0) });
    }
    const user = ACCESS.userOf(req);
    if (p === '/auth/me') return user ? send(req, res, 200, ACCESS.publicUser(user)) : send(req, res, 401, { error: 'Not signed in' });
    if (p === '/auth/password' && req.method === 'POST') {
      if (!user) return send(req, res, 401, { error: 'Not signed in' });
      let b = {};
      try { b = JSON.parse(await readBody(req)); } catch { /* bad body */ }
      const r = ACCESS.changeOwnPassword(user, String(b.current || ''), String(b.password || ''), req);
      return send(req, res, r.status, r);
    }
    if (p.startsWith('/admin/')) {
      if (!user) return send(req, res, 401, { error: 'Not signed in' });
      if (!user.isAdmin) { ACCESS.audit('denied', user.username, { path: p }); return send(req, res, 403, { error: 'Administrators only' }); }
      return await ACCESS.handleAdmin(req, res, url, user, { send, readBody });
    }

    const isApi = /^\/(data|live|lookup|status|sl)(\/|$)/.test(p);
    if (isApi) {
      if (req.method !== 'GET') return send(req, res, 405, { error: 'Method not allowed' });
      if (!user) return send(req, res, 401, { error: 'Not signed in' });
      if (user.mustChangePassword) return send(req, res, 403, { error: 'Please change your password first.', mustChangePassword: true });
      if (!ACCESS.canApi(user, p)) { ACCESS.audit('denied', user.username, { path: p }); return send(req, res, 403, { error: 'Your account does not have access to this page.' }); }
      return await handleApi(req, res, url, user);
    }
    return serveStatic(req, res, p);
  } catch (e) {
    if (e.status !== 403) log('ERROR', p, e.message);
    send(req, res, e.status && e.status < 500 ? e.status : 502, { error: e.message || 'Upstream error' });
  }
});

// ---------------------------------------------------------------- warm-up
async function warm() {
  const to = todayLocal();
  const from = isoDay(new Date(Date.parse(to) - (CFG.warmDays - 1) * 86400000));
  for (const ds of ['orders', 'invoices', 'returnCreditNotes', 'returns', 'quotations']) {
    try { await getRange(ds, from, to, false); } catch (e) { log('warm', ds, e.message); }
  }
  log(`warm-up done ${from}..${to}`);
  if (SL) await SL.warm(CFG.warmDays);
}

server.listen(CFG.port, () => {
  log(`Sales Force Dashboard V2 on http://localhost:${CFG.port}  (API ${CFG.apiBase}, users in ${CFG.dataDir})`);
  if (CFG.warmDays > 0) {
    warm();
    setInterval(warm, CFG.warmEveryMin * 60e3);
  }
});
