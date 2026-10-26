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
const { createNotices, NOTICE_DIR, APPROVAL, APPROVAL_20261024 } = require('../lib/notices');
const { client } = require('./helpers/api');

const PRIVACY_ID = 'privacy-2026-10-16-v1';
const TERMS_ID = 'terms-2026-10-16-v1';
const PRIVACY_V2_ID = 'privacy-2026-10-24-v2';
const TERMS_V2_ID = 'terms-2026-10-24-v2';
const PRIVACY_SHA = 'ba1a8f905d6b3af9ede6d5bfa7ac18fc520629847f49448530044fc4339e6f70';
const TERMS_SHA = '8570e1f5fac7f9a67597a672024fcdbe48bc85e90de9e6df907352ea987ed60d';
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const PRIVACY_V2_SHA = sha(fs.readFileSync(path.join(NOTICE_DIR, PRIVACY_V2_ID + '.txt')));
const TERMS_V2_SHA = sha(fs.readFileSync(path.join(NOTICE_DIR, TERMS_V2_ID + '.txt')));
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
      assert.equal(r.json.notice.approval.source_control, APPROVAL.source_control);
      assert.equal(r.json.notice.approval.independent_legal_approval, false);
    }
    for (const [id, sum] of [[PRIVACY_V2_ID, PRIVACY_V2_SHA], [TERMS_V2_ID, TERMS_V2_SHA]]) {
      const onDisk = fs.readFileSync(path.join(NOTICE_DIR, id + '.txt'));
      assert.ok(onDisk.length > 0, '2026-10-24 v2 artifact exists on disk');
      const r = await ctx.request('GET', `/api/v1/notices/${id}`);
      assert.equal(r.status, 200);
      assert.equal(r.json.notice.id, id);
      assert.equal(r.json.notice.sha256, sum);
      assert.equal(r.json.notice.bytes, onDisk.length);
      assert.equal(sha(Buffer.from(r.json.notice.text, 'utf8')), sum, 'returned v2 wording re-hashes to the recorded hash');
      assert.equal(r.json.notice.approval.basis, 'owner_delegated_technical_revision');
      assert.equal(r.json.notice.approval.revised_on, '2026-10-24');
      assert.equal(r.json.notice.approval.source_control, undefined, 'no PJW signature claim on 2026-10-24 technical revision');
      assert.equal(r.json.notice.approval.independent_legal_approval, false);
      assert.deepEqual(r.json.notice.approval, APPROVAL_20261024);
    }
    const list = await ctx.request('GET', '/api/v1/notices');
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.items.map(x => x.id).sort(), [PRIVACY_ID, PRIVACY_V2_ID, TERMS_ID, TERMS_V2_ID]);
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

test('ops 2026-10-24 publication & rollback lifecycle: retires v1 by status, requires fresh explicit v3 consent & terms 2.0 acceptance, refuses version 3 collision, and rolls back to the actual 2/2/2/1 prior map', async () => {
  const ctx = await startNoticeApi();
  try {
    const rawPublish = fs.readFileSync(path.join(__dirname, '..', 'ops', 'publish-notices-20261024.sql'), 'utf8');
    const rollbackSql = fs.readFileSync(path.join(__dirname, '..', 'ops', 'rollback-notices-20261024.sql'), 'utf8');
    const publishSql = rawPublish
      .replaceAll('EXPLICIT_PARENT_SHA_PRIVACY_2026_10_24_V2', PRIVACY_V2_SHA)
      .replaceAll('EXPLICIT_PARENT_SHA_TERMS_2026_10_24_V2', TERMS_V2_SHA);
    const unpinnedSql = publishSql.replace(
      /(^\s*v_privacy_sha\s+constant\s+text\s*:=\s*')[0-9a-f]{64}(';)/m,
      "$1EXPLICIT_PARENT_SHA_PRIVACY_2026_10_24_V2$2",
    );

    // The SQL's own pins must be the runtime artifact hashes (placeholders, if any, were substituted above).
    const pinnedIn = name => new RegExp(`^\\s*${name}\\s+constant\\s+text\\s*:=\\s*'([0-9a-f]{64})';`, 'm').exec(publishSql);
    assert.equal(pinnedIn('v_privacy_sha') && pinnedIn('v_privacy_sha')[1], PRIVACY_V2_SHA, 'publication SQL pins the runtime privacy v2 hash');
    assert.equal(pinnedIn('v_terms_sha') && pinnedIn('v_terms_sha')[1], TERMS_V2_SHA, 'publication SQL pins the runtime terms v2 hash');

    // The local harness applies foundation/career/privacy/notices only, so openai_training may legitimately have no rows; capture whatever
    // exists BEFORE publication and require it to be identical afterwards (never approved, never activated, never touched).
    const openaiBefore = (await ctx.db.query("select purpose, version, status, legal_approved, artifact_id, artifact_sha256, approval_provenance from public.wiz_consent_versions where purpose = 'openai_training' order by version")).rows;

    // 1. Fails closed if parent SHA placeholder is unpinned or if an expected current purpose is absent.
    await assert.rejects(ctx.db.exec(unpinnedSql), /parent must pin exact 64-char hex SHA-256 hashes/);
    await ctx.db.exec('rollback').catch(() => {});
    // Local fixtures still hold the original v1 placeholders as current, but staging's actual prior map is 2/2/2/1: refused before seeding.
    await assert.rejects(ctx.db.exec(publishSql), /purpose career_records expected current version 2, found 1/);
    await ctx.db.exec('rollback').catch(() => {});

    // Seed the representative staging state: approve save_chats v1 (original history), then seed health_processing v1 as already current.
    const PJW = 'Approved by and date: PJW 16/10/2026. Recorded by engineering as owner instruction; not independently verified solicitor approval.';
    await ctx.db.exec(`
      insert into public.wiz_consent_versions (purpose, version, status, summary, legal_approved, artifact_id, artifact_sha256, approval_provenance)
      values ('health_processing', '1', 'current',
        'Let WIZ handle health, wellbeing or neurodiversity information I choose to share while it coaches me, as set out in the Privacy Notice. I can use WIZ without sharing it and can withdraw at any time.',
        true, '${PRIVACY_ID}', '${PRIVACY_SHA}', '${PJW}');
      update public.wiz_consent_versions
         set legal_approved = true, artifact_id = '${PRIVACY_ID}', artifact_sha256 = '${PRIVACY_SHA}', approval_provenance = '${PJW}'
       where purpose = 'save_chats' and version = '1';
    `);

    const u = await ctx.newAccount('pub-20261024');
    assert.equal((await accept(ctx, u, GOOD)).status, 201);
    const grantV1 = await ctx.request('POST', '/api/v1/consents', { token: u.token, body: { purpose: 'save_chats', version: '1', action: 'grant' } });
    assert.equal(grantV1.status, 200);
    assert.equal(grantV1.json.purposes.find(x => x.purpose === 'save_chats').granted, true, 'original v1 grant recorded while v1 was current');

    // Now move career_records / personalisation / save_chats to a current version 2 (v1 kept as retired history), linked to the 16 Oct artifact.
    await ctx.db.exec(`
      update public.wiz_consent_versions set status = 'retired'
       where version = '1' and purpose in ('career_records', 'personalisation', 'save_chats');
      insert into public.wiz_consent_versions (purpose, version, status, summary, legal_approved, artifact_id, artifact_sha256, approval_provenance)
      select purpose, '2', 'current', summary, true, '${PRIVACY_ID}', '${PRIVACY_SHA}', '${PJW}'
        from public.wiz_consent_versions
       where version = '1' and purpose in ('career_records', 'personalisation', 'save_chats');
    `);
    const priorMap = { career_records: '2', health_processing: '1', personalisation: '2', save_chats: '2' };
    const currentMap = async () => Object.fromEntries((await ctx.db.query("select purpose, version from public.wiz_consent_versions where status = 'current' and purpose <> 'openai_training' order by purpose")).rows.map(r => [r.purpose, r.version]));
    assert.deepEqual(await currentMap(), priorMap, 'fixture mirrors actual staging current versions');
    const v1History = (await ctx.db.query("select purpose, version, status, legal_approved, artifact_id from public.wiz_consent_versions where version = '1' and purpose in ('career_records', 'personalisation', 'save_chats') order by purpose")).rows;
    assert.equal(v1History.length, 3);
    assert.ok(v1History.every(r => r.status === 'retired'), 'original v1 rows preserved as retired history');

    // Explicit pre-publication grants on the current versions: v1 for health_processing, v2 for the other three.
    const preGrants = {};
    for (const [purpose, version] of Object.entries(priorMap)) {
      const r = await ctx.request('POST', '/api/v1/consents', { token: u.token, body: { purpose, version, action: 'grant' } });
      assert.equal(r.status, 200, `pre-publication grant ${purpose} v${version}`);
      assert.equal(r.json.purposes.find(x => x.purpose === purpose).granted, true);
      preGrants[purpose] = version;
    }
    const eventsBeforePublish = (await ctx.db.query('select count(*)::int n from public.wiz_consent_events where user_id = $1', [u.id])).rows[0].n;
    assert.equal(eventsBeforePublish, 5, 'original save_chats v1 grant plus four pre-publication grants');

    // 2. Fails closed on version 3 collision if a conflicting version '3' row exists.
    await assert.rejects(
      ctx.db.exec(`
        begin;
        insert into public.wiz_consent_versions (purpose, version, status, summary, legal_approved, artifact_id, artifact_sha256, approval_provenance)
        values ('save_chats', '3', 'retired', 'conflicting row', true, '${PRIVACY_ID}', '${PRIVACY_SHA}', 'prior conflicting v3');
        ${publishSql.replace(/^\s*begin\s*;/im, '').replace(/commit\s*;\s*$/im, '')}
        commit;
      `),
      /consent version 3 collision on purpose save_chats/
    );
    await ctx.db.exec('rollback').catch(() => {});
    assert.deepEqual(await currentMap(), priorMap, 'collision refusal changed nothing');

    // 3. Apply 2026-10-24 publication (and re-run to verify idempotent no-op).
    await ctx.db.exec(publishSql);
    await ctx.db.exec(publishSql);

    // Old v1 rows are retired with original hashes/provenance intact; v2 rows are current; openai_training remains unapproved.
    const termsRows = (await ctx.db.query('select version, status, artifact_id, artifact_sha256 from public.wiz_terms_versions order by version')).rows;
    assert.deepEqual(termsRows, [
      { version: '1.0', status: 'retired', artifact_id: TERMS_ID, artifact_sha256: TERMS_SHA },
      { version: '2.0', status: 'current', artifact_id: TERMS_V2_ID, artifact_sha256: TERMS_V2_SHA }
    ]);
    const openaiAfter = (await ctx.db.query("select purpose, version, status, legal_approved, artifact_id, artifact_sha256, approval_provenance from public.wiz_consent_versions where purpose = 'openai_training' order by version")).rows;
    assert.deepEqual(openaiAfter, openaiBefore, 'openai_training rows unchanged by publication');
    assert.ok(openaiAfter.every(r => r.legal_approved === false), 'openai_training stays unapproved (nonactivation)');
    assert.equal(openaiAfter.filter(r => r.status === 'current' && r.legal_approved).length, 0, 'no approved current openai_training');

    // 4. No silent grant or terms carry-over: u must explicitly accept Terms 2.0 and grant v2 consents; v1 history is preserved.
    const termsState = (await ctx.request('GET', '/api/v1/terms', { token: u.token })).json.terms;
    assert.equal(termsState.current.version, '2.0');
    assert.equal(termsState.current.artifact_id, TERMS_V2_ID);
    assert.equal(termsState.current.artifact_sha256, TERMS_V2_SHA);
    assert.equal(termsState.accepted, false, 'v1.0 acceptance does not satisfy Terms 2.0');
    assert.equal(termsState.acceptances.length, 1, 'v1.0 acceptance preserved in history');

    const consentPurposes = (await ctx.request('GET', '/api/v1/consents', { token: u.token })).json.purposes;
    for (const p of ['save_chats', 'personalisation', 'career_records', 'health_processing']) {
      const row = consentPurposes.find(x => x.purpose === p);
      assert.ok(row, `purpose ${p} returned`);
      assert.equal(row.version, '3');
      assert.equal(row.legal_approved, true);
      assert.equal(row.granted, false, `prior v${preGrants[p]} grant not carried over silently to v3 for ${p}`);
    }
    // The consent API does not expose artifact fields; verify the current v3 rows' pinned artifact in the database instead.
    const v3Rows = (await ctx.db.query("select purpose, artifact_id, artifact_sha256 from public.wiz_consent_versions where version = '3' and status = 'current' order by purpose")).rows;
    assert.deepEqual(v3Rows.map(r => r.purpose), ['career_records', 'health_processing', 'personalisation', 'save_chats']);
    for (const r of v3Rows) {
      assert.equal(r.artifact_id, PRIVACY_V2_ID);
      assert.equal(r.artifact_sha256, PRIVACY_V2_SHA);
    }
    // Every prior row (v1 history, v2 retired, health v1 retired) is preserved; only status moved.
    const priorRows = (await ctx.db.query("select purpose, version, status from public.wiz_consent_versions where purpose <> 'openai_training' and version <> '3' order by purpose, version")).rows;
    assert.ok(priorRows.every(r => r.status === 'retired'), 'all prior versions retired');
    for (const [purpose, version] of Object.entries(priorMap)) assert.ok(priorRows.some(r => r.purpose === purpose && r.version === version), `${purpose} v${version} retained`);
    assert.equal(priorRows.filter(r => r.version === '1' && r.purpose !== 'health_processing').length, 3, 'original v1 history retained');
    assert.equal((await ctx.db.query('select count(*)::int n from public.wiz_consent_events where user_id = $1', [u.id])).rows[0].n, eventsBeforePublish, 'publication wrote no consent events');

    // Record fresh explicit Terms 2.0 acceptance and v3 grants (explicit grants on the new version, one per purpose).
    const accV2 = await accept(ctx, u, { version: '2.0', artifact_sha256: TERMS_V2_SHA, accepted: true });
    assert.equal(accV2.status, 201);
    assert.deepEqual(accV2.json.terms.acceptances.map(x => x.version), ['1.0', '2.0']);
    for (const p of Object.keys(priorMap)) {
      const stale = await ctx.request('POST', '/api/v1/consents', { token: u.token, body: { purpose: p, version: priorMap[p], action: 'grant' } });
      assert.notEqual(stale.status, 200, `grant on retired prior version for ${p} is refused`);
      const g = await ctx.request('POST', '/api/v1/consents', { token: u.token, body: { purpose: p, version: '3', action: 'grant' } });
      assert.equal(g.status, 200, `v3 grant for ${p}`);
      assert.equal(g.json.purposes.find(x => x.purpose === p).granted, true);
    }

    // 5. Rollback retires v3 by status only, restores the actual prior map (2/2/2/1) to current, and preserves all rows, acceptances, and consent events.
    await ctx.db.exec(rollbackSql);
    await ctx.db.exec(rollbackSql);

    const afterRollbackTerms = (await ctx.request('GET', '/api/v1/terms', { token: u.token })).json.terms;
    assert.equal(afterRollbackTerms.current.version, '1.0');
    assert.equal(afterRollbackTerms.accepted, true, 'restored v1.0 current version recognises preserved v1.0 acceptance');
    assert.deepEqual(afterRollbackTerms.acceptances.map(x => x.version), ['1.0', '2.0'], 'v2.0 acceptance record preserved after rollback');
    assert.deepEqual(await currentMap(), priorMap, 'rollback restores the actual prior purpose map');
    assert.equal((await ctx.db.query("select count(*)::int n from public.wiz_consent_versions where version = '3' and status = 'retired'")).rows[0].n, 4, 'all 4 v3 consent rows preserved as retired');
    assert.equal((await ctx.db.query("select count(*)::int n from public.wiz_consent_versions where version = '1' and purpose <> 'health_processing' and status = 'retired'")).rows[0].n, 3, 'original v1 history untouched');
    assert.equal((await ctx.db.query('select count(*)::int n from public.wiz_consent_events where user_id = $1', [u.id])).rows[0].n, eventsBeforePublish + 4, 'pre-publication and v3 consent events preserved');
    assert.deepEqual((await ctx.db.query("select purpose, version, status, legal_approved, artifact_id from public.wiz_consent_versions where purpose = 'openai_training' order by version")).rows.map(r => r.legal_approved), openaiBefore.map(r => r.legal_approved), 'openai_training still unapproved after rollback');
  } finally { await ctx.close(); }
});
