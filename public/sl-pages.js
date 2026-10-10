/* SAP analytics pages - data from the SAP Business One Service Layer (see sl.js on the server).
   Uses the helpers defined in app.js (table, hbars, columnChart, stackBar, tile, card, ...). */
'use strict';

// ------------------------------------------------------------ loading
function prevRangeOf(from, to) {
  const n = daysBetween(from, to) + 1;
  const pTo = addDays(from, -1);
  return { from: addDays(pTo, -(n - 1)), to: pTo };
}

// fills the server cache in 3-day steps so the progress bar moves, then asks for the aggregate
async function slWarm(dsList, from, to, force) {
  const chunks = [];
  for (let d = from; d <= to; d = addDays(d, 3)) chunks.push([d, addDays(d, 2) < to ? addDays(d, 2) : to]);
  progress(chunks.length, 0, 'SAP documents');
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const [a, b] = chunks[next++];
      const fresh = force && b >= S.from; // only the selected range is re-read on Refresh
      try { await api(`/sl/warm?ds=${dsList.join(',')}&from=${a}&to=${b}${fresh ? '&refresh=1' : ''}`); }
      finally { progress(0, 1, 'SAP documents'); }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

let slRepsP = null;
function slReps() {
  if (!slRepsP) slRepsP = api('/sl/reps').then(list => { for (const r of list) addRep(r.code, r.name); refreshFilterLists(); return list; }).catch(e => { slRepsP = null; throw e; });
  return slRepsP;
}

// "All dates" has no earlier period to compare with
const slCompare = () => S.preset !== 'all';
function slQuery(extra = '') {
  const p = new URLSearchParams({ from: S.from, to: S.to });
  if (!slCompare()) p.set('compare', '0');
  if (S.rep) p.set('rep', S.rep);
  if (S.cust) p.set('cust', S.cust);
  return p.toString() + extra;
}

function slLoad(path, dsList) {
  const key = `${path}?${slQuery()}`;
  if (!S.force && dataCache.has(key)) return dataCache.get(key);
  const force = S.force;
  const p = (async () => {
    slReps().catch(() => {});
    if (dsList) await slWarm(dsList, slCompare() ? prevRangeOf(S.from, S.to).from : S.from, S.to, force);
    progress(1, 0, 'SAP analytics');
    try { return await api(`${path}?${slQuery(force && !dsList ? '&refresh=1' : '')}`); }
    finally { progress(0, 1); }
  })();
  p.catch(() => dataCache.delete(key));
  dataCache.set(key, p);
  return p;
}

// ------------------------------------------------------------ small helpers
const marginOf = (gp, net) => (net ? (gp / net) * 100 : null);
function delta(cur, prev, { pts = false, invert = false } = {}) {
  if (prev === null || prev === undefined || cur === null || cur === undefined || prev === NO_PREV) return '';
  let d, txt;
  if (pts) { d = cur - prev; txt = `${d >= 0 ? '+' : ''}${d.toFixed(1)} pts`; }
  else { if (!prev) return '<span class="muted">new vs previous period</span>'; d = ((cur - prev) / Math.abs(prev)) * 100; txt = `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`; }
  const good = invert ? d < 0 : d > 0;
  if (Math.abs(d) < 0.05) return '<span class="muted">same as previous period</span>';
  return `<span class="${good ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${txt}</span> <span class="muted">vs previous period</span>`;
}
const growth = r => (r.prevNet ? ((r.net - r.prevNet) / Math.abs(r.prevNet)) * 100 : null);
const growthFmt = v => v === null ? '<span class="muted">new</span>' : `<span class="${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '▲' : '▼'} ${Math.abs(v).toFixed(1)}%</span>`;
const NO_PREV = Symbol('no previous period');
const prevLabel = d => d.prev ? `previous period ${dFull(d.prev.from)} – ${dFull(d.prev.to)}` : '';
// with no comparison every previous figure reads as "no value" so the change markers disappear
const prevOf = d => d.prevTotals || new Proxy({}, { get: () => NO_PREV });
const noCompareCols = (d, cols) => d.prev ? cols : cols.filter(c => c.key !== 'prevNet' && c.key !== 'growth');

// ------------------------------------------------------------ Sales & margin
PAGES['sl-sales'] = {
  title: 'Sales & margin',
  async render(main, alive) {
    main.innerHTML = spinner('Reading invoices and credit notes from SAP for ' + rangeLabel() + ' and the period before');
    const d = await slLoad('/sl/sales', ['invL2', 'cnL2', 'cnHeads']);
    if (!alive()) return;
    const t = d.totals, p = prevOf(d);
    main.innerHTML = `<div class="tiles">
        ${rsTile('Net sales', t.net, delta(t.net, p.net))}
        ${rsTile('Gross profit', t.gp, delta(t.gp, p.gp))}
        ${tile('Gross margin', t.margin === null ? '–' : pct(t.margin), delta(t.margin, p.margin, { pts: true }))}
        ${tile('Invoices', int(t.invoices), delta(t.invoices, p.invoices))}
        ${tile('Customers buying', int(t.customers), delta(t.customers, p.customers))}
        ${tile('Average invoice', t.invoices ? rs(t.invNet / t.invoices) : '–', 'before VAT')}
        ${rsTile('Returns', t.retNet, `${t.invNet ? pct((t.retNet / t.invNet) * 100) : '–'} of invoiced${d.prev ? ' · ' + delta(t.retNet, p.retNet, { invert: true }) : ''}`)}
        ${rsTile('Discount credit notes', t.discNotes, `${t.invNet ? pct((t.discNotes / t.invNet) * 100) : '–'} of invoiced${d.prev ? ' · ' + delta(t.discNotes, p.discNotes, { invert: true }) : ''}`)}
      </div>
      <p class="muted small" style="margin:0">All amounts exclude VAT. Net sales = invoiced item lines − returned item lines − discount and other service credit notes. Gross profit uses SAP's line cost.${d.prev ? ' Compared with the ' + esc(prevLabel(d)) + '.' : ''} Opening-balance service invoices are not included.</p>
      <div class="grid g2">${card('cNet', grainWord() + ' net sales', 'Before VAT')}${card('cMargin', grainWord() + ' gross margin', 'Gross profit ÷ net sales')}</div>
      <div class="grid g2">${card('cCo', 'By company', 'Net sales · margin')}${card('cWaterfall', 'From invoiced to net', esc(rangeLabel()))}</div>
      <section class="card"><div id="slTabs" style="margin-bottom:12px"></div><div id="slTbl"></div></section>`;
    const periods = bucketize(d.daily.map(x => ({ x: x.d, v: { net: x.net, gp: x.gp } })));
    columnChart($('#cNet'), { data: periods.map(x => ({ ...x, v: { v: x.v.net || 0 } })), series: [{ key: 'v', label: 'Net sales', color: 'var(--s1)' }], tipFmt: v => 'Rs ' + money(v) });
    columnChart($('#cMargin'), { data: periods.map(x => ({ ...x, v: { v: x.v.net > 0 ? Math.max(0, (x.v.gp / x.v.net) * 100) : 0 } })), series: [{ key: 'v', label: 'Margin', color: 'var(--s3)' }], fmt: v => Math.round(v) + '%', tipFmt: v => pct(v) });
    hbars($('#cCo'), d.dims.company.map(r => ({ label: r.name, value: r.net, sub: `margin ${pct(marginOf(r.gp, r.net))} · GP Rs ${money(r.gp)}` })));
    const steps = [
      { label: 'Invoiced (item lines)', value: t.invNet, color: 'var(--s1)' },
      { label: 'Returns', value: t.retNet, color: 'var(--serious)' },
      { label: 'Discount credit notes', value: t.discNotes, color: 'var(--warning)' },
      { label: 'Other credit notes', value: t.otherNotes, color: 'var(--neutral)' },
      { label: 'Net sales', value: t.net, color: 'var(--seq-4)' },
      { label: 'Gross profit', value: t.gp, color: 'var(--s3)' },
    ];
    hbars($('#cWaterfall'), steps, { max: Math.max(t.invNet, 1), valueTip: v => 'Rs ' + money(v) });

    const repCols = [
      { key: 'name', label: 'Rep' },
      { key: 'net', label: 'Net sales (Rs)', num: true, fmt: money },
      { key: 'gp', label: 'Gross profit (Rs)', num: true, fmt: money },
      { key: 'margin', label: 'Margin', num: true, val: r => marginOf(r.gp, r.net), fmt: pct },
      { key: 'share', label: 'Share', num: true, val: r => (t.net ? (r.net / t.net) * 100 : 0), fmt: pct },
      { key: 'prevNet', label: 'Previous (Rs)', num: true, fmt: money },
      { key: 'growth', label: 'Growth', num: true, val: growth, fmt: growthFmt, csv: r => { const g = growth(r); return g === null ? '' : g.toFixed(1); } },
      { key: 'invoices', label: 'Invoices', num: true },
      { key: 'customers', label: 'Customers', num: true },
      { key: 'returns', label: 'Returns (Rs)', num: true, fmt: v => v ? money(v) : '' },
      { key: 'notes', label: 'Discount notes (Rs)', num: true, fmt: v => v ? money(v) : '' },
    ];
    const custCols = [
      { key: 'key', label: 'Code' },
      { key: 'name', label: 'Customer', fmt: (v, r) => openLink('customer', r.key, v) },
      ...repCols.slice(1, 8),
      { key: 'balance', label: 'Account balance (Rs)', num: true, fmt: money },
      { key: 'creditLimit', label: 'Credit limit (Rs)', num: true, fmt: v => v ? money(v) : '' },
      ...repCols.slice(9),
    ];
    const foot = r => ({ net: money(sum(r, x => x.net)), gp: money(sum(r, x => x.gp)), margin: pct(marginOf(sum(r, x => x.gp), sum(r, x => x.net))), prevNet: money(sum(r, x => x.prevNet)), invoices: int(sum(r, x => x.invoices)) });
    const holder = $('#slTbl');
    const show = k => k === 'rep'
      ? table(holder, { name: 'net_sales_by_rep', rows: d.dims.rep, cols: noCompareCols(d, repCols), sort: { key: 'net', dir: 'desc' }, footer: foot, onRow: r => { S.rep = r.key; store.set('rep', S.rep); $('#fRep').value = S.rep; route(); } })
      : table(holder, { name: 'net_sales_by_customer', rows: d.dims.customer, cols: noCompareCols(d, custCols), sort: { key: 'net', dir: 'desc' }, footer: foot, onRow: r => openDoc('customer', r.key) });
    tabs($('#slTabs'), [{ key: 'rep', label: 'By sales rep', n: d.dims.rep.length }, { key: 'cust', label: 'By customer', n: d.dims.customer.length }], 'rep', show);
    show('rep');
    slFoot(d);
  },
};

// ------------------------------------------------------------ Products & brands
PAGES['sl-products'] = {
  title: 'Products & brands',
  async render(main, alive, params) {
    main.innerHTML = spinner('Reading invoice lines from SAP for ' + rangeLabel());
    const d = await slLoad('/sl/sales', ['invL2', 'cnL2', 'cnHeads']);
    if (!alive()) return;
    const DIMS = { brand: 'Brand', salesGroup: 'Sales group', partClass: 'Part type', category: 'Category', group: 'Item group', item: 'Item', warehouse: 'Warehouse' };
    let cur = DIMS[params.dim] ? params.dim : 'brand';
    const itemNet = sum(d.dims.brand, r => r.net);
    const low = d.dims.item.filter(r => r.coverDays !== null && r.coverDays < 14 && r.qty > 0).sort((a, b) => b.net - a.net);
    main.innerHTML = `<div class="tiles">
        ${rsTile('Item sales (net of returns)', itemNet, `${int(d.totals.items)} items sold`)}
        ${tile('Brands sold', int(d.dims.brand.filter(r => r.qty > 0).length), `top brand ${esc((d.dims.brand[0] || {}).name || '–')}`)}
        ${tile('Top-brand share', itemNet && d.dims.brand[0] ? pct((d.dims.brand[0].net / itemNet) * 100) : '–', 'of item sales')}
        ${tile('Fast sellers running low', int(low.length), 'under 14 days of stock at current sales rate')}
      </div>
      <p class="muted small" style="margin:0">Before VAT, after returns. Discount credit notes are not tied to items, so they are not deducted here (see Sales &amp; margin). Stock is today's on-hand quantity in SAP.</p>
      <section class="card"><div id="pTabs" style="margin-bottom:12px"></div><div class="grid g2"><div id="pTop"></div><div id="pMargin"></div></div></section>
      <section class="card"><div class="card-head"><h2 id="pTblTitle"></h2><span class="sub">click a column to sort</span></div><div id="pTbl"></div></section>
      ${card('pLow', 'Fast sellers running low', 'Sorted by sales value · days of cover = stock ÷ average daily quantity sold in the range')}`;
    const show = k => {
      cur = k;
      history.replaceState(null, '', `#/sl-products?dim=${k}`);
      const rows = d.dims[k];
      $('#pTop').innerHTML = '<h3 style="margin-bottom:10px">Top 15 by net sales</h3><div id="pTopC"></div>';
      hbars($('#pTopC'), rows.map(r => ({ label: r.name, value: r.net, sub: `margin ${pct(marginOf(r.gp, r.net))} · ${qty(r.qty)} units` })), { limit: 15 });
      const big = rows.filter(r => r.net > 0).slice(0, 15).sort((a, b) => marginOf(b.gp, b.net) - marginOf(a.gp, a.net));
      $('#pMargin').innerHTML = '<h3 style="margin-bottom:10px">Margin of the top 15</h3><div id="pMarC"></div>';
      hbars($('#pMarC'), big.map(r => ({ label: r.name, value: Math.max(0, marginOf(r.gp, r.net)), sub: 'GP Rs ' + money(r.gp) })), { fmt: pct, valueTip: v => pct(v) + ' margin', color: 'var(--s3)', max: 100, limit: 15 });
      $('#pTblTitle').textContent = `Sales by ${DIMS[k].toLowerCase()}`;
      const cols = [
        ...(k === 'item' ? [{ key: 'key', label: 'Item code', fmt: v => openLink('item', v) }] : k === 'group' ? [{ key: 'key', label: 'Group no.' }] : []),
        { key: 'name', label: DIMS[k] },
        { key: 'qty', label: 'Qty', num: true, fmt: qty },
        { key: 'net', label: 'Net sales (Rs)', num: true, fmt: money },
        { key: 'gp', label: 'Gross profit (Rs)', num: true, fmt: money },
        { key: 'margin', label: 'Margin', num: true, val: r => marginOf(r.gp, r.net), fmt: pct },
        { key: 'share', label: 'Share', num: true, val: r => (itemNet ? (r.net / itemNet) * 100 : 0), fmt: pct },
        { key: 'prevNet', label: 'Previous (Rs)', num: true, fmt: money },
        { key: 'growth', label: 'Growth', num: true, val: growth, fmt: growthFmt, csv: r => { const g = growth(r); return g === null ? '' : g.toFixed(1); } },
        { key: 'returns', label: 'Returns (Rs)', num: true, fmt: v => v ? money(v) : '' },
        { key: 'customers', label: 'Customers', num: true },
        ...(k === 'item' ? [
          { key: 'onHand', label: 'In stock', num: true, fmt: qty },
          { key: 'committed', label: 'Committed', num: true, fmt: qty },
          { key: 'onOrder', label: 'On order', num: true, fmt: qty },
          { key: 'coverDays', label: 'Days of cover', num: true, fmt: v => v === null ? '' : v < 14 ? `<b style="color:var(--bad-ink)">${v.toFixed(1)}</b>` : v.toFixed(0) },
        ] : []),
      ];
      table($('#pTbl'), { name: 'sales_by_' + k, rows, cols: noCompareCols(d, cols), sort: { key: 'net', dir: 'desc' }, footer: r => ({ qty: qty(sum(r, x => x.qty)), net: money(sum(r, x => x.net)), gp: money(sum(r, x => x.gp)), margin: pct(marginOf(sum(r, x => x.gp), sum(r, x => x.net))), prevNet: money(sum(r, x => x.prevNet)) }) });
    };
    tabs($('#pTabs'), Object.entries(DIMS).map(([k, l]) => ({ key: k, label: l, n: d.dims[k].length })), cur, show);
    show(cur);
    table($('#pLow'), {
      name: 'fast_sellers_low_stock', rows: low, sort: { key: 'net', dir: 'desc' }, empty: 'No fast seller is below 14 days of cover',
      cols: [
        { key: 'key', label: 'Item code', fmt: v => openLink('item', v) }, { key: 'name', label: 'Item' },
        { key: 'qty', label: 'Sold', num: true, fmt: qty }, { key: 'net', label: 'Net sales (Rs)', num: true, fmt: money },
        { key: 'onHand', label: 'In stock', num: true, fmt: qty }, { key: 'committed', label: 'Committed', num: true, fmt: qty }, { key: 'onOrder', label: 'On order', num: true, fmt: qty },
        { key: 'coverDays', label: 'Days of cover', num: true, fmt: v => `<b style="color:var(--bad-ink)">${v.toFixed(1)}</b>` },
      ],
    });
    slFoot(d);
  },
};

// ------------------------------------------------------------ Collections & cheques
PAGES['sl-collections'] = {
  title: 'Collections & cheques',
  async render(main, alive, params) {
    main.innerHTML = spinner('Reading incoming payments from SAP for ' + rangeLabel());
    const d = await slLoad('/sl/collections', ['pay2', 'payAlloc', 'rtnChq']);
    if (!alive()) return;
    const t = d.totals, p = prevOf(d), today = d.today;
    const cheques = d.cheques.map(c => ({ ...c, days: daysBetween(today, c.due) }));
    const pdc = cheques.filter(c => c.days > 0);
    main.innerHTML = `<div class="tiles">
        ${rsTile('Collected', t.total, delta(t.total, p.total))}
        ${tile('Receipts', int(t.count), `${int(t.customers)} customers paid`)}
        ${rsTile('Cheques', t.chq, `PDC Rs ${compact(t.pdc)} · CDC Rs ${compact(t.cdc)}`)}
        ${rsTile('Bank transfers', t.trf, t.total ? pct((t.trf / t.total) * 100) + ' of collections' : '')}
        ${rsTile('Cash', t.cash, t.total ? pct((t.cash / t.total) * 100) + ' of collections' : '')}
        ${rsTile('Post-dated cheques', sum(pdc, c => c.amt), `${int(pdc.length)} cheques received in range, due after today`)}
        ${rsTile('Returned / stopped cheques', sum(d.returned, r => r.amt), d.returnedNote ? esc(d.returnedNote) : `${int(d.returned.length)} receipts reversed${d.prev ? ' · ' + delta(sum(d.returned, r => r.amt), d.returnedPrevTotal, { invert: true }) : ''}`, { href: '#/sl-collections?tab=rtn' })}
      </div>
      <p class="muted small" style="margin:0">Customer incoming payments in SAP, not cancelled. A payment is credited to the reps of the invoices it settled; amounts not applied to an invoice show as "on account". ${d.prev ? 'Compared with the ' + esc(prevLabel(d)) + '.' : ''}</p>
      <div class="grid g2">${card('cColDay', grainWord() + ' collections by method', '')}${card('cMix', 'Payment method mix', '')}</div>
      <div class="grid g2">${card('cDue', 'When the cheques fall due', `Cheques received in range · as of ${dFull(today)}`)}${card('cColRep', 'Collections by rep', 'Click to filter')}</div>
      <section class="card"><div id="colTabs" style="margin-bottom:12px"></div><div id="colTbl"></div></section>`;
    const M = [{ key: 'chq', label: 'Cheque', color: 'var(--s1)' }, { key: 'trf', label: 'Transfer', color: 'var(--s2)' }, { key: 'cash', label: 'Cash', color: 'var(--s3)' }, { key: 'card', label: 'Card / other', color: 'var(--s4)' }];
    columnChart($('#cColDay'), { data: bucketize(d.daily.map(x => ({ x: x.d, v: { chq: x.chq, trf: x.trf, cash: x.cash, card: x.card } }))), series: M, tipFmt: v => 'Rs ' + money(v) });
    stackBar($('#cMix'), M.map(m => ({ label: m.label, value: m.key === 'card' ? t.card + t.boe : t[m.key], color: m.color })), { fmt: rs });
    const B = [['Already due', -1e9, 0], ['Due in 1–7 days', 1, 7], ['8–30 days', 8, 30], ['31–60 days', 31, 60], ['Over 60 days', 61, 1e9]];
    const seqC = ['var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-3)', 'var(--seq-4)'];
    hbars($('#cDue'), B.map(([l, a, b], i) => { const g = cheques.filter(c => c.days >= a && c.days <= b); return { label: l, value: sum(g, c => c.amt), color: seqC[i], sub: `${g.length} cheques` }; }), { max: Math.max(1, ...B.map(([, a, b]) => sum(cheques.filter(c => c.days >= a && c.days <= b), c => c.amt))) });
    hbars($('#cColRep'), d.byRep.map(r => ({ ...r, label: r.name, value: r.total, sub: `${r.count} receipts` })), { limit: 12, onClick: r => { if (/^\d+$/.test(r.key)) { S.rep = r.key; store.set('rep', S.rep); $('#fRep').value = S.rep; route(); } } });
    const holder = $('#colTbl');
    const views = {
      cust: () => table(holder, { name: 'collections_by_customer', rows: d.byCustomer, sort: { key: 'total', dir: 'desc' }, onRow: r => openDoc('customer', r.key),
        cols: [{ key: 'key', label: 'Code' }, { key: 'name', label: 'Customer', fmt: (v, r) => openLink('customer', r.key, v) }, { key: 'count', label: 'Receipts', num: true }, { key: 'total', label: 'Collected (Rs)', num: true, fmt: money }, { key: 'chq', label: 'By cheque (Rs)', num: true, fmt: money }, { key: 'balance', label: 'Account balance now (Rs)', num: true, fmt: money }],
        footer: r => ({ count: int(sum(r, x => x.count)), total: money(sum(r, x => x.total)), chq: money(sum(r, x => x.chq)) }) }),
      rep: () => table(holder, { name: 'collections_by_rep', rows: d.byRep, sort: { key: 'total', dir: 'desc' },
        cols: [{ key: 'name', label: 'Rep' }, { key: 'count', label: 'Receipts', num: true }, { key: 'total', label: 'Collected (Rs)', num: true, fmt: money }, { key: 'share', label: 'Share', num: true, val: r => (t.total ? (r.total / t.total) * 100 : 0), fmt: pct }, { key: 'chq', label: 'By cheque (Rs)', num: true, fmt: money }],
        footer: r => ({ count: int(sum(r, x => x.count)), total: money(sum(r, x => x.total)), chq: money(sum(r, x => x.chq)) }) }),
      chq: () => table(holder, { name: 'cheques', rows: cheques, sort: { key: 'due', dir: 'asc' },
        cols: [{ key: 'no', label: 'Cheque no.' }, { key: 'type', label: 'Type' }, { key: 'bank', label: 'Bank' }, { key: 'cardName', label: 'Customer', fmt: (v, r) => openLink('customer', r.card, v) }, { key: 'repName', label: 'Rep' }, { key: 'payment', label: 'Receipt no.' }, { key: 'received', label: 'Received', fmt: dFull }, { key: 'due', label: 'Due', fmt: dFull }, { key: 'days', label: 'Days to due', num: true, fmt: v => v > 0 ? int(v) : `<span class="muted">${v === 0 ? 'today' : 'due'}</span>` }, { key: 'amt', label: 'Amount (Rs)', num: true, fmt: money }],
        footer: r => ({ amt: money(sum(r, x => x.amt)) }) }),
      rtn: () => table(holder, { name: 'returned_cheques', rows: d.returned, sort: { key: 'received', dir: 'desc' }, empty: d.returnedNote || 'No returned or stopped cheques among receipts in this range',
        cols: [{ key: 'n', label: 'Receipt no.' }, { key: 'kind', label: 'What happened', val: r => r.kind === 'Return_Cheque' ? 'Cheque returned' : 'Cheque stopped' },
          { key: 'cn', label: 'Customer', fmt: (v, r) => openLink('customer', r.c, v) }, { key: 'ct', label: 'Type' },
          { key: 'chq', label: 'Cheque no.', val: r => r.cheques.map(c => c.no).join(', ') }, { key: 'received', label: 'Received', fmt: dFull },
          { key: 'returned', label: 'Returned on', fmt: v => v ? dFull(v) : '<span class="muted">not recorded</span>', csv: r => r.returned || '' },
          { key: 'amt', label: 'Amount (Rs)', num: true, fmt: money }, { key: 'reason', label: 'Reason' }],
        footer: r => ({ amt: money(sum(r, x => x.amt)) }) }),
      co: () => table(holder, { name: 'collections_by_company', rows: d.byCompany, sort: { key: 'total', dir: 'desc' },
        cols: [{ key: 'name', label: 'Company' }, { key: 'count', label: 'Receipts', num: true }, { key: 'total', label: 'Collected (Rs)', num: true, fmt: money }, { key: 'chq', label: 'By cheque (Rs)', num: true, fmt: money }] }),
    };
    const tab0 = views[params.tab] ? params.tab : 'cust';
    tabs($('#colTabs'), [{ key: 'cust', label: 'By customer', n: d.byCustomer.length }, { key: 'rep', label: 'By rep', n: d.byRep.length }, { key: 'chq', label: 'Cheques', n: cheques.length }, { key: 'rtn', label: 'Returned cheques', n: d.returned.length }, { key: 'co', label: 'By company', n: d.byCompany.length }], tab0, k => views[k]());
    views[tab0]();
    slFoot(d);
  },
};

// ------------------------------------------------------------ Credit control
PAGES['sl-credit'] = {
  title: 'Credit control',
  async render(main, alive, params) {
    main.innerHTML = spinner('Reading open invoices and customer balances from SAP (first load takes about 30 seconds)');
    const d = await slLoad('/sl/credit');
    if (!alive()) return;
    const R = d.rows;
    const open = sum(R, r => r.openInvoices), overdue = sum(R, r => r.overdue), over90 = sum(R, r => r.over90);
    const overLim = R.filter(r => r.overBy > 0), noLim = R.filter(r => !r.creditLimit && r.balance > 0);
    main.innerHTML = `<div class="tiles">
        ${rsTile('Open invoices', open, `${int(sum(R, r => r.invoices))} invoices · ${int(R.filter(r => r.openInvoices > 0).length)} customers`)}
        ${rsTile('Overdue', overdue, open ? pct((overdue / open) * 100) + ' of open invoices' : '')}
        ${rsTile('Over 90 days overdue', over90, `${int(R.filter(r => r.over90 > 0).length)} customers`)}
        ${tile('Over credit limit', int(overLim.length), `Rs ${compact(sum(overLim, r => r.overBy))} above their limits`)}
        ${tile('No credit limit set', int(noLim.length), `customers holding Rs ${compact(sum(noLim, r => r.balance))}`, { href: '#/sl-credit?tab=nolim' })}
        ${rsTile('Open orders & deliveries', sum(R, r => r.openOrders + r.openDeliveries), 'not yet invoiced')}
      </div>
      <p class="muted small" style="margin:0">As of ${dFull(d.today)}, not limited by the date filter. Ageing is by invoice due date. Rep is the rep on the open invoices (most customers have no rep on their master record). Credit limits and grades come from Anura's Credit Check record for each company (ATL = Anura Trading Lanka, AL = Anura Lubricants); "used" = open invoices of that company ÷ its limit.</p>
      <div class="grid g2">${card('cAge', 'Receivable ageing', 'Open invoice value by days past due')}${card('cRepOd', 'Overdue by rep', 'Click to filter')}</div>
      <section class="card"><div id="crTabs" style="margin-bottom:12px"></div><div id="crTbl"></div></section>
      ${card('crGrades', 'Customer grades', 'Payment term and period discount per grade')}`;
    table($('#crGrades'), { name: 'customer_grades', rows: d.grades || [], pageSize: 25, sort: { key: 'code', dir: 'asc' },
      cols: [{ key: 'code', label: 'Grade' }, { key: 'term', label: 'Payment term' }, { key: 'periodDiscount', label: 'Period discount %', num: true }, { key: 'eligibleDays', label: 'Discount if paid within (days)', num: true },
        { key: 'atl', label: 'Customers (ATL)', num: true, val: g => R.filter(r => r.gradeAtl === g.code).length }, { key: 'al', label: 'Customers (AL)', num: true, val: g => R.filter(r => r.gradeAl === g.code).length }] });
    const seqC = ['var(--good)', 'var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)', 'var(--critical)'];
    hbars($('#cAge'), d.buckets.map((b, i) => ({ label: b.label, value: b.value, color: seqC[i], sub: `${b.count} invoices` })), { max: Math.max(1, ...d.buckets.map(b => b.value)) });
    hbars($('#cRepOd'), d.byRep.filter(r => r.overdue > 0).sort((a, b) => b.overdue - a.overdue).map(r => ({ ...r, label: r.name, value: r.overdue, sub: `${r.customers} customers · Rs ${money(r.over90)} over 90 days` })), { limit: 12, color: 'var(--s2)', onClick: r => { S.rep = r.key; store.set('rep', S.rep); $('#fRep').value = S.rep; route(); } });
    const groups = {
      all: { label: 'All customers', f: () => true },
      od90: { label: 'Over 90 days', f: r => r.over90 > 0 },
      over: { label: 'Over credit limit', f: r => r.overBy > 0 },
      nolim: { label: 'No limit, has balance', f: r => !r.creditLimit && r.balance > 0 },
      credit: { label: 'Credit balance', f: r => r.balance < 0 },
      frozen: { label: 'On hold', f: r => r.frozen },
    };
    let cur = groups[params.tab] ? params.tab : 'all';
    const holder = $('#crTbl');
    const usedFmt = v => v === null ? '' : v > 100 ? `<b style="color:var(--bad-ink)">${pct(v)}</b>` : pct(v);
    const custCols = [
      { key: 'cardCode', label: 'Code' },
      { key: 'cardName', label: 'Customer', fmt: (v, r) => openLink('customer', r.cardCode, v) + (r.frozen ? ' <span class="chip critical"><span class="dot"></span>On hold</span>' : '') },
      { key: 'repName', label: 'Rep' },
      { key: 'balance', label: 'Balance (Rs)', num: true, fmt: money },
      { key: 'openInvoices', label: 'Open invoices (Rs)', num: true, fmt: money },
      { key: 'overdue', label: 'Overdue (Rs)', num: true, fmt: money },
      { key: 'over90', label: 'Over 90 days (Rs)', num: true, fmt: v => v ? `<b style="color:var(--bad-ink)">${money(v)}</b>` : '0.00', csv: r => r.over90 },
      { key: 'daysOverdue', label: 'Oldest overdue (days)', num: true, fmt: v => v ? int(v) : '' },
      { key: 'gradeAtl', label: 'Grade ATL', fmt: (v, r) => v ? `<span title="${esc(r.termAtl)}">${esc(v)}</span>` : '' },
      { key: 'limitAtl', label: 'Limit ATL (Rs)', num: true, fmt: v => v ? money(v) : '<span class="muted">none</span>', csv: r => r.limitAtl },
      { key: 'useAtl', label: 'Used ATL', num: true, fmt: usedFmt, csv: r => r.useAtl === null ? '' : r.useAtl.toFixed(1) },
      { key: 'gradeAl', label: 'Grade AL', fmt: (v, r) => v ? `<span title="${esc(r.termAl)}">${esc(v)}</span>` : '' },
      { key: 'limitAl', label: 'Limit AL (Rs)', num: true, fmt: v => v ? money(v) : '<span class="muted">none</span>', csv: r => r.limitAl },
      { key: 'useAl', label: 'Used AL', num: true, fmt: usedFmt, csv: r => r.useAl === null ? '' : r.useAl.toFixed(1) },
      { key: 'overBy', label: 'Over limit by (Rs)', num: true, fmt: v => v ? `<b style="color:var(--bad-ink)">${money(v)}</b>` : '', csv: r => r.overBy },
      { key: 'exposure', label: 'Exposure (Rs)', num: true, fmt: money },
      { key: 'group', label: 'Customer group' },
    ];
    const foot = r => ({ balance: money(sum(r, x => x.balance)), openInvoices: money(sum(r, x => x.openInvoices)), overdue: money(sum(r, x => x.overdue)), over90: money(sum(r, x => x.over90)), exposure: money(sum(r, x => x.exposure)), overBy: money(sum(r, x => x.overBy)) });
    const showCust = () => table(holder, { name: 'credit_control', rows: R.filter(groups[cur].f), cols: custCols, sort: { key: 'overdue', dir: 'desc' }, footer: foot, onRow: r => openDoc('customer', r.cardCode) });
    const showRep = () => table(holder, { name: 'receivable_by_rep', rows: d.byRep, sort: { key: 'overdue', dir: 'desc' },
      cols: [{ key: 'name', label: 'Rep' }, { key: 'customers', label: 'Customers', num: true }, { key: 'invoices', label: 'Open invoices', num: true }, { key: 'open', label: 'Open (Rs)', num: true, fmt: money }, { key: 'overdue', label: 'Overdue (Rs)', num: true, fmt: money }, { key: 'odPct', label: 'Overdue %', num: true, val: r => (r.open ? (r.overdue / r.open) * 100 : 0), fmt: pct }, { key: 'over90', label: 'Over 90 days (Rs)', num: true, fmt: money }],
      footer: r => ({ customers: int(sum(r, x => x.customers)), invoices: int(sum(r, x => x.invoices)), open: money(sum(r, x => x.open)), overdue: money(sum(r, x => x.overdue)), over90: money(sum(r, x => x.over90)) }) });
    tabs($('#crTabs'), [...Object.entries(groups).map(([k, g]) => ({ key: k, label: g.label, n: R.filter(g.f).length })), { key: 'rep', label: 'By rep', n: d.byRep.length }], cur, k => { if (k === 'rep') return showRep(); cur = k; showCust(); });
    showCust();
    slFoot(d);
  },
};

function slFoot(d) {
  if (d.fetchedAt && (!meta.fetchedAt || d.fetchedAt < meta.fetchedAt)) meta.fetchedAt = d.fetchedAt;
  if (d.stale && d.stale.length) meta.stale.push(...d.stale);
}
