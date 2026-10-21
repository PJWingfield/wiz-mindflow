'use strict';
// Career API harness: foundation + career migration (PGlite), real app/store/auth adapter, in-memory private storage.
const http = require('node:http');
const crypto = require('node:crypto');
const { startFakeGoTrue, client, ANON_KEY } = require('./api');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./db');
const { openCareerDb } = require('./career-db');
const SWEEP_SQL = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', '20261016000200_wiz_attachment_sweep.sql'), 'utf8');
const { createPgliteRpc } = require('./pglite-rpc');
const { createMemoryStorage } = require('./memory-storage');
const { loadConfig } = require('../../lib/config');
const { createApp } = require('../../lib/app');
const { createSupabaseAuth } = require('../../lib/auth');
const { createStore } = require('../../lib/store');

const TRACKS = ['sport', 'career'];
const LENSES = ['career', 'yourself', 'learning'];

async function startCareerApi(opts = {}) {
  const db = opts.db || await openCareerDb();
  if (!opts.db) await h.applyUp(db, SWEEP_SQL); // additive operator-sweep function (separate migration)
  const gotrue = await startFakeGoTrue(db);
  const storage = createMemoryStorage();
  const providerCalls = [];
  const provider = opts.provider || { model: 'test-model', async complete(args) { providerCalls.push(args); return [{ type: 'text', text: 'fake reply' }]; } };
  const config = loadConfig({ WIZ_CONSENT_FLOW: 'off', WIZ_BILLING_GATE: 'off', ...(opts.env || {}) }); // legacy fixtures predate the Terms/health flow and the paid gate: explicit opt-out
  Object.assign(config.limits, { authPerMinute: 1e6, apiPerMinute: 1e6, publicPerMinute: 1e6, chatPerMinute: 1e6 });
  const rpc = createPgliteRpc(db);
  const store = createStore(rpc);
  const logs = [];
  const app = createApp({
    config, store, provider, providers: opts.providers, authAdmin: opts.authAdmin, storage: opts.noStorage ? null : storage, retrieval: opts.retrieval, stripe: opts.stripe,
    auth: createSupabaseAuth({ url: gotrue.url, anonKey: ANON_KEY, timeoutMs: 3000 }),
    logger: (event, fields) => logs.push({ event, ...fields }),
    buildSystem: (track, lens) => [{ type: 'text', text: 'SYSTEM-STUB' }, { type: 'text', text: `${track}|${lens}` }],
    tracks: TRACKS, lenses: LENSES
  });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const request = client(port);
  let n = 0;
  async function newAccount(label = 'user') {
    const email = `${label}${++n}-${crypto.randomBytes(3).toString('hex')}@example.test`;
    const password = 'correct horse battery';
    await request('POST', '/api/v1/auth/signup', { body: { email, password, over_18: true } });
    const login = await request('POST', '/api/v1/auth/login', { body: { email, password } });
    const token = login.json.session.access_token;
    const me = await request('GET', '/api/v1/me', { token });
    return { email, token, id: me.json.user.id };
  }
  // Synthetic LOCAL approval of the seeded notices (real approval is an owner action) + the account's own grants
  const approveNotices = () => db.exec('update public.wiz_consent_versions set legal_approved = true');
  const grant = (u, purpose, action = 'grant') => request('POST', '/api/v1/consents', { token: u.token, body: { purpose, version: '1', action } });
  const as = u => ({
    get: p => request('GET', '/api/v1' + p, { token: u.token }),
    post: (p, body, key) => request('POST', '/api/v1' + p, { token: u.token, body, headers: key ? { 'Idempotency-Key': key } : {} }),
    put: (p, body) => request('PUT', '/api/v1' + p, { token: u.token, body }),
    patch: (p, body) => request('PATCH', '/api/v1' + p, { token: u.token, body }),
    del: p => request('DELETE', '/api/v1' + p, { token: u.token }),
    raw: (method, p, buf, type) => request(method, '/api/v1' + p, { token: u.token, raw: buf, headers: { 'Content-Type': type } })
  });
  return {
    db, gotrue, app, request, port, newAccount, approveNotices, grant, as, storage, providerCalls, logs, rpc,
    close: async () => { await new Promise(r => { server.closeAllConnections(); server.close(r); }); await gotrue.close(); if (!opts.db) await db.close(); }
  };
}

module.exports = { startCareerApi };
