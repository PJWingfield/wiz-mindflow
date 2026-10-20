'use strict';
// Career extension migration: applies on top of the foundation, preserves foundation data, hardens access, rolls back
// without deleting anything. Local PGlite only; the baseline is a fixture, so nothing here proves production cascades.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers/db');
const c = require('./helpers/career-db');
const { createPgliteRpc } = require('./helpers/pglite-rpc');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const TABLES = ['wiz_career_plans', 'wiz_prior_learning', 'wiz_portfolio_entries', 'wiz_networking_log', 'wiz_support_map', 'wiz_wellbeing_pulses', 'wiz_attachments'];

async function foundationDb() {
  const db = await h.openDb();
  await h.loadBaseline(db);
  await h.newAuthUser(db, 'a@example.test', A);
  await h.newAuthUser(db, 'b@example.test', B);
  await h.applyUp(db);
  const rpc = createPgliteRpc(db);
  await db.exec('update public.wiz_consent_versions set legal_approved = true');
  await rpc('wiz_ensure_user', { p_user_id: A, p_email: 'a@example.test' });
  await rpc('wiz_ensure_user', { p_user_id: B, p_email: 'b@example.test' });
  const goal = (await rpc('wiz_goal_create', { p_user_id: A, p_data: { title: 'Keep me' }, p_key: null })).item;
  const session = (await rpc('wiz_session_create', { p_user_id: A, p_data: { topic: { kind: 'custom', text: 'x' } }, p_key: null })).item;
  return { db, rpc, goal, session };
}
const snapshot = async db => ({
  grants: await h.grantSnapshot(db), rls: await h.rlsSnapshot(db), policies: await h.policySnapshot(db), triggers: await h.triggerSnapshot(db),
  fnames: (await h.wizFunctions(db)).filter(n => !/^wiz_(career|portfolio|prior_learning|networking|support|pulse|learning|attachment)_/.test(n)),
  rows: (await db.query('select (select count(*) from public.wiz_goals) g, (select count(*) from public.wiz_session_meta) s, (select count(*) from public.users) u')).rows[0]
});

test('refuses to apply without the foundation', async () => {
  const db = await h.openDb();
  await h.loadBaseline(db);
  await assert.rejects(c.applyCareerUp(db), /foundation migration must be applied first/);
  assert.deepEqual((await h.wizTables(db)).filter(t => TABLES.includes(t)), []);
  await db.close();
});

test('applies additively: foundation grants/RLS/policies/triggers/functions/data untouched; career access is service-role only', async () => {
  const { db, goal } = await foundationDb();
  const before = await snapshot(db);
  await c.applyCareerUp(db);
  const after = await snapshot(db);
  assert.deepEqual(after, before, 'nothing about the foundation changed');
  assert.equal((await db.query('select title from public.wiz_goals where id = $1', [goal.id])).rows[0].title, 'Keep me');
  // browser roles: no access to any career table or function; service role: only the functions' needs
  for (const t of TABLES) {
    for (const role of ['anon', 'authenticated']) {
      await assert.rejects(h.asRole(db, role, A, tx => tx.query(`select 1 from public.${t}`)), /permission denied/, `${role} on ${t}`);
    }
    assert.equal((await db.query('select relrowsecurity from pg_class where relname = $1', [t])).rows[0].relrowsecurity, true);
  }
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(h.asRole(db, role, A, tx => tx.query('select public.wiz_career_context($1)', [A])), /permission denied/);
    await assert.rejects(h.asRole(db, role, A, tx => tx.query('select learning_profile from public.wiz_user_profiles')), /permission denied/);
  }
  await assert.rejects(h.asRole(db, 'service_role', null, tx => tx.query('truncate public.wiz_portfolio_entries')), /permission denied/);
  const st = (await db.query("select status from public.wiz_migration_state where name = 'wiz_career_backend_20261008'")).rows;
  assert.deepEqual(st, [{ status: 'applied' }]);
    assert.equal((await db.query("select legal_approved from public.wiz_consent_versions where purpose = 'career_records'")).rows[0].legal_approved, false);
  assert.equal((await db.query("select count(*)::int n from public.wiz_consent_events where purpose = 'career_records'")).rows[0].n, 0);
  await db.close();
});

test('seeded career_records notice ships unapproved and cannot be granted until an owner approves it', async () => {
  const db = await h.openDb();
  await h.loadBaseline(db);
  await h.newAuthUser(db, 'a@example.test', A);
  await h.applyUp(db);
  await c.applyCareerUp(db);
  const rpc = createPgliteRpc(db);
  await rpc('wiz_ensure_user', { p_user_id: A, p_email: 'a@example.test' });
  assert.equal((await db.query("select legal_approved from public.wiz_consent_versions where purpose = 'career_records'")).rows[0].legal_approved, false);
  await assert.rejects(rpc('wiz_consent_record', { p_user_id: A, p_purpose: 'career_records', p_version: '1', p_action: 'grant' }), /notice_not_approved/);
  await assert.rejects(rpc('wiz_pulse_create', { p_user_id: A, p_data: { stress: 3, energy: 4 }, p_key: null }), /consent_required/);
  await db.close();
});

test('re-applying is a no-op', async () => {
  const { db } = await foundationDb();
  await c.applyCareerUp(db);
  const before = (await db.query('select count(*)::int n from pg_proc where proname like $1', ['wiz\\_%'])).rows[0].n;
  await c.applyCareerUp(db);
  assert.equal((await db.query('select count(*)::int n from pg_proc where proname like $1', ['wiz\\_%'])).rows[0].n, before);
  await db.close();
});

test('rollback keeps foundation AND career data, removes only the career functions/triggers; re-apply restores', async () => {
  const { db, rpc, goal } = await foundationDb();
  await c.applyCareerUp(db);
  await db.exec('update public.wiz_consent_versions set legal_approved = true');
  await rpc('wiz_consent_record', { p_user_id: A, p_purpose: 'career_records', p_version: '1', p_action: 'grant' });
  const entry = (await rpc('wiz_portfolio_create', { p_user_id: A, p_data: { entry_type: 'project', title: 'Kept', body: 'body', goal_id: goal.id }, p_key: null })).item;
  await rpc('wiz_learning_put', { p_user_id: A, p_profile: { focus_notes: 'private' }, p_expected_version: 0 });
  const foundation = await snapshot(db);

  await c.applyCareerDown(db);
  assert.deepEqual(await snapshot(db), foundation, 'foundation untouched by the rollback');
  assert.deepEqual(await h.wizFunctions(db), foundation.fnames, 'only foundation functions remain');
  const trg = await db.query("select tgname from pg_trigger where tgname = 'wiz_career_assert_refs' and not tgisinternal");
  assert.equal(trg.rows.length, 0);
  assert.equal((await db.query('select title from public.wiz_portfolio_entries where id = $1', [entry.id])).rows[0].title, 'Kept');
  assert.equal((await db.query('select learning_profile ->> $1 as v from public.wiz_user_profiles where user_id = $2', ['focus_notes', A])).rows[0].v, 'private');
  assert.equal((await db.query("select count(*)::int n from public.wiz_goals where id = $1", [goal.id])).rows[0].n, 1);
  assert.equal((await db.query("select status from public.wiz_migration_state where name = 'wiz_career_backend_20261008'")).rows[0].status, 'rolled_back');
  // foundation functions keep working after the rollback
  assert.equal((await rpc('wiz_goal_get', { p_user_id: A, p_id: goal.id })).title, 'Keep me');
  await c.applyCareerDown(db); // second rollback is a no-op

  await c.applyCareerUp(db);
  const again = await rpc('wiz_career_get', { p_user_id: A, p_kind: 'portfolio', p_id: entry.id });
  assert.equal(again.title, 'Kept');
  assert.equal(again.goal_id, goal.id);
  await db.close();
});

test('cross-owner references are rejected by the database itself and goal deletion clears links', async () => {
  const { db, rpc, goal } = await foundationDb();
  await c.applyCareerUp(db);
  await db.exec('update public.wiz_consent_versions set legal_approved = true');
  for (const u of [A, B]) await rpc('wiz_consent_record', { p_user_id: u, p_purpose: 'career_records', p_version: '1', p_action: 'grant' });
  await assert.rejects(rpc('wiz_portfolio_create', { p_user_id: B, p_data: { entry_type: 'other', title: 't', body: 'b', goal_id: goal.id }, p_key: null }), /invalid_reference/);
  await assert.rejects(rpc('wiz_career_plan_put', { p_user_id: B, p_plan: { goal_ids: [goal.id] }, p_expected_version: null }), /invalid_reference/);
  const e = (await rpc('wiz_portfolio_create', { p_user_id: A, p_data: { entry_type: 'other', title: 't', body: 'b', goal_id: goal.id }, p_key: null })).item;
  await assert.rejects(db.query('update public.wiz_portfolio_entries set user_id = $1 where id = $2', [B, e.id]), /invalid_reference/);
  await rpc('wiz_goal_delete', { p_user_id: A, p_id: goal.id });
  assert.equal((await rpc('wiz_career_get', { p_user_id: A, p_kind: 'portfolio', p_id: e.id })).goal_id, null);
  await db.close();
});
