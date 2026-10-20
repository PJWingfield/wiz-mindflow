'use strict';
// Exact notice artifacts (hash-verified, read-only) and separate, append-only terms acceptance. Real app + fake GoTrue + PGlite;
// synthetic accounts and synthetic notice fixtures only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const h = require('./helpers/db');
const { startNoticeApi, applyNoticesUp, applyNoticesDown } = require('./helpers/notices-api');
const { openPrivacyDb } = require('./helpers/privacy-api');
const { loadConfig } = require('../lib/config');
const { createApp } = require('../lib/app');
const { createNotices, NOTICE_DIR } = require('../lib/notices');
const { client } = require('./helpers/api');

const PRIVACY_ID = 'privacy-2026-10-16-v1';
const TERMS_ID = 'terms-2026-10-16-v1';
const PRIVACY_SHA = 'ba1a8f905d6b3af9ede6d5bfa7ac18fc520629847f49448530044fc4339e6f70';
const TERMS_SHA = '8570e1f5fac7f9a67597a672024fcdbe48bc85e90de9e6df907352ea987ed60d';
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const accept = (ctx, u, body) => ctx.request('POST', '/api/v1/terms/acceptance', { token: u.token, body });
const GOOD = { version: '1.0', artifact_sha256: TERMS_SHA, accepted: true };

test('notices: exact preserved bytes + hash + provenance are retrievable without authentication', async () => {
  const ctx = await startNoticeApi();
  try {
    for (const [id, sum] of [[PRIVACY_ID, PRIVACY_SHA], [TERMS_ID, TERMS_SHA]]) {
      const onDisk = fs.readFileSync(path.join(NOTICE_DIR, id + '.txt'));
      assert.equal(sha(onDisk), sum, 'preserved artifact still has the approved hash');
      const r = await ctx.request('GET', `/api/v1/notices/${id}`);
      assert.equal(r.status, 200);
      assert.equal(r.json.notice.id, id);
      assert.equal(r.json.notice.sha256, sum);
      assert.equal(r.json.notice.bytes, onDisk.length);
      assert.equal(sha(Buffer.from(r.json.notice.text, 'utf8')), sum, 'returned wording re-hashes to the recorded hash');
      assert.equal(r.json.notice.approval.basis, 'owner_instruction');
      assert.equal(r.json.notice.approval.independent_legal_approval, false);
    }
    const list = await ctx.request('GET', '/api/v1/notices');
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.items.map(x => x.id).sort(), [PRIVACY_ID, TERMS_ID]);
    assert.ok(list.json.items.every(x => x.text === undefined), 'the list carries no wording');
    // only catalogue ids: unknown id, traversal and an unsupported verb are all refused
    assert.equal((await ctx.request('GET', '/api/v1/notices/terms-2099-01-01-v9')).status, 404);
    assert.equal((await ctx.request('GET', '/api/v1/notices/..%2Fserver.js')).status, 400);
    assert.equal((await ctx.request('GET', '/api/v1/notices/%2e%2e%2fpackage.json')).status, 400);
    assert.equal((await ctx.request('DELETE', `/api/v1/notices/${TERMS_ID}`)).status, 405);
  } finally { await ctx.close(); }
});

test('notices: missing, tampered or mislinked artifact fails closed (503) with no path leak and no substitute', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiz-notice-'));
  const logs = [];
  const logger = (event, fields) => logs.push({ event, ...fields });
  const good = Buffer.from('Synthetic notice text\r\nline two\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'a.txt'), good);
  fs.writeFileSync(path.join(dir, 'b.txt'), 'altered after hashing');
  const catalogue = {
    'synthetic-ok': { kind: 'terms', file: 'a.txt', sha256: sha(good) },
    'synthetic-tampered': { kind: 'terms', file: 'b.txt', sha256: sha(good) },
    'synthetic-missing': { kind: 'privacy', file: 'nope.txt', sha256: sha(good) }
  };
  const notices = createNotices({ dir, catalogue, logger });
  const server = http.createServer(createApp({ config: loadConfig({}), notices, logger }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const request = client(server.address().port);
  try {
    const ok = await request('GET', '/api/v1/notices/synthetic-ok');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.notice.text, good.toString('utf8'), 'CRLF and content preserved exactly');
    for (const id of ['synthetic-tampered', 'synthetic-missing']) {
      const r = await request('GET', `/api/v1/notices/${id}`);
      assert.equal(r.status, 503);
      assert.equal(r.json.error.code, 'notice_unavailable');
      assert.ok(!r.text.includes(dir) && !r.text.includes('.txt') && !r.text.includes('altered'), 'no path or content leaked');
    }
    assert.deepEqual(logs.filter(l => l.event === 'notice_integrity_failure').map(l => l.reason).sort(), ['hash_mismatch', 'missing']);
    await assert.rejects(notices.load('synthetic-ok', sha('other')), e => e.code === 'notice_unavailable', 'a linked hash that differs is refused');
  } finally {
    await new Promise(r => { server.closeAllConnections(); server.close(r); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('terms: current state, explicit affirmative acceptance with server time, idempotent, owner-isolated', async () => {
  const ctx = await startNoticeApi();
  try {
    const a = await ctx.newAccount('terms-a');
    const b = await ctx.newAccount('terms-b');
    assert.equal((await ctx.request('GET', '/api/v1/terms')).status, 401);
    assert.equal((await ctx.request('POST', '/api/v1/terms/acceptance', { body: GOOD })).status, 401);

    const st = await ctx.request('GET', '/api/v1/terms', { token: a.token });
    assert.equal(st.status, 200);
    assert.equal(st.json.terms.current.version, '1.0');
    assert.equal(st.json.terms.current.artifact_id, TERMS_ID);
    assert.equal(st.json.terms.current.artifact_sha256, TERMS_SHA);
    assert.equal(st.json.terms.current.notice_path, `/api/v1/notices/${TERMS_ID}`);
    assert.match(st.json.terms.current.approval_provenance, /Not independently verified solicitor approval/);
    assert.equal(st.json.terms.accepted, false);
    assert.deepEqual(st.json.terms.acceptances, []);
    const shown = await ctx.request('GET', st.json.terms.current.notice_path);
    assert.equal(shown.json.notice.sha256, st.json.terms.current.artifact_sha256, 'the notice shown is the one the version links to');

    // not affirmative / forged / stale / unknown: all refused, nothing recorded
    const bad = async (body, status, code) => {
      const r = await accept(ctx, a, body);
      assert.equal(r.status, status, JSON.stringify(body));
      if (code) assert.equal(r.json.error.code, code);
    };
    await bad({ version: '1.0', artifact_sha256: TERMS_SHA }, 400, 'invalid_request');
    await bad({ ...GOOD, accepted: false }, 400, 'invalid_request');
    await bad({ ...GOOD, accepted: 'true' }, 400, 'invalid_request');
    await bad({ ...GOOD, user_id: b.id }, 400, 'invalid_request');
    await bad({ ...GOOD, accepted_at: '2000-01-01T00:00:00Z' }, 400, 'invalid_request');
    await bad({ ...GOOD, version: '0.9' }, 400, 'unknown_terms_version');
    await bad({ ...GOOD, artifact_sha256: PRIVACY_SHA }, 409, 'stale_terms_version');
    assert.equal((await ctx.db.query('select count(*)::int n from public.wiz_terms_acceptances')).rows[0].n, 0);

    const t0 = Date.now();
    const first = await accept(ctx, a, GOOD);
    const t1 = Date.now();
    assert.equal(first.status, 201);
    assert.equal(first.json.terms.accepted, true);
    assert.equal(first.json.terms.acceptances.length, 1);
    const rec = first.json.terms.acceptances[0];
    assert.deepEqual([rec.version, rec.artifact_id, rec.artifact_sha256], ['1.0', TERMS_ID, TERMS_SHA]);
    const at = Date.parse(rec.accepted_at);
    assert.ok(at >= t0 - 2000 && at <= t1 + 2000, 'server clock, not client-supplied');

    const again = await accept(ctx, a, GOOD);
    assert.equal(again.status, 200, 'duplicate is harmless');
    assert.equal(again.json.terms.acceptances.length, 1);
    assert.equal(again.json.terms.acceptances[0].accepted_at, rec.accepted_at, 'original acceptance time kept');
    const rows = await ctx.db.query('select user_id, version, artifact_sha256 from public.wiz_terms_acceptances');
    assert.deepEqual(rows.rows, [{ user_id: a.id, version: '1.0', artifact_sha256: TERMS_SHA }]);

    const other = await ctx.request('GET', '/api/v1/terms', { token: b.token });
    assert.equal(other.json.terms.accepted, false, "another account's acceptance is not shared");
    assert.deepEqual(other.json.terms.acceptances, []);

    // acceptance is not a consent event: it cannot be revoked there, nor deleted/overwritten over the API
    const rev = await ctx.request('POST', '/api/v1/consents', { token: a.token, body: { purpose: 'terms', version: '1.0', action: 'revoke' } });
    assert.equal(rev.status, 400);
    assert.equal(rev.json.error.code, 'unknown_purpose');
    assert.equal((await ctx.request('DELETE', '/api/v1/terms/acceptance', { token: a.token })).status, 405);
    assert.equal((await ctx.request('PUT', '/api/v1/terms', { token: a.token, body: GOOD })).status, 405);
    assert.equal((await ctx.request('GET', '/api/v1/terms', { token: a.token })).json.terms.accepted, true);
  } finally { await ctx.close(); }
});

test('terms: a new current version makes the old acceptance stale (kept as history); unverifiable wording is never recorded', async () => {
  const ctx = await startNoticeApi();
  try {
    const u = await ctx.newAccount('terms-stale');
    assert.equal((await accept(ctx, u, GOOD)).status, 201);

    // owner publishes terms 2.0 (synthetic: pointing at the other preserved artifact so the runtime hash check can pass)
    await ctx.db.exec(`update public.wiz_terms_versions set status = 'retired' where version = '1.0';
      insert into public.wiz_terms_versions (version, status, artifact_id, artifact_sha256, approval_provenance)
      values ('2.0', 'current', '${PRIVACY_ID}', '${PRIVACY_SHA}', 'synthetic fixture')`);
    const st = (await ctx.request('GET', '/api/v1/terms', { token: u.token })).json.terms;
    assert.equal(st.current.version, '2.0');
    assert.equal(st.accepted, false, 'an old acceptance does not satisfy a new version');
    assert.equal(st.acceptances.length, 1, 'history is kept');
    const stale = await accept(ctx, u, GOOD);
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, 'stale_terms_version');
    const v2 = await accept(ctx, u, { version: '2.0', artifact_sha256: PRIVACY_SHA, accepted: true });
    assert.equal(v2.status, 201);
    assert.deepEqual(v2.json.terms.acceptances.map(x => x.version), ['1.0', '2.0']);

    // a version whose recorded hash does not match the runtime artifact cannot be accepted
    const w = await ctx.newAccount('terms-bad');
    const bogus = 'f'.repeat(64);
    await ctx.db.exec(`update public.wiz_terms_versions set status = 'retired' where version = '2.0';
      insert into public.wiz_terms_versions (version, status, artifact_id, artifact_sha256, approval_provenance)
      values ('3.0', 'current', '${TERMS_ID}', '${bogus}', 'synthetic fixture')`);
    const r = await accept(ctx, w, { version: '3.0', artifact_sha256: bogus, accepted: true });
    assert.equal(r.status, 503);
    assert.equal(r.json.error.code, 'notice_unavailable');
    assert.equal((await ctx.db.query('select count(*)::int n from public.wiz_terms_acceptances where user_id = $1', [w.id])).rows[0].n, 0);
  } finally { await ctx.close(); }
});

test('published content identity is immutable; browser and application roles cannot rewrite or delete it', async () => {
  const ctx = await startNoticeApi();
  try {
    const u = await ctx.newAccount('immutable');
    assert.equal((await accept(ctx, u, GOOD)).status, 201);
    const db = ctx.db;
    // application path (service_role) and browser roles: no write privilege at all
    for (const role of ['service_role', 'authenticated', 'anon']) {
      for (const sql of ["update public.wiz_terms_versions set artifact_sha256 = repeat('0', 64)", 'delete from public.wiz_terms_versions',
        "update public.wiz_terms_acceptances set accepted_at = '2000-01-01'", 'delete from public.wiz_terms_acceptances',
        "update public.wiz_consent_versions set artifact_id = 'x-forged', artifact_sha256 = repeat('0', 64)"]) {
        await assert.rejects(h.asRole(db, role, u.id, tx => tx.query(sql)), /permission denied/, `${role}: ${sql}`);
      }
    }
    for (const role of ['authenticated', 'anon']) {
      await assert.rejects(h.asRole(db, role, u.id, tx => tx.query('select * from public.wiz_terms_acceptances')), /permission denied/);
      await assert.rejects(h.asRole(db, role, u.id, tx => tx.query('select * from public.wiz_terms_versions')), /permission denied/);
      await assert.rejects(h.asRole(db, role, u.id, tx => tx.query('select public.wiz_terms_accept($1, $2, $3)', [u.id, '1.0', TERMS_SHA])), /permission denied/);
    }
    // even the table owner cannot rewrite published identity or an acceptance (the trigger backstop)
    const bounce = sql => assert.rejects(db.exec(sql), /wiz:published_immutable/, sql);
    await bounce("update public.wiz_terms_versions set artifact_sha256 = repeat('0', 64) where version = '1.0'");
    await bounce("update public.wiz_terms_versions set artifact_id = 'other-artifact' where version = '1.0'");
    await bounce("update public.wiz_terms_versions set approval_provenance = 'changed' where version = '1.0'");
    await bounce("delete from public.wiz_terms_versions where version = '1.0'");
    await bounce("update public.wiz_terms_acceptances set accepted_at = '2000-01-01'");
    // consent versions: link once, never rewrite; existing approval handling is unchanged
    const before = (await db.query("select purpose, version, legal_approved, artifact_id, artifact_sha256, approval_provenance from public.wiz_consent_versions order by 1, 2")).rows;
    assert.ok(before.length > 0 && before.every(x => x.legal_approved === false && x.artifact_id === null), 'placeholders stay unapproved and unlinked');
    await db.exec(`update public.wiz_consent_versions set artifact_id = '${PRIVACY_ID}', artifact_sha256 = '${PRIVACY_SHA}', approval_provenance = 'synthetic' where purpose = 'save_chats' and version = '1'`);
    await bounce("update public.wiz_consent_versions set artifact_sha256 = repeat('1', 64) where purpose = 'save_chats' and version = '1'");
    await bounce("update public.wiz_consent_versions set artifact_id = null, artifact_sha256 = null where purpose = 'save_chats' and version = '1'");
    await bounce("update public.wiz_consent_versions set approval_provenance = 'other' where purpose = 'save_chats' and version = '1'");
    await assert.rejects(db.exec("update public.wiz_consent_versions set artifact_id = 'half-linked-only' where purpose = 'personalisation' and version = '1'"), /wiz_consent_artifact_pair/);
    await db.exec("update public.wiz_consent_versions set legal_approved = true where purpose = 'save_chats'"); // approval stays an owner action
  } finally { await ctx.close(); }
});

test('existing unapproved-consent regression still holds with the notices/terms migration applied', async () => {
  const ctx = await startNoticeApi();
  try {
    const u = await ctx.newAccount('unapproved');
    const r = await ctx.request('POST', '/api/v1/consents', { token: u.token, body: { purpose: 'save_chats', version: '1', action: 'grant' } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'notice_not_approved');
    assert.equal((await ctx.db.query('select count(*)::int n from public.wiz_consent_events')).rows[0].n, 0);
    const state = (await ctx.request('GET', '/api/v1/consents', { token: u.token })).json.purposes;
    assert.ok(state.every(p => p.legal_approved === false && p.granted === false));
    // accepting terms grants nothing else
    assert.equal((await accept(ctx, u, GOOD)).status, 201);
    assert.equal((await ctx.db.query('select count(*)::int n from public.wiz_consent_events')).rows[0].n, 0);
  } finally { await ctx.close(); }
});

test('privacy lifecycle: acceptances are exported for the owner only and removed by account erasure; catalogue and others stay', async () => {
  const ctx = await startNoticeApi();
  try {
    const a = await ctx.newAccount('exp-a');
    const b = await ctx.newAccount('exp-b');
    assert.equal((await accept(ctx, a, GOOD)).status, 201);
    assert.equal((await accept(ctx, b, GOOD)).status, 201);

    const exp = await ctx.request('GET', '/api/v1/account/export', { token: a.token });
    assert.equal(exp.status, 200);
    assert.equal(exp.json.terms_acceptances.length, 1);
    assert.deepEqual(
      [exp.json.terms_acceptances[0].version, exp.json.terms_acceptances[0].artifact_id, exp.json.terms_acceptances[0].artifact_sha256],
      ['1.0', TERMS_ID, TERMS_SHA]);
    assert.ok(exp.json.terms_acceptances[0].accepted_at);
    assert.ok(!JSON.stringify(exp.json.terms_acceptances).includes(b.id), "no other user's data");

    const er = await ctx.request('POST', '/api/v1/account/erasure', { token: a.token, body: { confirm: 'erase_my_account' } });
    assert.equal(er.status, 200);
    const left = await ctx.db.query('select user_id from public.wiz_terms_acceptances');
    assert.deepEqual(left.rows, [{ user_id: b.id }], "only the other account's acceptance remains");
    assert.equal((await ctx.db.query('select count(*)::int n from public.wiz_terms_versions')).rows[0].n, 1, 'global catalogue retained');
    assert.equal((await ctx.request('GET', '/api/v1/terms', { token: b.token })).json.terms.accepted, true);
    assert.ok([401, 403].includes((await ctx.request('GET', '/api/v1/terms', { token: a.token })).status), 'erased account is closed');
  } finally { await ctx.close(); }
});

test('migration: re-apply is a no-op; rollback keeps every acceptance and stops new ones; re-apply restores service', async () => {
  const db = await openPrivacyDb();
  try {
    await applyNoticesUp(db);
    await applyNoticesUp(db); // already applied -> explicit no-op
    const uid = await h.newAuthUser(db, 'migr@example.test');
    await db.query('insert into public.users (id, email) values ($1, $2) on conflict do nothing', [uid, 'migr@example.test']);
    await db.query('select public.wiz_terms_accept($1, $2, $3)', [uid, '1.0', TERMS_SHA]);
    const consentBefore = (await db.query('select * from public.wiz_consent_versions order by purpose, version')).rows;

    await applyNoticesDown(db);
    assert.equal((await db.query('select count(*)::int n from public.wiz_terms_acceptances')).rows[0].n, 1, 'acceptance preserved');
    assert.equal((await db.query('select count(*)::int n from public.wiz_terms_versions')).rows[0].n, 1);
    assert.deepEqual((await db.query('select * from public.wiz_consent_versions order by purpose, version')).rows, consentBefore, 'consent versions untouched');
    assert.equal((await db.query("select count(*)::int n from pg_proc where proname in ('wiz_terms_accept', 'wiz_terms_state')")).rows[0].n, 0);
    await assert.rejects(h.asRole(db, 'service_role', null, tx => tx.query("insert into public.wiz_terms_acceptances (user_id, version, artifact_id, artifact_sha256) values ($1, '1.0', 'x-y-z', repeat('a', 64))", [uid])), /permission denied/);
    // still exportable (retained table is read by the retained export function)
    const exp = await h.asRole(db, 'service_role', null, tx => tx.query('select public.wiz_privacy_export($1) as d', [uid]));
    assert.equal(exp.rows[0].d.terms_acceptances.length, 1);
    await applyNoticesDown(db); // second rollback: not applied -> no-op

    await applyNoticesUp(db);
    const st = await h.asRole(db, 'service_role', null, tx => tx.query('select public.wiz_terms_state($1) as s', [uid]));
    assert.equal(st.rows[0].s.accepted, true, 'service restored over the preserved record');
  } finally { await db.close(); }
});
