'use strict';
// Local API harness: real app + real Supabase-Auth adapter talking to a fake GoTrue HTTP server, and the real
// wiz_* SQL running in PGlite behind the same store the production app uses. No network beyond 127.0.0.1.
const http = require('node:http');
const crypto = require('node:crypto');
const h = require('./db');
const { createPgliteRpc } = require('./pglite-rpc');
const { loadConfig } = require('../../lib/config');
const { createApp } = require('../../lib/app');
const { createSupabaseAuth } = require('../../lib/auth');
const { createStore } = require('../../lib/store');

const ANON_KEY = 'test-anon-key-not-real';
// the same keys server.js declares in TRACK_NOTES / LENS_NOTES (checked against server.js in coaching.test.js)
const TRACKS = ['sport', 'career'];
const LENSES = ['mental_wellbeing', 'mind_performance', 'mental_resilience', 'career', 'yourself', 'relationships', 'life_transitions', 'thinking', 'neurodiversity', 'biofeedback', 'learning', 'training', 'life_review'];

// Minimal GoTrue: signup, password login, refresh rotation, logout, user. Users are mirrored into auth.users.
async function startFakeGoTrue(db) {
  const users = new Map(); // email -> { id, password, confirmed }
  const access = new Map(); // token -> user id
  const refresh = new Map(); // token -> user id
  const state = { mode: 'ok', confirmEmail: false, delayMs: 0, anonymousTokens: new Set(), recoveries: [], recoveryTokens: new Map(), userUpdates: [] };
  const issue = (user) => {
    const a = 'at_' + crypto.randomBytes(24).toString('hex');
    const r = 'rt_' + crypto.randomBytes(24).toString('hex');
    access.set(a, user.id);
    refresh.set(r, user.id);
    return { access_token: a, refresh_token: r, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: user.id, email: user.email, aud: 'authenticated', user_metadata: user.data || {} } };
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (state.mode === 'down') return req.socket.destroy();
      if (state.mode === 'error500') return send(500, { msg: 'boom-secret-detail' });
      if (state.delayMs) await new Promise(r => setTimeout(r, state.delayMs));
      if (req.headers.apikey !== ANON_KEY) return send(401, { msg: 'bad apikey' });
      let b = {};
      try { b = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch (_) { return send(400, {}); }
      const url = new URL(req.url, 'http://x');
      const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (url.pathname === '/auth/v1/signup' && req.method === 'POST') {
        if (users.has(b.email)) return send(200, { id: crypto.randomUUID(), email: b.email, aud: 'authenticated' }); // obfuscated like GoTrue
        if (b.password === 'password123') return send(422, { error_code: 'weak_password' });
        const id = crypto.randomUUID();
        const u = { id, email: b.email, password: b.password, data: b.data || {}, confirmed: !state.confirmEmail };
        users.set(b.email, u);
        if (db) await db.query('insert into auth.users (id, email) values ($1, $2)', [id, b.email]);
        return send(200, u.confirmed ? issue(u) : { id, email: b.email, aud: 'authenticated', user_metadata: u.data });
      }
      if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
        const u = users.get(b.email);
        if (!u || u.password !== b.password) return send(400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
        if (!u.confirmed) return send(400, { error_code: 'email_not_confirmed' });
        return send(200, issue(u));
      }
      if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
        const uid = refresh.get(b.refresh_token);
        if (!uid) return send(400, { error_code: 'refresh_token_not_found' });
        refresh.delete(b.refresh_token); // rotation
        return send(200, issue([...users.values()].find(x => x.id === uid)));
      }
      if (url.pathname === '/auth/v1/recover' && req.method === 'POST') { // always 200 (no account disclosure); a known email gets a recovery session
        state.recoveries.push({ email: b.email, redirect_to: url.searchParams.get('redirect_to') });
        const u = users.get(b.email);
        if (u) state.recoveryTokens.set(b.email, issue(u).access_token);
        return send(200, {});
      }
      if (url.pathname === '/auth/v1/user' && req.method === 'PUT') {
        const uid = access.get(bearer);
        if (!uid) return send(401, { msg: 'invalid JWT' });
        const u = [...users.values()].find(x => x.id === uid);
        state.userUpdates.push({ id: uid, hasPassword: typeof b.password === 'string' });
        if (b.password === 'password123') return send(422, { error_code: 'weak_password', msg: 'provider-weak-detail' });
        if (b.password === u.password) return send(422, { error_code: 'same_password', msg: 'provider-same-detail' });
        u.password = b.password;
        return send(200, { id: u.id, email: u.email, aud: 'authenticated', app_metadata: { provider: 'email', secret_marker: 'raw-provider-field' } });
      }
      if (url.pathname === '/auth/v1/logout' && req.method === 'POST') {
        if (!access.has(bearer)) return send(401, {});
        access.delete(bearer);
        return send(204, {});
      }
      if (url.pathname === '/auth/v1/user' && req.method === 'GET') {
        const uid = access.get(bearer);
        if (!uid) return send(401, { msg: 'invalid JWT' });
        const u = [...users.values()].find(x => x.id === uid);
        return send(200, { id: u.id, email: u.email, aud: state.anonymousTokens.has(bearer) ? 'authenticated' : 'authenticated', is_anonymous: state.anonymousTokens.has(bearer) });
      }
      send(404, {});
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, state, users, access, close: () => new Promise(r => { server.closeAllConnections && server.closeAllConnections(); server.close(r); }) };
}

// Raw HTTP client so paths/headers reach the server exactly as written.
function client(port) {
  return function request(method, path, { token, body, headers = {}, raw } = {}) {
    return new Promise((resolve, reject) => {
      const payload = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined;
      const hdrs = { ...headers };
      if (token) hdrs.Authorization = `Bearer ${token}`;
      if (payload !== undefined && !hdrs['Content-Type']) hdrs['Content-Type'] = 'application/json';
      if (payload !== undefined) hdrs['Content-Length'] = Buffer.byteLength(payload);
      const req = http.request({ host: '127.0.0.1', port, method, path, headers: hdrs }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  };
}

async function startApi(opts = {}) {
  const db = opts.db || await h.openDb();
  if (!opts.db) { await h.loadBaseline(db); await h.applyUp(db); }
  const gotrue = await startFakeGoTrue(db);
  const logs = [];
  const logger = (event, fields) => logs.push({ event, ...fields });
  const rpc = opts.rpc || createPgliteRpc(db);
  const providerCalls = [];
  const provider = opts.provider === undefined ? {
    model: 'test-model',
    async complete(args) { providerCalls.push(args); return [{ type: 'text', text: 'fake reply' }]; }
  } : opts.provider;
  const config = loadConfig({ WIZ_CONSENT_FLOW: 'off', WIZ_BILLING_GATE: 'off', ...(opts.env || {}) }); // legacy fixtures predate the Terms/health flow and the paid gate: explicit opt-out
  Object.assign(config.limits, opts.limits || {});
  if (opts.trustProxyHops !== undefined) config.trustProxyHops = opts.trustProxyHops;
  const auth = opts.auth === undefined ? createSupabaseAuth({ url: gotrue.url, anonKey: ANON_KEY, timeoutMs: opts.authTimeoutMs || 3000 }) : opts.auth;
  const store = opts.store === undefined ? createStore(rpc) : opts.store;
  const app = createApp({
    config, auth, store, provider, providers: opts.providers, logger, providerTimeoutMs: opts.providerTimeoutMs, embed: opts.embed,
    buildSystem: (track, lens) => [{ type: 'text', text: 'SYSTEM-STUB' }, { type: 'text', text: `${track}|${lens}` }],
    tracks: TRACKS, lenses: LENSES, now: opts.now
  });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const request = client(server.address().port);
  let n = 0;
  // sign up + log in a fresh account through the real API; returns { token, id, email, refresh }
  async function newAccount(label = 'user') {
    const email = `${label}${++n}-${crypto.randomBytes(3).toString('hex')}@example.test`;
    const password = 'correct horse battery';
    const up = await request('POST', '/api/v1/auth/signup', { body: { email, password, over_18: true } });
    if (up.status !== 201) throw new Error('signup failed ' + up.status + up.text);
    const login = await request('POST', '/api/v1/auth/login', { body: { email, password } });
    if (login.status !== 200) throw new Error('login failed ' + login.status + login.text);
    const me = await request('GET', '/api/v1/me', { token: login.json.session.access_token });
    return { email, password, token: login.json.session.access_token, refresh: login.json.session.refresh_token, id: me.json.user.id };
  }
  // the over-18 attestation that coaching (both chat routes) requires
  async function makeAdult(u, extra = {}) {
    const r = await request('PUT', '/api/v1/me/onboarding', { token: u.token, body: { answers: { over_18: true, ...extra }, complete: true } });
    if (r.status !== 200) throw new Error('onboarding failed ' + r.status + r.text);
  }
  return {
    db, gotrue, request, logs, providerCalls, newAccount, makeAdult, rpc, app,
    close: async () => { await new Promise(r => { server.closeAllConnections(); server.close(r); }); await gotrue.close(); if (!opts.db) await db.close(); }
  };
}

module.exports = { startApi, startFakeGoTrue, client, ANON_KEY };
