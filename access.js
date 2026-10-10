// Users, sessions, permissions and audit log for the dashboard.
// Users live in data/users.json (passwords hashed with scrypt); every change and sign-in is written to data/audit.log.

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// pages a user can be given; "group" is only used to lay out the admin screen
const PAGES = [
  { key: 'overview', label: 'Overview', group: 'Sales force' },
  { key: 'orders', label: 'Sales orders', group: 'Sales force' },
  { key: 'track', label: 'Track a document', group: 'Sales force' },
  { key: 'stock', label: 'Item stock', group: 'Sales force' },
  { key: 'pending', label: 'Approvals', group: 'Sales force' },
  { key: 'not-issued', label: 'Not issued', group: 'Sales force' },
  { key: 'invoices', label: 'Invoices', group: 'Sales force' },
  { key: 'returns', label: 'Returns', group: 'Sales force' },
  { key: 'quotations', label: 'Quotations', group: 'Sales force' },
  { key: 'reps', label: 'Sales reps', group: 'Sales force' },
  { key: 'customers', label: 'Customers', group: 'Sales force' },
  { key: 'sl-sales', label: 'Sales & margin', group: 'SAP analytics' },
  { key: 'sl-products', label: 'Products & brands', group: 'SAP analytics' },
  { key: 'sl-grades', label: 'Item grades', group: 'SAP analytics' },
  { key: 'sl-collections', label: 'Collections & cheques', group: 'SAP analytics' },
  { key: 'sl-credit', label: 'Credit control', group: 'SAP analytics' },
];
const PAGE_KEYS = PAGES.map(p => p.key);
const APP_VERSION = 'V2';
const SF = ['overview', 'orders', 'track', 'stock', 'pending', 'not-issued', 'invoices', 'returns', 'quotations', 'reps', 'customers'];

// starting points offered in the admin screen; the user record keeps its own page list
const ROLES = {
  admin: { label: 'Administrator', pages: PAGE_KEYS, canExport: true, canRefresh: true, note: 'Everything, including users & permissions' },
  management: { label: 'Management', pages: PAGE_KEYS, canExport: true, canRefresh: true, note: 'All pages, all data' },
  salesManager: { label: 'Sales manager', pages: [...SF, 'sl-sales', 'sl-products', 'sl-grades'], canExport: true, canRefresh: false, note: 'Sales pages and product analytics' },
  finance: { label: 'Finance', pages: ['overview', 'invoices', 'returns', 'customers', 'sl-sales', 'sl-collections', 'sl-credit'], canExport: true, canRefresh: false, note: 'Invoices, collections and credit' },
  salesRep: { label: 'Sales rep', pages: ['overview', 'orders', 'track', 'stock', 'pending', 'invoices', 'returns', 'quotations', 'customers', 'sl-collections'], canExport: false, canRefresh: false, note: 'Limit to the rep\'s own code under Data access' },
  viewer: { label: 'Viewer', pages: ['overview'], canExport: false, canRefresh: false, note: 'Overview only' },
};

// which pages open which server calls (a user needs at least one of the listed pages)
const DOC_PAGES = ['track', 'orders', 'pending', 'invoices', 'returns', 'quotations', 'customers', 'overview', 'reps'];
const API_ACCESS = [
  [/^\/data\/orders$/, ['overview', 'orders', 'reps', 'customers']],
  [/^\/data\/invoices$/, ['overview', 'invoices', 'reps', 'customers']],
  [/^\/data\/returns$/, ['overview', 'returns', 'reps']],
  [/^\/data\/returnCreditNotes$/, ['overview', 'returns', 'reps', 'customers']],
  [/^\/data\/quotations$/, ['overview', 'quotations']],
  [/^\/live\/pending$/, ['overview', 'orders', 'pending', 'reps']],
  [/^\/live\/rejected$/, ['pending']],
  [/^\/live\/(not-issued|line-closer)$/, ['not-issued']],
  [/^\/live\/grades$/, ['customers']],
  [/^\/lookup\/(order|order-chain|quotation|return|invoice|rr-lines|part)(\/|$)/, DOC_PAGES],
  [/^\/lookup\/(item|items|stock-search|batches)(\/|$)/, [...DOC_PAGES, 'stock', 'not-issued', 'sl-products', 'sl-grades']],
  [/^\/sl\/warehouses$/, ['stock', ...DOC_PAGES, 'not-issued', 'sl-products', 'sl-grades']],
  [/^\/lookup\/customer\//, [...DOC_PAGES, 'sl-sales', 'sl-collections', 'sl-credit', 'sl-grades']],
  [/^\/sl\/sales$/, ['sl-sales', 'sl-products']],
  [/^\/sl\/item-grades$/, ['sl-grades']],
  [/^\/sl\/collections$/, ['sl-collections']],
  [/^\/sl\/credit$/, ['sl-credit']],
  [/^\/sl\/(warm|reps|status)$/, ['sl-sales', 'sl-products', 'sl-grades', 'sl-collections', 'sl-credit']],
  [/^\/status$/, PAGE_KEYS],
];

module.exports = function createAccess({ dataDir, sessionHours, bootstrap, log }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const usersFile = path.join(dataDir, 'users.json');
  const auditFile = path.join(dataDir, 'audit.log');

  // ------------------------------------------------------------ passwords
  function hash(pw) {
    const salt = crypto.randomBytes(16);
    const h = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
    return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
  }
  function verify(pw, stored) {
    const [kind, saltHex, hashHex] = String(stored || '').split('$');
    if (kind !== 'scrypt' || !saltHex || !hashHex) return false;
    const h = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
    const want = Buffer.from(hashHex, 'hex');
    return want.length === h.length && crypto.timingSafeEqual(h, want);
  }
  function passwordProblem(pw, username) {
    pw = String(pw || '');
    if (pw.length < 8) return 'Password must be at least 8 characters.';
    if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain letters and numbers.';
    if (username && pw.toLowerCase().includes(String(username).toLowerCase())) return 'Password must not contain the user name.';
    return null;
  }

  // ------------------------------------------------------------ store
  let users = [];
  function save() {
    const tmp = usersFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ users }, null, 2));
    fs.renameSync(tmp, usersFile);
  }
  function normalise(u) {
    return {
      username: String(u.username).trim().toLowerCase(), name: u.name || u.username, role: ROLES[u.role] ? u.role : 'viewer',
      pages: (u.pages || []).filter(p => PAGE_KEYS.includes(p)), isAdmin: !!u.isAdmin,
      canExport: !!u.canExport, canRefresh: !!u.canRefresh,
      scope: { reps: (u.scope && u.scope.reps || []).map(String), companies: (u.scope && u.scope.companies || []).map(String) },
      active: u.active !== false, mustChangePassword: !!u.mustChangePassword,
      passwordHash: u.passwordHash, createdAt: u.createdAt || new Date().toISOString(), createdBy: u.createdBy || 'system',
      updatedAt: u.updatedAt || null, lastLogin: u.lastLogin || null, passwordChangedAt: u.passwordChangedAt || null,
    };
  }
  if (fs.existsSync(usersFile)) {
    users = (JSON.parse(fs.readFileSync(usersFile, 'utf8')).users || []).map(normalise);
  } else {
    // first start: turn the DASH_USERS entries of .env into administrators who must change their password
    for (const [name, pw] of Object.entries(bootstrap || {})) {
      users.push(normalise({ username: name, name, role: 'admin', isAdmin: true, pages: PAGE_KEYS, canExport: true, canRefresh: true,
        passwordHash: pw.startsWith('scrypt$') ? pw : hash(pw), mustChangePassword: true }));
    }
    if (!users.length) users.push(normalise({ username: 'admin', name: 'Administrator', role: 'admin', isAdmin: true, pages: PAGE_KEYS, canExport: true, canRefresh: true, passwordHash: hash('Admin@2026'), mustChangePassword: true }));
    save();
    log(`created ${usersFile} with ${users.map(u => u.username).join(', ')} (password change required at first sign-in)`);
  }
  const find = name => users.find(u => u.username === String(name || '').trim().toLowerCase());
  const publicUser = u => {
    const { passwordHash, ...rest } = u;
    return { ...rest, pages: u.isAdmin ? PAGE_KEYS : u.pages, roleLabel: (ROLES[u.role] || {}).label || u.role };
  };

  // ------------------------------------------------------------ audit
  const recent = [];
  if (fs.existsSync(auditFile)) {
    try { for (const l of fs.readFileSync(auditFile, 'utf8').trim().split('\n').slice(-1000)) if (l) recent.push(JSON.parse(l)); } catch { /* ignore */ }
  }
  function audit(event, actor, detail = {}) {
    const e = { at: new Date().toISOString(), event, actor: actor || '-', ...detail };
    recent.push(e); if (recent.length > 1000) recent.shift();
    fs.appendFile(auditFile, JSON.stringify(e) + '\n', () => {});
  }

  // ------------------------------------------------------------ sessions & sign-in
  const sessions = new Map();  // token -> { username, exp, ip }
  const failures = new Map();  // username|ip -> { count, until }
  const LOCK_AFTER = 5, LOCK_MIN = 15;

  function login(username, pw, ip) {
    const key = String(username || '').toLowerCase() + '|' + ip;
    const f = failures.get(key);
    if (f && f.until > Date.now()) {
      audit('login-blocked', username, { ip });
      return { error: `Too many failed attempts. Try again in ${Math.ceil((f.until - Date.now()) / 60000)} minutes.`, status: 429 };
    }
    const u = find(username);
    // always run the hash so a wrong user name takes as long as a wrong password
    const ok = verify(pw, u ? u.passwordHash : 'scrypt$00$00') && u && u.active;
    if (!ok) {
      // start counting again once an earlier lock has run out, or 15 minutes after the first failure
      const fresh = !f || (f.until && f.until <= Date.now()) || Date.now() - f.first > LOCK_MIN * 60e3;
      const n = (fresh ? 0 : f.count) + 1;
      failures.set(key, { count: n, first: fresh ? Date.now() : f.first, until: n >= LOCK_AFTER ? Date.now() + LOCK_MIN * 60e3 : 0 });
      audit('login-failed', username, { ip, reason: !u ? 'unknown user' : !u.active ? 'disabled' : 'wrong password' });
      return { error: u && !u.active ? 'This account is disabled.' : 'Invalid user name or password', status: 401 };
    }
    failures.delete(key);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { username: u.username, exp: Date.now() + sessionHours * 3600e3, ip });
    u.lastLogin = new Date().toISOString(); save();
    audit('login', u.username, { ip });
    return { token, user: publicUser(u) };
  }
  function getCookie(req, name) {
    const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  // looks the user up on every request, so disabling a user or changing permissions applies at once
  function userOf(req) {
    const t = getCookie(req, 'sfd_session');
    const s = t && sessions.get(t);
    if (!s || s.exp < Date.now()) { if (t) sessions.delete(t); return null; }
    const u = find(s.username);
    if (!u || !u.active) { sessions.delete(t); return null; }
    return u;
  }
  function logout(req) { const t = getCookie(req, 'sfd_session'); const s = t && sessions.get(t); if (s) audit('logout', s.username); if (t) sessions.delete(t); }
  function endSessions(username, exceptToken) { for (const [t, s] of sessions) if (s.username === username && t !== exceptToken) sessions.delete(t); }

  // ------------------------------------------------------------ permission checks
  const can = (u, page) => !!u && (u.isAdmin || u.pages.includes(page));
  function canApi(u, p) {
    if (u.isAdmin) return true;
    const rule = API_ACCESS.find(([re]) => re.test(p));
    return !!rule && rule[1].some(pg => u.pages.includes(pg));
  }
  const repScope = u => (u.isAdmin ? [] : u.scope.reps);
  const coScope = u => (u.isAdmin ? [] : u.scope.companies);
  const scoped = u => repScope(u).length > 0 || coScope(u).length > 0;

  // ------------------------------------------------------------ admin API
  async function handleAdmin(req, res, url, actor, { send, readBody }) {
    const p = url.pathname;
    const bodyJson = async () => { try { return JSON.parse(await readBody(req) || '{}'); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); } };
    const activeAdmins = () => users.filter(u => u.active && u.isAdmin).length;

    if (p === '/admin/meta' && req.method === 'GET') return send(req, res, 200, { pages: PAGES, roles: ROLES });
    if (p === '/admin/users' && req.method === 'GET') return send(req, res, 200, users.map(publicUser));
    if (p === '/admin/audit' && req.method === 'GET') return send(req, res, 200, [...recent].reverse());

    // ---- export / import of users, e.g. to carry them into a new version of the dashboard
    if (p === '/admin/export' && req.method === 'GET') {
      const withPw = url.searchParams.get('passwords') !== '0';
      const out = {
        format: 'sfd-users', formatVersion: 1, exportedAt: new Date().toISOString(), exportedBy: actor.username,
        appVersion: APP_VERSION, knownPages: PAGE_KEYS, passwordsIncluded: withPw,
        users: users.map(u => {
          const { passwordHash, lastLogin, ...rest } = u;
          return withPw ? { ...rest, passwordHash } : rest;
        }),
      };
      audit('users-exported', actor.username, { count: users.length, passwordsIncluded: withPw });
      return send(req, res, 200, out, undefined, { 'Content-Disposition': `attachment; filename="sfd-users-${new Date().toISOString().slice(0, 10)}.json"` });
    }
    if (p === '/admin/import' && req.method === 'POST') {
      let b;
      try { b = JSON.parse(await readBody(req, 5e6) || '{}'); } catch { return send(req, res, 400, { error: 'The file is not valid JSON.' }); }
      const plan = planImport(b.file, b.mode === 'replace' ? 'replace' : 'merge', actor);
      if (plan.error) return send(req, res, 400, { error: plan.error });
      if (b.apply) {
        if (!plan.result.some(u => u.active && u.isAdmin)) return send(req, res, 400, { error: 'After this import no active administrator would be left.' });
        users = plan.result; save();
        for (const a of plan.actions) if (a.action === 'remove' || a.endSessions) endSessions(a.username);
        audit('users-imported', actor.username, {
          mode: plan.mode, from: plan.source,
          added: plan.actions.filter(a => a.action === 'add').map(a => a.username),
          updated: plan.actions.filter(a => a.action === 'update').map(a => a.username),
          removed: plan.actions.filter(a => a.action === 'remove').map(a => a.username),
        });
      }
      return send(req, res, 200, { applied: !!b.apply, mode: plan.mode, source: plan.source, actions: plan.actions, warnings: plan.warnings });
    }

    if (p === '/admin/users' && req.method === 'POST') {
      const b = await bodyJson();
      const username = String(b.username || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,30}$/.test(username)) return send(req, res, 400, { error: 'User name: 3–30 characters, letters, numbers, dot, dash or underscore.' });
      if (find(username)) return send(req, res, 409, { error: 'That user name already exists.' });
      const prob = passwordProblem(b.password, username);
      if (prob) return send(req, res, 400, { error: prob });
      const u = normalise({ ...pick(b), username, passwordHash: hash(b.password), mustChangePassword: b.mustChangePassword !== false, createdBy: actor.username });
      users.push(u); save();
      audit('user-created', actor.username, { user: username, role: u.role, isAdmin: u.isAdmin, pages: u.pages, scope: u.scope });
      return send(req, res, 200, publicUser(u));
    }
    let m = p.match(/^\/admin\/users\/([a-z0-9._-]+)$/);
    if (m && req.method === 'PUT') {
      const u = find(m[1]);
      if (!u) return send(req, res, 404, { error: 'User not found' });
      const b = await bodyJson();
      const next = normalise({ ...u, ...pick(b), username: u.username, passwordHash: u.passwordHash });
      if (u.username === actor.username && (!next.isAdmin || !next.active)) return send(req, res, 400, { error: 'You cannot remove your own administrator rights or disable yourself.' });
      if (u.isAdmin && u.active && (!next.isAdmin || !next.active) && activeAdmins() <= 1) return send(req, res, 400, { error: 'At least one active administrator must remain.' });
      if (b.password) {
        const prob = passwordProblem(b.password, u.username);
        if (prob) return send(req, res, 400, { error: prob });
        next.passwordHash = hash(b.password); next.passwordChangedAt = new Date().toISOString();
        next.mustChangePassword = b.mustChangePassword !== false;
      }
      next.updatedAt = new Date().toISOString();
      const changes = diff(u, next);
      Object.assign(u, next); save();
      if (!u.active || b.password) endSessions(u.username);
      audit('user-updated', actor.username, { user: u.username, changes, passwordReset: !!b.password });
      return send(req, res, 200, publicUser(u));
    }
    if (m && req.method === 'DELETE') {
      const u = find(m[1]);
      if (!u) return send(req, res, 404, { error: 'User not found' });
      if (u.username === actor.username) return send(req, res, 400, { error: 'You cannot delete yourself.' });
      if (u.isAdmin && u.active && activeAdmins() <= 1) return send(req, res, 400, { error: 'At least one active administrator must remain.' });
      users = users.filter(x => x !== u); save(); endSessions(u.username);
      audit('user-deleted', actor.username, { user: u.username });
      return send(req, res, 200, { ok: true });
    }
    return send(req, res, 404, { error: 'Not found' });
  }
  function pick(b) {
    const out = {};
    for (const k of ['name', 'role', 'pages', 'isAdmin', 'canExport', 'canRefresh', 'scope', 'active', 'mustChangePassword']) if (b[k] !== undefined) out[k] = b[k];
    if (out.isAdmin) out.pages = PAGE_KEYS;
    return out;
  }
  function diff(a, b) {
    const d = {};
    for (const k of ['name', 'role', 'isAdmin', 'canExport', 'canRefresh', 'active', 'mustChangePassword']) if (a[k] !== b[k]) d[k] = [a[k], b[k]];
    if (a.pages.join() !== b.pages.join()) d.pages = [a.pages, b.pages];
    if (JSON.stringify(a.scope) !== JSON.stringify(b.scope)) d.scope = [a.scope, b.scope];
    return d;
  }

  // works out what an import would do; nothing is saved here
  function planImport(file, mode, actor) {
    if (!file || file.format !== 'sfd-users' || !Array.isArray(file.users)) return { error: 'This is not a users file exported from the dashboard.' };
    const warnings = [], actions = [];
    const known = Array.isArray(file.knownPages) ? file.knownPages : null;
    // pages added in this version since the file was made: give them by role, as a new user of that role would get them
    const newPages = known ? PAGE_KEYS.filter(k => !known.includes(k)) : [];
    if (newPages.length) warnings.push(`This version has pages the file does not know: ${newPages.map(k => (PAGES.find(p => p.key === k) || {}).label).join(', ')}. They are given to users whose role includes them by default.`);
    const dropped = new Set();
    for (const u of file.users) for (const pg of u.pages || []) if (!PAGE_KEYS.includes(pg)) dropped.add(pg);
    if (dropped.size) warnings.push(`Pages in the file that this version does not have were left out: ${[...dropped].join(', ')}.`);
    if (!file.passwordsIncluded) warnings.push('The file has no passwords. New users from it are created disabled and need a password reset before they can sign in; existing users keep their current password.');

    const seen = new Set(), result = [];
    for (const raw of file.users) {
      const username = String(raw.username || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,30}$/.test(username)) { actions.push({ username: username || '(blank)', action: 'skip', notes: ['invalid user name'] }); continue; }
      if (seen.has(username)) { actions.push({ username, action: 'skip', notes: ['appears twice in the file'] }); continue; }
      seen.add(username);
      const notes = [];
      const pages = (raw.pages || []).filter(pg => PAGE_KEYS.includes(pg));
      const role = ROLES[raw.role] ? raw.role : 'viewer';
      if (raw.role && !ROLES[raw.role]) notes.push(`unknown role "${raw.role}" → Viewer`);
      if (!raw.isAdmin) for (const pg of newPages) if ((ROLES[role].pages || []).includes(pg) && !pages.includes(pg)) { pages.push(pg); notes.push(`given new page ${(PAGES.find(p => p.key === pg) || {}).label}`); }
      let hashIn = raw.passwordHash && /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/.test(raw.passwordHash) ? raw.passwordHash : null;
      if (raw.passwordHash && !hashIn) notes.push('password in the file is not readable; ignored');
      const cur = find(username);
      let next = normalise({ ...raw, username, role, pages, passwordHash: hashIn || (cur && cur.passwordHash) || hash(crypto.randomBytes(24).toString('hex')),
        lastLogin: cur ? cur.lastLogin : null, createdAt: cur ? cur.createdAt : raw.createdAt, createdBy: cur ? cur.createdBy : raw.createdBy || actor.username });
      if (!cur && !hashIn) { next.active = false; next.mustChangePassword = true; notes.push('no password: created disabled, reset the password to enable'); }
      // the administrator doing the import always keeps their own access
      if (username === actor.username) {
        if (!next.isAdmin || !next.active) notes.push('kept as an active administrator (you are signed in as this user)');
        next.isAdmin = true; next.active = true; next.pages = PAGE_KEYS; next.passwordHash = cur.passwordHash;
        if (hashIn && hashIn !== cur.passwordHash) notes.push('your own password was not changed');
      }
      if (!cur) { actions.push({ username, name: next.name, action: 'add', notes }); result.push(next); continue; }
      const changes = diff(cur, next);
      const pwChanged = next.passwordHash !== cur.passwordHash;
      if (pwChanged) changes.password = ['', 'from file'];
      const n = Object.keys(changes).length;
      actions.push({ username, name: next.name, action: n ? 'update' : 'unchanged', changes, notes, endSessions: pwChanged || (cur.active && !next.active) });
      result.push(n ? { ...next, updatedAt: new Date().toISOString() } : cur);
    }
    for (const u of users) {
      if (seen.has(u.username)) continue;
      if (mode === 'replace' && u.username !== actor.username) actions.push({ username: u.username, name: u.name, action: 'remove', notes: ['not in the file'] });
      else { actions.push({ username: u.username, name: u.name, action: 'keep', notes: [mode === 'replace' ? 'kept: you are signed in as this user' : 'not in the file, left as it is'] }); result.push(u); }
    }
    return { mode, actions, warnings, result, source: { exportedAt: file.exportedAt, exportedBy: file.exportedBy, appVersion: file.appVersion, users: file.users.length } };
  }

  function changeOwnPassword(u, current, next, req) {
    if (!verify(current, u.passwordHash)) return { status: 400, error: 'Current password is not correct.' };
    const prob = passwordProblem(next, u.username);
    if (prob) return { status: 400, error: prob };
    if (verify(next, u.passwordHash)) return { status: 400, error: 'Choose a password different from the current one.' };
    u.passwordHash = hash(next); u.mustChangePassword = false; u.passwordChangedAt = new Date().toISOString(); save();
    endSessions(u.username, getCookie(req, 'sfd_session'));
    audit('password-changed', u.username);
    return { status: 200, ok: true };
  }

  return { login, logout, userOf, publicUser, can, canApi, repScope, coScope, scoped, handleAdmin, changeOwnPassword, audit, sessionHours };
};
