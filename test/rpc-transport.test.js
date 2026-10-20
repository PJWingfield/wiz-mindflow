'use strict';
// The production transport (Supabase PostgREST RPC) against a local stand-in that executes the real wiz_* SQL.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const h = require('./helpers/db');
const { createPgliteRpc } = require('./helpers/pglite-rpc');
const { createPostgrestRpc } = require('../lib/rpc');
const { createStore } = require('../lib/store');

const SERVICE_KEY = 'test-service-key-not-real';
const U = '44444444-4444-4444-8444-444444444444';

async function startPostgrest(db, behaviour = {}) {
  const rpc = createPgliteRpc(db);
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      seen.push({ url: req.url, apikey: req.headers.apikey, auth: req.headers.authorization });
      if (behaviour.status) return send(behaviour.status, { message: 'upstream detail' });
      if (behaviour.delayMs) await new Promise(r => setTimeout(r, behaviour.delayMs));
      if (req.headers.apikey !== SERVICE_KEY || req.headers.authorization !== `Bearer ${SERVICE_KEY}`) return send(401, { message: 'Invalid API key' });
      const m = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(req.url);
      if (!m || req.method !== 'POST') return send(404, {});
      try {
        send(200, await rpc(m[1], JSON.parse(Buffer.concat(chunks).toString() || '{}')));
      } catch (err) {
        send(400, { code: 'P0001', message: err.message, details: null, hint: null });
      }
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }) };
}

test('PostgREST transport: real SQL through HTTP, service-role headers, error mapping', async () => {
  const db = await h.openDb();
  await h.loadBaseline(db);
  await h.applyUp(db);
  await h.newAuthUser(db, 'pg@example.test', U);
  const pg = await startPostgrest(db);
  try {
    const store = createStore(createPostgrestRpc({ url: pg.url, serviceKey: SERVICE_KEY }));
    const me = await store.ensureUser(U, 'pg@example.test');
    assert.equal(me.user.id, U);
    assert.equal(pg.seen[0].apikey, SERVICE_KEY);
    assert.equal(pg.seen[0].auth, `Bearer ${SERVICE_KEY}`);
    const g = await store.createGoal(U, { title: 'via http' }, 'http-goal-key-1');
    assert.equal(g.replayed, false);
    assert.equal((await store.createGoal(U, { title: 'via http' }, 'http-goal-key-1')).replayed, true);
    assert.deepEqual((await store.listGoals(U, { ts: null, id: null }, 10)).items.map(x => x.title), ['via http']);

    await assert.rejects(store.getGoal(U, '55555555-5555-4555-8555-555555555555'), err => err.status === 404 && err.code === 'not_found');
    await assert.rejects(store.recordConsent(U, 'save_chats', '7', 'grant'), err => err.status === 409 && err.code === 'stale_consent_version');
    // an unexpected database error is generic and its text never surfaces
    await assert.rejects(store.putOnboarding(U, 'not-an-object', false), err => err.status === 500 && err.code === 'internal_error' && !/object|jsonb|json/i.test(err.message));
  } finally { await pg.close(); await db.close(); }
});

test('PostgREST transport fails closed on 5xx, bad key, unreachable host and timeout', async () => {
  const db = await h.openDb();
  await h.loadBaseline(db);
  await h.applyUp(db);
  try {
    const cases = [
      [{ status: 503 }, SERVICE_KEY], [{ status: 500 }, SERVICE_KEY], [{}, 'wrong-key'], [{ delayMs: 500 }, SERVICE_KEY, 100]
    ];
    for (const [behaviour, key, timeoutMs] of cases) {
      const pg = await startPostgrest(db, behaviour);
      try {
        const store = createStore(createPostgrestRpc({ url: pg.url, serviceKey: key, timeoutMs: timeoutMs || 3000 }));
        await assert.rejects(store.getMe(U), err => err.status === 503 && err.code === 'store_unavailable' && !/upstream|Invalid API/.test(err.message), JSON.stringify(behaviour));
      } finally { await pg.close(); }
    }
    const dead = createStore(createPostgrestRpc({ url: 'http://127.0.0.1:1', serviceKey: SERVICE_KEY, timeoutMs: 500 }));
    await assert.rejects(dead.getMe(U), err => err.status === 503);
  } finally { await db.close(); }
});

// Stubbed fetch: the transport must tell a valid JSON null apart from a body that fails to parse.
test('PostgREST transport: valid JSON null/object succeed; empty or malformed success body is unavailable; errors still mapped', async () => {
  const reply = (status, text) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text) });
  const call = (fetchImpl) => createPostgrestRpc({ url: 'http://127.0.0.1:1', serviceKey: SERVICE_KEY, fetchImpl })('wiz_privacy_erasure_state', {});
  assert.equal(await call(reply(200, 'null')), null);
  assert.deepEqual(await call(reply(200, '{"state":"pending"}')), { state: 'pending' });
  for (const bad of ['', '{not json']) {
    await assert.rejects(call(reply(200, bad)), err => err.name === 'RpcError' && err.kind === 'unavailable' && err.message === 'database unreachable', JSON.stringify(bad));
  }
  await assert.rejects(call(reply(400, '{"message":"wiz:not_found"}')), err => err.kind === 'db' && err.message === 'wiz:not_found');
  await assert.rejects(call(reply(500, 'null')), err => err.kind === 'unavailable' && err.message === 'database error');
  await assert.rejects(call(reply(401, '{"message":"Invalid API key"}')), err => err.kind === 'unavailable' && !/Invalid/.test(err.message));
});
