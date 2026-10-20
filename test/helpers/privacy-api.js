'use strict';
// Privacy harness: baseline + foundation + career + privacy migrations in PGlite, the career API harness on top, and a fixture
// Auth ADMIN that removes identities from the fake GoTrue (and, optionally, from auth.users so the fixture cascade fires).
const h = require('./db');
const c = require('./career-db');
const { startCareerApi } = require('./career-api');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const PRIVACY_UP_SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261008180000_wiz_privacy_controls.sql'), 'utf8');
const PRIVACY_DOWN_SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'rollbacks', '20261008180000_wiz_privacy_controls.down.sql'), 'utf8');
const applyPrivacyUp = db => h.applyUp(db, PRIVACY_UP_SQL);
const applyPrivacyDown = db => h.applyUp(db, PRIVACY_DOWN_SQL);

async function openPrivacyDb() {
  const db = await c.openCareerDb();
  await applyPrivacyUp(db);
  return db;
}

async function startPrivacyApi(opts = {}) {
  const db = opts.db || await openPrivacyDb();
  const holder = { gotrue: null };
  const admin = {
    state: { failDelete: false, failExists: false, stillExists: false, cascade: true, deleted: [], calls: [] },
    async deleteUser(id) {
      admin.state.calls.push(['delete', id]);
      if (admin.state.failDelete) throw new Error('injected auth admin failure');
      const g = holder.gotrue;
      const user = [...g.users.values()].find(u => u.id === id);
      if (!user) return { removed: false };
      g.users.delete(user.email);
      for (const [t, uid] of [...g.access]) if (uid === id) g.access.delete(t);
      if (admin.state.cascade) await db.query('delete from auth.users where id = $1', [id]);
      admin.state.deleted.push(id);
      return { removed: true };
    },
    async exists(id) {
      admin.state.calls.push(['exists', id]);
      if (admin.state.failExists) throw new Error('injected auth admin failure');
      if (admin.state.stillExists) return true;
      return [...holder.gotrue.users.values()].some(u => u.id === id);
    }
  };
  const ctx = await startCareerApi({ ...opts, db, env: { WIZ_PRIVACY_CONTROLS: opts.privacyOff ? 'off' : 'on', ...(opts.env || {}) }, authAdmin: opts.noAdmin ? null : admin });
  holder.gotrue = ctx.gotrue;
  return { ...ctx, admin, close: async () => { await ctx.close(); if (!opts.db) await db.close(); } };
}

module.exports = { openPrivacyDb, startPrivacyApi, applyPrivacyUp, applyPrivacyDown, PRIVACY_UP_SQL, PRIVACY_DOWN_SQL };
