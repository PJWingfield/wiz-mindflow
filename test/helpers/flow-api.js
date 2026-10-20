'use strict';
// Consent-flow harness: foundation + career + privacy + notices/terms + health-consent-flow migrations in PGlite, the privacy API
// harness on top, with the server-side flow ON (WIZ_CONSENT_FLOW=on). Local PGlite only; synthetic accounts only.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const h = require('./db');
const { ANON_KEY } = require('./api');
const { openPrivacyDb, startPrivacyApi } = require('./privacy-api');
const { applyNoticesUp } = require('./notices-api');

const ROOT = path.join(__dirname, '..', '..');
const FLOW_UP_SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261020120000_wiz_health_consent_flow.sql'), 'utf8');
const FLOW_DOWN_SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'rollbacks', '20261020120000_wiz_health_consent_flow.down.sql'), 'utf8');
const applyFlowUp = db => h.applyUp(db, FLOW_UP_SQL);
const applyFlowDown = db => h.applyUp(db, FLOW_DOWN_SQL); // same stop-on-error runner

async function openFlowDb() {
  const db = await openPrivacyDb();
  await applyNoticesUp(db);
  await applyFlowUp(db);
  return db;
}

// With the flow on the app refuses a sign-up that does not accept the current Terms, so the base harness' newAccount no longer works.
// newAccount(label) signs up through the real API WITH the current Terms; newLegacyAccount(label) creates the identity directly in
// the fake Auth service (an account that existed before Terms acceptance was required) and signs in through the API.
async function startFlowApi(opts = {}) {
  const db = opts.db || await openFlowDb();
  // WIZ_CONSENT_FLOW: undefined overrides the legacy helpers' opt-out, so these tests run on the real default (enforcement ON)
  const ctx = await startPrivacyApi({ ...opts, db, env: { WIZ_CONSENT_FLOW: undefined, ...(opts.env || {}) } });
  let k = 0;
  async function account(label, withTerms) {
    const email = `${label}${++k}-${crypto.randomBytes(3).toString('hex')}@example.test`, password = 'correct horse battery';
    if (withTerms) {
      const t = (await ctx.request('GET', '/api/v1/terms/current')).json.terms;
      const up = await ctx.request('POST', '/api/v1/auth/signup', { body: { email, password, over_18: true, accept_terms: true, terms_version: t.version, terms_sha256: t.artifact_sha256 } });
      if (up.status !== 201) throw new Error('signup failed ' + up.status + up.text);
    } else {
      const r = await fetch(ctx.gotrue.url + '/auth/v1/signup', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON_KEY }, body: JSON.stringify({ email, password }) });
      if (!r.ok) throw new Error('fixture identity failed ' + r.status);
    }
    const login = await ctx.request('POST', '/api/v1/auth/login', { body: { email, password } });
    if (login.status !== 200) throw new Error('login failed ' + login.status + login.text);
    const token = login.json.session.access_token;
    const me = await ctx.request('GET', '/api/v1/me', { token });
    return { email, password, token, id: me.json.user.id };
  }
  return { ...ctx, newAccount: label => account(label, true), newLegacyAccount: label => account(label, false), close: async () => { await ctx.close(); if (!opts.db) await db.close(); } };
}

// ---- scenario helpers ----------------------------------------------------------------------------------------------------------
const systemText = call => call.system.map(b => b.text).join('\n');

// A fresh account that is an adult and signed up with the current Terms. No consent decision is recorded.
async function newReadyAccount(ctx, label, extraAnswers = {}) {
  const u = await ctx.newAccount(label);
  const put = await ctx.as(u).put('/me/onboarding', { answers: { over_18: true, ...extraAnswers }, complete: true });
  if (put.status !== 200) throw new Error('onboarding failed ' + put.status + put.text);
  return u;
}
async function acceptTerms(ctx, u) {
  const cur = (await ctx.as(u).get('/terms')).json.terms.current;
  const r = await ctx.as(u).post('/terms/acceptance', { version: cur.version, artifact_sha256: cur.artifact_sha256, accepted: true });
  if (r.status !== 200 && r.status !== 201) throw new Error('terms failed ' + r.status + r.text);
}
// decide(ctx, u, 'health_processing', 'grant'|'revoke'): posts the CURRENT version as the API lists it
async function decide(ctx, u, purpose, action) {
  const p = (await ctx.as(u).get('/consents')).json.purposes.find(x => x.purpose === purpose);
  return ctx.as(u).post('/consents', { purpose, version: p.version, action });
}
let n = 0;
const newSession = async (ctx, u, topic) => (await ctx.as(u).post('/sessions', topic ? { topic } : {}, 'flow-sess-' + (++n) + '-0000')).json.item.id;
const chat = (ctx, u, sessionId, text, key = 'flow-chat-' + (++n) + '-0000') =>
  ctx.as(u).post(`/sessions/${sessionId}/chat`, { messages: [{ role: 'user', content: text }] }, key);
const messageCount = async (ctx, sessionId) => (await ctx.db.query('select count(*)::int n from public.messages where conversation_id = $1', [sessionId])).rows[0].n;

module.exports = { startFlowApi, openFlowDb, applyFlowUp, applyFlowDown, FLOW_UP_SQL, FLOW_DOWN_SQL, systemText, newReadyAccount, acceptTerms, decide, newSession, chat, messageCount };
