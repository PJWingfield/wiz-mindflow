'use strict';
// Real SQL verification of the migration against a local PostgreSQL-compatible engine (PGlite).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('./helpers/db');
const { createPgliteRpc } = require('./helpers/pglite-rpc');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

// Baseline with legacy data and a billing-bearing users row, as a deployed project would hold.
async function seededBaseline(opts) {
  const db = await h.openDb(opts && opts.dir);
  await h.loadBaseline(db, opts);
  await h.newAuthUser(db, 'a@example.test', A);
  await h.newAuthUser(db, 'b@example.test', B);
  await db.query("insert into public.users (id, email, full_name, subscription_status, subscription_tier, stripe_customer_id) values ($1,'a@example.test','Ann','active','pro','cus_test_a')", [A]);
  await db.query("insert into public.users (id, email) values ($1,'b@example.test')", [B]);
  const c1 = (await db.query("insert into public.conversations (user_id, title, created_at) values ($1,'Old chat one','2026-01-01T10:00:00Z') returning id", [A])).rows[0].id;
  const c2 = (await db.query("insert into public.conversations (user_id, created_at) values ($1,'2026-02-01T10:00:00Z') returning id", [A])).rows[0].id;
  const c3 = (await db.query("insert into public.conversations (user_id, title) values ($1,'Bee chat') returning id", [B])).rows[0].id;
  await db.query("insert into public.messages (conversation_id, sender, content, created_at) values ($1,'user','hello','2026-01-01T10:00:01Z'), ($1,'assistant','hi there','2026-01-01T10:00:02Z'), ($2,'user','second','2026-02-01T10:00:01Z'), ($3,'user','bee msg','2026-03-01T10:00:01Z')", [c1, c2, c3]);
  await db.query("insert into public.user_documents (user_id) values ($1)", [A]);
  return { db, c1, c2, c3 };
}

const down = async db => {
  await db.query("select set_config('wiz.accept_legacy_grant_restore', 'yes', false)");
  await h.applyDown(db);
};
// Synthetic LOCAL approval of the seeded notices (they ship legal_approved = false; a real approval is an owner action).
const approveNotices = db => db.exec('update public.wiz_consent_versions set legal_approved = true');

const ALL_REL = ['users', 'conversations', 'messages', 'user_documents'];

test('upgrade preserves every legacy row, billing fields and existing policies/triggers', async () => {
  const { db, c1, c2 } = await seededBaseline();
  const policies = await h.policySnapshot(db);
  const triggers = await h.triggerSnapshot(db);
  const before = {};
  for (const t of ALL_REL) before[t] = (await db.query(`select * from public.${t} order by 1`)).rows;
  await h.applyUp(db);
  for (const t of ALL_REL) assert.deepEqual((await db.query(`select * from public.${t} order by 1`)).rows, before[t], t);
  assert.deepEqual(await h.policySnapshot(db), policies, 'policies untouched');
  // every pre-existing trigger is untouched; the only additions are the two migration-owned reparent guards
  const trgAfter = await h.triggerSnapshot(db);
  assert.deepEqual(trgAfter.filter(t => t.tgname !== 'wiz_guard_reparent'), triggers, 'pre-existing triggers untouched');
  assert.deepEqual(trgAfter.filter(t => t.tgname === 'wiz_guard_reparent').map(t => t.relname).sort(), ['conversations', 'messages']);
  const u = (await db.query('select subscription_status, subscription_tier, stripe_customer_id from public.users where id = $1', [A])).rows[0];
  assert.deepEqual(u, { subscription_status: 'active', subscription_tier: 'pro', stripe_customer_id: 'cus_test_a' });

  // backfill: numbering only, per user, nothing invented
  const meta = (await db.query('select session_id, user_id, session_number, title_source, message_count from public.wiz_session_meta order by user_id, session_number')).rows;
  assert.equal(meta.length, 3);
  const a = meta.filter(m => m.user_id === A);
  assert.deepEqual(a.map(m => [m.session_id, m.session_number, m.title_source, m.message_count]), [[c1, 1, 'user', 2], [c2, 2, 'auto', 1]]);
  assert.equal((await db.query('select count(*)::int n from public.wiz_message_meta')).rows[0].n, 4);
  assert.equal((await db.query("select count(*)::int n from public.wiz_message_meta where provenance->>'origin' = 'legacy_import'")).rows[0].n, 4);
  for (const t of ['wiz_goals', 'wiz_journal_entries', 'wiz_reports', 'wiz_profile_evidence', 'wiz_consent_events']) {
    assert.equal((await db.query(`select count(*)::int n from public.${t}`)).rows[0].n, 0, `${t} must start empty (no fabricated records)`);
  }
  // consent versions exist but nothing is accepted for anyone
  const v = (await db.query('select purpose, legal_approved from public.wiz_consent_versions order by 1')).rows;
  assert.deepEqual(v, [{ purpose: 'personalisation', legal_approved: false }, { purpose: 'save_chats', legal_approved: false }]);
  await db.close();
});

test('browser roles lose all direct access; service role keeps it; default privileges are neutralised', async () => {
  const { db } = await seededBaseline();
  // control: before the migration the broad baseline lets a browser rewrite its own billing field
  await h.asRole(db, 'authenticated', A, tx => tx.query("update public.users set subscription_status = 'beta' where id = $1", [A]));
  await db.query("update public.users set subscription_status = 'active' where id = $1", [A]);
  await h.applyUp(db);

  const denied = async (role, sql, params = []) => {
    await assert.rejects(h.asRole(db, role, A, tx => tx.query(sql, params)), /permission denied/i, `${role}: ${sql}`);
  };
  for (const role of ['authenticated', 'anon']) {
    await denied(role, 'select * from public.users');
    await denied(role, "update public.users set subscription_status = 'beta'");
    await denied(role, "update public.users set stripe_customer_id = 'x'");
    await denied(role, 'select * from public.conversations');
    await denied(role, 'insert into public.conversations (user_id) values ($1)', [A]);
    await denied(role, "insert into public.messages (conversation_id, sender, content) select id, 'assistant', 'forged' from public.conversations");
    await denied(role, 'select * from public.messages');
    await denied(role, 'select * from public.user_documents');
    for (const t of await h.wizTables(db)) await denied(role, `select * from public.${t}`);
    await denied(role, 'select public.wiz_get_me($1)', [A]);
    await denied(role, 'select public.wiz_goal_list($1, 10, null, null)', [A]);
  }
  // and no privilege rows at all remain for PUBLIC/anon/authenticated on tables, sequences, functions
  const left = await db.query(`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a
    where n.nspname = 'public' and c.relkind in ('r','S') and (a.grantee = 0 or a.grantee::regrole::text in ('anon','authenticated'))`);
  assert.deepEqual(left.rows, []);
  const fn = await db.query(`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join lateral aclexplode(p.proacl) a
    where n.nspname = 'public' and p.proname like 'wiz\\_%' and (a.grantee = 0 or a.grantee::regrole::text in ('anon','authenticated'))`);
  assert.deepEqual(fn.rows, []);
  // RLS stays on for every table
  const rls = await db.query("select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname='public' and c.relkind='r' and not relrowsecurity");
  assert.deepEqual(rls.rows, []);
  // service role still reaches the data
  await h.asRole(db, 'service_role', null, async tx => {
    assert.equal((await tx.query('select count(*)::int n from public.users')).rows[0].n, 2);
    assert.equal((await tx.query('select count(*)::int n from public.wiz_session_meta')).rows[0].n, 3);
  });
  await db.close();
});

test('rerun of the up migration is a no-op and keeps the originally captured grants', async () => {
  const { db } = await seededBaseline();
  await db.query('grant select (content) on public.messages to anon'); // a column-level privilege in the baseline
  const grants0 = await h.grantSnapshot(db);
  await h.applyUp(db);
  const captured1 = (await db.query('select captured from public.wiz_migration_state')).rows[0].captured;
  const counts = async () => (await db.query("select (select count(*) from public.wiz_session_meta)::int s, (select count(*) from public.wiz_message_meta)::int m, (select count(*) from public.wiz_consent_versions)::int c")).rows[0];
  const c1 = await counts();
  const grants1 = await h.grantSnapshot(db);
  await h.applyUp(db);
  assert.deepEqual((await db.query('select captured from public.wiz_migration_state')).rows[0].captured, captured1, 'capture must not be overwritten by the hardened state');
  assert.deepEqual(await counts(), c1);
  assert.deepEqual(await h.grantSnapshot(db), grants1);
  assert.notDeepEqual(grants1, grants0);
  assert.equal((await db.query('select count(*)::int n from public.wiz_migration_state')).rows[0].n, 1);
  assert.equal((await db.query('select status from public.wiz_migration_state')).rows[0].status, 'applied');
  await db.close();
});

test('rollback restores exact grants (table, column, default-derived), RLS flags, triggers and policies, and keeps new data', async () => {
  const { db, c1 } = await seededBaseline();
  await db.query('grant select (content) on public.messages to anon');
  await db.query('revoke delete on public.user_documents from authenticated');
  await db.query('alter table public.user_documents force row level security');
  const snap = { grants: await h.grantSnapshot(db), rls: await h.rlsSnapshot(db), pol: await h.policySnapshot(db), trg: await h.triggerSnapshot(db) };
  assert.ok(snap.grants.some(g => g.includes('|content|anon|SELECT')), 'fixture column grant present');

  await h.applyUp(db);
  const rpc = createPgliteRpc(db);
  await approveNotices(db);
  await rpc('wiz_consent_record', { p_user_id: A, p_purpose: 'save_chats', p_version: '1', p_action: 'grant' });
  const goal = await rpc('wiz_goal_create', { p_user_id: A, p_data: { title: 'Run a marathon' }, p_key: null });
  await rpc('wiz_message_append', { p_user_id: A, p_session_id: c1, p_sender: 'user', p_content: 'after-up message', p_tokens: 3, p_key: 'key-after-up-1', p_model: null, p_provenance: {} });
  assert.notDeepEqual(await h.grantSnapshot(db), snap.grants);

  await down(db);
  assert.deepEqual(await h.grantSnapshot(db), snap.grants, 'grants restored exactly');
  assert.deepEqual(await h.rlsSnapshot(db), snap.rls, 'RLS flags restored exactly');
  assert.deepEqual(await h.policySnapshot(db), snap.pol);
  assert.deepEqual(await h.triggerSnapshot(db), snap.trg);
  assert.deepEqual(await h.wizFunctions(db), [], 'API functions removed so the API fails closed');
  assert.equal((await db.query('select status from public.wiz_migration_state')).rows[0].status, 'rolled_back');
  // data collected after the up migration is still there
  assert.equal((await db.query('select count(*)::int n from public.wiz_goals where id = $1', [goal.item.id])).rows[0].n, 1);
  assert.equal((await db.query("select count(*)::int n from public.messages where content = 'after-up message'")).rows[0].n, 1);
  assert.equal((await db.query('select count(*)::int n from public.wiz_consent_events')).rows[0].n, 1);
  // with exact grants back, the new tables are still closed to browser roles
  await assert.rejects(h.asRole(db, 'authenticated', A, tx => tx.query('select * from public.wiz_goals')), /permission denied/i);

  await down(db); // second rollback is a no-op
  assert.deepEqual(await h.grantSnapshot(db), snap.grants);

  // up again re-attaches without loss and re-hardens
  await h.applyUp(db);
  assert.equal((await rpc('wiz_goal_get', { p_user_id: A, p_id: goal.item.id })).title, 'Run a marathon');
  assert.equal((await db.query('select count(*)::int n from public.wiz_message_meta where session_id = $1', [c1])).rows[0].n, 3);
  await assert.rejects(h.asRole(db, 'authenticated', A, tx => tx.query('select * from public.users')), /permission denied/i);
  await db.close();
});

test('atomic: an unexpected schema is refused and nothing is applied', async () => {
  const mutations = {
    'missing column': "alter table public.messages drop column tokens_used",
    'wrong type': "alter table public.messages alter column content type varchar(10)",
    'unexpected practitioner column': "alter table public.users add column is_practitioner boolean",
    'nullable email': "alter table public.users alter column email drop not null"
  };
  for (const [label, ddl] of Object.entries(mutations)) {
    const { db } = await seededBaseline();
    await db.exec(ddl);
    const grants = await h.grantSnapshot(db);
    await assert.rejects(h.applyUp(db), /wiz migration refused/, label);
    assert.deepEqual(await h.wizTables(db), [], `${label}: no tables`);
    assert.equal((await db.query("select to_regclass('public.wiz_migration_state') as r")).rows[0].r, null, `${label}: no state table`);
    assert.deepEqual(await h.grantSnapshot(db), grants, `${label}: grants untouched`);
    await db.close();
  }
  // pre-existing wiz_* table that this migration did not create
  const { db } = await seededBaseline();
  await db.exec('create table public.wiz_goals (id int)');
  await assert.rejects(h.applyUp(db), /not recorded as this migration/);
  await db.close();
});

test('atomic: a failure after most work is done rolls everything back (no half-applied state)', async () => {
  const { db } = await seededBaseline();
  const grants = await h.grantSnapshot(db);
  const rls = await h.rlsSnapshot(db);
  // inject a failing statement just before the final state update
  const marker = "update public.wiz_migration_state set status = 'applied'";
  assert.ok(h.UP_SQL.includes(marker));
  const broken = h.UP_SQL.replace(marker, 'select 1 / 0;\n' + marker);
  await assert.rejects(h.applyUp(db, broken), /division by zero/);
  assert.deepEqual(await h.wizTables(db), []);
  assert.deepEqual(await h.wizFunctions(db), []);
  assert.deepEqual(await h.grantSnapshot(db), grants, 'revokes rolled back');
  assert.deepEqual(await h.rlsSnapshot(db), rls);
  assert.equal((await db.query("select to_regclass('public.wiz_migration_state') as r")).rows[0].r, null);
  // the session is clean and the real migration then applies fine
  await h.applyUp(db);
  assert.equal((await db.query('select status from public.wiz_migration_state')).rows[0].status, 'applied');
  await db.close();
});

test('destructive alternative: refused until rolled back, then removes only new data', async () => {
  const { db } = await seededBaseline();
  await h.applyUp(db);
  await assert.rejects(h.applyDestructive(db), /refused/);
  assert.ok((await h.wizTables(db)).length > 10, 'refusal left data in place');
  await down(db);
  await h.applyDestructive(db);
  assert.deepEqual(await h.wizTables(db), []);
  assert.equal((await db.query('select count(*)::int n from public.messages')).rows[0].n, 4);
  assert.equal((await db.query('select count(*)::int n from public.users')).rows[0].n, 2);
  await db.close();
});

test('constraints and ownership in SQL: cross-user access fails even for the service role', async () => {
  const { db, c1, c3 } = await seededBaseline();
  await h.applyUp(db);
  const rpc = createPgliteRpc(db);
  const code = p => p.then(() => null, e => e.message);

  // B (owner of c3) cannot read, list, write to, rename, checkpoint or archive A's session c1
  assert.equal(await code(rpc('wiz_session_get', { p_user_id: B, p_id: c1 })), 'wiz:not_found');
  assert.equal(await code(rpc('wiz_message_list', { p_user_id: B, p_session_id: c1, p_limit: 10, p_after: null })), 'wiz:not_found');
  assert.equal(await code(rpc('wiz_session_update', { p_user_id: B, p_id: c1, p_patch: { title: 'hijack' } })), 'wiz:not_found');
  assert.equal(await code(rpc('wiz_checkpoint_put', { p_user_id: B, p_id: c1, p_checkpoint: { x: 1 }, p_expected_version: null })), 'wiz:not_found');
  await approveNotices(db);
  await rpc('wiz_consent_record', { p_user_id: B, p_purpose: 'save_chats', p_version: '1', p_action: 'grant' });
  assert.equal(await code(rpc('wiz_message_append', { p_user_id: B, p_session_id: c1, p_sender: 'user', p_content: 'x', p_tokens: 0, p_key: null, p_model: null, p_provenance: {} })), 'wiz:not_found');
  assert.equal((await db.query('select title from public.conversations where id = $1', [c1])).rows[0].title, 'Old chat one');
  // list only returns the caller's own sessions
  const list = await rpc('wiz_session_list', { p_user_id: B, p_limit: 50, p_before_ts: null, p_before_id: null, p_archived: null });
  assert.deepEqual(list.items.map(s => s.id), [c3]);

  // records are owner-scoped on read, update and delete
  const goal = await rpc('wiz_goal_create', { p_user_id: A, p_data: { title: 'Mine' }, p_key: null });
  assert.equal(await code(rpc('wiz_goal_get', { p_user_id: B, p_id: goal.item.id })), 'wiz:not_found');
  assert.equal(await code(rpc('wiz_goal_update', { p_user_id: B, p_id: goal.item.id, p_patch: { title: 'x' }, p_expected_version: null })), 'wiz:not_found');
  assert.equal(await code(rpc('wiz_goal_delete', { p_user_id: B, p_id: goal.item.id })), 'wiz:not_found');
  // a record cannot reference another user's session (function check + trigger backstop)
  assert.equal(await code(rpc('wiz_goal_create', { p_user_id: B, p_data: { title: 'x', session_id: c1 }, p_key: null })), 'wiz:not_found');
  await assert.rejects(db.query("insert into public.wiz_journal_entries (user_id, session_id, body) values ($1, $2, 'x')", [B, c1]), /wiz:not_found/);

  // database constraints
  await assert.rejects(db.query("insert into public.wiz_goals (user_id, title) values ($1, '')", [A]), /check constraint/);
  await assert.rejects(db.query("insert into public.wiz_profile_evidence (user_id, statement, source, ai_use_enabled) values ($1, 's', 'assistant_inferred', true)", [A]), /check constraint/);
  await assert.rejects(db.query("insert into public.wiz_pairing_status (user_id, status) values ($1, 'married')", [A]), /check constraint/);
  await assert.rejects(db.query("insert into public.wiz_training_progress (user_id, module_key, status, percent) values ($1, 'm1', 'in_progress', 101)", [A]), /check constraint/);
  await assert.rejects(db.query("insert into public.wiz_consent_events (user_id, purpose, version, action) values ($1, 'save_chats', '99', 'grant')", [A]), /foreign key/);
  await assert.rejects(db.query("insert into public.wiz_session_meta (session_id, user_id, session_number) values ($1, $2, 99)", [c1, B]), /wiz:not_found/);
  await assert.rejects(db.query("insert into public.wiz_goals (user_id, title) values ('33333333-3333-4333-8333-333333333333', 'orphan')"), /foreign key/);

  // user deletion removes every owned record (right to erasure at the data layer)
  await rpc('wiz_journal_create', { p_user_id: A, p_data: { body: 'private' }, p_key: null });
  await db.query('delete from auth.users where id = $1', [A]);
  for (const t of ['wiz_goals', 'wiz_journal_entries', 'wiz_session_meta', 'wiz_message_meta', 'wiz_user_profiles']) {
    assert.equal((await db.query(`select count(*)::int n from public.${t} where user_id = $1`, [A])).rows[0].n, 0, t);
  }
  await db.close();
});

test('local disk persistence: close, reopen, data and migration state survive; rollback after reopen preserves data', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiz-pglite-'));
  try {
    let { db, c1 } = await seededBaseline({ dir });
    await h.applyUp(db);
    let rpc = createPgliteRpc(db);
    await approveNotices(db);
    await rpc('wiz_consent_record', { p_user_id: A, p_purpose: 'save_chats', p_version: '1', p_action: 'grant' });
    const m = await rpc('wiz_message_append', { p_user_id: A, p_session_id: c1, p_sender: 'user', p_content: 'persist me', p_tokens: 2, p_key: 'persist-key-1', p_model: null, p_provenance: {} });
    const g = await rpc('wiz_goal_create', { p_user_id: A, p_data: { title: 'Durable goal', target_date: '2027-01-01' }, p_key: 'goal-key-0001' });
    await db.close();

    db = await h.openDb(dir);
    rpc = createPgliteRpc(db);
    assert.equal((await db.query('select status from public.wiz_migration_state')).rows[0].status, 'applied');
    const list = await rpc('wiz_message_list', { p_user_id: A, p_session_id: c1, p_limit: 50, p_after: null });
    assert.deepEqual(list.items.map(x => x.content), ['hello', 'hi there', 'persist me']);
    assert.equal(list.items[2].id, m.item.id);
    // idempotent retry after restart returns the stored record instead of duplicating
    const again = await rpc('wiz_goal_create', { p_user_id: A, p_data: { title: 'Durable goal', target_date: '2027-01-01' }, p_key: 'goal-key-0001' });
    assert.equal(again.replayed, true);
    assert.equal(again.item.id, g.item.id);
    await down(db);
    await db.close();

    db = await h.openDb(dir);
    assert.equal((await db.query('select count(*)::int n from public.wiz_goals')).rows[0].n, 1);
    assert.equal((await db.query("select count(*)::int n from public.messages where content = 'persist me'")).rows[0].n, 1);
    assert.equal((await db.query('select status from public.wiz_migration_state')).rows[0].status, 'rolled_back');
    await db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('works with and without an auth new-user trigger (attachment unverified in production)', async () => {
  for (const authTrigger of [false, true]) {
    const db = await h.openDb();
    await h.loadBaseline(db, { authTrigger });
    await h.applyUp(db);
    const rpc = createPgliteRpc(db);
    const id = await h.newAuthUser(db, 'new@example.test');
    const me = await rpc('wiz_ensure_user', { p_user_id: id, p_email: 'new@example.test' });
    assert.equal(me.user.email, 'new@example.test');
    assert.equal(me.user.subscription_status, undefined, 'billing fields never returned');
    const again = await rpc('wiz_ensure_user', { p_user_id: id, p_email: 'new@example.test' });
    assert.equal(again.user.id, id);
    assert.equal((await db.query('select count(*)::int n from public.users')).rows[0].n, 1);
    await db.close();
  }
});
