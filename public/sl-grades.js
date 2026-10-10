/* Item grades page - ABC grade per item and item sales by customer grade (SAP Service Layer).
   Uses helpers from app.js and sl-pages.js. */
'use strict';

PAGES['sl-grades'] = {
  title: 'Item grades',
  async render(main, alive, params) {
    main.innerHTML = spinner('Reading invoice lines and customer grades from SAP for ' + rangeLabel());
    const d = await slLoad('/sl/item-grades', ['invL2', 'cnL2', 'cnHeads']);
    if (!alive()) return;
    const A = Object.fromEntries(d.abcSummary.map(r => [r.abc, r]));
    const totalNet = sum(d.abcSummary, r => r.net) || 1;
    const graded = sum(d.grades.filter(g => g.grade !== 'No grade'), g => g.net);
    const ABC_COL = { A: 'var(--seq-4)', B: 'var(--seq-3)', C: 'var(--seq-1)', 'No sales': 'var(--neutral)' };
    const abcChip = v => `<span class="chip"><span class="dot" style="background:${ABC_COL[v] || 'var(--neutral)'}"></span>${esc(v)}</span>`;
    const share = k => pct((A[k].net / totalNet) * 100);
    main.innerHTML = `<div class="tiles">
        ${tile('A items', int(A.A.items), `${share('A')} of sales · Rs ${compact(A.A.net)}`, { href: '#/sl-grades?tab=A' })}
        ${tile('B items', int(A.B.items), `${share('B')} of sales · Rs ${compact(A.B.net)}`, { href: '#/sl-grades?tab=B' })}
        ${tile('C items', int(A.C.items), `${share('C')} of sales · Rs ${compact(A.C.net)}`, { href: '#/sl-grades?tab=C' })}
        ${tile('In stock, no sales', int(A['No sales'].items), `${qty(A['No sales'].onHand)} units not sold in this range`, { href: '#/sl-grades?tab=none' })}
        ${tile('Sales to graded customers', pct((graded / (sum(d.grades, g => g.net) || 1)) * 100), `${int(d.grades.filter(g => g.grade !== 'No grade').length)} customer grades bought`)}
      </div>
      <p class="muted small" style="margin:0">Item grade (ABC) is by net sales in the selected dates: <b>A</b> = items making the first 80% of sales value, <b>B</b> = the next 15%, <b>C</b> = the last 5% and items returned in full. Customer grade is the grade in Anura's Credit Check for the company that invoiced (ATL / AL). Amounts exclude VAT and are after returns. Stock value is an estimate: units in stock × the item's cost on its invoice lines in this range (SAP keeps batch costs, which the Service Layer does not expose).</p>
      ${card('gAbc', 'Item grades (ABC)', esc(rangeLabel()))}
      ${card('gCat', 'Item grades by category', 'How many items of each category are A, B or C, and their sales · click a row to list its items')}
      ${card('gCust', 'Sales by customer grade', 'Net sales · margin')}
      <section class="card"><div class="card-head"><h2>Item sales by customer grade</h2><span class="sub">Net sales (Rs) · darker cell = bigger part of that row</span></div><div id="gmTabs" style="margin-bottom:12px"></div><div id="gmTbl"></div></section>
      <section class="card"><div class="card-head"><h2>Items</h2><span class="sub">Every item sold in the range with its grade, plus stocked items that did not sell</span></div><div id="giTabs" style="margin-bottom:12px"></div><div id="giTbl"></div></section>`;

    // ABC summary
    $('#gAbc').innerHTML = '<div id="gAbcBar" style="margin-bottom:14px"></div><div id="gAbcT"></div>';
    stackBar($('#gAbcBar'), ['A', 'B', 'C'].map(k => ({ label: `Grade ${k}`, value: A[k].net, color: ABC_COL[k], sub: `${int(A[k].items)} items` })), { fmt: rs });
    table($('#gAbcT'), {
      name: 'abc_summary', rows: d.abcSummary, pageSize: 10,
      cols: [
        { key: 'abc', label: 'Grade', fmt: abcChip },
        { key: 'items', label: 'Items', num: true, fmt: int },
        { key: 'net', label: 'Net sales (Rs)', num: true, fmt: money },
        { key: 'share', label: 'Share', num: true, val: r => (r.net / totalNet) * 100, fmt: pct },
        { key: 'margin', label: 'Margin', num: true, val: r => marginOf(r.gp, r.net), fmt: pct },
        { key: 'onHand', label: 'Units in stock', num: true, fmt: qty },
        { key: 'stockValueEst', label: 'Stock value est. (Rs)', num: true, fmt: v => v === null ? '<span class="muted">no cost</span>' : money(v), csv: r => r.stockValueEst ?? '' },
      ],
      footer: r => ({ items: int(sum(r, x => x.items)), net: money(sum(r, x => x.net)), onHand: qty(sum(r, x => x.onHand)), stockValueEst: money(sum(r, x => x.stockValueEst || 0)) }),
    });

    // ABC per category
    const pctOf = (v, t) => (t ? pct((v / t) * 100) : '–');
    table($('#gCat'), {
      name: 'item_grades_by_category', rows: d.byCategory, sort: { key: 'net', dir: 'desc' },
      onRow: r => { catFilter = r.key; $('#giTabs .tab.on') ? showItems(curItems) : null; $('#giTabs').scrollIntoView({ block: 'start' }); },
      cols: [
        { key: 'name', label: 'Category', fmt: v => `<span class="trunc" title="${esc(v)}">${esc(v)}</span>` },
        { key: 'net', label: 'Net sales (Rs)', num: true, fmt: money },
        { key: 'share', label: 'Share', num: true, val: r => (r.net / totalNet) * 100, fmt: pct },
        { key: 'margin', label: 'Margin', num: true, val: r => marginOf(r.gp, r.net), fmt: pct },
        { key: 'A', label: 'A items', num: true, fmt: (v, r) => v ? `${int(v)} <span class="muted small">${pctOf(r.netA, r.net)}</span>` : '0' },
        { key: 'B', label: 'B items', num: true, fmt: (v, r) => v ? `${int(v)} <span class="muted small">${pctOf(r.netB, r.net)}</span>` : '0' },
        { key: 'C', label: 'C items', num: true, fmt: (v, r) => v ? `${int(v)} <span class="muted small">${pctOf(r.netC, r.net)}</span>` : '0' },
        { key: 'noSales', label: 'In stock, no sales', num: true, fmt: int },
        { key: 'onHand', label: 'Units in stock', num: true, fmt: qty },
        { key: 'noSalesUnits', label: 'Units not selling', num: true, fmt: qty },
      ],
      footer: r => ({ net: money(sum(r, x => x.net)), A: int(sum(r, x => x.A)), B: int(sum(r, x => x.B)), C: int(sum(r, x => x.C)), noSales: int(sum(r, x => x.noSales)), onHand: qty(sum(r, x => x.onHand)), noSalesUnits: qty(sum(r, x => x.noSalesUnits)) }),
    });
    $('#gCat').insertAdjacentHTML('afterbegin', '<p class="muted small" style="margin:0 0 10px">The small % next to each count is that grade\'s share of the category\'s sales.</p>');

    // customer grades
    $('#gCust').innerHTML = '<div class="grid g32"><div id="gCustT"></div><div id="gCustC"></div></div>';
    hbars($('#gCustC'), d.grades.map(g => ({ label: g.grade === 'No grade' ? 'No grade' : `Grade ${g.grade}${g.term ? ' · ' + g.term : ''}`, value: g.net, sub: `margin ${pct(marginOf(g.gp, g.net))} · ${int(g.customers)} customers` })), { limit: 15 });
    table($('#gCustT'), {
      name: 'sales_by_customer_grade', rows: d.grades, pageSize: 25,
      cols: [
        { key: 'grade', label: 'Grade' }, { key: 'term', label: 'Payment term' },
        { key: 'periodDiscount', label: 'Period disc. %', num: true, fmt: v => v === null ? '' : qty(v) },
        { key: 'customers', label: 'Customers', num: true }, { key: 'invoices', label: 'Invoices', num: true }, { key: 'items', label: 'Items', num: true },
        { key: 'net', label: 'Net sales (Rs)', num: true, fmt: money },
        { key: 'margin', label: 'Margin', num: true, val: g => marginOf(g.gp, g.net), fmt: pct },
      ],
      footer: r => ({ customers: int(sum(r, x => x.customers)), net: money(sum(r, x => x.net)) }),
    });

    // matrix: rows = brand / sales group / part type / item, columns = customer grades
    const LEV = { brand: 'Brand', category: 'Category', salesGroup: 'Sales group', partClass: 'Part type', item: 'Item (top 500)' };
    const heat = (v, r) => {
      const part = r.net > 0 && v > 0 ? Math.min(1, v / r.net) : 0;
      return v ? `<span class="heat" style="--h:${Math.round(part * 55)}%">${money(v)}</span>` : '<span class="muted">–</span>';
    };
    const showMatrix = k => table($('#gmTbl'), {
      name: 'sales_by_customer_grade_' + k, rows: d.matrix[k], sort: { key: 'net', dir: 'desc' },
      cols: [
        ...(k === 'item' ? [{ key: 'key', label: 'Item code', fmt: v => openLink('item', v) }] : []),
        { key: 'name', label: LEV[k].replace(' (top 500)', '') },
        { key: 'net', label: 'Total (Rs)', num: true, fmt: money },
        { key: 'margin', label: 'Margin', num: true, val: r => marginOf(r.gp, r.net), fmt: pct },
        ...d.gradeCols.map(g => ({ key: 'g_' + g, label: g === 'No grade' ? 'No grade' : 'Grade ' + g, num: true, val: r => r.g[g] || 0, fmt: heat, csv: r => (r.g[g] || 0).toFixed(2) })),
      ],
      footer: r => Object.fromEntries([['net', money(sum(r, x => x.net))], ...d.gradeCols.map(g => ['g_' + g, money(sum(r, x => x.g[g] || 0))])]),
    });
    tabs($('#gmTabs'), Object.entries(LEV).map(([k, l]) => ({ key: k, label: l, n: d.matrix[k].length })), 'brand', showMatrix);
    showMatrix('brand');

    // item list by ABC grade
    const col = {
      key: { key: 'key', label: 'Item code', fmt: v => openLink('item', v) },
      name: { key: 'name', label: 'Item', fmt: v => `<span class="trunc" title="${esc(v)}">${esc(v)}</span>` },
      abc: { key: 'abc', label: 'Grade', fmt: abcChip },
      brand: { key: 'brandName', label: 'Brand' },
      cat: { key: 'catName', label: 'Category', fmt: v => `<span class="trunc" title="${esc(v)}">${esc(v)}</span>` },
      sg: { key: 'sg', label: 'Sales group' },
      pc: { key: 'pc', label: 'Part type' },
      qty: { key: 'qty', label: 'Qty sold', num: true, fmt: qty },
      net: { key: 'net', label: 'Net sales (Rs)', num: true, fmt: money },
      margin: { key: 'margin', label: 'Margin', num: true, val: r => (r.net ? marginOf(r.gp, r.net) : null), fmt: pct },
      cum: { key: 'cumShare', label: 'Cumulative share', num: true, fmt: pct },
      top: { key: 'topGrade', label: 'Main customer grade' },
      custs: { key: 'customers', label: 'Customers', num: true },
      onHand: { key: 'onHand', label: 'In stock', num: true, fmt: qty },
      committed: { key: 'committed', label: 'Committed', num: true, fmt: qty },
      onOrder: { key: 'onOrder', label: 'On order', num: true, fmt: qty },
      cover: { key: 'coverDays', label: 'Days of cover', num: true, fmt: v => (v === null || v === undefined ? '' : v < 14 ? `<b style="color:var(--bad-ink)">${v.toFixed(1)}</b>` : v.toFixed(0)) },
      value: { key: 'stockValueEst', label: 'Stock value est. (Rs)', num: true, fmt: v => (v === null || v === undefined ? '' : money(v)) },
    };
    const soldCols = ['key', 'name', 'abc', 'brand', 'cat', 'sg', 'pc', 'qty', 'net', 'margin', 'cum', 'top', 'custs', 'onHand', 'committed', 'onOrder', 'cover', 'value'].map(k => col[k]);
    const unsoldCols = ['key', 'name', 'brand', 'cat', 'sg', 'pc', 'onHand', 'committed', 'onOrder'].map(k => col[k]);
    const views = {
      all: { label: 'All sold', rows: d.items },
      A: { label: 'Grade A', rows: d.items.filter(r => r.abc === 'A') },
      B: { label: 'Grade B', rows: d.items.filter(r => r.abc === 'B') },
      C: { label: 'Grade C', rows: d.items.filter(r => r.abc === 'C') },
      none: { label: 'In stock, no sales', rows: d.noSales },
    };
    let catFilter = '', curItems = 'all';
    const inCat = rows => (catFilter ? rows.filter(r => r.cat === catFilter) : rows);
    const catNote = () => (catFilter ? `<span class="chip info"><span class="dot"></span>Category ${esc(catFilter)}</span> <button class="btn sm" data-clearcat>Show all categories</button>` : '');
    const showItems = k => { curItems = k; const t = drawItems(k); const b = $('[data-clearcat]', $('#giTbl')); if (b) b.addEventListener('click', () => { catFilter = ''; showItems(curItems); }); return t; };
    const drawItems = k => table($('#giTbl'), k === 'none'
      ? {
        name: 'stock_no_sales', rows: inCat(views.none.rows), cols: unsoldCols, sort: { key: 'onHand', dir: 'desc' }, empty: 'Every stocked item sold in this range',
        tools: catNote() + (d.noSalesTotal > views.none.rows.length ? ` <span class="muted small">Largest ${int(views.none.rows.length)} of ${int(d.noSalesTotal)} by units in stock</span>` : ''),
        footer: r => ({ onHand: qty(sum(r, x => x.onHand)) }),
      }
      : {
        name: 'items_grade_' + k, rows: inCat(views[k].rows), cols: soldCols, sort: { key: 'net', dir: 'desc' }, tools: catNote(),
        footer: r => ({ qty: qty(sum(r, x => x.qty)), net: money(sum(r, x => x.net)), onHand: qty(sum(r, x => x.onHand)), stockValueEst: money(sum(r, x => x.stockValueEst || 0)) }),
      });
    const t0 = views[params.tab] ? params.tab : 'all';
    tabs($('#giTabs'), Object.entries(views).map(([k, v]) => ({ key: k, label: v.label, n: k === 'none' ? d.noSalesTotal : v.rows.length })), t0, showItems);
    showItems(t0);
    if (params.tab) $('#giTabs').scrollIntoView({ block: 'start' });
    slFoot(d);
  },
};
