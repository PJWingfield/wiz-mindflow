'use strict';
// Career extension harness: foundation first (via the existing helper), then the career migration. Local PGlite only.
const fs = require('node:fs');
const path = require('node:path');
const h = require('./db');

const ROOT = path.join(__dirname, '..', '..');
const CAREER_UP_SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261008120000_wiz_career_backend.sql'), 'utf8');
const CAREER_DOWN_SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'rollbacks', '20261008120000_wiz_career_backend.down.sql'), 'utf8');

const applyCareerUp = db => h.applyUp(db, CAREER_UP_SQL);
const applyCareerDown = db => h.applyUp(db, CAREER_DOWN_SQL); // same stop-on-error runner

async function openCareerDb() {
  const db = await h.openDb();
  await h.loadBaseline(db);
  await h.applyUp(db);
  await applyCareerUp(db);
  return db;
}

module.exports = { openCareerDb, applyCareerUp, applyCareerDown, CAREER_UP_SQL, CAREER_DOWN_SQL };
