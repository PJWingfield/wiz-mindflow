'use strict';
// Local PostgreSQL (PGlite) harness. Never touches a real Supabase project.
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const BASELINE_SQL = read('test', 'fixtures', 'baseline.sql');
const UP_SQL = read('supabase', 'migrations', '20261003120000_wiz_account_foundation.sql');
const DOWN_SQL = read('supabase', 'rollbacks', '20261003120000_wiz_account_foundation.down.sql');
const DESTRUCTIVE_SQL = read('supabase', 'rollbacks', 'destructive', '20261003120000_wiz_account_foundation.DROP-NEW-DATA.sql');

// Variant: a new-user trigger exists (attachment is unverified in production, so both cases are tested).
const AUTH_TRIGGER_SQL = `
  create function public.handle_new_user() returns trigger language plpgsql security definer as $$
  begin insert into public.users (id, email) values (new.id, new.email) on conflict do nothing; return new; end $$;
  create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();`;

async function openDb(dataDir) {
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.waitReady;
  return db;
}

async function loadBaseline(db, { authTrigger = false } = {}) {
  await db.exec(BASELINE_SQL);
  if (authTrigger) await db.exec(AUTH_TRIGGER_SQL);
}

// Run a script the way a stop-on-error client does: on failure, roll the session back and rethrow.
async function runScript(db, sql) {
  try {
    await db.exec(sql);
  } catch (err) {
    try { await db.exec('rollback'); } catch (_) { /* no open transaction */ }
    throw err;
  }
}
const applyUp = (db, sql = UP_SQL) => runScript(db, sql);
const applyDown = db => runScript(db, DOWN_SQL);
const applyDestructive = db => runScript(db, DESTRUCTIVE_SQL);

async function newAuthUser(db, email, id) {
  const r = id
    ? await db.query('insert into auth.users (id, email) values ($1, $2) returning id', [id, email])
    : await db.query('insert into auth.users (email) values ($1) returning id', [email]);
  return r.rows[0].id;
}

// Execute fn(tx) in a transaction as a database role, with auth.uid() set the way PostgREST does.
async function asRole(db, role, sub, fn) {
  return db.transaction(async tx => {
    await tx.query(`set local role ${role}`);
    if (sub) await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [sub]);
    return fn(tx);
  });
}

const TOUCHED = "('users','conversations','messages','user_documents')";
// Normalised table + column grants of the touched tables, for exact before/after comparison.
async function grantSnapshot(db) {
  const r = await db.query(`
    select c.relname as rel, case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee,
      a.privilege_type as priv, a.is_grantable as grantable, '' as col
    from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a
    where n.nspname = 'public' and c.relname in ${TOUCHED}
    union all
    select c.relname, case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end, a.privilege_type, a.is_grantable, t.attname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute t on t.attrelid = c.oid and t.attnum > 0 and not t.attisdropped
    cross join lateral aclexplode(t.attacl) a
    where n.nspname = 'public' and c.relname in ${TOUCHED}
    order by 1, 5, 2, 3`);
  return r.rows.map(x => `${x.rel}|${x.col}|${x.grantee}|${x.priv}|${x.grantable}`);
}
async function rlsSnapshot(db) {
  const r = await db.query(`select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c
    join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname in ${TOUCHED} order by 1`);
  return r.rows;
}
async function policySnapshot(db) {
  const r = await db.query("select tablename, policyname, cmd, roles::text, qual, with_check from pg_policies where schemaname = 'public' order by 1, 2");
  return r.rows;
}
async function triggerSnapshot(db) {
  const r = await db.query(`select c.relname, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname in ${TOUCHED} and not t.tgisinternal order by 1, 2`);
  return r.rows;
}
async function wizTables(db) {
  const r = await db.query("select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and relname like 'wiz\\_%' order by 1");
  return r.rows.map(x => x.relname);
}
async function wizFunctions(db) {
  const r = await db.query("select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname like 'wiz\\_%' order by 1");
  return r.rows.map(x => x.proname);
}

module.exports = {
  openDb, loadBaseline, applyUp, applyDown, applyDestructive, newAuthUser, asRole,
  grantSnapshot, rlsSnapshot, policySnapshot, triggerSnapshot, wizTables, wizFunctions, UP_SQL, DOWN_SQL
};
