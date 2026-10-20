'use strict';
// Terms + health-consent flow, enforced on the server: readiness gate before append/retrieval/provider, general-coaching mode after a
// decline, the pre-withdrawal context fence, a last check before the provider call, and Terms at sign-up. Real app + fake GoTrue + PGlite
// with every migration applied; synthetic accounts and markers only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers/db');
const { createPgliteRpc } = require('./helpers/pglite-rpc');
const { openPrivacyDb } = require('./helpers/privacy-api');
const { applyNoticesUp } = require('./helpers/notices-api');
const f = require('./helpers/flow-api');

const ONB = 'MARKER-ONBOARDING-FOCUS';
const OLD_CHAT = 'MARKER-EARLIER-CHAT';
const OLD_PLAN = 'MARKER-OLD-CAREER-PLAN';
const GENERAL_LINE = 'has not allowed WIZ to handle health, wellbeing or neurodiversity information';
const code = r => r.json && r.json.error && r.json.error.code;
const eventsOf = (ctx, uid) => ctx.db.query('select purpose, version, action, created_at from public.wiz_consent_events where user_id = $1 order by seq', [uid]).then(r => r.rows);

// grants every purpose the personalised path needs (each one an explicit API decision) and saves a career plan
async function fullyConsented(ctx, label) {
  const u = await f.newReadyAccount(ctx, label, { focus: ONB });
  for (const p of ['health_processing', 'save_chats', 'personalisation', 'career_records']) {
    const r = await f.decide(ctx, u, p, 'grant');
    assert.equal(r.status, 200, p + ' ' + r.text);
  }
  return u;
}
async function savePlan(ctx, u, direction) {
  const api = ctx.as(u);
  assert.equal((await api.put('/career-plan', { plan: { direction, values: [], routes: [] }, expected_version: 0 })).status, 200);
  assert.equal((await api.put('/career-plan/ai-use', { enabled: true })).status, 200);
}

test('gate: Terms, an answered health choice and the other purposes are each enforced before append, retrieval or provider work', async () => {
  const ctx = await f.startFlowApi();
  try {
    // an account that existed before Terms acceptance was required
    const u = await ctx.newLegacyAccount('gate');
    const api = ctx.as(u);
    assert.equal((await api.put('/me/onboarding', { answers: { over_18: true }, complete: true })).status, 200);
    const sid = await f.newSession(ctx, u);
    const startSid = await f.newSession(ctx, u, { kind: 'custom', text: 'a focus' });
    const body = { messages: [{ role: 'user', content: 'hello' }] };
    const blocked = async (status, c) => {
      const r = await f.chat(ctx, u, sid, 'hello');
      assert.equal(r.status, status); assert.equal(code(r), c);
      assert.equal(await f.messageCount(ctx, sid), 0, 'nothing was appended');
      assert.equal(ctx.providerCalls.length, 0, 'no provider work');
      const legacy = await ctx.request('POST', '/api/chat', { token: u.token, body });
      assert.equal(legacy.status, status); assert.equal(code(legacy), c);
      const start = await api.post(`/sessions/${startSid}/start`, {}, 'flow-start-' + c + '-0');
      assert.equal(code(start), c, 'the start route is gated too');
      assert.equal(await f.messageCount(ctx, startSid), 0);
      assert.equal(ctx.providerCalls.length, 0);
    };
    await blocked(403, 'terms_required');
    assert.deepEqual((await api.get('/readiness')).json.blocker, 'terms_required');

    // Terms: only the current version + hash, affirmative; then the health choice is the next requirement
    await f.acceptTerms(ctx, u);
    await blocked(403, 'health_choice_required');
    assert.equal((await eventsOf(ctx, u.id)).length, 0, 'nothing was granted for them');

    // stale / unknown versions and a changed (not yet approved) notice
    const stale = await api.post('/consents', { purpose: 'health_processing', version: '0', action: 'grant' });
    assert.equal(code(stale), 'stale_consent_version');
    await ctx.db.exec(`update public.wiz_consent_versions set status = 'retired' where purpose = 'health_processing' and version = '1';
      insert into public.wiz_consent_versions (purpose, version, status, summary, legal_approved) values ('health_processing', '2', 'current', 'changed notice (synthetic)', false)`);
    assert.equal((await api.get('/readiness')).json.blocker, 'health_choice_unavailable');
    await blocked(503, 'health_choice_unavailable');
    const unapproved = await api.post('/consents', { purpose: 'health_processing', version: '2', action: 'grant' });
    assert.equal(code(unapproved), 'notice_not_approved');
    await ctx.db.exec("update public.wiz_consent_versions set legal_approved = true where purpose = 'health_processing' and version = '2'");
    await blocked(403, 'health_choice_required');
    assert.equal(ctx.providerCalls.length, 0);
  } finally { await ctx.close(); }
});

test('gate: a grant on an older notice version is not inherited by a changed notice', async () => {
  const ctx = await f.startFlowApi();
  try {
    const u = await f.newReadyAccount(ctx, 'inherit');
    assert.equal((await f.decide(ctx, u, 'health_processing', 'grant')).status, 200);
    assert.equal((await ctx.as(u).get('/readiness')).json.mode, 'health');
    await ctx.db.exec(`update public.wiz_consent_versions set status = 'retired' where purpose = 'health_processing' and version = '1';
      insert into public.wiz_consent_versions (purpose, version, status, summary, legal_approved) values ('health_processing', '2', 'current', 'changed notice (synthetic)', true)`);
    const r = (await ctx.as(u).get('/readiness')).json;
    assert.equal(r.ready, false); assert.equal(r.blocker, 'health_choice_required');
    const sid = await f.newSession(ctx, u);
    assert.equal(code(await f.chat(ctx, u, sid, 'hi')), 'health_choice_required');
    assert.equal(ctx.providerCalls.length, 0);
  } finally { await ctx.close(); }
});

test('allow: version/action/server time recorded; chats retained; save_chats and personalisation stay independent', async () => {
  const ctx = await f.startFlowApi();
  try {
    const u = await f.newReadyAccount(ctx, 'allow', { focus: ONB });
    const sid = await f.newSession(ctx, u);
    const t0 = Date.now();
    const g = await f.decide(ctx, u, 'health_processing', 'grant');
    assert.equal(g.status, 200);
    const [ev] = await eventsOf(ctx, u.id);
    assert.deepEqual([ev.purpose, ev.version, ev.action], ['health_processing', '1', 'grant']);
    assert.ok(Math.abs(new Date(ev.created_at).getTime() - t0) < 5000, 'server clock');
    const ready = (await ctx.as(u).get('/readiness')).json;
    assert.deepEqual([ready.ready, ready.mode, ready.fenced], [true, 'health', false]);

    // health alone does not unlock chat retention: save_chats is its own gate, and it stops the turn before the provider
    const noSave = await f.chat(ctx, u, sid, 'first');
    assert.equal(noSave.status, 403); assert.equal(code(noSave), 'consent_required');
    assert.equal(ctx.providerCalls.length, 0);
    assert.equal((await f.decide(ctx, u, 'save_chats', 'grant')).status, 200);
    const ok = await f.chat(ctx, u, sid, 'first');
    assert.equal(ok.status, 200);
    assert.equal(await f.messageCount(ctx, sid), 2, 'user turn and reply retained');
    // personalisation was never granted, so saved onboarding answers are not in the request
    assert.ok(!f.systemText(ctx.providerCalls[0]).includes(ONB));
    assert.equal((await eventsOf(ctx, u.id)).filter(e => e.purpose === 'personalisation').length, 0);
    // adult attestation still required
    const minor = await ctx.newAccount('minor');
    assert.equal(code(await f.chat(ctx, minor, await f.newSession(ctx, minor), 'hi')), 'age_verification_required');
  } finally { await ctx.close(); }
});

test('decline: general coaching only; no stored profile, earlier chat or career context; chats stay readable and exportable', async () => {
  const ctx = await f.startFlowApi();
  try {
    const u = await f.newReadyAccount(ctx, 'decline', { focus: ONB });
    for (const p of ['save_chats', 'personalisation', 'career_records']) assert.equal((await f.decide(ctx, u, p, 'grant')).status, 200);
    assert.equal((await f.decide(ctx, u, 'health_processing', 'grant')).status, 200);
    const old = await f.newSession(ctx, u);
    assert.equal((await f.chat(ctx, u, old, OLD_CHAT)).status, 200);
    await savePlan(ctx, u, OLD_PLAN);
    const probe = await f.newSession(ctx, u);
    assert.equal((await f.chat(ctx, u, probe, 'baseline probe')).status, 200);
    const baseline = f.systemText(ctx.providerCalls.at(-1));
    for (const m of [ONB, OLD_CHAT, OLD_PLAN]) assert.ok(baseline.includes(m), 'fixture personalisation really flows with health allowed: ' + m);

    // decline = a current-version revoke
    const t0 = Date.now();
    assert.equal((await f.decide(ctx, u, 'health_processing', 'revoke')).status, 200);
    const evs = (await eventsOf(ctx, u.id)).filter(e => e.purpose === 'health_processing');
    assert.deepEqual(evs.at(-1).action, 'revoke'); assert.equal(evs.at(-1).version, '1');
    assert.ok(Math.abs(new Date(evs.at(-1).created_at).getTime() - t0) < 5000);
    const r = (await ctx.as(u).get('/readiness')).json;
    assert.deepEqual([r.ready, r.mode, r.fenced, r.health.decision], [true, 'general', true, 'declined']);

    // a new session and the old session both get general coaching: only the current message, the general brief, nothing stored
    const fresh = await f.newSession(ctx, u);
    assert.equal((await f.chat(ctx, u, fresh, 'general question')).status, 200);
    let call = ctx.providerCalls.at(-1), sys = f.systemText(call);
    for (const m of [ONB, OLD_CHAT, OLD_PLAN, 'baseline probe']) assert.ok(!sys.includes(m), 'not injected: ' + m);
    assert.ok(sys.includes(GENERAL_LINE));
    const cont = await f.chat(ctx, u, old, 'post-decline note in the old session');
    assert.equal(cont.status, 200);
    call = ctx.providerCalls.at(-1);
    assert.equal(call.messages.length, 1, 'history from before the decline is not sent');
    assert.ok(!JSON.stringify(call).includes(OLD_CHAT));
    const prov = (await ctx.db.query("select x.provenance from public.wiz_message_meta x join public.messages m on m.id = x.message_id where m.conversation_id = $1 and m.sender = 'assistant' order by x.seq desc limit 1", [old])).rows[0].provenance;
    assert.deepEqual([prov.health_mode, prov.personalisation.used], ['general', false]);

    // legacy route: allowed in general mode, with the general brief and no retained context
    const legacy = await ctx.request('POST', '/api/chat', { token: u.token, body: { messages: [{ role: 'user', content: 'legacy hello' }] } });
    assert.equal(legacy.status, 200);
    assert.ok(f.systemText(ctx.providerCalls.at(-1)).includes(GENERAL_LINE));

    // history is still readable and exportable; nothing was deleted
    const listed = await ctx.as(u).get(`/sessions/${old}/messages`);
    assert.ok(listed.json.items.some(m => m.content.includes(OLD_CHAT)));
    const exp = await ctx.request('GET', '/api/v1/account/export', { token: u.token });
    assert.ok(JSON.stringify(exp.json.sessions).includes(OLD_CHAT));
    assert.ok(exp.json.consents.events.some(e => e.purpose === 'health_processing' && e.action === 'revoke'));

    // an initial decline (never granted) is distinct from "no decision"
    const v = await f.newReadyAccount(ctx, 'decline-first');
    assert.equal((await ctx.as(v).get('/readiness')).json.blocker, 'health_choice_required');
    assert.equal((await f.decide(ctx, v, 'health_processing', 'revoke')).status, 200);
    assert.equal((await ctx.as(v).get('/readiness')).json.health.decision, 'declined');
  } finally { await ctx.close(); }
});

test('withdrawal: pre-withdrawal context stays fenced after re-consent, survives restart, and only new material returns', async () => {
  const ctx = await f.startFlowApi();
  try {
    const u = await fullyConsented(ctx, 'withdraw');
    const s1 = await f.newSession(ctx, u);
    assert.equal((await f.chat(ctx, u, s1, OLD_CHAT)).status, 200);
    await savePlan(ctx, u, OLD_PLAN);

    assert.equal((await f.decide(ctx, u, 'health_processing', 'revoke')).status, 200); // withdrawal
    const s2 = await f.newSession(ctx, u);
    assert.equal((await f.chat(ctx, u, s2, 'MARKER-POST-WITHDRAWAL-GENERAL')).status, 200);
    assert.equal((await f.chat(ctx, u, s1, 'MARKER-NOTE-IN-OLD-SESSION')).status, 200);

    // re-consent does NOT bring the old material back
    assert.equal((await f.decide(ctx, u, 'health_processing', 'grant')).status, 200);
    const r = (await ctx.as(u).get('/readiness')).json;
    assert.deepEqual([r.mode, r.fenced], ['health', true]);
    const s3 = await f.newSession(ctx, u);
    assert.equal((await f.chat(ctx, u, s3, 'after regrant')).status, 200);
    let sys = f.systemText(ctx.providerCalls.at(-1));
    for (const m of [ONB, OLD_CHAT, OLD_PLAN, 'MARKER-NOTE-IN-OLD-SESSION']) assert.ok(!sys.includes(m), 'still fenced: ' + m);
    assert.ok(sys.includes('MARKER-POST-WITHDRAWAL-GENERAL'), 'a session begun after the fence is ordinary context again');
    // the old session itself continues without its pre-fence history or derived notes
    assert.equal((await f.chat(ctx, u, s1, 'continuing old session')).status, 200);
    assert.ok(!JSON.stringify(ctx.providerCalls.at(-1).messages).includes(OLD_CHAT));

    // new material created after the fence is usable: delete + recreate the plan
    assert.equal((await ctx.as(u).del('/career-plan')).status < 300, true);
    await savePlan(ctx, u, 'MARKER-NEW-CAREER-PLAN');
    const s4 = await f.newSession(ctx, u);
    assert.equal((await f.chat(ctx, u, s4, 'with new plan')).status, 200);
    sys = f.systemText(ctx.providerCalls.at(-1));
    assert.ok(sys.includes('MARKER-NEW-CAREER-PLAN') && !sys.includes(OLD_PLAN));

    // the boundary lives in the database, not in process memory
    const fresh = createPgliteRpc(ctx.db);
    const st = await fresh('wiz_coaching_state', { p_user_id: u.id });
    assert.ok(st.fence_at && st.health.decision === 'granted');
    const pc = await fresh('wiz_personalisation_context', { p_user_id: u.id, p_session_id: s4, p_max_sessions: 5, p_per_session: 8 });
    assert.deepEqual(pc.onboarding.answers, {});
    assert.ok(!JSON.stringify(pc.sessions).includes(OLD_CHAT));
    // nothing deleted
    assert.ok(JSON.stringify((await ctx.as(u).get(`/sessions/${s1}/messages`)).json).includes(OLD_CHAT));
  } finally { await ctx.close(); }
});

test('withdrawal during retrieval: the assembled request is refused unsent, then retried in general mode', async () => {
  const hook = { fn: null };
  const retrieval = { search: async () => { if (hook.fn) await hook.fn(); return { status: 'no_match', tiers: {}, chunks: [] }; } };
  const ctx = await f.startFlowApi({ retrieval });
  try {
    const u = await fullyConsented(ctx, 'race');
    const sid = await f.newSession(ctx, u);
    assert.equal((await f.chat(ctx, u, sid, OLD_CHAT)).status, 200);
    const before = ctx.providerCalls.length;
    hook.fn = () => f.decide(ctx, u, 'health_processing', 'revoke');
    const key = 'flow-race-key-0001';
    const r = await f.chat(ctx, u, sid, 'sent while withdrawing', key);
    assert.equal(r.status, 409); assert.equal(code(r), 'consent_changed');
    assert.equal(ctx.providerCalls.length, before, 'nothing reached the provider');
    assert.equal((await ctx.as(u).get('/readiness')).json.mode, 'general');
    hook.fn = null;
    const retry = await f.chat(ctx, u, sid, 'sent while withdrawing', key);
    assert.equal(retry.status, 200);
    assert.equal(ctx.providerCalls.length, before + 1);
    const sys = f.systemText(ctx.providerCalls.at(-1));
    assert.ok(!sys.includes(ONB) && !sys.includes(OLD_CHAT) && sys.includes(GENERAL_LINE));
    assert.ok(!JSON.stringify(ctx.providerCalls.at(-1).messages).includes(OLD_CHAT));
  } finally { await ctx.close(); }
});

test('terms at sign-up: validated before the account exists; recorded against the Auth result; truthful without a session', async () => {
  const ctx = await f.startFlowApi();
  try {
    const cur = await ctx.request('GET', '/api/v1/terms/current');
    assert.equal(cur.json.enabled, true);
    const t = cur.json.terms;
    assert.deepEqual([t.version, t.artifact_id], ['1.0', 'terms-2026-10-16-v1']);
    const base = { password: 'correct horse battery', over_18: true };
    const usersBefore = ctx.gotrue.users.size;
    const bad = async (extra, status, c) => {
      const r = await ctx.request('POST', '/api/v1/auth/signup', { body: { ...base, email: 'bad' + Math.random().toString(16).slice(2) + '@example.test', ...extra } });
      assert.equal(r.status, status, JSON.stringify(extra)); assert.equal(code(r), c);
      assert.equal(ctx.gotrue.users.size, usersBefore, 'no Auth account was created');
    };
    await bad({}, 400, 'terms_not_accepted');
    await bad({ accept_terms: false, terms_version: t.version, terms_sha256: t.artifact_sha256 }, 400, 'terms_not_accepted');
    await bad({ accept_terms: true, terms_version: '0.1', terms_sha256: t.artifact_sha256 }, 409, 'stale_terms_version');
    await bad({ accept_terms: true, terms_version: t.version, terms_sha256: 'a'.repeat(64) }, 409, 'stale_terms_version');
    await bad({ accept_terms: true, terms_version: t.version, terms_sha256: t.artifact_sha256, user_id: '00000000-0000-4000-8000-000000000000' }, 400, 'invalid_request');

    // session issued: acceptance recorded against the user the Auth service returned, with the server's time
    const t0 = Date.now();
    const ok = await ctx.request('POST', '/api/v1/auth/signup', { body: { ...base, email: 'new1@example.test', accept_terms: true, terms_version: t.version, terms_sha256: t.artifact_sha256 } });
    assert.equal(ok.status, 201); assert.equal(ok.json.terms_recorded, true);
    const row = (await ctx.db.query('select user_id, version, artifact_sha256, accepted_at from public.wiz_terms_acceptances')).rows;
    assert.equal(row.length, 1);
    assert.deepEqual([row[0].user_id, row[0].version, row[0].artifact_sha256], [ok.json.user.id, '1.0', t.artifact_sha256]);
    assert.ok(Math.abs(row[0].accepted_at.getTime() - t0) < 5000);

    // email confirmation: no session, so nothing is recorded and the response says so; coaching waits for acceptance after sign-in
    ctx.gotrue.state.confirmEmail = true;
    const pend = await ctx.request('POST', '/api/v1/auth/signup', { body: { ...base, email: 'pending@example.test', accept_terms: true, terms_version: t.version, terms_sha256: t.artifact_sha256 } });
    assert.equal(pend.status, 201); assert.equal(pend.json.confirmation_required, true); assert.equal(pend.json.terms_recorded, false);
    assert.equal((await ctx.db.query('select count(*)::int n from public.wiz_terms_acceptances')).rows[0].n, 1);
    ctx.gotrue.users.get('pending@example.test').confirmed = true;
    const login = await ctx.request('POST', '/api/v1/auth/login', { body: { email: 'pending@example.test', password: base.password } });
    const p = { token: login.json.session.access_token };
    p.id = (await ctx.request('GET', '/api/v1/me', { token: p.token })).json.user.id;
    assert.equal((await ctx.as(p).get('/readiness')).json.blocker, 'terms_required');
    assert.equal((await ctx.as(p).put('/me/onboarding', { answers: { over_18: true }, complete: true })).status, 200);
    assert.equal(code(await f.chat(ctx, p, await f.newSession(ctx, p), 'hi')), 'terms_required');
    await f.acceptTerms(ctx, p);
    assert.equal((await ctx.as(p).get('/readiness')).json.blocker, 'health_choice_required');
    ctx.gotrue.state.confirmEmail = false;

    // recording fails after the account exists: explicit recoverable failure, and coaching stays blocked
    await ctx.db.exec('revoke insert on public.wiz_terms_acceptances from service_role');
    const fail = await ctx.request('POST', '/api/v1/auth/signup', { body: { ...base, email: 'norecord@example.test', accept_terms: true, terms_version: t.version, terms_sha256: t.artifact_sha256 } });
    assert.equal(fail.status, 503); assert.equal(code(fail), 'terms_not_recorded');
    assert.equal(fail.json.session, undefined, 'no session was handed out');
    await ctx.db.exec('grant insert on public.wiz_terms_acceptances to service_role');
    const login2 = await ctx.request('POST', '/api/v1/auth/login', { body: { email: 'norecord@example.test', password: base.password } });
    const q = { token: login2.json.session.access_token };
    assert.equal((await ctx.as(q).get('/readiness')).json.blocker, 'terms_required');
    await ctx.as(q).put('/me/onboarding', { answers: { over_18: true }, complete: true });
    assert.equal(code(await f.chat(ctx, q, await f.newSession(ctx, q), 'hi')), 'terms_required');
    assert.equal(ctx.providerCalls.length, 0);
  } finally { await ctx.close(); }
});

test('default is ON: only an explicit "off" disables enforcement, and the default runtime enforces readiness and retention', async () => {
  const { loadConfig } = require('../lib/config');
  assert.equal(loadConfig({}).consent.flow, true);
  assert.equal(loadConfig({ WIZ_CONSENT_FLOW: 'on' }).consent.flow, true);
  assert.equal(loadConfig({ WIZ_CONSENT_FLOW: 'off' }).consent.flow, false);
  assert.equal(loadConfig({ WIZ_CONSENT_FLOW: 'ON' }).consent.flow, true, 'anything but exactly "off" keeps enforcement');
  const ctx = await f.startFlowApi(); // runs on the real default (no WIZ_CONSENT_FLOW at all)
  try {
    const u = await f.newReadyAccount(ctx, 'default-on');
    const r = (await ctx.as(u).get('/readiness')).json;
    assert.deepEqual([r.enabled, r.ready, r.blocker], [true, false, 'health_choice_required']);
    assert.equal(code(await f.chat(ctx, u, await f.newSession(ctx, u), 'hi')), 'health_choice_required');
    assert.equal(code(await ctx.request('POST', '/api/chat', { token: u.token, body: { messages: [{ role: 'user', content: 'hi' }] } })), 'health_choice_required');
    assert.equal(ctx.providerCalls.length, 0);
  } finally { await ctx.close(); }
});

test('first use: retention is reported, asked for explicitly, never granted silently; the first chat then completes', async () => {
  const ctx = await f.startFlowApi();
  try {
    const u = await f.newReadyAccount(ctx, 'first-use');
    assert.equal((await f.decide(ctx, u, 'health_processing', 'revoke')).status, 200); // "continue without sharing"
    const r = (await ctx.as(u).get('/readiness')).json;
    assert.equal(r.ready, true);
    assert.deepEqual([r.retention.version, r.retention.granted], ['2', false]);
    assert.ok(r.retention.summary && r.retention.summary.length > 10, 'the approved summary is supplied for the dialog');
    const sid = await f.newSession(ctx, u);
    const first = await f.chat(ctx, u, sid, 'my first message', 'flow-first-use-0001');
    assert.equal(first.status, 403); assert.equal(code(first), 'consent_required');
    assert.equal(await f.messageCount(ctx, sid), 0);
    assert.equal(ctx.providerCalls.length, 0);
    assert.equal((await eventsOf(ctx, u.id)).filter(e => e.purpose === 'save_chats').length, 0, 'no silent grant');
    // the explicit decision the dialog posts, using the version the API reported
    assert.equal((await ctx.as(u).post('/consents', { purpose: 'save_chats', version: r.retention.version, action: 'grant' })).status, 200);
    assert.equal((await ctx.as(u).get('/readiness')).json.retention.granted, true);
    const again = await f.chat(ctx, u, sid, 'my first message', 'flow-first-use-0001'); // the very same request is repeated
    assert.equal(again.status, 200);
    assert.equal(await f.messageCount(ctx, sid), 2);
    assert.deepEqual((await eventsOf(ctx, u.id)).map(e => `${e.purpose}:${e.version}:${e.action}`), ['health_processing:1:revoke', 'save_chats:2:grant']);
  } finally { await ctx.close(); }
});

test('learning profile: re-saving, or editing one field, does not restore unchanged fenced fields; only genuinely new values reach the model', async () => {
  const ctx = await f.startFlowApi();
  try {
    const u = await fullyConsented(ctx, 'learn');
    const api = ctx.as(u);
    const OLD = ['MARKER-LEARN-NOTE', 'MARKER-OLD-STYLE', 'MARKER-OLD-ADJUSTMENT'];
    const profile = { learning_styles: ['MARKER-OLD-STYLE'], focus_notes: 'MARKER-LEARN-NOTE', useful_adjustments: 'MARKER-OLD-ADJUSTMENT', self_recognition: 'MARKER-PRIVATE-SELF' };
    assert.equal((await api.put('/learning-profile', { profile, expected_version: 0 })).status, 200);
    assert.equal((await api.put('/learning-profile/ai-use', { enabled: true })).status, 200);
    assert.equal((await f.chat(ctx, u, await f.newSession(ctx, u), 'baseline')).status, 200);
    for (const m of OLD) assert.ok(f.systemText(ctx.providerCalls.at(-1)).includes(m), 'fixture: used before withdrawal: ' + m);
    assert.ok(!f.systemText(ctx.providerCalls.at(-1)).includes('MARKER-PRIVATE-SELF'), 'self_recognition is never offered');

    assert.equal((await f.decide(ctx, u, 'health_processing', 'revoke')).status, 200);
    assert.equal((await f.decide(ctx, u, 'health_processing', 'grant')).status, 200);
    const cur = (await api.get('/learning-profile')).json.item;
    assert.equal((await api.put('/learning-profile', { profile: cur.profile, expected_version: cur.version })).status, 200); // the UI "Save" with no edits
    assert.equal((await f.chat(ctx, u, await f.newSession(ctx, u), 'after plain re-save')).status, 200);
    for (const m of OLD) assert.ok(!f.systemText(ctx.providerCalls.at(-1)).includes(m), 'unchanged retained content stays fenced: ' + m);
    assert.ok((await api.get('/learning-profile')).json.item.profile.focus_notes === 'MARKER-LEARN-NOTE', 'the owner can still view it');

    // change ONE field: only that value is offered; the unchanged old fields stay out
    const cur2 = (await api.get('/learning-profile')).json.item;
    assert.equal((await api.put('/learning-profile', { profile: { ...cur2.profile, focus_notes: 'MARKER-NEW-LEARN-NOTE' }, expected_version: cur2.version })).status, 200);
    assert.equal((await f.chat(ctx, u, await f.newSession(ctx, u), 'after new content')).status, 200);
    let sys = f.systemText(ctx.providerCalls.at(-1));
    assert.ok(sys.includes('MARKER-NEW-LEARN-NOTE'), 'the genuinely new value is offered');
    for (const m of ['MARKER-OLD-STYLE', 'MARKER-OLD-ADJUSTMENT', 'MARKER-LEARN-NOTE', 'MARKER-PRIVATE-SELF']) assert.ok(!sys.includes(m), 'still out: ' + m);
    const kept = (await api.get('/learning-profile')).json.item.profile;
    assert.deepEqual([kept.learning_styles[0], kept.useful_adjustments, kept.self_recognition], ['MARKER-OLD-STYLE', 'MARKER-OLD-ADJUSTMENT', 'MARKER-PRIVATE-SELF'], 'nothing was deleted');

    // a second withdrawal fences everything that exists then, including the field that had been new
    assert.equal((await f.decide(ctx, u, 'health_processing', 'revoke')).status, 200);
    assert.equal((await f.decide(ctx, u, 'health_processing', 'grant')).status, 200);
    assert.equal((await f.chat(ctx, u, await f.newSession(ctx, u), 'after second withdrawal')).status, 200);
    sys = f.systemText(ctx.providerCalls.at(-1));
    for (const m of [...OLD, 'MARKER-NEW-LEARN-NOTE']) assert.ok(!sys.includes(m), 'fenced again: ' + m);
    const cur3 = (await api.get('/learning-profile')).json.item;
    assert.equal((await api.put('/learning-profile', { profile: { ...cur3.profile, learning_styles: ['MARKER-NEWER-STYLE'] }, expected_version: cur3.version })).status, 200);
    assert.equal((await f.chat(ctx, u, await f.newSession(ctx, u), 'after second edit')).status, 200);
    sys = f.systemText(ctx.providerCalls.at(-1));
    assert.ok(sys.includes('MARKER-NEWER-STYLE'));
    for (const m of [...OLD, 'MARKER-NEW-LEARN-NOTE']) assert.ok(!sys.includes(m), 'still out: ' + m);

    // the fingerprints hold no profile text
    const stored = JSON.stringify((await ctx.db.query('select learning_fence_hashes from public.wiz_user_profiles where user_id = $1', [u.id])).rows[0]);
    assert.ok(!stored.includes('MARKER') && /[0-9a-f]{32}/.test(stored));
  } finally { await ctx.close(); }
});

test('in-flight request: a reply to a request begun before a withdrawal is kept, but never reused as context', async () => {
  const calls = [];
  let release; const held = new Promise(r => { release = r; });
  const provider = {
    model: 'test-model',
    async complete(args) {
      calls.push(args);
      if (calls.length === 2) { await held; return [{ type: 'text', text: 'DERIVED-FROM-OLD-CONTEXT' }]; } // the controlled pending request
      return [{ type: 'text', text: 'plain reply' }];
    }
  };
  const ctx = await f.startFlowApi({ provider });
  try {
    const u = await fullyConsented(ctx, 'inflight');
    const sid = await f.newSession(ctx, u);
    assert.equal((await f.chat(ctx, u, sid, OLD_CHAT)).status, 200);
    const key = 'flow-inflight-key-01';
    const pending = f.chat(ctx, u, sid, 'second question', key);
    for (let i = 0; i < 100 && calls.length < 2; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(calls.length, 2, 'the request reached the provider');
    assert.ok(f.systemText(calls[1]).includes(ONB), 'it was assembled WITH old personal context');
    assert.equal((await f.decide(ctx, u, 'health_processing', 'revoke')).status, 200); // withdrawal while the call is out
    release();
    const done = await pending;
    assert.equal(done.status, 200); assert.equal(done.json.content, 'DERIVED-FROM-OLD-CONTEXT');

    // the next turn must not carry the derivative (or the old-context exchange it answered)
    assert.equal((await f.chat(ctx, u, sid, 'third question')).status, 200);
    const next = JSON.stringify(calls[2]);
    for (const m of ['DERIVED-FROM-OLD-CONTEXT', 'second question', OLD_CHAT, ONB]) assert.ok(!next.includes(m), 'not reused: ' + m);

    // ... while the exchange stays stored, readable, exportable, and an identical retry still returns the completed reply
    const listed = JSON.stringify((await ctx.as(u).get(`/sessions/${sid}/messages`)).json);
    assert.ok(listed.includes('DERIVED-FROM-OLD-CONTEXT') && listed.includes('second question'));
    assert.ok(JSON.stringify((await ctx.request('GET', '/api/v1/account/export', { token: u.token })).json.sessions).includes('DERIVED-FROM-OLD-CONTEXT'));
    const retry = await f.chat(ctx, u, sid, 'second question', key);
    assert.equal(retry.status, 200); assert.equal(retry.json.replayed, true); assert.equal(retry.json.content, 'DERIVED-FROM-OLD-CONTEXT');
    assert.equal(calls.length, 3, 'the retry did not call the provider again');
    const prov = (await ctx.db.query("select x.provenance from public.wiz_message_meta x join public.messages m on m.id = x.message_id where m.content = 'DERIVED-FROM-OLD-CONTEXT'")).rows[0].provenance;
    assert.equal(prov.request_fence, 'none', 'the reply records the fence its request was assembled under');
  } finally { await ctx.close(); }
});

test('flow off (explicit opt-out): behaviour is unchanged and no Terms or health requirement applies', async () => {
  const ctx = await f.startFlowApi({ env: { WIZ_CONSENT_FLOW: 'off' } });
  try {
    assert.equal((await ctx.request('GET', '/api/v1/terms/current')).json.enabled, false);
    const email = 'legacy@example.test';
    const up = await ctx.request('POST', '/api/v1/auth/signup', { body: { email, password: 'correct horse battery', over_18: true } });
    assert.equal(up.status, 201); assert.equal(up.json.terms_recorded, undefined);
    const u = { token: up.json.session.access_token };
    assert.deepEqual((await ctx.as(u).get('/readiness')).json, { enabled: false, ready: true, billing: { required: false } });
    assert.equal((await ctx.as(u).put('/me/onboarding', { answers: { over_18: true }, complete: true })).status, 200);
    const legacy = await ctx.request('POST', '/api/chat', { token: u.token, body: { messages: [{ role: 'user', content: 'hi' }] } });
    assert.equal(legacy.status, 200);
  } finally { await ctx.close(); }
});

test('privacy lifecycle: decisions, fence and acceptances are exported for the owner and removed by erasure; others untouched', async () => {
  const ctx = await f.startFlowApi();
  try {
    const a = await f.newReadyAccount(ctx, 'erase-a'), b = await f.newReadyAccount(ctx, 'erase-b');
    for (const u of [a, b]) { await f.decide(ctx, u, 'health_processing', 'grant'); await f.decide(ctx, u, 'health_processing', 'revoke'); }
    const exp = await ctx.request('GET', '/api/v1/account/export', { token: a.token });
    assert.equal(exp.json.consents.events.filter(e => e.purpose === 'health_processing').length, 2);
    assert.equal(exp.json.terms_acceptances.length, 1);
    assert.equal((await ctx.request('POST', '/api/v1/account/erasure', { token: a.token, body: { confirm: 'erase_my_account' } })).status, 200);
    const left = async table => (await ctx.db.query(`select user_id from public.${table}`)).rows.map(r => r.user_id);
    for (const t of ['wiz_consent_events', 'wiz_terms_acceptances']) assert.deepEqual([...new Set(await left(t))], [b.id], t);
    const fences = (await ctx.db.query('select user_id from public.wiz_user_profiles where context_fence_at is not null')).rows.map(r => r.user_id);
    assert.deepEqual(fences, [b.id], "the erased account's fence is gone, the other account's remains");
  } finally { await ctx.close(); }
});

test('migration: published versions are linked and approved, placeholders retired not rewritten; fence rules; rollback keeps the record', async () => {
  const db = await openPrivacyDb();
  try {
    await applyNoticesUp(db);
    const uid = await h.newAuthUser(db, 'mig-flow@example.test');
    await db.query('insert into public.users (id, email) values ($1, $2) on conflict do nothing', [uid, 'mig-flow@example.test']);
    await db.query("insert into public.wiz_consent_events (user_id, purpose, version, action) values ($1, 'save_chats', '1', 'revoke')", [uid]); // history on a placeholder
    const placeholdersBefore = (await db.query("select purpose, version, summary, legal_approved, published_at from public.wiz_consent_versions where version = '1' order by purpose")).rows;

    await f.applyFlowUp(db);
    await f.applyFlowUp(db); // already applied -> explicit no-op
    const cur = (await db.query("select purpose, version, legal_approved, artifact_id, artifact_sha256 from public.wiz_consent_versions where status = 'current' order by purpose")).rows;
    assert.deepEqual(cur.map(r => `${r.purpose}:${r.version}`), ['career_records:2', 'health_processing:1', 'personalisation:2', 'save_chats:2']);
    assert.ok(cur.every(r => r.legal_approved && r.artifact_id === 'privacy-2026-10-16-v1' && r.artifact_sha256 === 'ba1a8f905d6b3af9ede6d5bfa7ac18fc520629847f49448530044fc4339e6f70'));
    const placeholdersAfter = (await db.query("select purpose, version, summary, legal_approved, published_at from public.wiz_consent_versions where version = '1' and purpose <> 'health_processing' order by purpose")).rows;
    assert.deepEqual(placeholdersAfter, placeholdersBefore, 'placeholders keep their text, unapproved flag and date');
    assert.equal((await db.query("select count(*)::int n from public.wiz_consent_versions where version = '1' and status = 'current' and purpose <> 'health_processing'")).rows[0].n, 0);
    assert.equal((await db.query('select count(*)::int n from public.wiz_consent_events where user_id = $1', [uid])).rows[0].n, 1, 'history preserved');
    await assert.rejects(db.exec("update public.wiz_consent_versions set artifact_sha256 = repeat('0', 64) where purpose = 'save_chats' and version = '2'"), /wiz:published_immutable/);

    // no decision means unanswered; nothing is granted by publication
    const rpc = createPgliteRpc(db);
    assert.equal((await rpc('wiz_coaching_state', { p_user_id: uid })).health.decision, 'unanswered');
    assert.equal((await db.query("select count(*)::int n from public.wiz_consent_events where action = 'grant'")).rows[0].n, 0);

    // the fence: a revoke sets it, a grant never clears it, a later revoke only moves it forward
    const fence = async () => (await db.query('select context_fence_at from public.wiz_user_profiles where user_id = $1', [uid])).rows[0]?.context_fence_at;
    assert.equal(await fence(), undefined);
    await db.query("insert into public.wiz_consent_events (user_id, purpose, version, action) values ($1, 'health_processing', '1', 'revoke')", [uid]);
    const f1 = await fence(); assert.ok(f1);
    await db.query("insert into public.wiz_consent_events (user_id, purpose, version, action) values ($1, 'health_processing', '1', 'grant')", [uid]);
    assert.deepEqual(await fence(), f1);
    await new Promise(r => setTimeout(r, 20));
    await db.query("insert into public.wiz_consent_events (user_id, purpose, version, action) values ($1, 'health_processing', '1', 'revoke')", [uid]);
    assert.ok((await fence()) > f1);
    const f2 = await fence();

    await f.applyFlowDown(db);
    assert.equal((await db.query('select count(*)::int n from public.wiz_consent_events where user_id = $1', [uid])).rows[0].n, 4, 'every decision kept');
    assert.deepEqual(await fence(), f2, 'fence kept');
    assert.equal((await db.query("select count(*)::int n from public.wiz_consent_versions where status = 'current' and legal_approved")).rows[0].n, 0, 'publication withdrawn');
    assert.equal((await db.query("select count(*)::int n from public.wiz_consent_versions where status = 'current' and version = '1' and purpose <> 'health_processing'")).rows[0].n, 3, 'placeholders current again');
    assert.equal((await db.query("select count(*)::int n from pg_proc where proname in ('wiz_coaching_state', 'wiz_terms_current')")).rows[0].n, 0);
    assert.equal((await db.query("select count(*)::int n from pg_trigger where tgname = 'wiz_health_fence'")).rows[0].n, 1, 'fence trigger kept');

    await f.applyFlowUp(db);
    assert.equal((await db.query("select count(*)::int n from public.wiz_consent_versions where status = 'current' and legal_approved")).rows[0].n, 4, 're-published');
    const again = await createPgliteRpc(db)('wiz_coaching_state', { p_user_id: uid });
    assert.deepEqual([again.health.decision, again.fence_at !== null], ['declined', true], 'earlier decisions (last one: a revoke) and the fence apply again');
  } finally { await db.close(); }
});
