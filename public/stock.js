/* Item stock - search an item and see whether it is in stock, in which warehouses and batches.
   Data: Sales API Items (stock per warehouse) and batch quantities; warehouse names from the Service Layer. */
'use strict';

let whsInfoP = null;
function whsInfo() {
  if (!whsInfoP) whsInfoP = api('/sl/warehouses').then(list => new Map(list.map(w => [w.code, w])), () => new Map());
  return whsInfoP;
}
const COMPANY_SHORT = { 4: 'ATL', 5: 'AL' };

// one status per item, shown with an icon-like dot and a word (never colour alone)
function stockStatus(onHand, committed, ordered) {
  const avail = onHand - committed;
  if (onHand <= 0) return ordered > 0 ? ['On order only', 'warning'] : ['Out of stock', 'critical'];
  if (avail <= 0) return ['All committed', 'serious'];
  return ['In stock', 'good'];
}
const statusChip = ([label, cls]) => `<span class="chip ${cls}"><span class="dot"></span>${esc(label)}</span>`;
const itemTotals = it => {
  const w = it.ItemWarehouseInfoCollection || [];
  const onHand = sum(w, x => x.InStock), committed = sum(w, x => x.Committed), ordered = sum(w, x => x.Ordered);
  return { onHand, committed, ordered, avail: onHand - committed, whs: w.filter(x => x.InStock > 0) };
};

PAGES.stock = {
  title: 'Item stock',
  async render(main, alive, params) {
    main.innerHTML = `<section class="card"><div class="card-head"><h2>Find an item</h2><span class="sub">By item code, name or part number · stock as it is in SAP now</span></div>
      <form class="search-row" id="stForm">
        <input id="stQ" placeholder="e.g. AZ0165, FAN BELT, 6PK1050" value="${esc(params.q || '')}" required minlength="2">
        <label class="switch"><input type="checkbox" id="stIn" ${params.instock === '0' ? '' : 'checked'}> In stock only</label>
        <button class="btn primary">Search</button>
      </form></section>
      <div id="stRes"></div><div id="stDet"></div>`;
    const go = async (more) => {
      const qv = $('#stQ').value.trim(), inStock = $('#stIn').checked;
      if (qv.length < 2) return;
      if (!more) history.replaceState(null, '', `#/stock?q=${encodeURIComponent(qv)}${inStock ? '' : '&instock=0'}`);
      const box = $('#stRes');
      if (!more) { box.innerHTML = `<section class="card">${spinner('Searching items')}</section>`; $('#stDet').innerHTML = ''; PAGES.stock.rows = []; }
      try {
        const r = await api(`/lookup/stock-search?q=${encodeURIComponent(qv)}&inStock=${inStock ? 1 : 0}&skip=${more ? PAGES.stock.next : 0}`);
        if (!alive()) return;
        PAGES.stock.rows = [...(more ? PAGES.stock.rows : []), ...r.items];
        PAGES.stock.next = r.nextSkip;
        drawResults(box, PAGES.stock.rows, r.more, qv, inStock);
        if (PAGES.stock.rows.length === 1 && !more) showItemStatus(PAGES.stock.rows[0].ItemCode, $('#stDet'));
      } catch (e) { if (!(e instanceof AuthError)) box.innerHTML = errorBox(e.message); }
    };
    $('#stForm').addEventListener('submit', e => { e.preventDefault(); go(false); });
    $('#stIn').addEventListener('change', () => { if ($('#stQ').value.trim().length >= 2) go(false); });
    if (params.item) showItemStatus(params.item, $('#stDet'));
    else if (params.q) go(false);
    else $('#stQ').focus();

    function drawResults(box, rows, more, qv, inStock) {
      const shown = rows.map(it => ({ ...it, ...itemTotals(it) }));
      box.innerHTML = `<section class="card"><div class="card-head"><h2>Items matching “${esc(qv)}”</h2><span class="sub">${inStock ? 'in stock only · ' : ''}click an item for warehouses and batches</span>${more ? '<span class="right"><button class="btn sm" id="stMore">Load next 100</button></span>' : ''}</div><div id="stTbl"></div></section>`;
      if (more) $('#stMore').addEventListener('click', () => go(true));
      table($('#stTbl'), {
        name: 'item_stock_search', rows: shown, sort: { key: 'onHand', dir: 'desc' }, onRow: it => showItemStatus(it.ItemCode, $('#stDet')),
        empty: inStock ? 'No matching item is in stock. Untick "In stock only" to see all matches.' : 'No item matches',
        cols: [
          { key: 'ItemCode', label: 'Item code', fmt: v => `<b>${esc(v)}</b>` },
          { key: 'ItemName', label: 'Name', fmt: v => `<span class="trunc" title="${esc(v)}">${esc(v)}</span>` },
          { key: 'SupplierCatalogNo', label: 'Part no.' },
          { key: 'U_ItemsBrandCode', label: 'Brand' },
          { key: 'status', label: 'Status', val: it => stockStatus(it.onHand, it.committed, it.ordered)[0], fmt: (v, it) => statusChip(stockStatus(it.onHand, it.committed, it.ordered)) },
          { key: 'onHand', label: 'In stock', num: true, fmt: qty },
          { key: 'committed', label: 'Committed', num: true, fmt: qty },
          { key: 'avail', label: 'Available', num: true, fmt: v => (v < 0 ? `<b style="color:var(--bad-ink)">${qty(v)}</b>` : qty(v)) },
          { key: 'ordered', label: 'On order', num: true, fmt: v => (v ? qty(v) : '') },
          { key: 'where', label: 'Warehouses with stock', val: it => it.whs.sort((a, b) => b.InStock - a.InStock).map(w => `${w.WarehouseCode}: ${qty(w.InStock)}`).join(', '), fmt: v => `<span class="trunc" style="max-width:300px" title="${esc(v)}">${esc(v) || '<span class="muted">none</span>'}</span>` },
          { key: 'price', label: 'Price list 1 (Rs)', num: true, val: it => ((it.ItemPrices || []).find(p => p.PriceList === 1) || {}).Price ?? null, fmt: v => (v ? money(v) : '') },
        ],
      });
    }
  },
};

// full status of one item: totals, every warehouse, every batch. Also used when an item link is clicked anywhere.
async function showItemStatus(code, el) {
  el.innerHTML = `<section class="card">${spinner('Loading ' + code)}</section>`;
  let it, batches, wmap;
  try {
    [it, batches, wmap] = await Promise.all([api(`/lookup/item/${encodeURIComponent(code)}`), api(`/lookup/batches/${encodeURIComponent(code)}`).catch(() => []), whsInfo()]);
  } catch (e) {
    if (!(e instanceof AuthError)) el.innerHTML = errorBox(/404|not found/i.test(e.message) ? `Item ${code} was not found.` : e.message);
    return;
  }
  const T = itemTotals(it);
  const bByWhs = new Map();
  for (const b of batches) { const a = bByWhs.get(b.WhsCode) || []; a.push(b); bByWhs.set(b.WhsCode, a); }
  const rows = (it.ItemWarehouseInfoCollection || []).filter(w => w.InStock || w.Committed || w.Ordered).map(w => {
    const info = wmap.get(w.WarehouseCode) || {};
    return { code: w.WarehouseCode, name: info.name || '', company: COMPANY_SHORT[info.company] || info.company || '', inStock: w.InStock, committed: w.Committed, ordered: w.Ordered, avail: w.InStock - w.Committed, batches: (bByWhs.get(w.WarehouseCode) || []).length };
  });
  const prices = (it.ItemPrices || []).filter(p => p.Price).map(p => `PL${p.PriceList}: ${money(p.Price)}`).join(' · ') || '–';
  const yes = v => (v === 'Y' || v === 'tYES' ? 'Yes' : v === 'N' || v === 'tNO' ? 'No' : esc(v || '–'));
  const id = 's' + Math.random().toString(36).slice(2, 8);
  el.innerHTML = `<section class="card"><div class="card-head"><h2>${esc(it.ItemCode)}</h2><span class="sub">${esc(it.ItemName)}</span><span class="right">${statusChip(stockStatus(T.onHand, T.committed, T.ordered))}</span></div>
      <div class="kv">
        <div><span>Part no.</span><b>${esc(it.SupplierCatalogNo || '–')}</b></div>
        <div><span>Brand</span><b>${esc(it.U_ItemsBrandCode || '–')}</b></div>
        <div><span>Category</span><b>${esc(it.U_CategoryCode || '–')}</b></div>
        <div><span>Sales group</span><b>${esc((it.U_SalesGroup || '–').replace(/^Sales Group - /, ''))}</b></div>
        <div><span>Vehicle model</span><b>${esc(it.U_VehicleModel || '–')}</b></div>
        <div><span>Country of origin</span><b>${esc(it.U_CountryofOrigin || '–')}</b></div>
        <div><span>Active in SFA</span><b>${yes(it.U_Active_SFA)}</b></div>
        <div><span>New item / new GRN</span><b>${yes(it.U_NewItem)} / ${yes(it.U_NewGRN)}</b></div>
        <div><span>Not-issued count</span><b>${int(it['NI Count'] || 0)}</b></div>
        <div><span>Prices</span><b>${esc(prices)}</b></div>
      </div></section>
    <div class="tiles">
      ${tile('In stock', qty(T.onHand), `in ${int(T.whs.length)} warehouse${T.whs.length === 1 ? '' : 's'}`)}
      ${tile('Committed', qty(T.committed), 'reserved for open sales orders')}
      ${tile('Available', qty(T.avail), T.avail < 0 ? 'more committed than in stock' : 'in stock minus committed')}
      ${tile('On order', qty(T.ordered), 'open purchase orders')}
    </div>
    <section class="card"><div class="card-head"><h2>Stock by warehouse</h2><span class="sub">click a warehouse to see its batches</span></div><div id="${id}w"></div></section>
    <section class="card"><div class="card-head"><h2>Batches</h2><span class="sub" id="${id}bs">available quantity per batch (in stock minus committed)</span></div><div id="${id}b"></div></section>`;
  const drawBatches = whs => {
    const list = whs ? batches.filter(b => b.WhsCode === whs) : batches;
    $(`#${id}bs`).innerHTML = whs ? `warehouse ${esc(whs)} · <span class="link" id="${id}ball">show all warehouses</span>` : 'available quantity per batch (in stock minus committed)';
    const all = $(`#${id}ball`); if (all) all.addEventListener('click', () => drawBatches(null));
    table($(`#${id}b`), {
      name: 'batches_' + it.ItemCode, rows: list.map(b => ({ ...b, q: num(b.Quantity), wname: (wmap.get(b.WhsCode) || {}).name || '' })), sort: { key: 'q', dir: 'desc' }, pageSize: 25,
      empty: 'No batch with available quantity',
      cols: [{ key: 'WhsCode', label: 'Warehouse' }, { key: 'wname', label: 'Warehouse name' }, { key: 'DistNumber', label: 'Batch no.' }, { key: 'q', label: 'Available', num: true, fmt: qty }],
      footer: r => ({ q: qty(sum(r, x => x.q)) }),
    });
  };
  table($(`#${id}w`), {
    name: 'stock_by_warehouse_' + it.ItemCode, rows, sort: { key: 'inStock', dir: 'desc' }, pageSize: 50, empty: 'Not held in any warehouse', onRow: w => drawBatches(w.code),
    cols: [
      { key: 'code', label: 'Warehouse' }, { key: 'name', label: 'Name' }, { key: 'company', label: 'Company' },
      { key: 'inStock', label: 'In stock', num: true, fmt: qty }, { key: 'committed', label: 'Committed', num: true, fmt: qty },
      { key: 'avail', label: 'Available', num: true, fmt: v => (v < 0 ? `<b style="color:var(--bad-ink)">${qty(v)}</b>` : qty(v)) },
      { key: 'ordered', label: 'On order', num: true, fmt: v => (v ? qty(v) : '') }, { key: 'batches', label: 'Batches', num: true },
    ],
    footer: r => ({ inStock: qty(sum(r, x => x.inStock)), committed: qty(sum(r, x => x.committed)), avail: qty(sum(r, x => x.avail)), ordered: qty(sum(r, x => x.ordered)), batches: int(sum(r, x => x.batches)) }),
  });
  drawBatches(null);
  if (el.id === 'stDet') el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
