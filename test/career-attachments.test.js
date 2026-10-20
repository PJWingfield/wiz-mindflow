'use strict';
// Private attachment lifecycle against the in-memory private object transport (no network, no bucket, no live storage).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startCareerApi } = require('./helpers/career-api');
const { createSupabaseStorageTransport, safeFilename, createAttachments } = require('../lib/attachments');
const { createStore } = require('../lib/store');
const { loadConfig } = require('../lib/config');

let ctx;
test.before(async () => { ctx = await startCareerApi(); await ctx.approveNotices(); });
test.after(async () => { await ctx.close(); });

const code = r => r.json && r.json.error && r.json.error.code;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake image body')]);
const PDF = Buffer.from('%PDF-1.4\nfake pdf\n%%EOF');
async function account(label) {
  const u = await ctx.newAccount(label);
  await ctx.grant(u, 'career_records');
  const api = ctx.as(u);
  const entry = (await api.post('/portfolio', { entry_type: 'qualification', title: 'Certificate', body: 'Level 2' })).json.item;
  return { ...u, api, entry };
}
async function uploaded(u, buf = PNG, mime = 'image/png', name = 'cert.png') {
  const intent = await u.api.post(`/portfolio/${u.entry.id}/attachments`, { filename: name, mime_type: mime, size: buf.length });
  assert.equal(intent.status, 201);
  const put = await u.api.raw('PUT', `/attachments/${intent.json.item.id}/content`, buf, mime);
  assert.equal(put.status, 200);
  return intent.json.item;
}

test('intent -> upload -> finalise -> authorised download; the storage key never reaches the client and is server-selected', async () => {
  const u = await account('att');
  const att = await uploaded(u);
  assert.equal(att.state, 'pending');
  assert.equal(att.object_key, undefined);
  assert.equal(att.user_id, undefined);
  assert.equal(JSON.stringify(att).includes('u/'), false);
  const fin = await u.api.post(`/attachments/${att.id}/finalize`);
  assert.equal(fin.status, 200);
  assert.equal(fin.json.item.state, 'ready');
  assert.equal(fin.json.item.size_bytes, PNG.length);
  assert.equal(fin.json.item.sha256, crypto.createHash('sha256').update(PNG).digest('hex'));
  assert.equal(fin.json.item.object_key, undefined);
  // the key in the transport is owner-prefixed, built from ids only (never from the filename)
  const keys = [...ctx.storage.objects.keys()];
  const key = keys.find(k => k.includes(att.id));
  assert.equal(key, `u/${u.id}/${att.id}`);
  const dl = await ctx.request('GET', `/api/v1/attachments/${att.id}/content`, { token: u.token });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers['content-type'], 'image/png');
  assert.match(dl.headers['content-disposition'], /^attachment; filename="cert.png"/);
  assert.equal(dl.headers['x-content-type-options'], 'nosniff');
  assert.match(dl.headers['cache-control'], /no-store/);
  assert.equal(dl.text.length > 0, true);
  assert.deepEqual((await u.api.get(`/portfolio/${u.entry.id}/attachments`)).json.items.map(a => a.id), [att.id]);
  assert.equal((await ctx.request('GET', `/api/v1/attachments/${att.id}/content`)).status, 401, 'no anonymous or URL-only access');
  // finalise is idempotent
  assert.equal((await u.api.post(`/attachments/${att.id}/finalize`)).json.item.state, 'ready');
});

test('two-account isolation for metadata, bytes and keys', async () => {
  const a = await account('att-a');
  const b = await account('att-b');
  const att = await uploaded(a);
  await a.api.post(`/attachments/${att.id}/finalize`);
  const calls = ctx.storage.state.calls.length;
  for (const [m, p] of [['get', `/attachments/${att.id}`], ['get', `/attachments/${att.id}/content`], ['post', `/attachments/${att.id}/finalize`], ['del', `/attachments/${att.id}`], ['get', `/portfolio/${a.entry.id}/attachments`]]) {
    assert.equal((await b.api[m](p)).status, 404, `${m} ${p}`);
  }
  assert.equal((await b.api.raw('PUT', `/attachments/${att.id}/content`, PNG, 'image/png')).status, 404);
  assert.equal((await b.api.post(`/portfolio/${a.entry.id}/attachments`, { filename: 'x.png', mime_type: 'image/png', size: 10 })).status, 404, 'cannot attach to a foreign entry');
  assert.equal(ctx.storage.state.calls.length, calls, 'no storage call was made on behalf of the other account');
  // a client cannot choose keys or paths: unknown fields are refused and filenames are display-only
  assert.equal((await b.api.post(`/portfolio/${b.entry.id}/attachments`, { filename: 'x.png', mime_type: 'image/png', size: 10, object_key: `u/${a.id}/${att.id}` })).status, 400);
  const sneaky = await b.api.post(`/portfolio/${b.entry.id}/attachments`, { filename: `../../u/${a.id}/${att.id}`, mime_type: 'image/png', size: 10 });
  assert.equal(sneaky.status, 201);
  assert.equal(sneaky.json.item.filename, att.id, "only the last path segment is kept as a display name");
  assert.equal(sneaky.json.item.filename.includes('/'), false);
  assert.equal(safeFilename('..'), null);
  assert.equal(safeFilename('a\\b\\c.pdf'), 'c.pdf');
  // A's file is intact
  assert.equal((await a.api.get(`/attachments/${att.id}/content`)).status, 200);
});

test('verification: type allow-list, size cap, declared size and magic bytes are enforced', async () => {
  const u = await account('att-bad');
  const bad = [
    { filename: 'x.exe', mime_type: 'application/x-msdownload', size: 10 },
    { filename: 'x.svg', mime_type: 'image/svg+xml', size: 10 },
    { filename: 'x.png', mime_type: 'image/png', size: 5 * 1024 * 1024 + 1 },
    { filename: 'x.png', mime_type: 'image/png', size: 0 },
    { filename: '', mime_type: 'image/png', size: 10 },
    { filename: 'x.png', mime_type: 'image/png', size: 10, url: 'https://example.test/x.png' }
  ];
  for (const b of bad) assert.equal((await u.api.post(`/portfolio/${u.entry.id}/attachments`, b)).status, 400, JSON.stringify(b));
  // declared size mismatch / wrong content type at upload
  const i1 = (await u.api.post(`/portfolio/${u.entry.id}/attachments`, { filename: 'a.png', mime_type: 'image/png', size: PNG.length + 1 })).json.item;
  assert.equal(code(await u.api.raw('PUT', `/attachments/${i1.id}/content`, PNG, 'image/png')), 'attachment_invalid');
  const i2 = (await u.api.post(`/portfolio/${u.entry.id}/attachments`, { filename: 'a.png', mime_type: 'image/png', size: PNG.length })).json.item;
  assert.equal(code(await u.api.raw('PUT', `/attachments/${i2.id}/content`, PNG, 'application/pdf')), 'attachment_invalid');
  assert.equal(ctx.storage.objects.size >= 0, true);
  // right size and header, wrong bytes: finalisation discards the object and the metadata
  const fake = Buffer.from('this is not a png at all');
  const i3 = (await u.api.post(`/portfolio/${u.entry.id}/attachments`, { filename: 'fake.png', mime_type: 'image/png', size: fake.length })).json.item;
  assert.equal((await u.api.raw('PUT', `/attachments/${i3.id}/content`, fake, 'image/png')).status, 200);
  assert.ok(ctx.storage.objects.has(`u/${u.id}/${i3.id}`));
  const fin = await u.api.post(`/attachments/${i3.id}/finalize`);
  assert.equal(fin.status, 422);
  assert.equal(code(fin), 'attachment_invalid');
  assert.equal(ctx.storage.objects.has(`u/${u.id}/${i3.id}`), false, 'unverified object discarded');
  assert.equal((await u.api.get(`/attachments/${i3.id}`)).status, 404);
  // finalising before any upload, and downloading a pending attachment, are refused
  assert.equal(code(await u.api.post(`/attachments/${i2.id}/finalize`)), 'attachment_not_uploaded');
  assert.equal(code(await u.api.get(`/attachments/${i2.id}/content`)), 'invalid_state');
  // text files must be real UTF-8 without NULs; PDF needs its signature
  const txt = Buffer.from('plain reference letter');
  const t = await uploaded(u, txt, 'text/plain', 'ref.txt');
  assert.equal((await u.api.post(`/attachments/${t.id}/finalize`)).status, 200);
  const bin = Buffer.from([0x68, 0x00, 0x69]);
  const tb = await uploaded(u, bin, 'text/plain', 'bin.txt');
  assert.equal((await u.api.post(`/attachments/${tb.id}/finalize`)).status, 422);
  const pdf = await uploaded(u, PDF, 'application/pdf', 'cv.pdf');
  assert.equal((await u.api.post(`/attachments/${pdf.id}/finalize`)).json.item.state, 'ready');
  // uploads to a finalised attachment are refused
  assert.equal(code(await u.api.raw('PUT', `/attachments/${pdf.id}/content`, PDF, 'application/pdf')), 'invalid_state');
});

test('integrity: a tampered or missing stored object is never served', async () => {
  const u = await account('att-integrity');
  const att = await uploaded(u);
  await u.api.post(`/attachments/${att.id}/finalize`);
  const key = `u/${u.id}/${att.id}`;
  ctx.storage.objects.get(key).buffer = Buffer.concat([PNG.subarray(0, PNG.length - 1), Buffer.from('X')]);
  assert.equal(code(await u.api.get(`/attachments/${att.id}/content`)), 'attachment_corrupt');
  ctx.storage.objects.delete(key);
  assert.equal(code(await u.api.get(`/attachments/${att.id}/content`)), 'attachment_missing');
});

test('delete removes the object then the row; a failed cleanup is explicit, keeps the row and is retryable', async () => {
  const u = await account('att-del');
  const att = await uploaded(u);
  await u.api.post(`/attachments/${att.id}/finalize`);
  const key = `u/${u.id}/${att.id}`;
  ctx.storage.state.failDelete = true;
  const fail = await u.api.del(`/attachments/${att.id}`);
  assert.equal(fail.status, 502);
  assert.equal(code(fail), 'attachment_cleanup_failed');
  assert.equal(fail.json.error.attachment.state, 'delete_failed');
  assert.equal(fail.json.error.attachment.cleanup_attempts, 1);
  assert.equal(fail.json.error.attachment.object_key, undefined);
  assert.ok(ctx.storage.objects.has(key), 'object still there, and the metadata still points at it');
  const meta = (await u.api.get(`/attachments/${att.id}`)).json.item;
  assert.equal(meta.state, 'delete_failed');
  assert.equal(code(await u.api.get(`/attachments/${att.id}/content`)), 'invalid_state', 'a half-deleted file is not served');
  assert.equal((await u.api.del(`/attachments/${att.id}`)).status, 502);
  assert.equal((await u.api.get(`/attachments/${att.id}`)).json.item.cleanup_attempts, 2);
  // the portfolio entry cannot be deleted while a file is stuck, and nothing is lost
  assert.equal(code(await u.api.del(`/portfolio/${u.entry.id}`)), 'attachment_cleanup_failed');
  assert.equal((await u.api.get(`/portfolio/${u.entry.id}`)).status, 200);
  ctx.storage.state.failDelete = false;
  assert.equal((await u.api.del(`/attachments/${att.id}`)).status, 200);
  assert.equal(ctx.storage.objects.has(key), false);
  assert.equal((await u.api.get(`/attachments/${att.id}`)).status, 404);
  assert.ok(ctx.logs.some(l => l.event === 'attachment_cleanup_failed'));
});

test('deleting a portfolio entry removes its attachments first', async () => {
  const u = await account('att-entry');
  const a1 = await uploaded(u);
  const a2 = await uploaded(u, PDF, 'application/pdf', 'cv.pdf');
  await u.api.post(`/attachments/${a1.id}/finalize`);
  await u.api.post(`/attachments/${a2.id}/finalize`);
  assert.equal((await u.api.del(`/portfolio/${u.entry.id}`)).status, 200);
  assert.equal(ctx.storage.objects.has(`u/${u.id}/${a1.id}`) || ctx.storage.objects.has(`u/${u.id}/${a2.id}`), false);
  assert.equal((await u.api.get(`/attachments/${a1.id}`)).status, 404);
});

test('storage failures are explicit 502s; limits, consent and idempotency apply', async () => {
  const u = await account('att-misc');
  const intentBody = { filename: 'a.png', mime_type: 'image/png', size: PNG.length };
  const key = 'att-key-' + Math.random().toString(36).slice(2);
  const r1 = await u.api.post(`/portfolio/${u.entry.id}/attachments`, intentBody, key);
  const r2 = await u.api.post(`/portfolio/${u.entry.id}/attachments`, intentBody, key);
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 200);
  assert.equal(r2.json.item.id, r1.json.item.id);
  assert.deepEqual(r1.json.limits.mime_types.sort(), ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/plain']);
  ctx.storage.state.failPut = true;
  const put = await u.api.raw('PUT', `/attachments/${r1.json.item.id}/content`, PNG, 'image/png');
  assert.equal(put.status, 502);
  assert.equal(code(put), 'storage_unavailable');
  ctx.storage.state.failPut = false;
  assert.equal((await u.api.raw('PUT', `/attachments/${r1.json.item.id}/content`, PNG, 'image/png')).status, 200);
  ctx.storage.state.failGet = true;
  assert.equal(code(await u.api.post(`/attachments/${r1.json.item.id}/finalize`)), 'storage_unavailable');
  ctx.storage.state.failGet = false;
  assert.equal((await u.api.post(`/attachments/${r1.json.item.id}/finalize`)).status, 200);
  // five per entry
  for (let i = 0; i < 4; i++) assert.equal((await u.api.post(`/portfolio/${u.entry.id}/attachments`, intentBody)).status, 201);
  assert.equal(code(await u.api.post(`/portfolio/${u.entry.id}/attachments`, intentBody)), 'attachment_limit');
  // revoked storage consent blocks new attachments but not removing them
  await ctx.grant(u, 'career_records', 'revoke');
  assert.equal(code(await u.api.post(`/portfolio/${u.entry.id}/attachments`, intentBody)), 'consent_required');
  assert.equal((await u.api.del(`/attachments/${r1.json.item.id}`)).status, 200);
});

test('without a configured private bucket the attachment routes fail closed (503) and nothing is stored', async () => {
  const bare = await startCareerApi({ db: ctx.db, noStorage: true });
  try {
    const u = await bare.newAccount('att-nostorage');
    await bare.grant(u, 'career_records');
    const api = bare.as(u);
    const e = (await api.post('/portfolio', { entry_type: 'other', title: 't', body: 'b' })).json.item;
    const r = await api.post(`/portfolio/${e.id}/attachments`, { filename: 'a.png', mime_type: 'image/png', size: 10 });
    assert.equal(r.status, 503);
    assert.equal(code(r), 'storage_unavailable');
    assert.equal(bare.storage.state.calls.length, 0);
  } finally { await bare.close(); }
});

test('Supabase Storage adapter: private bucket paths, service credential only server-side, no public URL (fixture fetch, no network)', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, arrayBuffer: async () => PNG }; };
  const t = createSupabaseStorageTransport({ url: 'https://proj.example.test', serviceKey: 'service-fixture-not-real', bucket: 'career-private', fetchImpl });
  const key = 'u/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222';
  await t.put(key, PNG, 'image/png');
  assert.equal((await t.get(key)).length, PNG.length);
  await t.delete(key);
  assert.deepEqual(seen.map(s => s.init.method), ['POST', 'GET', 'DELETE']);
  const [putCall, getCall, delCall] = seen;
  assert.equal(putCall.url, `https://proj.example.test/storage/v1/object/career-private/${key}`);
  assert.equal(putCall.init.headers['Content-Type'], 'image/png');
  assert.equal(getCall.url, `https://proj.example.test/storage/v1/object/career-private/${key}`);
  assert.equal(delCall.url, 'https://proj.example.test/storage/v1/object/career-private');
  assert.equal(delCall.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(delCall.init.body), { prefixes: [key] });
  for (const s of seen) {
    assert.ok(!s.url.includes('/public/') && !s.url.includes('sign'), 'authenticated object API only');
    assert.equal(s.init.headers.Authorization, 'Bearer service-fixture-not-real');
    assert.equal(s.init.headers.apikey, 'service-fixture-not-real');
  }
  const cfg = loadConfig({ SUPABASE_URL: 'https://proj.example.test', SUPABASE_SERVICE_ROLE_KEY: 'k', WIZ_ATTACHMENT_BUCKET: 'career-private' });
  assert.equal(cfg.storage.bucket, 'career-private');
  assert.equal(loadConfig({ SUPABASE_URL: 'https://proj.example.test', SUPABASE_SERVICE_ROLE_KEY: 'k', WIZ_ATTACHMENT_BUCKET: '../x' }).storage.bucket, null);
  assert.equal(loadConfig({}).storage.bucket, null);
  // upstream failure surfaces as an error (not silent success); a missing object reads as null
  const failing = createSupabaseStorageTransport({ url: 'https://proj.example.test', serviceKey: 'k', bucket: 'b', fetchImpl: async () => ({ ok: false, status: 500 }) });
  await assert.rejects(failing.delete(key));
  const missing = createSupabaseStorageTransport({ url: 'https://proj.example.test', serviceKey: 'k', bucket: 'b', fetchImpl: async () => ({ ok: false, status: 404 }) });
  assert.equal(await missing.get(key), null);
  await assert.rejects(missing.delete(key));
  // body-timeout contract: exchange aborts and rejects when reading the response body stalls
  const stalled = createSupabaseStorageTransport({
    url: 'https://proj.example.test',
    serviceKey: 'k',
    bucket: 'b',
    timeoutMs: 30,
    fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: () => new Promise(r => setTimeout(r, 100)) })
  });
  await assert.rejects(stalled.get(key), err => err.name === 'StorageTimeout');
});

test('sweeper removes only old abandoned attachments (pending, interrupted deletes) and never ready ones', async () => {
  const u = await account('sweep');
  const oldPending = await uploaded(u, PNG, 'image/png', 'old-pending.png');   // uploaded to storage, never finalised
  const oldNoObject = (await u.api.post(`/portfolio/${u.entry.id}/attachments`, { filename: 'never.png', mime_type: 'image/png', size: PNG.length })).json.item;
  const ready = await uploaded(u, PNG, 'image/png', 'ready.png');
  assert.equal((await u.api.post(`/attachments/${ready.id}/finalize`)).status, 200);
  const fresh = (await u.api.post(`/portfolio/${u.entry.id}/attachments`, { filename: 'fresh.png', mime_type: 'image/png', size: PNG.length })).json.item;
  // age everything except the fresh pending one by two days
  await ctx.db.query(`update public.wiz_attachments set created_at = now() - interval '2 days' where id = any($1::uuid[])`, [[oldPending.id, oldNoObject.id, ready.id]]);
  const attachments = createAttachments({ store: createStore(ctx.rpc), transport: ctx.storage, logger: () => {} });
  await assert.rejects(() => attachments.sweepAbandoned({ olderThanSeconds: 60 }), /at least 3600/);
  await assert.rejects(() => attachments.sweepAbandoned({ limit: 0 }), /limit/);
  const keyOf = id => [...ctx.storage.objects.keys()].find(k => k.includes(id));
  assert.ok(keyOf(oldPending.id));
  const res = await attachments.sweepAbandoned({ olderThanSeconds: 86400, limit: 50 });
  assert.deepEqual(res, { found: 2, removed: 2, failed: 0 });
  const ids = (await ctx.db.query('select id, state from public.wiz_attachments where user_id = $1', [u.id])).rows;
  const byId = Object.fromEntries(ids.map(r => [r.id, r.state]));
  assert.equal(byId[oldPending.id], undefined);
  assert.equal(byId[oldNoObject.id], undefined);
  assert.equal(byId[ready.id], 'ready');
  assert.equal(byId[fresh.id], 'pending');
  assert.equal(keyOf(oldPending.id), undefined);          // stored object removed
  assert.ok(keyOf(ready.id));                              // ready object untouched
  assert.deepEqual(await attachments.sweepAbandoned({ olderThanSeconds: 86400 }), { found: 0, removed: 0, failed: 0 });
});
