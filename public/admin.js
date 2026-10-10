/* Users & permissions - administrators only. Server checks every change again (access.js). */
'use strict';

const COMPANIES = [['4', 'Anura Trading Lanka (ATL)'], ['5', 'Anura Lubricants (AL)']];
const EVENT_LABEL = {
  login: 'Signed in', logout: 'Signed out', 'login-failed': 'Sign-in failed', 'login-blocked': 'Sign-in blocked (too many tries)',
  'users-exported': 'Users exported', 'users-imported': 'Users imported',
  'user-created': 'User created', 'user-updated': 'User changed', 'user-deleted': 'User deleted', 'password-changed': 'Changed own password', denied: 'Access refused',
};

PAGES.admin = {
  title: 'Users & permissions',
  async render(main, alive, params) {
    main.innerHTML = spinner('Loading users');
    const [meta, users, reps] = await Promise.all([api('/admin/meta'), api('/admin/users'), api('/sl/reps').catch(() => [])]);
    if (!alive()) return;
    for (const r of reps) addRep(r.code, r.name);
    const repList = reps.length ? reps : [...REPS.entries()].map(([code, r]) => ({ code, name: r.name || r.short || 'Rep ' + code, active: true }));
    const repLabel = c => (repList.find(r => r.code === String(c)) || {}).name || 'Rep ' + c;
    const pageLabel = Object.fromEntries(meta.pages.map(p => [p.key, p.label]));
    const access = u => u.isAdmin ? 'Everything' : u.pages.length === meta.pages.length ? 'All pages' : `${u.pages.length} page${u.pages.length === 1 ? '' : 's'}`;
    const dataAccess = u => {
      if (u.isAdmin) return 'All data';
      const parts = [];
      parts.push(u.scope.reps.length ? (u.scope.reps.length <= 2 ? u.scope.reps.map(repLabel).join(', ') : `${u.scope.reps.length} reps`) : 'All reps');
      if (u.scope.companies.length) parts.push(u.scope.companies.map(c => ({ 4: 'ATL', 5: 'AL' }[c] || c)).join(' + ') + ' only');
      return parts.join(' · ');
    };
    const active = users.filter(u => u.active);
    main.innerHTML = `<div class="tiles">
        ${tile('Users', int(users.length), `${int(active.length)} active · ${int(users.length - active.length)} disabled`)}
        ${tile('Administrators', int(active.filter(u => u.isAdmin).length), 'can manage users')}
        ${tile('Limited to reps / company', int(active.filter(u => !u.isAdmin && (u.scope.reps.length || u.scope.companies.length)).length), 'see only their own data')}
        ${tile('Must change password', int(active.filter(u => u.mustChangePassword).length), 'at next sign-in')}
      </div>
      <section class="card"><div class="card-head"><div id="admTabs"></div><span class="right"><button class="btn sm" id="expUsers">⭳ Export users</button><button class="btn sm" id="impUsers">⭱ Import users</button><button class="btn primary sm" id="addUser">+ Add user</button></span></div><div id="admBody"></div></section>`;
    $('#addUser').addEventListener('click', () => editUser(null));
    $('#expUsers').addEventListener('click', exportUsers);
    $('#impUsers').addEventListener('click', importUsers);

    const views = {
      users: () => table($('#admBody'), {
        name: 'users', rows: users, sort: { key: 'username', dir: 'asc' }, onRow: u => editUser(u), pageSize: 50,
        cols: [
          { key: 'username', label: 'User name', fmt: (v, u) => `<b>${esc(v)}</b>${u.username === ME.username ? ' <span class="muted small">(you)</span>' : ''}` },
          { key: 'name', label: 'Name' },
          { key: 'roleLabel', label: 'Role' },
          { key: 'access', label: 'Pages', val: access },
          { key: 'data', label: 'Data access', val: dataAccess },
          { key: 'canExport', label: 'Excel', fmt: v => (v ? '✓' : '–') },
          { key: 'canRefresh', label: 'Refresh', fmt: v => (v ? '✓' : '–') },
          { key: 'active', label: 'Status', val: u => (u.active ? 'Active' : 'Disabled'), fmt: (v, u) => `<span class="chip ${u.active ? 'good' : 'critical'}"><span class="dot"></span>${v}</span>${u.mustChangePassword ? ' <span class="chip warning"><span class="dot"></span>New password due</span>' : ''}` },
          { key: 'lastLogin', label: 'Last sign-in', fmt: v => (v ? new Date(v).toLocaleString() : '<span class="muted">never</span>') },
        ],
      }),
      log: async () => {
        $('#admBody').innerHTML = spinner();
        const log = await api('/admin/audit');
        table($('#admBody'), {
          name: 'activity_log', rows: log, sort: { key: 'at', dir: 'desc' }, pageSize: 50,
          cols: [
            { key: 'at', label: 'When', fmt: v => new Date(v).toLocaleString() },
            { key: 'event', label: 'What', val: e => EVENT_LABEL[e.event] || e.event, fmt: (v, e) => `<span class="chip ${/failed|blocked|denied/.test(e.event) ? 'critical' : /deleted/.test(e.event) ? 'warning' : ''}"><span class="dot"></span>${esc(v)}</span>` },
            { key: 'actor', label: 'By' },
            { key: 'user', label: 'User affected' },
            { key: 'detail', label: 'Details', val: e => auditDetail(e, pageLabel, repLabel), fmt: v => `<span class="wrap-any" style="white-space:normal">${esc(v)}</span>` },
            { key: 'ip', label: 'From' },
          ],
        });
      },
      roles: () => table($('#admBody'), {
        name: 'roles', rows: Object.entries(meta.roles).map(([k, r]) => ({ k, ...r })), pageSize: 25,
        cols: [
          { key: 'label', label: 'Role' }, { key: 'note', label: 'Meant for' },
          { key: 'pages', label: 'Pages', val: r => r.pages.map(p => pageLabel[p]).join(', '), fmt: v => `<span style="white-space:normal">${esc(v)}</span>` },
          { key: 'canExport', label: 'Excel', fmt: v => (v ? '✓' : '–') }, { key: 'canRefresh', label: 'Refresh', fmt: v => (v ? '✓' : '–') },
        ],
      }),
    };
    const t0 = views[params.tab] ? params.tab : 'users';
    tabs($('#admTabs'), [{ key: 'users', label: 'Users', n: users.length }, { key: 'log', label: 'Activity log' }, { key: 'roles', label: 'Roles' }], t0, k => views[k]());
    views[t0]();

    // ------------------------------------------------------------ editor
    function editUser(u) {
      const isNew = !u;
      const v = u || { username: '', name: '', role: 'salesRep', isAdmin: false, pages: meta.roles.salesRep.pages, canExport: false, canRefresh: false, scope: { reps: [], companies: [] }, active: true, mustChangePassword: true };
      $('#drawerTitle').textContent = isNew ? 'Add user' : `User ${v.username}`;
      const groups = [...new Set(meta.pages.map(p => p.group))];
      $('#drawerBody').innerHTML = `<form id="userForm" class="grid" autocomplete="off">
        <section class="card"><div class="card-head"><h2>Account</h2></div><div class="form-grid">
          <label>User name<input name="username" value="${esc(v.username)}" ${isNew ? 'required pattern="[A-Za-z0-9._-]{3,30}"' : 'disabled'}></label>
          <label>Full name<input name="name" value="${esc(v.name)}" required></label>
          <label>Role<select name="role">${Object.entries(meta.roles).map(([k, r]) => `<option value="${k}" ${k === v.role ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select></label>
          <label>${isNew ? 'Password' : 'Reset password (leave empty to keep)'}<input name="password" type="password" autocomplete="new-password" ${isNew ? 'required' : ''} minlength="8" placeholder="at least 8 characters, letters and numbers"></label>
        </div>
        <div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:12px">
          <label class="switch"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Active (can sign in)</label>
          <label class="switch"><input type="checkbox" name="mustChangePassword" ${v.mustChangePassword ? 'checked' : ''}> Must choose a new password at next sign-in</label>
          <label class="switch"><input type="checkbox" name="isAdmin" ${v.isAdmin ? 'checked' : ''}> Administrator (all pages, all data, manages users)</label>
        </div><p class="muted small" id="roleNote" style="margin:10px 0 0"></p></section>

        <section class="card" id="pagesCard"><div class="card-head"><h2>Pages this user can open</h2><span class="right"><button type="button" class="btn sm" data-all="1">Select all</button><button type="button" class="btn sm" data-all="0">Clear</button></span></div>
          ${groups.map(g => `<h3 style="margin:6px 0 8px">${esc(g)}</h3><div class="checks" style="margin-bottom:12px">${meta.pages.filter(p => p.group === g).map(p => `<label><input type="checkbox" name="page" value="${p.key}" ${v.pages.includes(p.key) ? 'checked' : ''}> ${esc(p.label)}</label>`).join('')}</div>`).join('')}
          <h3 style="margin:6px 0 8px">Actions</h3>
          <div class="checks"><label><input type="checkbox" name="canExport" ${v.canExport ? 'checked' : ''}> Download tables to Excel</label><label><input type="checkbox" name="canRefresh" ${v.canRefresh ? 'checked' : ''}> Refresh data from SAP</label></div>
        </section>

        <section class="card" id="scopeCard"><div class="card-head"><h2>Data access</h2><span class="sub">What this user's pages show</span></div>
          <div class="field" style="margin-bottom:10px">Sales reps
            <div class="checks" style="grid-template-columns:auto auto;justify-content:start">
              <label><input type="radio" name="repMode" value="all" ${v.scope.reps.length ? '' : 'checked'}> All reps</label>
              <label><input type="radio" name="repMode" value="some" ${v.scope.reps.length ? 'checked' : ''}> Only the reps ticked below</label>
            </div></div>
          <div id="repBox" ${v.scope.reps.length ? '' : 'hidden'}>
            <input type="search" id="repSearch" placeholder="Find a rep by code or name" style="width:100%;margin-bottom:8px">
            <div class="rep-pick checks" id="repPick">${[...repList].sort((a, b) => (v.scope.reps.includes(b.code) - v.scope.reps.includes(a.code)) || (b.active - a.active) || a.name.localeCompare(b.name)).map(r => `<label data-q="${esc((r.code + ' ' + r.name).toLowerCase())}"><input type="checkbox" name="rep" value="${esc(r.code)}" ${v.scope.reps.includes(r.code) ? 'checked' : ''}> ${esc(r.name)} <span class="muted small">${esc(r.code)}${r.active ? '' : ' · inactive'}</span></label>`).join('')}</div>
            <p class="muted small" id="repCount" style="margin:6px 0 0"></p>
          </div>
          <div class="field" style="margin-top:12px">Companies (none ticked = both)
            <div class="checks">${COMPANIES.map(([k, n]) => `<label><input type="checkbox" name="company" value="${k}" ${v.scope.companies.includes(k) ? 'checked' : ''}> ${esc(n)}</label>`).join('')}</div></div>
          <p class="muted small" style="margin:12px 0 0">With a rep or company limit, every list, total and document is cut to that data on the server. "Not issued" lines carry no rep or company, so that page is not available to limited users. Sales orders and return requests carry no company in the Sales API, so for those only the rep limit applies.</p>
        </section>
        <div id="userErr" class="alert crit" hidden></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" type="submit">${isNew ? 'Create user' : 'Save changes'}</button><button class="btn" type="button" id="userCancel">Cancel</button>${isNew || v.username === ME.username ? '' : '<button class="btn" type="button" id="userDelete" style="margin-left:auto;color:var(--bad-ink)">Delete user</button>'}</div>
      </form>`;
      $('#drawer').hidden = false; $('#drawerBg').hidden = false;
      const f = $('#userForm');
      const sync = () => {
        const admin = f.isAdmin.checked;
        $$('input[name=page], input[name=canExport], input[name=canRefresh]', f).forEach(i => { i.disabled = admin; if (admin) i.checked = true; });
        $$('input[name=repMode], input[name=rep], input[name=company]', f).forEach(i => { i.disabled = admin; });
        $('#scopeCard').style.opacity = admin ? 0.5 : 1;
        $('#repBox').hidden = admin || f.repMode.value !== 'some';
        $('#repCount').textContent = `${$$('input[name=rep]:checked', f).length} rep(s) ticked`;
        $('#roleNote').textContent = (meta.roles[f.role.value] || {}).note || '';
      };
      f.role.addEventListener('change', () => {
        const r = meta.roles[f.role.value];
        $$('input[name=page]', f).forEach(i => { i.checked = r.pages.includes(i.value); });
        f.canExport.checked = r.canExport; f.canRefresh.checked = r.canRefresh;
        f.isAdmin.checked = f.role.value === 'admin';
        if (f.role.value === 'salesRep') { f.repMode.value = 'some'; }
        sync();
      });
      f.isAdmin.addEventListener('change', sync);
      $$('input[name=repMode], input[name=rep]', f).forEach(i => i.addEventListener('change', sync));
      $$('[data-all]', f).forEach(b => b.addEventListener('click', () => $$('input[name=page]', f).forEach(i => { i.checked = b.dataset.all === '1'; })));
      $('#repSearch').addEventListener('input', e => { const q = e.target.value.trim().toLowerCase(); $$('#repPick label').forEach(l => { l.hidden = q && !l.dataset.q.includes(q); }); });
      $('#userCancel').addEventListener('click', closeDrawer);
      const del = $('#userDelete');
      if (del) del.addEventListener('click', async () => {
        if (!confirm(`Delete user ${v.username}? They will be signed out and cannot sign in again.`)) return;
        try { await api('/admin/users/' + encodeURIComponent(v.username), 'DELETE'); closeDrawer(); toast(`User ${v.username} deleted`); route(); }
        catch (x) { showErr(x.message); }
      });
      const showErr = m => { const e = $('#userErr'); e.textContent = m; e.hidden = false; e.scrollIntoView({ block: 'nearest' }); };
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const reps = f.repMode.value === 'some' ? $$('input[name=rep]:checked', f).map(i => i.value) : [];
        if (!f.isAdmin.checked && f.repMode.value === 'some' && !reps.length) return showErr('Tick at least one rep, or choose "All reps".');
        const pages = $$('input[name=page]:checked', f).map(i => i.value);
        if (!f.isAdmin.checked && !pages.length) return showErr('Give the user at least one page.');
        const body = {
          name: f.name.value.trim(), role: f.role.value, isAdmin: f.isAdmin.checked, pages,
          canExport: f.canExport.checked, canRefresh: f.canRefresh.checked, active: f.active.checked, mustChangePassword: f.mustChangePassword.checked,
          scope: { reps, companies: $$('input[name=company]:checked', f).map(i => i.value) },
        };
        if (f.password.value) body.password = f.password.value;
        try {
          if (isNew) await api('/admin/users', 'POST', { ...body, username: f.username.value.trim() });
          else await api('/admin/users/' + encodeURIComponent(v.username), 'PUT', body);
          closeDrawer();
          toast(isNew ? 'User created' : 'Changes saved');
          if (v.username === ME.username) { ME = await api('/auth/me'); applyAccess(); }
          route();
        } catch (x) { showErr(x.message); }
      });
      sync();
      setTimeout(() => (isNew ? f.username : f.name).focus(), 50);
    }
  },
};

// ------------------------------------------------------------ export / import
function openPanel(title, html) {
  $('#drawerTitle').textContent = title;
  $('#drawerBody').innerHTML = html;
  $('#drawer').hidden = false; $('#drawerBg').hidden = false;
}

function exportUsers() {
  openPanel('Export users', `<section class="card">
      <p style="margin-top:0">Downloads every user with their role, pages, Excel / refresh rights, data access (reps, companies) and status, to load into another or newer version with <b>Import users</b>.</p>
      <label class="switch"><input type="checkbox" id="expPw" checked> Include passwords (stored hashed, so people keep their passwords after the move)</label>
      <p class="muted small">Keep the file safe: with passwords included it lets anyone who has it set up the same accounts. Without passwords, new accounts created from the file need a password reset.</p>
      <div style="display:flex;gap:8px"><button class="btn primary" id="expGo">Download file</button><button class="btn" id="expCancel">Cancel</button></div></section>`);
  $('#expCancel').addEventListener('click', closeDrawer);
  $('#expGo').addEventListener('click', async () => {
    try {
      const data = await api('/admin/export?passwords=' + ($('#expPw').checked ? 1 : 0));
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `sfd-users-${data.appVersion || ''}-${data.exportedAt.slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      closeDrawer();
      toast(`Exported ${data.users.length} users`);
    } catch (x) { if (!(x instanceof AuthError)) toast(x.message); }
  });
}

function importUsers() {
  openPanel('Import users', `<section class="card">
      <p style="margin-top:0">Load a file made with <b>Export users</b> (from this or an earlier version). You see what will change before anything is saved.</p>
      <div class="form-grid">
        <label>Users file<input type="file" id="impFile" accept=".json,application/json"></label>
        <div class="field">How to combine
          <label class="switch"><input type="radio" name="impMode" value="merge" checked> Merge: add new users and update those in the file; keep everyone else</label>
          <label class="switch"><input type="radio" name="impMode" value="replace"> Replace: make the user list exactly the file (others are removed)</label>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px"><button class="btn primary" id="impCheck">Check file</button><button class="btn" id="impCancel">Cancel</button></div>
    </section><div id="impOut" class="grid"></div>`);
  $('#impCancel').addEventListener('click', closeDrawer);
  let fileData = null;
  $('#impFile').addEventListener('change', async e => {
    const f = e.target.files[0];
    fileData = null;
    if (!f) return;
    try { fileData = JSON.parse(await f.text()); } catch { $('#impOut').innerHTML = '<div class="alert crit">This file is not valid JSON.</div>'; }
  });
  const mode = () => $('input[name=impMode]:checked').value;
  const run = async apply => {
    if (!fileData) { $('#impOut').innerHTML = '<div class="alert crit">Choose a users file first.</div>'; return null; }
    return api('/admin/import', 'POST', { file: fileData, mode: mode(), apply });
  };
  $('#impCheck').addEventListener('click', async () => {
    try {
      const r = await run(false);
      if (r) showPlan(r);
    } catch (x) { if (!(x instanceof AuthError)) $('#impOut').innerHTML = `<div class="alert crit">${esc(x.message)}</div>`; }
  });
  function showPlan(r) {
    const n = k => r.actions.filter(a => a.action === k).length;
    const LABEL = { add: 'Add', update: 'Update', unchanged: 'No change', remove: 'Remove', keep: 'Keep as is', skip: 'Skip' };
    const CLS = { add: 'good', update: 'info', remove: 'critical', skip: 'warning' };
    const changeText = a => Object.keys(a.changes || {}).map(k => ({ pages: 'pages', scope: 'data access', isAdmin: 'administrator', canExport: 'Excel', canRefresh: 'refresh', mustChangePassword: 'must change password', password: 'password' }[k] || k)).join(', ');
    $('#impOut').innerHTML = `<section class="card"><div class="card-head"><h2>What the import will do</h2><span class="sub">file from ${esc(r.source.appVersion || 'unknown version')}, exported ${r.source.exportedAt ? new Date(r.source.exportedAt).toLocaleString() : '–'} by ${esc(r.source.exportedBy || '–')} · ${int(r.source.users)} users</span></div>
        <div class="tiles" style="margin-bottom:12px">${tile('Add', int(n('add')), 'new users')}${tile('Update', int(n('update')), 'permissions or password change')}${tile('Remove', int(n('remove')), r.mode === 'replace' ? 'not in the file' : 'merge never removes')}${tile('No change', int(n('unchanged') + n('keep')), '')}</div>
        ${r.warnings.map(w => `<div class="alert" style="margin-bottom:8px">${esc(w)}</div>`).join('')}
        <div id="impTbl"></div>
        <div style="display:flex;gap:8px;margin-top:12px">${n('add') + n('update') + n('remove') ? '<button class="btn primary" id="impApply">Import now</button>' : '<span class="muted">Nothing to change.</span>'}<button class="btn" id="impClose">Close</button></div></section>`;
    table($('#impTbl'), {
      name: 'import_preview', rows: r.actions, pageSize: 50, sort: { key: 'action', dir: 'asc' },
      cols: [
        { key: 'username', label: 'User name' }, { key: 'name', label: 'Name' },
        { key: 'action', label: 'Action', fmt: v => `<span class="chip ${CLS[v] || ''}"><span class="dot"></span>${esc(LABEL[v] || v)}</span>` },
        { key: 'what', label: 'Changes', val: changeText },
        { key: 'notes', label: 'Notes', val: a => (a.notes || []).join('; '), fmt: v => `<span style="white-space:normal">${esc(v)}</span>` },
      ],
    });
    $('#impClose').addEventListener('click', closeDrawer);
    const ap = $('#impApply');
    if (ap) ap.addEventListener('click', async () => {
      if (!confirm(`${r.mode === 'replace' ? 'Replace' : 'Merge'} users now? Add ${n('add')}, update ${n('update')}, remove ${n('remove')}.`)) return;
      try {
        await run(true);
        closeDrawer();
        toast(`Imported: ${n('add')} added, ${n('update')} updated, ${n('remove')} removed`);
        ME = await api('/auth/me'); applyAccess();
        route();
      } catch (x) { if (!(x instanceof AuthError)) toast(x.message); }
    });
  }
}

function auditDetail(e, pageLabel, repLabel) {
  const parts = [];
  if (e.reason) parts.push(e.reason);
  if (e.event === 'users-exported') parts.push(`${e.count} users${e.passwordsIncluded ? ', with passwords' : ', without passwords'}`);
  if (e.event === 'users-imported') parts.push(`${e.mode}: ${(e.added || []).length} added, ${(e.updated || []).length} updated, ${(e.removed || []).length} removed${e.from && e.from.appVersion ? ' · file from ' + e.from.appVersion : ''}`);
  if (e.path) parts.push(e.path);
  if (e.passwordReset) parts.push('password reset');
  if (e.role) parts.push('role ' + e.role);
  if (e.changes) {
    for (const [k, [a, b]] of Object.entries(e.changes)) {
      if (k === 'pages') {
        const add = b.filter(p => !a.includes(p)).map(p => pageLabel[p] || p), rem = a.filter(p => !b.includes(p)).map(p => pageLabel[p] || p);
        if (add.length) parts.push('pages added: ' + add.join(', '));
        if (rem.length) parts.push('pages removed: ' + rem.join(', '));
      } else if (k === 'scope') {
        parts.push(`data access: ${b.reps.length ? b.reps.map(repLabel).join(', ') : 'all reps'}${b.companies.length ? ' · companies ' + b.companies.join('+') : ''}`);
      } else parts.push(`${k}: ${a} → ${b}`);
    }
  }
  return parts.join(' · ');
}
