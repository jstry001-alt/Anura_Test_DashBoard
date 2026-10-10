// SAP Business One Service Layer analytics (read only).
// Pages through documents day by day, caches them on disk and returns
// pre-aggregated results to the dashboard. Only GET calls are made (plus Login).

'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');

module.exports = function createSL(cfg, h) {
  const { log, todayLocal, ttlFor, dayList, daysBetween, isoDay, validDate } = h;
  const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: cfg.concurrency + 2 });
  const base = cfg.base.replace(/\/+$/, '');
  const ROOT = '/b1s/v1/';

  // ------------------------------------------------------------ http + session
  let cookie = null, loginP = null, active = 0;
  const queue = [];
  function limited(fn) {
    return new Promise((resolve, reject) => {
      const run = () => { active++; fn().then(resolve, reject).finally(() => { active--; if (queue.length) queue.shift()(); }); };
      active < cfg.concurrency ? run() : queue.push(run);
    });
  }

  function raw(method, p, body) {
    return new Promise((resolve, reject) => {
      const u = new URL(base + p);
      const started = Date.now();
      const req = https.request(u, {
        method, agent, timeout: cfg.timeoutMs,
        headers: {
          'Content-Type': 'application/json', 'Accept-Encoding': 'gzip', 'Prefer': 'odata.maxpagesize=5000',
          ...(cookie && !p.endsWith('/Login') ? { Cookie: cookie } : {}),
        },
      }, res => {
        let s = res;
        if (res.headers['content-encoding'] === 'gzip') s = res.pipe(zlib.createGunzip());
        const chunks = [];
        s.on('data', c => chunks.push(c));
        s.on('error', reject);
        s.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
          if (method === 'GET') log(`SL ${res.statusCode} ${decodeURIComponent(p).slice(8, 110)} ${(Date.now() - started) / 1000}s ${(text.length / 1024).toFixed(0)}KB`);
          resolve({ status: res.statusCode, headers: res.headers, json, text });
        });
      });
      req.on('timeout', () => req.destroy(new Error('Service Layer timeout')));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  function login() {
    if (!loginP) {
      loginP = (async () => {
        const r = await raw('POST', ROOT + 'Login', JSON.stringify({ CompanyDB: cfg.company, UserName: cfg.user, Password: cfg.password }));
        if (r.status !== 200) throw new Error('Service Layer login failed: ' + slError(r));
        cookie = (r.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
        log(`SL login ok (${cfg.company})`);
      })().finally(() => { loginP = null; });
    }
    return loginP;
  }

  function slError(r) {
    const e = r.json && r.json.error;
    if (!e) return `HTTP ${r.status}`;
    return typeof e.message === 'string' ? e.message : (e.message && e.message.value) || `code ${e.code}`;
  }

  async function get(p) {
    if (!cookie) await login();
    let r = await limited(() => raw('GET', p));
    if (r.status === 401 || (r.json && r.json.error && String(r.json.error.code) === '301')) {
      cookie = null; await login();
      r = await limited(() => raw('GET', p));
    }
    if (r.status >= 400) throw Object.assign(new Error('Service Layer: ' + slError(r)), { status: 502 });
    return r.json;
  }

  // follows odata.nextLink until every page is read
  async function getAll(p) {
    const rows = [];
    let next = p;
    while (next) {
      const j = await get(next);
      rows.push(...(j.value || []));
      const nl = j['odata.nextLink'] || j['@odata.nextLink'];
      next = nl ? ROOT + nl.replace(/^\/?b1s\/v[12]\//, '') : null;
    }
    return rows;
  }
  const q = s => s.replace(/ /g, '%20').replace(/#/g, '%23');

  // ------------------------------------------------------------ day datasets
  // line rows are arrays to keep the cache small:
  // [docEntry, slpCode, cardCode, bplId, itemCode, qty, net, grossProfit, whs, brand, category, itemGroup, salesGroup, partClass]
  const lineQuery = (ent, day) => q(`${ROOT}$crossjoin(${ent},${ent}/DocumentLines,Items)?$expand=` +
    `${ent}($select=DocEntry,CardCode,SalesPersonCode,BPL_IDAssignedToInvoice),` +
    `${ent}/DocumentLines($select=ItemCode,Quantity,LineTotal,GrossProfit,WarehouseCode),` +
    `Items($select=ItemName,ItemsGroupCode,U_ItemsBrandCode,U_CategoryCode,U_SalesGroup,U_PartClassification)` +
    `&$filter=${ent}/DocEntry eq ${ent}/DocumentLines/DocEntry and Items/ItemCode eq ${ent}/DocumentLines/ItemCode` +
    ` and ${ent}/DocDate eq '${day}' and ${ent}/Cancelled eq 'tNO'`);
  async function loadLines(ent, day) {
    const rows = await getAll(lineQuery(ent, day));
    const names = {};
    const lines = rows.map(r => {
      const H = r[ent], L = r[ent + '/DocumentLines'], I = r.Items;
      names[L.ItemCode] = I.ItemName;
      return [H.DocEntry, H.SalesPersonCode, H.CardCode, H.BPL_IDAssignedToInvoice, L.ItemCode, L.Quantity, L.LineTotal, L.GrossProfit,
        L.WarehouseCode, I.U_ItemsBrandCode || '(no brand)', I.U_CategoryCode || '(no category)', I.ItemsGroupCode,
        (I.U_SalesGroup || '(not set)').replace(/^Sales Group - /, ''), I.U_PartClassification || '(not set)'];
    });
    return { lines, names };
  }

  const DAY = {
    invL2: day => loadLines('Invoices', day),
    cnL2: day => loadLines('CreditNotes', day),
    cnHeads: async day => ({
      rows: (await getAll(q(`${ROOT}CreditNotes?$select=DocEntry,DocNum,DocType,DocTotal,VatSum,SalesPersonCode,CardCode,BPL_IDAssignedToInvoice,U_CreditNotType` +
        `&$filter=DocDate eq '${day}' and Cancelled eq 'tNO'`)))
        .map(c => ({ e: c.DocEntry, n: c.DocNum, t: c.DocType, tot: c.DocTotal, vat: c.VatSum, s: c.SalesPersonCode, c: c.CardCode, b: c.BPL_IDAssignedToInvoice, k: c.U_CreditNotType || '' })),
    }),
    pay2: async day => ({
      rows: (await getAll(q(`${ROOT}IncomingPayments?$select=DocEntry,DocNum,DocType,CardCode,CardName,CashSum,TransferSum,BillOfExchangeAmount,BPLID,PaymentChecks,PaymentCreditCards,U_ChqType` +
        `&$filter=DocDate eq '${day}' and Cancelled eq 'tNO'`)))
        .filter(p => p.DocType === 'rCustomer')
        .map(p => {
          const chq = (p.PaymentChecks || []).reduce((a, c) => a + (c.CheckSum || 0), 0);
          const card = (p.PaymentCreditCards || []).reduce((a, c) => a + (c.CreditSum || 0), 0);
          return {
            e: p.DocEntry, n: p.DocNum, c: p.CardCode, cn: p.CardName, b: p.BPLID, ct: p.U_ChqType || '',
            cash: p.CashSum || 0, trf: p.TransferSum || 0, chq, card, boe: p.BillOfExchangeAmount || 0,
            cheques: (p.PaymentChecks || []).map(c => ({ no: c.CheckNumber, due: (c.DueDate || '').slice(0, 10), amt: c.CheckSum || 0, bank: c.BankCode, type: p.U_ChqType || '' })),
          };
        }),
    }),
    // receipts later cancelled because the cheque came back or was stopped (Anura records them with U_CancelType)
    rtnChq: async day => ({
      rows: (await getAll(q(`${ROOT}IncomingPayments?$select=DocEntry,DocNum,CardCode,CardName,BPLID,PaymentChecks,CashSum,TransferSum,U_ChqType,U_CancelType,U_CancelReason,U_ActualRtnDate` +
        `&$filter=DocDate eq '${day}' and Cancelled eq 'tYES' and (U_CancelType eq 'Return_Cheque' or U_CancelType eq 'Stopped_Cheque')`)))
        .map(p => ({
          e: p.DocEntry, n: p.DocNum, c: p.CardCode, cn: p.CardName, b: p.BPLID, ct: p.U_ChqType || '', kind: p.U_CancelType, reason: p.U_CancelReason || '',
          returned: (p.U_ActualRtnDate || '').slice(0, 10) || null,
          amt: (p.PaymentChecks || []).reduce((a, c) => a + (c.CheckSum || 0), 0) || (p.CashSum || 0) + (p.TransferSum || 0),
          cheques: (p.PaymentChecks || []).map(c => ({ no: c.CheckNumber, due: (c.DueDate || '').slice(0, 10), amt: c.CheckSum || 0, bank: c.BankCode })),
        })),
    }),
    payAlloc: async day => ({
      rows: (await getAll(q(`${ROOT}$crossjoin(IncomingPayments,IncomingPayments/PaymentInvoices,Invoices)?$expand=` +
        `IncomingPayments($select=DocEntry),IncomingPayments/PaymentInvoices($select=SumApplied),Invoices($select=SalesPersonCode)` +
        `&$filter=IncomingPayments/DocEntry eq IncomingPayments/PaymentInvoices/DocNum and Invoices/DocEntry eq IncomingPayments/PaymentInvoices/DocEntry` +
        ` and IncomingPayments/DocDate eq '${day}' and IncomingPayments/PaymentInvoices/InvoiceType eq 'it_Invoice'`)))
        .map(r => [r.IncomingPayments.DocEntry, r['IncomingPayments/PaymentInvoices'].SumApplied || 0, r.Invoices.SalesPersonCode]),
    }),
  };

  const mem = new Map(), inflight = new Map();
  const file = (ds, day) => path.join(cfg.cacheDir, ds, day + '.json');
  async function getDay(ds, day, force) {
    const key = ds + '|' + day;
    let hit = mem.get(key);
    if (!hit && fs.existsSync(file(ds, day))) { try { hit = JSON.parse(fs.readFileSync(file(ds, day), 'utf8')); mem.set(key, hit); } catch { /* corrupt */ } }
    if (hit && !force && Date.now() - hit.fetchedAt < ttlFor(day)) return hit;
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      try {
        const data = await DAY[ds](day);
        const entry = { fetchedAt: Date.now(), ...data };
        mem.set(key, entry);
        fs.mkdirSync(path.dirname(file(ds, day)), { recursive: true });
        fs.writeFileSync(file(ds, day), JSON.stringify(entry));
        return entry;
      } catch (e) {
        if (hit) return { ...hit, stale: true };
        throw e;
      } finally { inflight.delete(key); }
    })();
    inflight.set(key, p);
    return p;
  }
  async function getRange(ds, from, to, force) {
    const days = dayList(from, to);
    return Promise.all(days.map(d => getDay(ds, d, force).then(r => ({ d, ...r }))));
  }

  // ------------------------------------------------------------ masters
  const masters = new Map();
  const MASTER = {
    customers: { ttl: 30 * 60e3, load: () => getAll(q(`${ROOT}BusinessPartners?$select=CardCode,CardName,SalesPersonCode,GroupCode,CreditLimit,CurrentAccountBalance,OpenOrdersBalance,OpenDeliveryNotesBalance,Frozen,Valid&$filter=CardType eq 'cCustomer'`)) },
    reps: { ttl: 6 * 3600e3, load: () => getAll(q(`${ROOT}SalesPersons?$select=SalesEmployeeCode,SalesEmployeeName,Active`)) },
    itemGroups: { ttl: 6 * 3600e3, load: () => getAll(q(`${ROOT}ItemGroups?$select=Number,GroupName`)) },
    bpGroups: { ttl: 6 * 3600e3, load: () => getAll(q(`${ROOT}BusinessPartnerGroups?$select=Code,Name`)) },
    openInvoices: { ttl: 30 * 60e3, load: () => getAll(q(`${ROOT}Invoices?$select=DocEntry,DocNum,CardCode,SalesPersonCode,DocTotal,PaidToDate,DocDate,DocDueDate,BPL_IDAssignedToInvoice&$filter=DocumentStatus eq 'bost_Open'`)) },
    creditCheck: { ttl: 60 * 60e3, load: () => getAll(q(`${ROOT}Credit_Check?$select=Code,U_C_Status,C_CHECK_LCollection`)) },
    brands: { ttl: 6 * 3600e3, load: () => getAll(q(`${ROOT}IM_BrandCode?$select=Code,Name`)) },
    grades: { ttl: 6 * 3600e3, load: () => getAll(q(`${ROOT}CUSTOMER_GRADES?$select=Code,Name,U_PayTerm,U_Prd_DiscPct,U_Elgbl_Prd`)) },
    warehouses: { ttl: 6 * 3600e3, load: () => getAll(q(`${ROOT}Warehouses?$select=WarehouseCode,WarehouseName,BusinessPlaceID,Inactive`)) },
    stock3: { ttl: 60 * 60e3, load: () => getAll(q(`${ROOT}Items?$select=ItemCode,ItemName,QuantityOnStock,QuantityOrderedByCustomers,QuantityOrderedFromVendors,U_ItemsBrandCode,U_SalesGroup,U_PartClassification,U_CategoryCode&$filter=QuantityOnStock gt 0`)) },
  };
  async function master(name, force) {
    const m = masters.get(name);
    const f = path.join(cfg.cacheDir, 'master', name + '.json');
    let hit = m || (fs.existsSync(f) ? (() => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } })() : null);
    if (hit && !force && Date.now() - hit.fetchedAt < MASTER[name].ttl) { masters.set(name, hit); return hit.rows; }
    if (hit && hit.p) return hit.p;
    const p = MASTER[name].load().then(rows => {
      const e = { fetchedAt: Date.now(), rows };
      masters.set(name, e);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(e));
      return rows;
    }, err => { if (hit && hit.rows) { masters.set(name, hit); return hit.rows; } masters.delete(name); throw err; });
    masters.set(name, { ...(hit || {}), fetchedAt: 0, p });
    return p;
  }
  const mapBy = (rows, k) => new Map(rows.map(r => [String(r[k]), r]));

  // ------------------------------------------------------------ helpers
  function prevRange(from, to) {
    const n = daysBetween(from, to) + 1;
    const pTo = isoDay(new Date(Date.parse(from) - 86400000));
    const pFrom = isoDay(new Date(Date.parse(pTo) - (n - 1) * 86400000));
    return { from: pFrom, to: pTo };
  }
  // rep and bpl may be comma-separated lists (a user can be limited to several reps or both companies)
  function filters(qs, custMap) {
    const reps = (qs.get('rep') || '').split(',').filter(Boolean), bpls = (qs.get('bpl') || '').split(',').filter(Boolean);
    const cust = (qs.get('cust') || '').trim().toLowerCase();
    const repOk = slp => !reps.length || reps.includes(String(slp));
    return {
      rep: reps.join(','), bpl: bpls.join(','), reps, bpls, cust, repOk,
      ok(slp, card, b, skipRep) {
        if (!skipRep && !repOk(slp)) return false;
        if (bpls.length && !bpls.includes(String(b))) return false;
        if (cust) {
          const c = String(card || '').toLowerCase();
          if (c !== cust && !`${c} ${((custMap.get(String(card)) || {}).CardName || '').toLowerCase()}`.includes(cust)) return false;
        }
        return true;
      },
    };
  }
  class Agg {
    constructor() { this.m = new Map(); }
    add(key, f) { let r = this.m.get(key); if (!r) { r = { key, qty: 0, net: 0, gp: 0, prevNet: 0, prevGp: 0, docs: new Set(), custs: new Set() }; this.m.set(key, r); } f(r); }
    rows(limit, nameFn, extra) {
      return [...this.m.values()].map(r => ({
        key: r.key, name: nameFn ? nameFn(r.key) : r.key, qty: r.qty, net: r.net, gp: r.gp, prevNet: r.prevNet, prevGp: r.prevGp,
        invoices: r.docs.size, customers: r.custs.size, ...(extra ? extra(r) : {}),
      })).sort((a, b) => b.net - a.net).slice(0, limit || 1e9);
    }
  }

  // ------------------------------------------------------------ /sl/sales
  async function sales(qs, force) {
    const { from, to } = range(qs);
    const prev = qs.get('compare') === '0' ? null : prevRange(from, to);
    const [cur, prv, custRows, repRows, grpRows, stockRows, brandRows] = await Promise.all([
      loadSalesRange(from, to, force), prev ? loadSalesRange(prev.from, prev.to, false) : { inv: [], cn: [], heads: [] },
      master('customers'), master('reps'), master('itemGroups'), master('stock3').catch(() => []), master('brands').catch(() => []),
    ]);
    const custMap = mapBy(custRows, 'CardCode'), repMap = mapBy(repRows, 'SalesEmployeeCode'), grpMap = mapBy(grpRows, 'Number'), stockMap = mapBy(stockRows, 'ItemCode'), brandMap = mapBy(brandRows, 'Code');
    const F = filters(qs, custMap);
    const names = {};
    const dims = { brand: new Agg(), category: new Agg(), group: new Agg(), salesGroup: new Agg(), partClass: new Agg(), item: new Agg(), warehouse: new Agg(), rep: new Agg(), customer: new Agg(), company: new Agg() };
    const T = () => ({ invNet: 0, invGp: 0, retNet: 0, retGp: 0, discNotes: 0, otherNotes: 0, qty: 0, invoices: new Set(), customers: new Set(), items: new Set(), lines: 0 });
    const tot = { cur: T(), prev: T() };
    const daily = new Map(dayList(from, to).map(d => [d, { d, net: 0, gp: 0, invoices: new Set() }]));

    for (const [period, data] of [['cur', cur], ['prev', prv]]) {
      const t = tot[period], isCur = period === 'cur';
      for (const day of data.inv) {
        Object.assign(names, day.names || {});
        for (const L of day.lines) {
          const [e, s, c, b, item, qty, net, gp, whs, brand, cat, grp, sg, pc] = L;
          if (!F.ok(s, c, b)) continue;
          t.invNet += net; t.invGp += gp; t.qty += qty; t.lines++; t.invoices.add(e); t.customers.add(c); t.items.add(item);
          const add = r => { if (isCur) { r.qty += qty; r.net += net; r.gp += gp; r.docs.add(e); r.custs.add(c); } else { r.prevNet += net; r.prevGp += gp; } };
          dims.brand.add(brand, add); dims.category.add(cat, add); dims.group.add(String(grp), add); dims.item.add(item, add); dims.salesGroup.add(sg, add); dims.partClass.add(pc, add);
          dims.warehouse.add(whs, add); dims.rep.add(String(s), add); dims.customer.add(c, add); dims.company.add(String(b), add);
          if (isCur) { const dd = daily.get(day.d); if (dd) { dd.net += net; dd.gp += gp; dd.invoices.add(e); } }
        }
      }
      for (const day of data.cn) {
        Object.assign(names, day.names || {});
        for (const L of day.lines) {
          const [e, s, c, b, item, qty, net, gp, whs, brand, cat, grp, sg, pc] = L;
          if (!F.ok(s, c, b)) continue;
          t.retNet += net; t.retGp += gp;
          const sub = r => { if (isCur) { r.qty -= qty; r.net -= net; r.gp -= gp; r.returns = (r.returns || 0) + net; } else { r.prevNet -= net; r.prevGp -= gp; } };
          dims.brand.add(brand, sub); dims.category.add(cat, sub); dims.group.add(String(grp), sub); dims.item.add(item, sub); dims.salesGroup.add(sg, sub); dims.partClass.add(pc, sub);
          dims.warehouse.add(whs, sub); dims.rep.add(String(s), sub); dims.customer.add(c, sub); dims.company.add(String(b), sub);
          if (isCur) { const dd = daily.get(day.d); if (dd) { dd.net -= net; dd.gp -= gp; } }
        }
      }
      // credit notes without item lines (period / product discounts and other service notes)
      for (const day of data.heads) {
        for (const h0 of day.rows) {
          if (h0.t !== 'dDocument_Service' || !F.ok(h0.s, h0.c, h0.b)) continue;
          const v = (h0.tot || 0) - (h0.vat || 0);
          if (/disc/i.test(h0.k)) t.discNotes += v; else t.otherNotes += v;
          const sub = r => { if (isCur) { r.net -= v; r.gp -= v; r.notes = (r.notes || 0) + v; } else { r.prevNet -= v; r.prevGp -= v; } };
          dims.rep.add(String(h0.s), sub); dims.customer.add(h0.c, sub); dims.company.add(String(h0.b), sub);
          if (isCur) { const dd = daily.get(day.d); if (dd) { dd.net -= v; dd.gp -= v; } }
        }
      }
    }
    const fin = t => {
      const net = t.invNet - t.retNet - t.discNotes - t.otherNotes;
      const gp = t.invGp - t.retGp - t.discNotes - t.otherNotes;
      return { invNet: t.invNet, invGp: t.invGp, retNet: t.retNet, retGp: t.retGp, discNotes: t.discNotes, otherNotes: t.otherNotes, net, gp, margin: net ? (gp / net) * 100 : null,
        qty: t.qty, lines: t.lines, invoices: t.invoices.size, customers: t.customers.size, items: t.items.size };
    };
    const days = daysBetween(from, to) + 1;
    const repName = k => (repMap.get(k) || {}).SalesEmployeeName || 'Rep ' + k;
    const custName = k => (custMap.get(k) || {}).CardName || k;
    return {
      from, to, prev, filters: { rep: F.rep, bpl: F.bpl, cust: F.cust }, days,
      totals: fin(tot.cur), prevTotals: prev ? fin(tot.prev) : null,
      daily: [...daily.values()].map(d => ({ d: d.d, net: d.net, gp: d.gp, invoices: d.invoices.size })),
      dims: {
        brand: dims.brand.rows(500, k => { const n = (brandMap.get(k) || {}).Name; return n && n !== k ? `${k} – ${n}` : k; }),
        salesGroup: dims.salesGroup.rows(100),
        partClass: dims.partClass.rows(100),
        category: dims.category.rows(500),
        group: dims.group.rows(1000, k => (grpMap.get(k) || {}).GroupName || 'Group ' + k),
        warehouse: dims.warehouse.rows(500),
        company: dims.company.rows(20, k => ({ 4: 'Anura Trading Lanka', 5: 'Anura Lubricants' }[k] || 'Branch ' + k)),
        rep: dims.rep.rows(500, repName),
        customer: dims.customer.rows(1500, custName, r => { const c = custMap.get(r.key) || {}; return { balance: c.CurrentAccountBalance || 0, creditLimit: c.CreditLimit || 0 }; }),
        item: dims.item.rows(1500, k => names[k] || k, r => {
          const s = stockMap.get(r.key) || {};
          const perDay = r.qty / days, onHand = s.QuantityOnStock || 0;
          return { onHand, committed: s.QuantityOrderedByCustomers || 0, onOrder: s.QuantityOrderedFromVendors || 0, coverDays: perDay > 0 ? onHand / perDay : null };
        }),
      },
      fetchedAt: Math.min(...[...cur.inv, ...cur.cn].map(d => d.fetchedAt)),
      stale: [...cur.inv, ...cur.cn, ...cur.heads].filter(d => d.stale).map(d => d.d),
    };
  }
  async function loadSalesRange(from, to, force) {
    const [inv, cn, heads] = await Promise.all([getRange('invL2', from, to, force), getRange('cnL2', from, to, force), getRange('cnHeads', from, to, force)]);
    return { inv, cn, heads };
  }

  // ------------------------------------------------------------ /sl/collections
  async function collections(qs, force) {
    const { from, to } = range(qs);
    const prev = qs.get('compare') === '0' ? null : prevRange(from, to);
    const none = Promise.resolve([]);
    const [cur, prv, curAlloc, prvAlloc, custRows, repRows, rtnCur, rtnPrev] = await Promise.all([
      getRange('pay2', from, to, force), prev ? getRange('pay2', prev.from, prev.to, false) : none,
      getRange('payAlloc', from, to, force), prev ? getRange('payAlloc', prev.from, prev.to, false) : none, master('customers'), master('reps'),
      getRange('rtnChq', from, to, force), prev ? getRange('rtnChq', prev.from, prev.to, false) : none]);
    const custMap = mapBy(custRows, 'CardCode'), repMap = mapBy(repRows, 'SalesEmployeeCode');
    const F = filters(qs, custMap);
    // customers rarely carry a rep in this company, so a payment belongs to the reps of the invoices it settled;
    // whatever is not applied to an invoice is "on account"
    const alloc = new Map();
    for (const day of [...curAlloc, ...prvAlloc]) for (const [e, amt, slp] of day.rows) {
      const m = alloc.get(e) || new Map(); m.set(String(slp), (m.get(String(slp)) || 0) + amt); alloc.set(e, m);
    }
    const ON_ACC = 'on-account';
    const splits = (p, total) => {
      const m = alloc.get(p.e), out = [];
      let applied = 0;
      if (m) for (const [rep, amt] of m) { out.push([rep, amt]); applied += amt; }
      // a payment that also settles credit notes applies more to invoices than it collects: scale back to the cash received
      if (applied > total && applied > 0) for (const o of out) o[1] *= total / applied;
      else if (total - applied > 0.5) out.push([ON_ACC, total - applied]);
      return out.sort((a, b) => b[1] - a[1]);
    };
    const T = () => ({ total: 0, count: 0, cash: 0, trf: 0, chq: 0, card: 0, boe: 0, pdc: 0, cdc: 0, customers: new Set() });
    const t = T(), pt = T();
    const daily = new Map(dayList(from, to).map(d => [d, { d, cash: 0, trf: 0, chq: 0, card: 0 }]));
    const byRep = new Map(), byCust = new Map(), byBpl = new Map(), cheques = [];
    const bump = (m, k, name, v) => { const r = m.get(k) || { key: k, name, total: 0, count: 0, chq: 0 }; r.total += v.total; r.count++; r.chq += v.chq; m.set(k, r); };
    for (const [data, tt, isCur] of [[cur, t, true], [prv, pt, false]]) {
      for (const day of data) for (const p of day.rows) {
        const gross = p.cash + p.trf + p.chq + p.card + p.boe;
        const parts = splits(p, gross);
        // with a rep filter only the part applied to that rep's invoices counts
        const share = F.rep ? parts.filter(([r]) => F.repOk(r)).reduce((a, [, v]) => a + v, 0) / (gross || 1) : 1;
        if (!share || !F.ok(null, p.c, p.b, true)) continue;
        const total = gross * share, rep = parts.length ? parts[0][0] : ON_ACC;
        if (p.ct === 'PDC') tt.pdc += p.chq * share; else if (p.chq) tt.cdc += p.chq * share;
        tt.total += total; tt.count++; tt.cash += p.cash * share; tt.trf += p.trf * share; tt.chq += p.chq * share; tt.card += p.card * share; tt.boe += p.boe * share; tt.customers.add(p.c);
        if (!isCur) continue;
        const dd = daily.get(day.d); if (dd) { dd.cash += p.cash * share; dd.trf += p.trf * share; dd.chq += p.chq * share; dd.card += (p.card + p.boe) * share; }
        for (const [r, v] of parts) {
          if (F.rep && !F.repOk(r)) continue;
          const nm = r === ON_ACC ? 'Not applied to an invoice (on account)' : (repMap.get(r) || {}).SalesEmployeeName || (r === '-1' ? 'No rep on invoice' : 'Rep ' + r);
          const rr = byRep.get(r) || { key: r, name: nm, total: 0, count: 0, chq: 0 };
          rr.total += v; rr.count++; rr.chq += gross ? p.chq * (v / gross) : 0; byRep.set(r, rr);
        }
        bump(byCust, p.c, p.cn, { total, chq: p.chq * share });
        bump(byBpl, String(p.b), String(p.b), { total, chq: p.chq * share });
        if (share === 1) for (const c of p.cheques) cheques.push({ ...c, payment: p.n, received: day.d, card: p.c, cardName: p.cn, rep, repName: rep === ON_ACC ? 'On account' : (repMap.get(rep) || {}).SalesEmployeeName || '' });
      }
    }
    const fin = x => ({ total: x.total, count: x.count, cash: x.cash, trf: x.trf, chq: x.chq, card: x.card, boe: x.boe, pdc: x.pdc, cdc: x.cdc, customers: x.customers.size });
    // returned / stopped cheques carry no rep, so they follow the customer and company filters only
    const rtn = data => data.flatMap(day => day.rows.map(r => ({ ...r, received: day.d }))).filter(r => F.ok('', r.c, r.b));
    const returned = F.rep ? [] : rtn(rtnCur), returnedPrev = F.rep ? [] : rtn(rtnPrev);
    const custRowsOut = [...byCust.values()].sort((a, b) => b.total - a.total).slice(0, 1500).map(r => {
      const c = custMap.get(String(r.key)) || {}; return { ...r, balance: c.CurrentAccountBalance || 0 };
    });
    return {
      from, to, prev, today: todayLocal(), totals: fin(t), prevTotals: prev ? fin(pt) : null,
      returned, returnedPrevTotal: prev ? returnedPrev.reduce((a, r) => a + r.amt, 0) : null, returnedNote: F.rep ? 'Returned cheques are not linked to a rep; clear the rep filter to see them.' : '',
      daily: [...daily.values()],
      byRep: [...byRep.values()].sort((a, b) => b.total - a.total),
      byCustomer: custRowsOut,
      byCompany: [...byBpl.values()].map(r => ({ ...r, name: { 4: 'Anura Trading Lanka', 5: 'Anura Lubricants' }[r.key] || 'Branch ' + r.key })),
      cheques: cheques.sort((a, b) => a.due.localeCompare(b.due)),
      stale: cur.filter(d => d.stale).map(d => d.d),
    };
  }

  // ------------------------------------------------------------ /sl/credit
  async function credit(qs, force) {
    const [custRows, repRows, grpRows, openInv, ccRows, gradeRows] = await Promise.all([master('customers', force), master('reps'), master('bpGroups').catch(() => []), master('openInvoices', force), master('creditCheck', force).catch(() => []), master('grades').catch(() => [])]);
    // Anura keeps the real credit limit and grade per company in the Credit_Check object, not on the business partner
    const cc = new Map();
    for (const r of ccRows) {
      const per = {};
      for (const l of r.C_CHECK_LCollection || []) per[String(l.U_CompanyCode)] = { limit: l.U_C_Limit || 0, grade: l.U_Grade || '' };
      cc.set(r.Code, { status: r.U_C_Status, per });
    }
    const gradeMap = mapBy(gradeRows, 'Code');
    const repMap = mapBy(repRows, 'SalesEmployeeCode'), grpMap = mapBy(grpRows, 'Code'), custMap = mapBy(custRows, 'CardCode');
    const F = filters(qs, custMap);
    const today = todayLocal();
    const repName = r => (repMap.get(String(r)) || {}).SalesEmployeeName || (String(r) === '-1' ? 'No rep' : 'Rep ' + r);
    const BUCKETS = ['Not due', '1–30 days', '31–60 days', '61–90 days', '91–120 days', 'Over 120 days'];
    const bucketOf = od => od <= 0 ? 0 : od <= 30 ? 1 : od <= 60 ? 2 : od <= 90 ? 3 : od <= 120 ? 4 : 5;
    // open invoices give the receivable by rep and by how far past the due date it is
    const per = new Map(), repAgg = new Map(), buckets = BUCKETS.map(label => ({ label, value: 0, count: 0 }));
    for (const i of openInv) {
      const open = (i.DocTotal || 0) - (i.PaidToDate || 0);
      if (open <= 0.005 || !F.ok(i.SalesPersonCode, i.CardCode, i.BPL_IDAssignedToInvoice)) continue;
      const due = (i.DocDueDate || i.DocDate || '').slice(0, 10);
      const od = daysBetween(due, today);
      const b = bucketOf(od);
      buckets[b].value += open; buckets[b].count++;
      const c = per.get(i.CardCode) || { open: 0, overdue: 0, over90: 0, invoices: 0, oldestDue: null, reps: new Map(), b: BUCKETS.map(() => 0), byCo: {} };
      c.open += open; c.invoices++; c.b[b] += open;
      const co = String(i.BPL_IDAssignedToInvoice); c.byCo[co] = (c.byCo[co] || 0) + open;
      if (od > 0) { c.overdue += open; if (!c.oldestDue || due < c.oldestDue) c.oldestDue = due; }
      if (od > 90) c.over90 += open;
      c.reps.set(String(i.SalesPersonCode), (c.reps.get(String(i.SalesPersonCode)) || 0) + open);
      per.set(i.CardCode, c);
      const k = String(i.SalesPersonCode);
      const r = repAgg.get(k) || { key: k, name: repName(k), open: 0, overdue: 0, over90: 0, invoices: 0, customers: new Set() };
      r.open += open; r.invoices++; r.customers.add(i.CardCode); if (od > 0) r.overdue += open; if (od > 90) r.over90 += open;
      repAgg.set(k, r);
    }
    const rows = [];
    for (const c of custRows) {
      const o = per.get(c.CardCode);
      if (F.rep || F.bpl) { if (!o) continue; }                       // rep / company come from the open invoices
      else if (!F.ok('', c.CardCode, '')) continue;
      if (!o && !c.CurrentAccountBalance && !c.OpenOrdersBalance && !c.OpenDeliveryNotesBalance) continue;
      const bal = c.CurrentAccountBalance || 0;
      const chk = cc.get(c.CardCode) || { per: {} };
      const atl = chk.per['4'] || {}, al = chk.per['5'] || {};
      const openAtl = o ? o.byCo['4'] || 0 : 0, openAl = o ? o.byCo['5'] || 0 : 0;
      // with a company filter only that company's limit counts
      const lim = F.bpls.length ? F.bpls.reduce((a, b) => a + ((chk.per[b] || {}).limit || 0), 0) : (atl.limit || 0) + (al.limit || 0);
      const exposure = bal + (c.OpenOrdersBalance || 0) + (c.OpenDeliveryNotesBalance || 0);
      const useAtl = atl.limit ? (openAtl / atl.limit) * 100 : null, useAl = al.limit ? (openAl / al.limit) * 100 : null;
      const overBy = Math.max(0, atl.limit ? openAtl - atl.limit : 0) + Math.max(0, al.limit ? openAl - al.limit : 0);
      const mainRep = o && o.reps.size ? [...o.reps.entries()].sort((a, b) => b[1] - a[1])[0][0] : String(c.SalesPersonCode);
      rows.push({
        cardCode: c.CardCode, cardName: c.CardName, rep: mainRep, repName: repName(mainRep),
        group: (grpMap.get(String(c.GroupCode)) || {}).Name || String(c.GroupCode),
        balance: bal, openInvoices: o ? o.open : 0, overdue: o ? o.overdue : 0, over90: o ? o.over90 : 0, invoices: o ? o.invoices : 0,
        oldestDue: o ? o.oldestDue : null, daysOverdue: o && o.oldestDue ? daysBetween(o.oldestDue, today) : 0,
        aging: o ? o.b : BUCKETS.map(() => 0),
        creditLimit: lim, limitAtl: atl.limit || 0, limitAl: al.limit || 0, gradeAtl: atl.grade || '', gradeAl: al.grade || '',
        termAtl: (gradeMap.get(atl.grade) || {}).Name || '', termAl: (gradeMap.get(al.grade) || {}).Name || '',
        openAtl, openAl, useAtl, useAl, utilisation: [useAtl, useAl].filter(v => v !== null).reduce((a, v) => Math.max(a, v), -1),
        overBy, checkStatus: chk.status || '',
        openOrders: c.OpenOrdersBalance || 0, openDeliveries: c.OpenDeliveryNotesBalance || 0, exposure,
        frozen: c.Frozen === 'tYES',
      });
    }
    return {
      today, buckets, rows: rows.map(r => ({ ...r, utilisation: r.utilisation < 0 ? null : r.utilisation })), filtered: !!(F.rep || F.bpl || F.cust),
      grades: gradeRows.map(g => ({ code: g.Code, term: g.Name, periodDiscount: g.U_Prd_DiscPct, eligibleDays: g.U_Elgbl_Prd })),
      byRep: [...repAgg.values()].map(r => ({ ...r, customers: r.customers.size })).sort((a, b) => b.open - a.open),
      fetchedAt: Math.min((masters.get('customers') || {}).fetchedAt || Date.now(), (masters.get('openInvoices') || {}).fetchedAt || Date.now()),
    };
  }

  // ------------------------------------------------------------ /sl/item-grades
  // ABC grade of each item by sales value, and item sales by the grade of the customer who bought them
  async function itemGrades(qs, force) {
    const { from, to } = range(qs);
    const [data, custRows, ccRows, gradeRows, stockRows, brandRows, grpRows] = await Promise.all([
      loadSalesRange(from, to, force), master('customers'), master('creditCheck').catch(() => []), master('grades').catch(() => []),
      master('stock3').catch(() => []), master('brands').catch(() => []), master('itemGroups').catch(() => [])]);
    // category codes (F10, A53 ...) are described by the item group named "F10 - MITSUBA BRAND FAN BELT"
    const catDesc = new Map();
    for (const g of grpRows) { const m = /^\s*([^\s-]+)\s*-\s*(.+)$/.exec(g.GroupName || ''); if (m && !catDesc.has(m[1])) catDesc.set(m[1], m[2].trim()); }
    const catName = k => (catDesc.has(k) ? `${k} – ${catDesc.get(k)}` : k);
    const custMap = mapBy(custRows, 'CardCode'), brandMap = mapBy(brandRows, 'Code'), stockMap = mapBy(stockRows, 'ItemCode');
    const F = filters(qs, custMap);
    const NO_GRADE = 'No grade';
    const ccGrade = new Map();
    for (const r of ccRows) {
      const per = {};
      for (const l of r.C_CHECK_LCollection || []) if (l.U_Grade) per[String(l.U_CompanyCode)] = l.U_Grade;
      ccGrade.set(r.Code, per);
    }
    const gradeOf = (card, bpl) => (ccGrade.get(card) || {})[String(bpl)] || NO_GRADE;
    const brandName = k => { const n = (brandMap.get(k) || {}).Name; return n && n !== k ? `${k} – ${n}` : k; };

    const names = {}, items = new Map(), G = new Map();
    const levels = { brand: new Map(), category: new Map(), salesGroup: new Map(), partClass: new Map() };
    const bump = (m, key, name, grade, qty, net, gp) => {
      const r = m.get(key) || { key, name, qty: 0, net: 0, gp: 0, g: {} };
      r.qty += qty; r.net += net; r.gp += gp; r.g[grade] = (r.g[grade] || 0) + net; m.set(key, r);
    };
    for (const [list, sign] of [[data.inv, 1], [data.cn, -1]]) {
      for (const day of list) {
        Object.assign(names, day.names || {});
        for (const L of day.lines) {
          const [e, s, c, b, item, qty0, net0, gp0, , brand, cat0, , sg, pc] = L;
          const cat = cat0 || '(no category)';
          if (!F.ok(s, c, b)) continue;
          const qty = qty0 * sign, net = net0 * sign, gp = gp0 * sign, grade = gradeOf(c, b);
          const it = items.get(item) || { key: item, brand, cat, sg: sg || '(not set)', pc: pc || '(not set)', qty: 0, net: 0, gp: 0, soldQty: 0, soldCost: 0, g: {}, custs: new Set() };
          it.qty += qty; it.net += net; it.gp += gp; it.g[grade] = (it.g[grade] || 0) + net; it.custs.add(c);
          if (sign > 0) { it.soldQty += qty0; it.soldCost += net0 - gp0; }
          items.set(item, it);
          const gg = G.get(grade) || { grade, qty: 0, net: 0, gp: 0, invoices: new Set(), customers: new Set(), items: new Set() };
          gg.qty += qty; gg.net += net; gg.gp += gp; gg.customers.add(c); gg.items.add(item); if (sign > 0) gg.invoices.add(e);
          G.set(grade, gg);
          bump(levels.brand, brand, brandName(brand), grade, qty, net, gp);
          bump(levels.category, cat, catName(cat), grade, qty, net, gp);
          bump(levels.salesGroup, sg || '(not set)', sg || '(not set)', grade, qty, net, gp);
          bump(levels.partClass, pc || '(not set)', pc || '(not set)', grade, qty, net, gp);
        }
      }
    }

    // ABC: A = items making the first 80% of net sales, B = next 15%, C = the rest (incl. items fully returned)
    const days = daysBetween(from, to) + 1;
    const sold = [...items.values()].sort((a, b) => b.net - a.net);
    const totalNet = sold.reduce((a, r) => a + Math.max(0, r.net), 0) || 1;
    let cum = 0;
    const rows = sold.map(r => {
      const before = cum / totalNet;
      if (r.net > 0) cum += r.net;
      const abc = r.net <= 0 ? 'C' : before < 0.8 ? 'A' : before < 0.95 ? 'B' : 'C';
      const st = stockMap.get(r.key) || {};
      const onHand = st.QuantityOnStock || 0, unitCost = r.soldQty > 0 ? r.soldCost / r.soldQty : null;
      const top = Object.entries(r.g).sort((a, b) => b[1] - a[1])[0];
      return {
        key: r.key, name: names[r.key] || st.ItemName || r.key, brand: r.brand, brandName: brandName(r.brand), cat: r.cat, catName: catName(r.cat), sg: r.sg, pc: r.pc, abc,
        qty: r.qty, net: r.net, gp: r.gp, cumShare: (cum / totalNet) * 100, customers: r.custs.size,
        onHand, committed: st.QuantityOrderedByCustomers || 0, onOrder: st.QuantityOrderedFromVendors || 0,
        coverDays: r.qty > 0 ? onHand / (r.qty / days) : null, unitCost, stockValueEst: unitCost !== null ? onHand * unitCost : null,
        topGrade: top ? top[0] : '', g: r.g,
      };
    });
    const noSales = stockRows.filter(s => !items.has(s.ItemCode) && (s.QuantityOnStock || 0) > 0).map(s => ({
      key: s.ItemCode, name: s.ItemName, brand: s.U_ItemsBrandCode || '(no brand)', brandName: brandName(s.U_ItemsBrandCode || '(no brand)'),
      cat: s.U_CategoryCode || '(no category)', catName: catName(s.U_CategoryCode || '(no category)'),
      sg: (s.U_SalesGroup || '(not set)').replace(/^Sales Group - /, ''), pc: s.U_PartClassification || '(not set)', abc: 'No sales',
      onHand: s.QuantityOnStock || 0, committed: s.QuantityOrderedByCustomers || 0, onOrder: s.QuantityOrderedFromVendors || 0,
    }));
    const abcSummary = ['A', 'B', 'C'].map(k => {
      const g = rows.filter(r => r.abc === k);
      const withCost = g.filter(r => r.stockValueEst !== null);
      return { abc: k, items: g.length, net: g.reduce((a, r) => a + r.net, 0), gp: g.reduce((a, r) => a + r.gp, 0), qty: g.reduce((a, r) => a + r.qty, 0),
        onHand: g.reduce((a, r) => a + r.onHand, 0), stockValueEst: withCost.reduce((a, r) => a + r.stockValueEst, 0) };
    });
    abcSummary.push({ abc: 'No sales', items: noSales.length, net: 0, gp: 0, qty: 0, onHand: noSales.reduce((a, r) => a + r.onHand, 0), stockValueEst: null });

    const byCat = new Map();
    const catRow = k => { if (!byCat.has(k)) byCat.set(k, { key: k, name: catName(k), net: 0, gp: 0, qty: 0, onHand: 0, A: 0, B: 0, C: 0, netA: 0, netB: 0, netC: 0, noSales: 0, noSalesUnits: 0 }); return byCat.get(k); };
    for (const r of rows) { const c = catRow(r.cat); c.net += r.net; c.gp += r.gp; c.qty += r.qty; c.onHand += r.onHand; c[r.abc]++; c['net' + r.abc] += r.net; }
    for (const r of noSales) { const c = catRow(r.cat); c.noSales++; c.noSalesUnits += r.onHand; c.onHand += r.onHand; }
    const gradeDefs = new Map(gradeRows.map(g => [g.Code, g]));
    const gradeList = [...G.values()].map(g => ({
      grade: g.grade, term: (gradeDefs.get(g.grade) || {}).Name || '', periodDiscount: (gradeDefs.get(g.grade) || {}).U_Prd_DiscPct ?? null,
      qty: g.qty, net: g.net, gp: g.gp, invoices: g.invoices.size, customers: g.customers.size, items: g.items.size,
    })).sort((a, b) => (a.grade === NO_GRADE) - (b.grade === NO_GRADE) || a.grade.localeCompare(b.grade));
    const lvl = m => [...m.values()].sort((a, b) => b.net - a.net);
    return {
      from, to, days, gradeCols: gradeList.map(g => g.grade), grades: gradeList, abcSummary,
      byCategory: [...byCat.values()].sort((a, b) => b.net - a.net),
      matrix: { brand: lvl(levels.brand), category: lvl(levels.category), salesGroup: lvl(levels.salesGroup), partClass: lvl(levels.partClass),
        item: rows.slice(0, 500).map(r => ({ key: r.key, name: r.name, qty: r.qty, net: r.net, gp: r.gp, g: r.g })) },
      items: rows.map(({ g, ...r }) => r),
      noSales: noSales.sort((a, b) => b.onHand - a.onHand).slice(0, 3000), noSalesTotal: noSales.length,
      stale: [...data.inv, ...data.cn].filter(d => d.stale).map(d => d.d),
      fetchedAt: Math.min(...[...data.inv, ...data.cn].map(d => d.fetchedAt)),
    };
  }

  function range(qs) {
    const from = qs.get('from'), to = qs.get('to');
    if (!validDate(from) || !validDate(to) || from > to) throw Object.assign(new Error('from/to must be YYYY-MM-DD and from <= to'), { status: 400 });
    if (daysBetween(from, to) + 1 > cfg.maxRangeDays) throw Object.assign(new Error(`Range limited to ${cfg.maxRangeDays} days`), { status: 400 });
    return { from, to };
  }

  // ------------------------------------------------------------ routes
  async function handle(p, qs) {
    const force = qs.get('refresh') === '1';
    if (p === '/sl/warm') {
      // lets the browser fill the cache in small steps and show progress
      const { from, to } = range(qs);
      const ds = (qs.get('ds') || '').split(',').filter(d => DAY[d]);
      const out = await Promise.all(ds.map(d => getRange(d, from, to, force)));
      return { ok: true, days: out.reduce((a, r) => a + r.length, 0) };
    }
    if (p === '/sl/sales') return sales(qs, force);
    if (p === '/sl/collections') return collections(qs, force);
    if (p === '/sl/credit') return credit(qs, force);
    if (p === '/sl/item-grades') return itemGrades(qs, force);
    if (p === '/sl/warehouses') return (await master('warehouses')).map(w => ({ code: w.WarehouseCode, name: w.WarehouseName, company: String(w.BusinessPlaceID), inactive: w.Inactive === 'tYES' }));
    if (p === '/sl/reps') return (await master('reps')).map(r => ({ code: String(r.SalesEmployeeCode), name: r.SalesEmployeeName, active: r.Active === 'tYES' }));
    if (p === '/sl/status') { await login(); return { ok: true, company: cfg.company, active, queued: queue.length }; }
    return null;
  }

  async function warm(days) {
    const to = todayLocal();
    const from = isoDay(new Date(Date.parse(to) - (days - 1) * 86400000));
    for (const m of ['reps', 'itemGroups', 'bpGroups', 'brands', 'grades', 'customers', 'creditCheck', 'openInvoices', 'stock3']) { try { await master(m); } catch (e) { log('SL warm', m, e.message); } }
    for (const ds of Object.keys(DAY)) { try { await getRange(ds, from, to, false); } catch (e) { log('SL warm', ds, e.message); } }
    log(`SL warm-up done ${from}..${to}`);
  }

  return { handle, warm, warehouses: () => master('warehouses') };
};
