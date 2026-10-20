'use strict';
// One regression group per finding of the Astra schema review (docs/SCHEMA-REVIEW-CORRECTIONS.md).
// Self-contained: its own seeding on top of the shared PGlite helpers; all local, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers/db');
const { createPgliteRpc } = require('./helpers/pglite-rpc');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const Z = '00000000-0000-4000-8000-000000000000';

// Baseline fixture + two accounts + legacy conversations; `mutate` can alter the baseline before the migration.
async function baseline({ mutate, up = true, authTrigger = false } = {}) {
  const db = await h.openDb();
  await h.loadBaseline(db, { authTrigger });
  await h.newAuthUser(db, 'a@example.test', A);
  await h.newAuthUser(db, 'b@example.test', B);
  if (!authTrigger) {
    await db.query("insert into public.users (id, email) values ($1,'a@example.test'), ($2,'b@example.test')", [A, B]);
  }
  const c1 = (await db.query("insert into public.conversations (user_id, title) values ($1,'one') returning id", [A])).rows[0].id;
  const c2 = (await db.query("insert into public.conversations (user_id, title) values ($1,'two') returning id", [A])).rows[0].id;
  const m1 = (await db.query("insert into public.messages (conversation_id, sender, content) values ($1,'user','legacy') returning id", [c1])).rows[0].id;
  if (mutate) await mutate(db);
  if (up) await h.applyUp(db);
  return { db, c1, c2, m1, rpc: createPgliteRpc(db) };
}
const approve = db => db.exec('update public.wiz_consent_versions set legal_approved = true'); // synthetic LOCAL approval
const accept = db => db.query("select set_config('wiz.accept_legacy_grant_restore', 'yes', false)");
const unaccept = db => db.query("select set_config('wiz.accept_legacy_grant_restore', '', false)");
const rollback = async db => { await accept(db); await h.applyDown(db); };
const failure = p => p.then(() => null, e => e.message);
const asService = (db, sql, params) => h.asRole(db, 'service_role', null, tx => tx.query(sql, params));
const grant = (rpc, who, purpose, action = 'grant') => rpc('wiz_consent_record', { p_user_id: who, p_purpose: purpose, p_version: '1', p_action: action });
const append = (rpc, who, sid, content, key, extra = {}) => rpc('wiz_message_append', {
  p_user_id: who, p_session_id: sid, p_sender: 'user', p_content: content, p_tokens: 0, p_key: key, p_model: null, p_provenance: {}, ...extra
});
const noUnexpectedObjects = async db => {
  assert.deepEqual(await h.wizTables(db), [], 'no wiz tables');
  assert.deepEqual(await h.wizFunctions(db), [], 'no wiz functions');
};

// ---------------------------------------------------------------------------------------------------------------
// Finding 1: browser access fully closed (PUBLIC column grants) and existing callable functions assessed
// ---------------------------------------------------------------------------------------------------------------
test('F1: PUBLIC and browser column privileges are removed; rollback restores them exactly', async () => {
  const mutate = async db => {
    await db.exec('grant select (subscription_status, stripe_customer_id) on public.users to public');
    await db.exec('grant select (content) on public.messages to public');
    await db.exec('grant update (full_name) on public.users to anon');
    await db.exec('grant select (title) on public.conversations to authenticated');
  };
  const { db } = await baseline({ mutate, up: false });
  const before = await h.grantSnapshot(db);
  assert.ok(before.some(g => g.startsWith('users|subscription_status|PUBLIC|SELECT')));
  // control: the defect scenario is real before the migration (PUBLIC column grant + own-row policy)
  const leaked = await h.asRole(db, 'authenticated', A, tx => tx.query('select subscription_status from public.users'));
  assert.equal(leaked.rows.length, 1);

  await h.applyUp(db);
  for (const role of ['authenticated', 'anon']) {
    await assert.rejects(h.asRole(db, role, A, tx => tx.query('select subscription_status from public.users')), /permission denied/i, role);
    await assert.rejects(h.asRole(db, role, A, tx => tx.query('select content from public.messages')), /permission denied/i, role);
    await assert.rejects(h.asRole(db, role, A, tx => tx.query("update public.users set full_name = 'x'")), /permission denied/i, role);
  }
  const left = await db.query(`
    select c.relname, t.attname, case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute t on t.attrelid = c.oid and t.attnum > 0 and not t.attisdropped
    cross join lateral aclexplode(t.attacl) a
    where n.nspname = 'public' and c.relkind = 'r' and (a.grantee = 0 or a.grantee::regrole::text in ('anon', 'authenticated'))`);
  assert.deepEqual(left.rows, [], 'no PUBLIC/anon/authenticated column privileges anywhere in public');

  await rollback(db);
  assert.deepEqual(await h.grantSnapshot(db), before, 'captured PUBLIC and role column grants restored exactly');
  await db.close();
});

test('F1: browser-callable functions are refused until reviewed; non-callables are recorded', async () => {
  const definer = db => db.exec("create function public.leaky() returns setof public.users language sql as 'select * from public.users'");
  const { db } = await baseline({ mutate: definer, up: false });
  const grants = await h.grantSnapshot(db);
  await assert.rejects(h.applyUp(db), /function\(s\) need review: leaky\(\)/);
  await noUnexpectedObjects(db);
  assert.deepEqual(await h.grantSnapshot(db), grants);
  assert.equal((await db.query("select to_regclass('public.wiz_migration_state') as r")).rows[0].r, null);
  // a wrong or partial review list does not unlock it
  await db.query("select set_config('wiz.reviewed_callable_functions', 'other()', false)");
  await assert.rejects(h.applyUp(db), /need review/);
  // reviewed -> applies and is recorded for the staging audit
  await db.query("select set_config('wiz.reviewed_callable_functions', 'leaky()', false)");
  await h.applyUp(db);
  const rec = (await db.query("select captured -> 'callable_functions' as c from public.wiz_migration_state")).rows[0].c;
  assert.deepEqual(rec, [{ signature: 'leaky()', security_definer: false }]);
  await db.close();

  // Trigger functions do not block and are not callable.
  const mixed = async d => {
    await d.exec("create function public.tg() returns trigger language plpgsql as 'begin return new; end'");
  };
  const ctx = await baseline({ mutate: mixed });
  const rec2 = (await ctx.db.query("select captured -> 'callable_functions' as c from public.wiz_migration_state")).rows[0].c;
  assert.deepEqual(rec2, []);
  // wiz_* functions themselves are not callable by browsers or PUBLIC
  const exec = await ctx.db.query(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'wiz\\_%' and has_function_privilege('anon', p.oid, 'EXECUTE')`);
  assert.equal(exec.rows[0].n, 0);
  await ctx.db.close();
});

// ---------------------------------------------------------------------------------------------------------------
// Finding 2: service_role least privilege (trusted server boundary), still sufficient for every function
// ---------------------------------------------------------------------------------------------------------------
test('F2: service_role has no TRUNCATE/billing/state/notice privileges; direct statements are denied', async () => {
  const { db, c1 } = await baseline();
  const denied = async (sql, params) => assert.rejects(asService(db, sql, params), /permission denied/i, sql);
  await denied("update public.users set subscription_status = 'beta'");
  await denied("update public.users set subscription_tier = 'pro'");
  await denied("update public.users set stripe_customer_id = 'cus_x'");
  await denied('update public.users set id = id');
  await denied('delete from public.users');
  await denied('truncate public.users');
  await denied('truncate public.conversations');
  await denied('truncate public.messages');
  await denied('truncate public.wiz_goals');
  await denied('truncate public.wiz_consent_events');
  await denied('select * from public.wiz_migration_state');
  await denied('update public.wiz_migration_state set status = \'rolled_back\'');
  await denied('update public.conversations set user_id = $1 where id = $2', [B, c1]);
  await denied('delete from public.conversations');
  await denied("update public.messages set content = 'edited'");
  await denied('delete from public.messages');
  await denied('update public.wiz_consent_versions set legal_approved = true');
  await denied("insert into public.wiz_consent_versions (purpose, version, summary) values ('x_purpose', '1', 's')");
  await denied('delete from public.wiz_consent_events');
  await denied('delete from public.wiz_message_meta');
  // privilege catalogue: nothing beyond the per-table minimum
  const t = await db.query(`
    select c.relname, p.priv from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
    where n.nspname = 'public' and c.relkind = 'r' and (c.relname in ('users', 'conversations', 'messages') or c.relname like 'wiz\\_%')
      and has_table_privilege('service_role', c.oid, p.priv)`);
  assert.deepEqual(t.rows, []);
  const cols = await db.query(`select
    has_column_privilege('service_role', 'public.users', 'subscription_status', 'UPDATE') sub_upd,
    has_column_privilege('service_role', 'public.users', 'stripe_customer_id', 'UPDATE') stripe_upd,
    has_column_privilege('service_role', 'public.users', 'email', 'UPDATE') email_upd,
    has_column_privilege('service_role', 'public.users', 'full_name', 'UPDATE') name_upd,
    has_column_privilege('service_role', 'public.conversations', 'user_id', 'UPDATE') owner_upd,
    has_table_privilege('service_role', 'public.wiz_migration_state', 'SELECT') state_sel`);
  assert.deepEqual(cols.rows[0], { sub_upd: false, stripe_upd: false, email_upd: true, name_upd: true, owner_upd: false, state_sel: false });
  await db.close();
});

test('F2: every wiz_* function still works under the reduced service_role privileges', async () => {
  const { db, rpc } = await baseline();
  await approve(db);
  const e = await rpc('wiz_ensure_user', { p_user_id: A, p_email: 'a@example.test' });
  assert.equal(e.user.email, 'a@example.test');
  await rpc('wiz_update_profile', { p_user_id: A, p_patch: { full_name: 'Ann', preferences: { track: 'sport' } } });
  await rpc('wiz_onboarding_put', { p_user_id: A, p_answers: { goal: 'focus' }, p_complete: true });
  await rpc('wiz_onboarding_get', { p_user_id: A });
  await grant(rpc, A, 'save_chats');
  await grant(rpc, A, 'personalisation');
  await rpc('wiz_consent_state', { p_user_id: A });
  const s = (await rpc('wiz_session_create', { p_user_id: A, p_data: { track: 'sport', topic: { kind: 'custom', text: 'x' } }, p_key: 'smoke-session-1' })).item;
  await append(rpc, A, s.id, 'hello there coach', 'smoke-msg-0001');
  await append(rpc, A, s.id, 'reply', 'smoke-msg-0002', { p_sender: 'assistant', p_model: 'claude-sonnet-4-6', p_tokens: 5 });
  assert.equal((await rpc('wiz_message_list', { p_user_id: A, p_session_id: s.id, p_limit: 10, p_after: null })).items.length, 2);
  await rpc('wiz_session_update', { p_user_id: A, p_id: s.id, p_patch: { title: 'Renamed', is_archived: true } });
  await rpc('wiz_session_list', { p_user_id: A, p_limit: 5, p_before_ts: null, p_before_id: null, p_archived: null });
  await rpc('wiz_session_get', { p_user_id: A, p_id: s.id });
  await rpc('wiz_checkpoint_put', { p_user_id: A, p_id: s.id, p_checkpoint: { p: 1 }, p_expected_version: 0 });
  await rpc('wiz_checkpoint_get', { p_user_id: A, p_id: s.id });
  const g = (await rpc('wiz_goal_create', { p_user_id: A, p_data: { title: 'g' }, p_key: null })).item;
  await rpc('wiz_goal_get', { p_user_id: A, p_id: g.id });
  await rpc('wiz_goal_list', { p_user_id: A, p_limit: 5, p_before_ts: null, p_before_id: null });
  await rpc('wiz_goal_update', { p_user_id: A, p_id: g.id, p_patch: { why: 'w' }, p_expected_version: 1 });
  await rpc('wiz_goal_delete', { p_user_id: A, p_id: g.id });
  const j = (await rpc('wiz_journal_create', { p_user_id: A, p_data: { body: 'b' }, p_key: null })).item;
  await rpc('wiz_journal_update', { p_user_id: A, p_id: j.id, p_patch: { body: 'c' }, p_expected_version: null });
  await rpc('wiz_journal_get', { p_user_id: A, p_id: j.id });
  await rpc('wiz_journal_list', { p_user_id: A, p_limit: 5, p_before_ts: null, p_before_id: null });
  await rpc('wiz_journal_delete', { p_user_id: A, p_id: j.id });
  const r = (await rpc('wiz_report_create', { p_user_id: A, p_data: { kind: 'k', title: 't', body: 'b', source: 'client_submitted' }, p_key: null })).item;
  await rpc('wiz_report_get', { p_user_id: A, p_id: r.id });
  await rpc('wiz_report_list', { p_user_id: A, p_limit: 5, p_before_ts: null, p_before_id: null });
  await rpc('wiz_report_delete', { p_user_id: A, p_id: r.id });
  const ev = (await rpc('wiz_evidence_create', { p_user_id: A, p_data: { statement: 's', source: 'user_stated' }, p_key: null })).item;
  await rpc('wiz_evidence_correct', { p_user_id: A, p_id: ev.id, p_statement: 's2', p_expected_version: 1 });
  await rpc('wiz_evidence_confirm', { p_user_id: A, p_id: ev.id });
  await rpc('wiz_evidence_set_ai_use', { p_user_id: A, p_id: ev.id, p_enabled: true });
  assert.equal((await rpc('wiz_evidence_ai_usable', { p_user_id: A })).length, 1);
  await rpc('wiz_evidence_list', { p_user_id: A, p_limit: 5, p_before_ts: null, p_before_id: null });
  await rpc('wiz_evidence_delete', { p_user_id: A, p_id: ev.id });
  await rpc('wiz_training_upsert', { p_user_id: A, p_module_key: 'm1', p_status: 'completed', p_percent: 100 });
  await rpc('wiz_training_list', { p_user_id: A });
  await rpc('wiz_pairing_set', { p_user_id: A, p_status: 'pending' });
  assert.equal((await rpc('wiz_pairing_get', { p_user_id: A })).status, 'pending');
  // deleting the auth user still erases everything (cascade does not need service_role DELETE privileges)
  await db.query('delete from auth.users where id = $1', [A]);
  assert.equal((await db.query('select count(*)::int n from public.wiz_session_meta where user_id = $1', [A])).rows[0].n, 0);
  await db.close();
});

// ---------------------------------------------------------------------------------------------------------------
// Finding 3: migration-owned inventory; collisions refused; rollback removes only what was created
// ---------------------------------------------------------------------------------------------------------------
test('F3: recorded inventory equals what the migration actually created, and rollback removes exactly that', async () => {
  const { db } = await baseline();
  const owned = (await db.query("select captured -> 'owned' as o from public.wiz_migration_state")).rows[0].o;
  const actual = (await db.query("select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'wiz\\_%' order by 1")).rows.map(r => r.sig);
  const recorded = (await Promise.all(owned.functions.map(async f => (await db.query('select $1::regprocedure::text as s', [f])).rows[0].s))).sort();
  assert.deepEqual(recorded, actual);
  // every CREATE FUNCTION public.wiz_* in the migration text is in the inventory (nothing created off-list)
  const created = [...h.UP_SQL.matchAll(/^create function public\.(wiz_[a-z_]+)\(/gm)].map(m => m[1]).sort();
  assert.deepEqual([...new Set(actual.map(s => s.replace(/\(.*/, '')))].sort(), [...new Set(created)]);
  const ownedTables = owned.tables.map(t => t.replace('public.', '')).sort();
  assert.deepEqual((await h.wizTables(db)).filter(t => t !== 'wiz_migration_state'), ownedTables);
  await rollback(db);
  assert.deepEqual(await h.wizFunctions(db), []);
  assert.equal((await db.query("select to_regclass('public.wiz_conversations_user_updated_idx') as r")).rows[0].r, null);
  assert.deepEqual((await h.triggerSnapshot(db)).filter(t => t.tgname.startsWith('wiz_')), []);
  await db.close();
});

test('F3: unrelated objects (even wiz-named ones and dependants) survive upgrade and rollback', async () => {
  const mutate = async db => {
    await db.exec('create function public.wiz_helper_unrelated(int) returns int language sql as \'select $1 + 1\'');
    await db.exec('revoke execute on function public.wiz_helper_unrelated(int) from public, anon, authenticated');
    await db.exec('create view public.unrelated_view as select public.wiz_helper_unrelated(1) as x');
    await db.exec('create index unrelated_title_idx on public.conversations (title)');
    await db.exec('create table public.wiz_foreign_table (id int)');
  };
  const { db } = await baseline({ mutate });
  await h.applyUp(db);
  assert.equal((await db.query('select x from public.unrelated_view')).rows[0].x, 2);
  await rollback(db);
  assert.equal((await db.query('select x from public.unrelated_view')).rows[0].x, 2, 'view and its wiz-named function untouched');
  assert.ok(await db.query("select 1 from pg_indexes where indexname = 'unrelated_title_idx'").then(r => r.rows.length === 1));
  assert.equal((await db.query("select count(*)::int n from pg_class where relname = 'wiz_foreign_table'")).rows[0].n, 1);
  await h.applyUp(db); // and it can be re-applied
  assert.equal((await db.query('select x from public.unrelated_view')).rows[0].x, 2);
  await db.close();
});

test('F3: initial collisions with existing functions, indexes, triggers or tables are refused without overwriting', async () => {
  const cases = {
    function: ["create function public.wiz_fail(text) returns void language sql as 'select 1'", /function public\.wiz_fail\(text\) already exists but is not recorded as this migration/],
    index: ['create index wiz_conversations_user_updated_idx on public.conversations (title)', /index public\.wiz_conversations_user_updated_idx already exists but is not recorded/],
    trigger: ['create function public.mine() returns trigger language plpgsql as \'begin return new; end\'; create trigger wiz_guard_reparent before update on public.conversations for each row execute function public.mine()', /trigger public\.conversations\.wiz_guard_reparent already exists but is not recorded/],
    table: ['create table public.wiz_goals (id int)', /table public\.wiz_goals already exists but is not recorded/]
  };
  for (const [label, [ddl, re]] of Object.entries(cases)) {
    const { db } = await baseline({ mutate: async d => {
      await d.exec(ddl);
      await d.exec('revoke execute on function public.wiz_fail(text) from public, anon, authenticated cascade;').catch(e => { if (!e.message.includes('does not exist')) throw e; });
    }, up: false });
    await assert.rejects(h.applyUp(db), re, label);
    assert.equal((await db.query("select to_regclass('public.wiz_migration_state') as r")).rows[0].r, null, label);
    if (label === 'function') assert.equal((await db.query("select prosrc from pg_proc where proname = 'wiz_fail'")).rows[0].prosrc, 'select 1', 'not overwritten');
    await db.close();
  }
  // after a rollback, a foreign function with an owned signature also blocks the re-apply
  const { db } = await baseline();
  await rollback(db);
  await db.exec("create function public.wiz_fail(text) returns void language sql as 'select 1'");
  await db.exec('revoke execute on function public.wiz_fail(text) from public, anon, authenticated');
  await assert.rejects(h.applyUp(db), /exists although the migration is rolled back/);
  await db.close();
});

test('F3: rollback never cascades: an outside dependant makes it fail atomically, then it succeeds once removed', async () => {
  const { db } = await baseline();
  await db.exec("create view public.depends_on_wiz as select public.wiz_consent_active('00000000-0000-4000-8000-000000000000'::uuid, 'x') as ok");
  const grants = await h.grantSnapshot(db);
  await assert.rejects(rollback(db), /depends on function|cannot drop/i);
  assert.equal((await db.query('select status from public.wiz_migration_state')).rows[0].status, 'applied');
  assert.ok((await h.wizFunctions(db)).length > 40, 'functions still present');
  assert.notDeepEqual(await h.grantSnapshot(db), undefined);
  assert.equal((await db.query('select count(*)::int n from public.depends_on_wiz')).rows[0].n, 1, 'dependant view intact');
  await db.exec('drop view public.depends_on_wiz');
  await rollback(db);
  assert.deepEqual(await h.wizFunctions(db), []);
  assert.notDeepEqual(await h.grantSnapshot(db), grants, 'legacy grants restored only after a successful rollback');
  await db.close();
});

// ---------------------------------------------------------------------------------------------------------------
// Finding 4: consent approval gate, revocation ordering, consent-aware evidence read
// ---------------------------------------------------------------------------------------------------------------
test('F4: unapproved notices cannot be accepted or treated as active; revocation is always possible', async () => {
  const { db, rpc, c1 } = await baseline();
  const seeded = (await db.query('select purpose, status, legal_approved from public.wiz_consent_versions order by 1')).rows;
  assert.deepEqual(seeded, [
    { purpose: 'personalisation', status: 'current', legal_approved: false },
    { purpose: 'save_chats', status: 'current', legal_approved: false }
  ]);
  assert.equal(await failure(grant(rpc, A, 'save_chats')), 'wiz:notice_not_approved');
  assert.equal((await db.query('select count(*)::int n from public.wiz_consent_events')).rows[0].n, 0, 'nothing recorded');
  assert.equal(await failure(append(rpc, A, c1, 'hi', 'unapproved-key-1')), 'wiz:consent_required');
  // even a forged grant event (direct owner SQL) is not "active" while the notice is unapproved
  await db.query("insert into public.wiz_consent_events (user_id, purpose, version, action) values ($1, 'save_chats', '1', 'grant'), ($1, 'personalisation', '1', 'grant')", [A]);
  assert.equal((await db.query("select public.wiz_consent_active($1, 'save_chats') as a", [A])).rows[0].a, false);
  assert.equal(await failure(append(rpc, A, c1, 'hi', 'unapproved-key-2')), 'wiz:consent_required');
  assert.deepEqual(await rpc('wiz_evidence_ai_usable', { p_user_id: A }), []);
  // withdrawing needs no approval
  await grant(rpc, A, 'save_chats', 'revoke');
  assert.equal((await db.query("select action from public.wiz_consent_events where user_id = $1 and purpose = 'save_chats' order by seq desc limit 1", [A])).rows[0].action, 'revoke');

  // approved -> usable; un-approving later switches it off again without touching stored decisions
  await approve(db);
  await grant(rpc, A, 'save_chats');
  assert.equal((await append(rpc, A, c1, 'now allowed', 'approved-key-0001')).replayed, false);
  await db.exec("update public.wiz_consent_versions set legal_approved = false where purpose = 'save_chats'");
  assert.equal(await failure(append(rpc, A, c1, 'blocked again', 'approved-key-0002')), 'wiz:consent_required');
  const st = (await rpc('wiz_consent_state', { p_user_id: A })).find(p => p.purpose === 'save_chats');
  assert.equal(st.granted, true, 'user decision remains recorded');
  assert.equal(st.legal_approved, false);
  await db.exec("update public.wiz_consent_versions set legal_approved = true where purpose = 'save_chats'");
  assert.equal((await append(rpc, A, c1, 'allowed again', 'approved-key-0003')).replayed, false);
  await db.close();
});

test('F4: a new notice version invalidates old grants until the owner decides again', async () => {
  const { db, rpc, c1 } = await baseline();
  await approve(db);
  await grant(rpc, A, 'save_chats');
  await db.exec("update public.wiz_consent_versions set status = 'retired' where purpose = 'save_chats' and version = '1'");
  await db.exec("insert into public.wiz_consent_versions (purpose, version, status, summary, legal_approved) values ('save_chats', '2', 'current', 'v2', true)");
  assert.equal(await failure(append(rpc, A, c1, 'x', 'version-key-0001')), 'wiz:consent_required');
  assert.equal(await failure(grant(rpc, A, 'save_chats')), 'wiz:stale_consent_version');
  await rpc('wiz_consent_record', { p_user_id: A, p_purpose: 'save_chats', p_version: '2', p_action: 'grant' });
  assert.equal((await append(rpc, A, c1, 'x', 'version-key-0002')).replayed, false);
  await db.close();
});

test('F4: consent-dependent writes take the documented locks (notice shared -> user consent exclusive); notice changes take the notice lock exclusively', async () => {
  const { db, rpc, c1 } = await baseline();
  await approve(db);
  await grant(rpc, A, 'save_chats');
  const lockRows = async (tx, text) => (await tx.query(
    `select mode, granted from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()
     and ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`, [text])).rows;

  await db.transaction(async tx => {
    await tx.query("select public.wiz_message_append($1, $2, 'user', 'locked write', 0, 'lock-key-0001', null, '{}'::jsonb)", [A, c1]);
    assert.deepEqual(await lockRows(tx, 'wiz_notice:save_chats'), [{ mode: 'ShareLock', granted: true }]);
    assert.deepEqual(await lockRows(tx, `${A}:consent`), [{ mode: 'ExclusiveLock', granted: true }]);
  });
  await db.transaction(async tx => {
    await tx.query("select public.wiz_consent_record($1, 'save_chats', '1', 'revoke')", [A]);
    assert.deepEqual(await lockRows(tx, 'wiz_notice:save_chats'), [{ mode: 'ShareLock', granted: true }]);
    assert.deepEqual(await lockRows(tx, `${A}:consent`), [{ mode: 'ExclusiveLock', granted: true }]);
  });
  await grant(rpc, A, 'save_chats');
  const ev = (await rpc('wiz_evidence_create', { p_user_id: A, p_data: { statement: 's' }, p_key: null })).item;
  await grant(rpc, A, 'personalisation');
  await db.transaction(async tx => {
    await tx.query('select public.wiz_evidence_set_ai_use($1, $2, true)', [A, ev.id]);
    assert.deepEqual(await lockRows(tx, 'wiz_notice:personalisation'), [{ mode: 'ShareLock', granted: true }]);
    assert.deepEqual(await lockRows(tx, `${A}:consent`), [{ mode: 'ExclusiveLock', granted: true }]);
  });
  await db.transaction(async tx => {
    await tx.query('select public.wiz_evidence_ai_usable($1)', [A]);
    assert.equal((await lockRows(tx, `${A}:consent`)).length, 1);
  });
  // owner-side notice changes serialise against the shared holders above
  await db.transaction(async tx => {
    await tx.query("update public.wiz_consent_versions set summary = summary where purpose = 'save_chats'");
    assert.deepEqual(await lockRows(tx, 'wiz_notice:save_chats'), [{ mode: 'ExclusiveLock', granted: true }]);
  });
  await db.transaction(async tx => {
    await tx.query("insert into public.wiz_consent_versions (purpose, version, status, summary) values ('save_chats', '9', 'retired', 'x')");
    assert.equal((await lockRows(tx, 'wiz_notice:save_chats')).length, 1);
  });
  await db.close();
});

test('F4: after revocation neither writes nor the AI-evidence read go through, even with ai_use_enabled still set', async () => {
  const { db, rpc, c1 } = await baseline();
  await approve(db);
  await grant(rpc, A, 'save_chats');
  await grant(rpc, A, 'personalisation');
  const ev = (await rpc('wiz_evidence_create', { p_user_id: A, p_data: { statement: 'I run daily' }, p_key: null })).item;
  await rpc('wiz_evidence_set_ai_use', { p_user_id: A, p_id: ev.id, p_enabled: true });
  assert.deepEqual((await rpc('wiz_evidence_ai_usable', { p_user_id: A })).map(e => e.statement), ['I run daily']);
  await grant(rpc, A, 'personalisation', 'revoke');
  await grant(rpc, A, 'save_chats', 'revoke');
  assert.equal((await db.query('select ai_use_enabled from public.wiz_profile_evidence where id = $1', [ev.id])).rows[0].ai_use_enabled, true, 'flag alone is unchanged');
  assert.deepEqual(await rpc('wiz_evidence_ai_usable', { p_user_id: A }), [], 'AI read rechecks the consent');
  assert.equal(await failure(rpc('wiz_evidence_set_ai_use', { p_user_id: A, p_id: ev.id, p_enabled: true })), 'wiz:consent_required');
  assert.equal(await failure(append(rpc, A, c1, 'after revoke', 'revoked-key-0001')), 'wiz:consent_required');
  // unconfirmed or revoked evidence is never returned, and other users' evidence never is
  await grant(rpc, A, 'personalisation');
  await db.query("insert into public.wiz_profile_evidence (user_id, statement, source) values ($1, 'inferred', 'assistant_inferred')", [A]);
  await rpc('wiz_evidence_set_ai_use', { p_user_id: A, p_id: ev.id, p_enabled: false });
  assert.deepEqual(await rpc('wiz_evidence_ai_usable', { p_user_id: A }), []);
  assert.deepEqual(await rpc('wiz_evidence_ai_usable', { p_user_id: B }), []);
  await db.close();
});

// ---------------------------------------------------------------------------------------------------------------
// Finding 5: relationship integrity
// ---------------------------------------------------------------------------------------------------------------
test('F5: message metadata must name the message\'s own session; revisions must match the evidence owner; reparenting is blocked', async () => {
  const { db, rpc, c1, c2, m1 } = await baseline();
  // legacy message m1 lives in c1 and was backfilled; a fresh message in c1 has no meta yet
  const m2 = (await db.query("insert into public.messages (conversation_id, sender, content) values ($1,'user','direct') returning id", [c1])).rows[0].id;
  await assert.rejects(db.query('insert into public.wiz_message_meta (message_id, session_id, user_id) values ($1, $2, $3)', [m2, c2, A]), /wiz:not_found/, 'wrong session');
  await assert.rejects(db.query('insert into public.wiz_message_meta (message_id, session_id, user_id) values ($1, $2, $3)', [m2, c1, B]), /wiz:not_found/, 'wrong owner');
  await db.query('insert into public.wiz_message_meta (message_id, session_id, user_id) values ($1, $2, $3)', [m2, c1, A]); // correct one is fine
  await assert.rejects(db.query('update public.wiz_message_meta set session_id = $1 where message_id = $2', [c2, m2]), /wiz:not_found/, 'cannot be moved');

  const ev = (await rpc('wiz_evidence_create', { p_user_id: A, p_data: { statement: 's' }, p_key: null })).item;
  await assert.rejects(db.query("insert into public.wiz_profile_evidence_revisions (evidence_id, user_id, version, statement) values ($1, $2, 1, 'x')", [ev.id, B]), /foreign key/);
  await db.query("insert into public.wiz_profile_evidence_revisions (evidence_id, user_id, version, statement) values ($1, $2, 1, 'x')", [ev.id, A]);

  // ownership/parent changes underneath existing metadata are refused for every role, including the table owner
  await assert.rejects(db.query('update public.conversations set user_id = $1 where id = $2', [B, c1]), /wiz:ownership_locked/);
  await assert.rejects(db.query('update public.messages set conversation_id = $1 where id = $2', [c2, m1]), /wiz:ownership_locked/);
  await assert.rejects(asService(db, 'update public.conversations set user_id = $1 where id = $2', [B, c1]), /permission denied/i);
  assert.equal((await db.query('select user_id from public.conversations where id = $1', [c1])).rows[0].user_id, A);
  // a conversation without wiz metadata (created behind the API's back) is not locked, and ordinary updates are unaffected
  const loose = (await db.query('insert into public.conversations (user_id) values ($1) returning id', [A])).rows[0].id;
  await db.query('update public.conversations set user_id = $1 where id = $2', [B, loose]);
  await db.query("update public.conversations set title = 'renamed' where id = $1", [c1]);
  await db.close();
});

// ---------------------------------------------------------------------------------------------------------------
// Finding 6: exact baseline preflight
// ---------------------------------------------------------------------------------------------------------------
test('F6: preflight verifies keys, referential actions, defaults and rejects NULL legacy timestamps', async () => {
  const cases = {
    'FK without cascade': [async d => { await d.exec('alter table public.conversations drop constraint conversations_user_id_fkey; alter table public.conversations add foreign key (user_id) references public.users (id)'); }, /foreign key public\.conversations\(user_id\) -> public\.users\(id\) ON DELETE CASCADE/],
    'FK missing': [d => d.exec('alter table public.messages drop constraint messages_conversation_id_fkey'), /foreign key public\.messages\(conversation_id\)/],
    'users not linked to auth.users': [d => d.exec('alter table public.users drop constraint users_id_fkey'), /foreign key public\.users\(id\) -> auth\.users\(id\)/],
    'users primary key on another column': [d => d.exec('alter table public.users drop constraint users_pkey cascade; alter table public.users add primary key (email)'), /public\.users\.id is not the primary key/],
    'conversations pk gone': [d => d.exec('alter table public.conversations drop constraint conversations_pkey cascade'), /public\.conversations\.id is not the primary key/],
    'title default changed': [d => d.exec("alter table public.conversations alter column title set default 'Untitled'"), /conversations\.title does not have the expected default/],
    'conversation id default dropped': [d => d.exec('alter table public.conversations alter column id drop default'), /conversations\.id does not have the expected default/],
    'subscription default changed': [d => d.exec("alter table public.users alter column subscription_status set default 'active'"), /users\.subscription_status does not have the expected default/],
    'NULL conversation timestamps': [d => d.exec('alter table public.conversations disable trigger user; insert into public.conversations (user_id, created_at, updated_at) select id, null, null from public.users limit 2'), /2 conversations rows have NULL created_at\/updated_at/],
    'NULL message timestamp': [d => d.exec('insert into public.messages (conversation_id, sender, content, created_at) select id, \'user\', \'x\', null from public.conversations limit 1'), /1 messages rows have NULL created_at/]
  };
  for (const [label, [mutate, re]] of Object.entries(cases)) {
    const { db } = await baseline({ mutate, up: false });
    const grants = await h.grantSnapshot(db);
    await assert.rejects(h.applyUp(db), re, label);
    await noUnexpectedObjects(db);
    assert.deepEqual(await h.grantSnapshot(db), grants, `${label}: untouched`);
    await db.close();
  }
  // the NULL-timestamp rows really would have been dropped from keyset lists: the rejection is not hypothetical
  const { db } = await baseline({ up: false });
  await db.exec('insert into public.conversations (user_id, created_at, updated_at) values (\'' + A + '\', now(), null)');
  assert.equal((await db.query('select count(*)::int n from public.conversations where updated_at is not null')).rows[0].n, 2);
  await assert.rejects(h.applyUp(db), /NULL created_at\/updated_at/);
  await db.close();
});

// ---------------------------------------------------------------------------------------------------------------
// Finding 7: lifecycle semantics
// ---------------------------------------------------------------------------------------------------------------
test('F7: an applied rerun is an explicit no-op (no function replacement, backfill or regrant)', async () => {
  const { db, c1 } = await baseline();
  const before = (await db.query('select * from public.wiz_migration_state')).rows[0];
  await db.exec('drop function public.wiz_pairing_get(uuid)'); // drift that an executing rerun would have silently "healed"
  await db.exec('grant select on public.users to anon'); // drift that a re-hardening rerun would have removed
  const c3 = (await db.query('insert into public.conversations (user_id) values ($1) returning id', [A])).rows[0].id; // a rerun would backfill it
  await h.applyUp(db);
  assert.equal((await db.query("select to_regprocedure('public.wiz_pairing_get(uuid)')::text as f")).rows[0].f, null, 'not re-created');
  assert.equal((await db.query("select has_table_privilege('anon', 'public.users', 'SELECT') as p")).rows[0].p, true, 'not re-hardened');
  assert.equal((await db.query('select count(*)::int n from public.wiz_session_meta where session_id = $1', [c3])).rows[0].n, 0, 'not backfilled');
  assert.deepEqual((await db.query('select * from public.wiz_migration_state')).rows[0], before);
  assert.equal((await db.query('select count(*)::int n from public.wiz_session_meta where session_id = $1', [c1])).rows[0].n, 1);
  await db.close();
});

test('F7: a stale applying state is refused; rollback needs acceptance and is a clean no-op when never applied', async () => {
  const { db } = await baseline();
  await db.exec("update public.wiz_migration_state set status = 'applying'");
  await assert.rejects(h.applyUp(db), /previous run left state applying/);
  await db.exec("update public.wiz_migration_state set status = 'applied'");

  // without explicit acceptance of the legacy-grant restore the rollback refuses and changes nothing
  await unaccept(db);
  const grants = await h.grantSnapshot(db);
  await assert.rejects(h.applyDown(db), /accept/);
  assert.equal((await db.query('select status from public.wiz_migration_state')).rows[0].status, 'applied');
  assert.deepEqual(await h.grantSnapshot(db), grants);
  assert.ok((await h.wizFunctions(db)).length > 40);
  await db.close();

  // never applied: the rollback (and the destructive script's guard) are valid and change nothing
  const pristine = await baseline({ up: false });
  const g0 = await h.grantSnapshot(pristine.db);
  await unaccept(pristine.db);
  await h.applyDown(pristine.db);
  assert.deepEqual(await h.grantSnapshot(pristine.db), g0);
  assert.equal((await pristine.db.query("select to_regclass('public.wiz_migration_state') as r")).rows[0].r, null);
  await assert.rejects(h.applyDestructive(pristine.db), /refused/);
  await pristine.db.close();

  // already rolled back: second rollback is a no-op
  const rb = await baseline();
  await rollback(rb.db);
  const g1 = await h.grantSnapshot(rb.db);
  await unaccept(rb.db);
  await h.applyDown(rb.db);
  assert.deepEqual(await h.grantSnapshot(rb.db), g1);
  await rb.db.close();
});

test('F7: lifecycle scripts hold the migration advisory lock while they run', async () => {
  const lockCheck = `
    if not exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and mode = 'ExclusiveLock'
        and ((classid::bigint << 32) | objid::bigint) = hashtextextended('wiz_account_foundation_20261003', 0)) then
      raise exception 'LOCK NOT HELD';
    end if;\n`;
  const pristine = await baseline({ up: false });
  const upMarker = "update public.wiz_migration_state set status = 'applied'";
  assert.ok(h.UP_SQL.includes(upMarker));
  await h.applyUp(pristine.db, h.UP_SQL.replace(upMarker, `do $chk$ begin\n${lockCheck}end $chk$;\n` + upMarker)); // throws if the lock is not held
  assert.equal((await pristine.db.query('select status from public.wiz_migration_state')).rows[0].status, 'applied');
  const fs = require('node:fs');
  const path = require('node:path');
  const downSql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'rollbacks', '20261003120000_wiz_account_foundation.down.sql'), 'utf8');
  const downMarker = "update public.wiz_migration_state set status = 'rolled_back'";
  assert.ok(downSql.includes(downMarker));
  await accept(pristine.db);
  await h.applyUp(pristine.db, downSql.replace(downMarker, lockCheck + downMarker));
  assert.equal((await pristine.db.query('select status from public.wiz_migration_state')).rows[0].status, 'rolled_back');
  // negative control: the probe really fails when the lock is absent
  await assert.rejects(pristine.db.exec(`do $chk$ begin\n${lockCheck}end $chk$;\n`), /LOCK NOT HELD/);
  await pristine.db.close();
});

// ---------------------------------------------------------------------------------------------------------------
// Finding 8: provenance and confirmation
// ---------------------------------------------------------------------------------------------------------------
test('F8: goals keep their validated source and the real confirmation time; replays with changed provenance conflict', async () => {
  const { db, rpc } = await baseline();
  const plain = (await rpc('wiz_goal_create', { p_user_id: A, p_data: { title: 'mine' }, p_key: null })).item;
  assert.equal(plain.source, 'user_stated');
  const when = '2026-09-01T10:00:00Z';
  const sugg = (await rpc('wiz_goal_create', { p_user_id: A, p_data: { title: 'suggested', source: 'assistant_suggested_user_confirmed', confirmed_at: when }, p_key: 'goal-prov-key-1' })).item;
  assert.equal(sugg.source, 'assistant_suggested_user_confirmed');
  assert.equal(new Date(sugg.confirmed_at).toISOString(), '2026-09-01T10:00:00.000Z');
  assert.equal(await failure(rpc('wiz_goal_create', { p_user_id: A, p_data: { title: 'x', source: 'invented' }, p_key: null })), 'wiz:invalid_input');
  assert.equal(await failure(rpc('wiz_goal_create', { p_user_id: A, p_data: { title: 'x', confirmed_at: '2999-01-01T00:00:00Z' }, p_key: null })), 'wiz:invalid_input');
  // same key, same payload: replay returns the original with its original provenance
  const again = await rpc('wiz_goal_create', { p_user_id: A, p_data: { title: 'suggested', source: 'assistant_suggested_user_confirmed', confirmed_at: when }, p_key: 'goal-prov-key-1' });
  assert.equal(again.replayed, true);
  assert.equal(again.item.source, 'assistant_suggested_user_confirmed');
  // same key, different provenance: conflict
  assert.equal(await failure(rpc('wiz_goal_create', { p_user_id: A, p_data: { title: 'suggested' }, p_key: 'goal-prov-key-1' })), 'wiz:idempotency_conflict');
  await db.close();
});

test('F8: message replay detects changed provenance (and model/sender) instead of silently accepting it', async () => {
  const { db, rpc, c1 } = await baseline();
  await approve(db);
  await grant(rpc, A, 'save_chats');
  const p1 = { origin: 'user_input', client: 'web' };
  const first = await append(rpc, A, c1, 'same words', 'prov-msg-key-1', { p_provenance: p1 });
  assert.equal(first.replayed, false);
  const same = await append(rpc, A, c1, 'same words', 'prov-msg-key-1', { p_provenance: p1 });
  assert.equal(same.replayed, true);
  assert.equal(same.item.id, first.item.id);
  assert.equal(await failure(append(rpc, A, c1, 'same words', 'prov-msg-key-1', { p_provenance: { origin: 'assistant_inferred' } })), 'wiz:idempotency_conflict');
  assert.equal(await failure(append(rpc, A, c1, 'same words', 'prov-msg-key-1', { p_provenance: {} })), 'wiz:idempotency_conflict');
  assert.equal(await failure(append(rpc, A, c1, 'same words', 'prov-msg-key-1', { p_provenance: p1, p_model: 'other-model' })), 'wiz:idempotency_conflict');
  assert.deepEqual((await db.query('select provenance from public.wiz_message_meta where message_id = $1', [first.item.id])).rows[0].provenance, p1, 'stored provenance is the original');
  assert.equal((await db.query("select count(*)::int n from public.messages where content = 'same words'")).rows[0].n, 1);
  await db.close();
});
