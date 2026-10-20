'use strict';
// Notices/terms harness: foundation + career + privacy + sweep-free API (existing privacy harness) with the consent-notices/terms
// migration applied on top. Local PGlite only; synthetic accounts only.
const fs = require('node:fs');
const path = require('node:path');
const h = require('./db');
const { openPrivacyDb, startPrivacyApi } = require('./privacy-api');

const ROOT = path.join(__dirname, '..', '..');
const NOTICES_UP_SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261019120000_wiz_consent_notices_terms.sql'), 'utf8');
const NOTICES_DOWN_SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'rollbacks', '20261019120000_wiz_consent_notices_terms.down.sql'), 'utf8');
const applyNoticesUp = db => h.applyUp(db, NOTICES_UP_SQL);
const applyNoticesDown = db => h.applyUp(db, NOTICES_DOWN_SQL); // same stop-on-error runner

async function startNoticeApi(opts = {}) {
  const db = await openPrivacyDb();
  await applyNoticesUp(db);
  const ctx = await startPrivacyApi({ ...opts, db });
  return { ...ctx, close: async () => { await ctx.close(); await db.close(); } };
}

module.exports = { startNoticeApi, applyNoticesUp, applyNoticesDown, NOTICES_UP_SQL, NOTICES_DOWN_SQL };
