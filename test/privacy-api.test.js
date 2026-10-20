'use strict';
// Privacy controls end to end: real app + real wiz_* SQL (all four stages) in PGlite, fixture GoTrue, fixture Auth admin and
// in-memory private storage. No network beyond 127.0.0.1, no credentials, nothing live.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startPrivacyApi } = require('./helpers/privacy-api');
const { createStore } = require('../lib/store');
const { RpcError } = require('../lib/rpc');

let ctx;
test.before(async () => { ctx = await startPrivacyApi(); await ctx.approveNotices(); });
test.after(async () => { await ctx.close(); });

const code = r => r.json && r.json.error && r.json.error.code;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('privacy fixture image')]);
const CONFIRM_ERASE = { confirm: 'erase_my_account' };
const CONFIRM_SESSION = { confirm: 'delete_session' };
let n = 0;
const key = () => `pk-${++n}-${Math.random().toString(36).slice(2, 10)}`;

// every table with an owner column, with its row count for one user
async function ownedCounts(userId) {
  const tables = (await ctx.db.query(`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'user_id' order by 1`)).rows.map(r => r.table_name);
  const out = {};
  for (const t of tables) out[t] = (await ctx.db.query(`select count(*)::int n from public.${t} where user_id = $1`, [userId])).rows[0].n;
  return out;
}
const total = c => Object.values(c).reduce((a, b) => a + b, 0);

async function rich(label, marker) {
  const u = await ctx.newAccount(label);
  const api = ctx.as(u);
  for (const p of ['save_chats', 'personalisation', 'career_records']) await ctx.grant(u, p);
  await api.put('/me/onboarding', { answers: { over_18: true, hint: marker + '-onboarding' }, complete: true });
  const s1 = (await api.post('/sessions', { topic: { kind: 'custom', text: marker + '-topic' } })).json.item;
  const s2 = (await api.post('/sessions', { topic: { kind: 'custom', text: 'second' } })).json.item;
  await api.patch('/sessions/' + s2.id, { is_archived: true });
  for (const t of [marker + '-hello', marker + '-again']) {
    assert.equal((await api.post(`/sessions/${s1.id}/messages`, { content: t }, key())).status, 201);
  }
  await api.put(`/sessions/${s1.id}/checkpoint`, { checkpoint: { note: marker + '-checkpoint' } });
  const goal = (await api.post('/goals', { title: marker + '-goal', session_id: s1.id })).json.item;
  const journal = (await api.post('/journal', { body: marker + '-journal', session_id: s1.id })).json.item;
  const report = (await api.post('/reports', { kind: 'summary', title: marker + '-report', body: 'b', session_id: s1.id })).json.item;
  const evidence = (await api.post('/evidence', { statement: marker + '-evidence', session_id: s1.id })).json.item;
  await api.patch('/evidence/' + evidence.id, { statement: marker + '-evidence-corrected', expected_version: 1 });
  await api.put('/training/module_one', { status: 'in_progress', percent: 30 });
  const entry = (await api.post('/portfolio', { entry_type: 'project', title: marker + '-portfolio', body: 'b' })).json.item;
  const intent = (await api.post(`/portfolio/${entry.id}/attachments`, { filename: 'proof.png', mime_type: 'image/png', size: PNG.length })).json.item;
  await api.raw('PUT', `/attachments/${intent.id}/content`, PNG, 'image/png');
  await api.post(`/attachments/${intent.id}/finalize`);
  const pl = (await api.post('/prior-learning', { experience: marker + '-exp', skill: 's', application: 'a' })).json.item;
  await api.post(`/prior-learning/${pl.id}/promote`);
  await api.post('/networking', { contact_label: marker + '-net' });
  await api.post('/support-map', { label: marker + '-support', support_role: 'r' });
  await api.post('/pulses', { stress: 6, energy: 4, note: marker + '-pulse' });
  await api.put('/career-plan', { plan: { direction: marker + '-plan', goal_ids: [goal.id] } });
  await api.put('/learning-profile', { profile: { focus_notes: marker + '-learning' } });
  await ctx.db.query("update public.users set subscription_status = 'active', subscription_tier = 'pro', stripe_customer_id = 'cus_SECRETVALUE' where id = $1", [u.id]);
  await ctx.db.query('insert into public.user_documents (user_id) values ($1)', [u.id]);
  return { ...u, api, s1, s2, goal, journal, report, evidence, entry, attachment: intent };
}

test('export is complete and consistent: every owned table, beyond normal pagination, no billing or key material', async () => {
  const a = await rich('exp-a', 'MARKA');
  const b = await rich('exp-b', 'MARKB');
  // volume past every list limit (100): 130 journal entries, 130 more messages, 105 more goals
  await ctx.db.query("insert into public.wiz_journal_entries (user_id, body) select $1, 'bulk-journal-' || g from generate_series(1, 130) g", [a.id]);
  await ctx.db.query("insert into public.wiz_goals (user_id, title) select $1, 'bulk-goal-' || g from generate_series(1, 105) g", [a.id]);
  for (let i = 0; i < 130; i++) await ctx.rpc('wiz_message_append', { p_user_id: a.id, p_session_id: a.s1.id, p_sender: 'user', p_content: 'bulk-msg-' + i, p_tokens: 0, p_key: null, p_model: null, p_provenance: {} });

  const r = await a.api.get('/account/export');
  assert.equal(r.status, 200);
  assert.match(r.headers['cache-control'], /no-store/);
  assert.match(r.headers['content-disposition'], /attachment/);
  const d = r.json;
  assert.equal(d.schema, 'wiz.account-export');
  assert.equal(d.version, 1);
  assert.ok(Date.parse(d.generated_at) > 0);
  assert.equal(d.account.id, a.id);
  assert.equal(d.account.email, a.email);
  assert.equal(d.profile.onboarding.hint, 'MARKA-onboarding');
  assert.equal(d.profile.learning_profile.focus_notes, 'MARKA-learning');
  assert.ok(d.consents.events.length >= 3);
  assert.ok(d.consents.current.some(c2 => c2.purpose === 'career_records' && c2.granted));
  assert.equal(d.sessions.length, 2, 'active and archived sessions');
  const s1 = d.sessions.find(s => s.id === a.s1.id);
  assert.equal(s1.messages.length, 132, 'complete transcript, not a first page');
  assert.equal(s1.messages[0].content, 'MARKA-hello');
  assert.deepEqual(s1.checkpoint, { note: 'MARKA-checkpoint' });
  assert.equal(d.sessions.find(s => s.id === a.s2.id).is_archived, true);
  assert.equal(d.goals.length, 106);
  assert.equal(d.journal_entries.length, 131);
  assert.equal(d.reports.length, 1);
  assert.equal(d.profile_evidence.length, 1);
  assert.equal(d.profile_evidence_revisions.length >= 1, true);
  assert.equal(d.training.length, 1);
  assert.ok('pairing' in d);
  assert.equal(d.career.plan.plan.direction, 'MARKA-plan');
  assert.equal(d.career.prior_learning.length, 1);
  assert.equal(d.career.portfolio.length, 2, 'own entry + the promoted prior-learning entry');
  assert.equal(d.career.networking_log.length, 1);
  assert.equal(d.career.support_map.length, 1);
  assert.equal(d.career.wellbeing_pulses.length, 1);
  assert.equal(d.career.attachments.length, 1);
  assert.equal(d.legacy_documents.length, 1);

  // attachment: metadata + an owner-authenticated download path, never a storage key or URL
  const att = d.career.attachments[0];
  assert.equal(att.download_path, `/api/v1/attachments/${a.attachment.id}/content`);
  assert.equal(att.object_key, undefined);
  const dl = await ctx.request('GET', att.download_path, { token: a.token });
  assert.equal(dl.status, 200);
  assert.equal((await ctx.request('GET', att.download_path, { token: b.token })).status, 404);
  assert.equal((await ctx.request('GET', att.download_path)).status, 401);

  // no billing, key, storage or other-account material anywhere in the document
  const text = JSON.stringify(d);
  for (const bad of ['cus_SECRETVALUE', 'stripe', 'subscription', 'object_key', `u/${a.id}/`, 'MARKB', b.id, b.email, 'service_role', 'apikey', 'Bearer', 'user_id']) {
    assert.equal(text.includes(bad), false, 'export leaks ' + bad);
  }
  assert.equal(d.idempotency, undefined);
  // body/query cannot choose an owner
  const spoof = await ctx.request('GET', `/api/v1/account/export?user_id=${b.id}`, { token: a.token });
  assert.equal(spoof.json.account.id, a.id);
  assert.equal((await ctx.request('GET', '/api/v1/account/export')).status, 401);
  // B's export has only B
  const rb = (await b.api.get('/account/export')).json;
  assert.equal(JSON.stringify(rb).includes('MARKA'), false);
  assert.equal(rb.sessions.length, 2);
});

test('every owner-keyed table is either in the export or explicitly excluded (guards future tables)', async () => {
  const tables = (await ctx.db.query(`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'user_id' order by 1`)).rows.map(r => r.table_name);
  const exported = new Set(['wiz_user_profiles', 'wiz_consent_events', 'wiz_session_meta', 'wiz_message_meta', 'conversations', 'wiz_goals', 'wiz_journal_entries', 'wiz_reports',
    'wiz_profile_evidence', 'wiz_profile_evidence_revisions', 'wiz_training_progress', 'wiz_pairing_status', 'wiz_career_plans', 'wiz_prior_learning', 'wiz_portfolio_entries',
    'wiz_networking_log', 'wiz_support_map', 'wiz_wellbeing_pulses', 'wiz_attachments', 'user_documents']);
  const excluded = new Set(['wiz_idempotency', 'wiz_erasure_receipts']); // replay keys / the erasure receipt itself: not account content
  const unknown = tables.filter(t => !exported.has(t) && !excluded.has(t));
  assert.deepEqual(unknown, [], 'new owner-keyed table must be added to wiz_privacy_export or excluded here with a reason');
});

test('export failure is an explicit error, never a partial document', async () => {
  const mk = message => createStore(async () => { throw new RpcError('db', message); });
  await assert.rejects(mk('wiz:export_too_large').accountExport('x'), err => err.status === 413 && err.code === 'export_too_large');
  await assert.rejects(createStore(async () => { throw new RpcError('unavailable', 'database unreachable'); }).accountExport('x'), err => err.status === 503);
  const u = await ctx.newAccount('exp-empty');
  const r = await ctx.as(u).get('/account/export'); // a brand-new account exports cleanly with empty sections
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.sessions, []);
  assert.equal(r.json.career.plan, null);
});

test('privacy controls stay usable after every consent is revoked, and never change consent', async () => {
  const u = await rich('revoked', 'MARKR');
  for (const p of ['save_chats', 'personalisation', 'career_records']) await ctx.grant(u, p, 'revoke');
  const before = (await u.api.get('/consents')).json.purposes;
  assert.equal((await u.api.get('/account/export')).status, 200);
  assert.equal((await u.api.del('/sessions/' + u.s2.id)).status, 400, 'confirmation still required');
  const del = await ctx.request('DELETE', `/api/v1/sessions/${u.s2.id}`, { token: u.token, body: CONFIRM_SESSION });
  assert.equal(del.status, 200);
  assert.deepEqual((await u.api.get('/consents')).json.purposes, before, 'consent state unchanged by privacy calls');
  assert.equal((await ctx.request('POST', '/api/v1/account/erasure', { token: u.token, body: CONFIRM_ERASE })).status, 200);
});

test('session deletion: explicit confirmation, owner scoped, transcript + metadata + replay keys gone, independent records kept', async () => {
  const a = await rich('sd-a', 'MARKS');
  const b = await rich('sd-b', 'MARKT');
  const del = (u, id, body) => ctx.request('DELETE', `/api/v1/sessions/${id}`, { token: u.token, body });
  assert.equal(code(await del(a, a.s1.id)), 'confirmation_required', 'no body');
  assert.equal(code(await del(a, a.s1.id, {})), 'confirmation_required');
  assert.equal(code(await del(a, a.s1.id, { confirm: 'yes' })), 'confirmation_required');
  assert.equal(code(await del(a, a.s1.id, { confirm: true })), 'invalid_request', 'wrong type');
  assert.equal((await del(a, a.s1.id, { ...CONFIRM_SESSION, user_id: b.id })).status, 400, 'body cannot name an owner');
  assert.equal((await del(b, a.s1.id, CONFIRM_SESSION)).status, 404, 'another account cannot delete it');
  assert.equal((await ctx.request('DELETE', `/api/v1/sessions/${a.s1.id}`, { body: CONFIRM_SESSION })).status, 401);
  assert.equal((await a.api.get('/sessions/' + a.s1.id)).status, 200, 'refusals deleted nothing');
  const idemBefore = (await ctx.db.query("select count(*)::int n from public.wiz_idempotency where user_id = $1 and scope = $2", [a.id, 'message:' + a.s1.id])).rows[0].n;
  assert.equal(idemBefore, 2);

  const ok = await del(a, a.s1.id, CONFIRM_SESSION);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { deleted: true, messages_removed: 2 });
  const q = async (sql, args) => (await ctx.db.query(sql, args)).rows[0].n;
  assert.equal(await q('select count(*)::int n from public.conversations where id = $1', [a.s1.id]), 0);
  assert.equal(await q('select count(*)::int n from public.messages where conversation_id = $1', [a.s1.id]), 0);
  assert.equal(await q('select count(*)::int n from public.wiz_session_meta where session_id = $1', [a.s1.id]), 0);
  assert.equal(await q('select count(*)::int n from public.wiz_message_meta where session_id = $1', [a.s1.id]), 0);
  assert.equal(await q("select count(*)::int n from public.wiz_idempotency where user_id = $1 and (scope = $2 or (scope = 'session' and result_id = $3))", [a.id, 'message:' + a.s1.id, a.s1.id]), 0);
  assert.equal((await a.api.get('/sessions/' + a.s1.id)).status, 404);
  assert.equal(code(await del(a, a.s1.id, CONFIRM_SESSION)), 'not_found', 'repeat is a clean 404');
  // independently saved records survive, only the optional session link is cleared
  for (const [p, rec] of [['/goals/', a.goal], ['/journal/', a.journal], ['/reports/', a.report]]) {
    const got = await a.api.get(p + rec.id);
    assert.equal(got.status, 200, p);
    assert.equal(got.json.item.session_id, null, p);
  }
  assert.equal((await a.api.get('/evidence')).json.items[0].session_id, null);
  assert.equal((await a.api.get('/portfolio/' + a.entry.id)).status, 200);
  assert.equal((await a.api.get('/sessions/' + a.s2.id)).status, 200, 'other sessions untouched');
  // the other account is untouched
  assert.equal((await b.api.get('/sessions/' + b.s1.id)).status, 200);
  assert.equal((await b.api.get(`/sessions/${b.s1.id}/messages`)).json.items.length, 2);
  // the deleted transcript is gone from the export too
  assert.equal(JSON.stringify((await a.api.get('/account/export')).json).includes('MARKS-hello'), false);
});

test('erasure requires explicit confirmation and only the verified bearer; nothing is touched on refusal', async () => {
  const a = await rich('er-confirm', 'MARKC');
  const b = await rich('er-other', 'MARKD');
  const post = (u, body) => ctx.request('POST', '/api/v1/account/erasure', { token: u && u.token, body });
  assert.equal(code(await post(a)), 'confirmation_required', 'no body');
  assert.equal(code(await post(a, {})), 'confirmation_required');
  assert.equal(code(await post(a, { confirm: 'yes please' })), 'confirmation_required');
  assert.equal(code(await post(a, { confirm: 'delete_session' })), 'confirmation_required');
  assert.equal((await post(a, { ...CONFIRM_ERASE, user_id: b.id })).status, 400, 'a body user id is rejected, never used as owner');
  assert.equal((await post(null, CONFIRM_ERASE)).status, 401);
  assert.equal(code(await ctx.request('GET', '/api/v1/account/erasure', { token: 'at_forged' })), 'invalid_token');
  assert.deepEqual((await a.api.get('/account/erasure')).json, { state: 'none' });
  assert.equal((await ctx.db.query('select count(*)::int n from public.wiz_erasure_receipts')).rows[0].n >= 0, true);
  assert.equal(total(await ownedCounts(a.id)) > 10, true);
  assert.equal((await a.api.get('/me')).status, 200);
  assert.equal(ctx.admin.state.calls.filter(c2 => c2[1] === a.id).length, 0);
});

test('erasure success: storage objects, identity and every owned row are gone; other accounts untouched; id cannot be recreated', async () => {
  const a = await rich('er-ok', 'MARKE');
  const b = await rich('er-ok-b', 'MARKF');
  const aKey = `u/${a.id}/${a.attachment.id}`;
  const bKey = `u/${b.id}/${b.attachment.id}`;
  assert.ok(ctx.storage.objects.has(aKey) && ctx.storage.objects.has(bKey));
  const countsB = await ownedCounts(b.id);
  assert.ok(total(await ownedCounts(a.id)) > 20);

  const r = await ctx.request('POST', '/api/v1/account/erasure', { token: a.token, body: CONFIRM_ERASE });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.erased, true);
  assert.equal(r.json.receipt.state, 'completed');
  assert.equal(ctx.storage.objects.has(aKey), false, 'private object removed');
  assert.equal(ctx.storage.objects.has(bKey), true);
  const left = await ownedCounts(a.id);
  assert.deepEqual(Object.entries(left).filter(([, c2]) => c2 > 0), [], 'no owned row remains in any table');
  assert.equal((await ctx.db.query('select count(*)::int n from public.users where id = $1', [a.id])).rows[0].n, 0);
  assert.equal((await ctx.db.query('select count(*)::int n from public.conversations where user_id = $1', [a.id])).rows[0].n, 0);
  assert.equal((await ctx.db.query('select count(*)::int n from public.messages m where not exists (select 1 from public.conversations c where c.id = m.conversation_id)')).rows[0].n, 0);
  // identity: the bearer no longer works and login fails
  assert.equal((await ctx.request('GET', '/api/v1/me', { token: a.token })).status, 401);
  assert.equal((await ctx.request('POST', '/api/v1/auth/login', { body: { email: a.email, password: 'correct horse battery' } })).status, 401);
  // receipt: minimal, no id kept, one-way hash only
  const rec = (await ctx.db.query('select * from public.wiz_erasure_receipts where id = $1', [r.json.receipt.id])).rows[0];
  assert.equal(rec.state, 'completed');
  assert.equal(rec.user_id, null);
  assert.match(rec.subject_hash, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(rec).includes(a.email), false);
  // the same id cannot be re-created by the application tables
  await assert.rejects(ctx.db.query('insert into public.users (id, email) values ($1, $2)', [a.id, a.email]), /erasure_pending/);
  // other account fully intact
  assert.deepEqual(await ownedCounts(b.id), countsB);
  assert.equal((await b.api.get('/me')).status, 200);
  assert.equal((await ctx.request('GET', `/api/v1/attachments/${b.attachment.id}/content`, { token: b.token })).status, 200);
});

test('storage failure: erasure stays pending and visible, the account is closed, nothing else is deleted, and a retry completes', async () => {
  const a = await rich('er-storage', 'MARKG');
  const key2 = `u/${a.id}/${a.attachment.id}`;
  ctx.storage.state.failDelete = true;
  const authCallsBefore = ctx.admin.state.calls.length;
  const r = await ctx.request('POST', '/api/v1/account/erasure', { token: a.token, body: CONFIRM_ERASE });
  assert.equal(r.status, 503);
  assert.equal(code(r), 'erasure_incomplete');
  assert.equal(r.json.error.erasure.phase, 'storage');
  assert.equal(r.json.error.erasure.state, 'pending');
  assert.match(r.json.error.erasure.receipt_id, /^[0-9a-f-]{36}$/);
  assert.equal(JSON.stringify(r.json).includes(a.id), false, 'error carries the receipt, not internals');
  assert.equal(ctx.admin.state.calls.length, authCallsBefore, 'Auth is not touched before storage is clean');
  assert.ok(ctx.storage.objects.has(key2));
  assert.ok(total(await ownedCounts(a.id)) > 20, 'application data not yet removed');
  // the pending account is closed to normal use and cannot be re-opened by any request
  for (const [m, p, b] of [['GET', '/me'], ['GET', '/goals'], ['POST', '/goals', { title: 'sneaky' }], ['POST', '/sessions', { topic: { kind: 'custom', text: 'x' } }]]) {
    const x = await ctx.request(m, '/api/v1' + p, { token: a.token, body: b });
    assert.equal(x.status, 403, p);
    assert.equal(code(x), 'account_erasure_pending', p);
  }
  assert.equal(code(await ctx.request('GET', `/api/v1/attachments/${a.attachment.id}/content`, { token: a.token })), 'account_erasure_pending');
  assert.equal((await a.api.get('/account/erasure')).json.state, 'pending');
  assert.equal((await a.api.get('/account/export')).status, 200, 'owner can still export while pending');
  await assert.rejects(ctx.db.query('insert into public.wiz_attachments (user_id, portfolio_entry_id, object_key, filename, mime_type, declared_size) values ($1, $2, $3, $4, $5, 1)',
    [a.id, a.entry.id, `u/${a.id}/${a.entry.id}`, 'x.png', 'image/png']), /erasure_pending/);
  // retry once storage works
  ctx.storage.state.failDelete = false;
  const ok = await ctx.request('POST', '/api/v1/account/erasure', { token: a.token, body: CONFIRM_ERASE });
  assert.equal(ok.status, 200);
  assert.equal(ctx.storage.objects.has(key2), false);
  assert.equal(total(await ownedCounts(a.id)), 0);
  assert.equal((await ctx.db.query('select count(*)::int n from public.wiz_erasure_receipts where id = $1 and state = $2', [r.json.error.erasure.receipt_id, 'completed'])).rows[0].n, 1, 'same receipt carried through');
});

test('Auth failure and unconfirmed identity removal keep the erasure retryable; storage is not repeated', async () => {
  const a = await rich('er-auth', 'MARKH');
  ctx.admin.state.failDelete = true;
  const r1 = await ctx.request('POST', '/api/v1/account/erasure', { token: a.token, body: CONFIRM_ERASE });
  assert.equal(r1.status, 503);
  assert.equal(r1.json.error.erasure.phase, 'auth');
  assert.equal(ctx.storage.objects.has(`u/${a.id}/${a.attachment.id}`), false, 'storage phase already finished');
  assert.equal((await ctx.request('GET', '/api/v1/me', { token: a.token })).status, 403, 'still closed');
  ctx.admin.state.failDelete = false;
  ctx.admin.state.stillExists = true; // provider says OK but the identity is still there: must not be reported as success
  const r2 = await ctx.request('POST', '/api/v1/account/erasure', { token: a.token, body: CONFIRM_ERASE });
  assert.equal(r2.status, 503);
  assert.equal(r2.json.error.erasure.phase, 'auth');
  ctx.admin.state.stillExists = false;
  const storageCalls = ctx.storage.state.calls.filter(c2 => c2[0] === 'delete').length;
  const done = await ctx.app.locals.privacy.resume(r2.json.error.erasure.receipt_id);
  assert.equal(done.erased, true);
  assert.equal(ctx.storage.state.calls.filter(c2 => c2[0] === 'delete').length, storageCalls, 'resumed after the storage phase');
  assert.equal(total(await ownedCounts(a.id)), 0);
});

test('post-Auth cleanup failure: identity is gone, receipt resumes the application cleanup (explicit delete, no cascade assumed)', async () => {
  const a = await rich('er-clean', 'MARKI');
  ctx.admin.state.cascade = false; // production cascade from the Auth identity is unverified: do not rely on it
  await ctx.db.query('revoke delete on public.users from service_role'); // simulated cleanup failure
  try {
    const r = await ctx.request('POST', '/api/v1/account/erasure', { token: a.token, body: CONFIRM_ERASE });
    assert.equal(r.status, 503);
    assert.equal(r.json.error.erasure.phase, 'cleanup');
    const receiptId = r.json.error.erasure.receipt_id;
    assert.equal((await ctx.request('GET', '/api/v1/me', { token: a.token })).status, 401, 'identity already gone: the bearer can no longer retry');
    assert.ok((await ctx.db.query('select count(*)::int n from public.users where id = $1', [a.id])).rows[0].n === 1);
    const state = await ctx.rpc('wiz_privacy_erasure_receipt', { p_receipt_id: receiptId });
    assert.equal(state.state, 'pending');
    assert.equal(state.phase, 'auth_done');
    await assert.rejects(ctx.app.locals.privacy.resume(receiptId), err => err.code === 'erasure_incomplete');
    await ctx.db.query('grant delete on public.users to service_role');
    const done = await ctx.app.locals.privacy.resume(receiptId);
    assert.deepEqual(done, { erased: true, receipt: { id: receiptId, state: 'completed' } });
    assert.equal(total(await ownedCounts(a.id)), 0);
    assert.equal((await ctx.db.query('select count(*)::int n from public.users where id = $1', [a.id])).rows[0].n, 0);
    assert.equal((await ctx.app.locals.privacy.resume(receiptId)).erased, true, 'resume is idempotent');
    await assert.rejects(ctx.app.locals.privacy.resume('00000000-0000-4000-8000-000000000000'), err => err.status === 404);
  } finally {
    ctx.admin.state.cascade = true;
    await ctx.db.query('grant delete on public.users to service_role');
  }
});

test('erasure fails closed when its collaborators are missing, without closing the account', async () => {
  const bare = await startPrivacyApi({ db: ctx.db, noAdmin: true });
  try {
    const u = await bare.newAccount('er-noadmin');
    const r = await bare.request('POST', '/api/v1/account/erasure', { token: u.token, body: CONFIRM_ERASE });
    assert.equal(r.status, 503);
    assert.equal(code(r), 'erasure_unavailable');
    assert.equal((await bare.request('GET', '/api/v1/me', { token: u.token })).status, 200, 'account not closed by a request that could not run');
  } finally { await bare.close(); }
  const off = await startPrivacyApi({ db: ctx.db, privacyOff: true });
  try {
    const u = await off.newAccount('er-off');
    for (const [m, p, b] of [['GET', '/account/export'], ['POST', '/account/erasure', CONFIRM_ERASE]]) assert.equal(code(await off.request(m, '/api/v1' + p, { token: u.token, body: b })), 'privacy_unavailable');
    const s = (await off.as(u).post('/sessions', { topic: { kind: 'custom', text: 'x' } })).json.item;
    assert.equal(code(await off.request('DELETE', `/api/v1/sessions/${s.id}`, { token: u.token, body: CONFIRM_SESSION })), 'privacy_unavailable');
  } finally { await off.close(); }
});

test('erasure with attachments but no storage transport is refused before the account is closed', async () => {
  const a = await rich('er-nostore', 'MARKJ');
  const nos = await startPrivacyApi({ db: ctx.db, noStorage: true });
  nos.gotrue.users.set(a.email, { id: a.id, email: a.email });
  nos.gotrue.access.set(a.token, a.id);
  try {
    const r = await nos.request('POST', '/api/v1/account/erasure', { token: a.token, body: CONFIRM_ERASE });
    assert.equal(r.status, 503);
    assert.equal(code(r), 'storage_unavailable');
    assert.equal((await nos.request('GET', '/api/v1/me', { token: a.token })).status, 200);
  } finally { await nos.close(); }
  assert.ok(ctx.storage.objects.has(`u/${a.id}/${a.attachment.id}`));
});
