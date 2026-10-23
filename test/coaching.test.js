'use strict';
// Coaching MVP path against the real wiring: createApp(config from env, real store, real wiz_* SQL in PGlite,
// local fake GoTrue) with INJECTED provider and embedding transport. No external calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { startApi } = require('./helpers/api');
const { createPgliteRpc } = require('./helpers/pglite-rpc');
const { kbRow, mockMatch } = require('./helpers/kb-runtime-fixture');
const { fromIndex } = require('./helpers/pathways-from-index');
const { createRetriever } = require('../lib/retrieval');
const { loadConfig } = require('../lib/config');
const { shapeMessages, assistantKey } = require('../lib/coaching');

const BIG = { authPerMinute: 100000, apiPerMinute: 100000, publicPerMinute: 100000, chatPerMinute: 100000 };
const calls = [];
const state = { failNext: false, delayMs: 0 };
let ctx;
let realRpc;
let kbRows = [];
const preservation = Object.fromEntries(['server.js', 'index.html', 'package.json'].map(f => [f, fs.readFileSync(path.join(__dirname, '..', f))]));

const textOf = c => (typeof c === 'string' ? c : c.filter(b => b.type === 'text').map(b => b.text).join('\n'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

test.before(async () => {
  ctx = await startApi({
    limits: BIG,
    rpc: async (name, args) => name === 'wiz_match_kb_chunks_attested' ? mockMatch(kbRows, args, state.kbFailureTier) : realRpc(name, args),
    env: { VOYAGE_API_KEY: 'test-key-not-real', WIZ_KB_PROVENANCE: 'on', WIZ_KB_EMBEDDING_DIM: '1024' },
    embed: async text => {
      if (text.includes('embed_fail')) throw new Error('embedding service down');
      if (text.includes('bad_dim')) return [1, 2, 3];
      const arr = Array(1024).fill(0);
      if (/sleep/i.test(text)) { arr[0] = 1; return arr; }
      if (/focus/i.test(text)) { arr[1] = 1; return arr; }
      arr[2] = 1; return arr;
    },
    provider: {
      model: 'claude-sonnet-4-6',
      async complete(args) {
        calls.push(args);
        if (state.delayMs) await sleep(state.delayMs);
        const last = textOf(args.messages[args.messages.length - 1].content);
        if (state.failNext || last.includes('trigger_fail')) {
          state.failNext = false;
          throw Object.assign(new Error('provider body must never surface'), { name: 'ProviderError', status: 502 });
        }
        return [{ type: 'text', text: 'Reply to: ' + last.slice(0, 80) }];
      }
    }
  });
  realRpc = createPgliteRpc(ctx.db);
  await ctx.db.query('update public.wiz_consent_versions set legal_approved = true'); // synthetic LOCAL approval of the seeded notices
  const v = i => { const a = Array(1024).fill(0); a[i] = 1; return a; };
  kbRows = [
    kbRow({ content: 'Sleep consolidates learning and memory; protect a regular sleep window.', source_file: 'guide-sleep.md', title: 'Sleep and the brain', section_number: '3.2', embedding: v(0) }),
    kbRow({ content: 'Focus is trained by short, deliberate practice blocks.', source_file: 'guide-focus.md', title: 'Focus basics', section_number: '1.1', embedding: v(1), chunk_index: 1 }),
    kbRow({ content: 'INTERNAL-ONLY-NOTE do not surface', source_type: 'internal', source_file: 'internal.md', embedding: v(0) })
  ];
});
test.after(async () => { if (ctx) await ctx.close(); });

const key = () => ({ 'Idempotency-Key': 'k-' + Math.random().toString(36).slice(2, 12) + Date.now() });
const consent = (u, purpose, action = 'grant') => ctx.request('POST', '/api/v1/consents', { token: u.token, body: { purpose, version: '1', action } });
const chat = (u, sid, text, headers = key()) => ctx.request('POST', `/api/v1/sessions/${sid}/chat`, { token: u.token, headers, body: { messages: [{ role: 'user', content: text }] } });
const newSession = async (u, body = {}) => (await ctx.request('POST', '/api/v1/sessions', { token: u.token, headers: key(), body })).json.item;
const systemData = call => call.system[call.system.length - 1].text;
const adultWithConsent = async (label, extra) => {
  const u = await ctx.newAccount(label);
  await ctx.makeAdult(u, extra);
  await consent(u, 'save_chats');
  await consent(u, 'personalisation');
  return u;
};
// seed messages directly through the real store RPCs (as earlier turns of a session would have)
const seed = async (u, sid, n, make) => {
  for (let i = 1; i <= n; i++) {
    await ctx.rpc('wiz_message_append', {
      p_user_id: u.id, p_session_id: sid, p_sender: i % 2 ? 'user' : 'assistant', p_content: make(i), p_tokens: 0,
      p_key: `seed-${sid.slice(0, 8)}-${i}-${Math.random().toString(36).slice(2, 8)}`, p_model: null, p_provenance: {}
    });
  }
};

test('adult gate: both chat routes refuse without an over-18 attestation, before any model call or storage', async () => {
  const u = await ctx.newAccount('gate');
  await consent(u, 'save_chats');
  const s = await newSession(u);
  const before = calls.length;
  for (const answers of [null, { over_18: false }, { over_18: 'yes' }]) {
    if (answers) await ctx.request('PUT', '/api/v1/me/onboarding', { token: u.token, body: { answers } });
    const r = await chat(u, s.id, 'hello');
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, 'age_verification_required');
    const legacy = await ctx.request('POST', '/api/chat', { token: u.token, body: { messages: [{ role: 'user', content: 'hello' }] } });
    assert.equal(legacy.status, 403, 'the stateless /api/chat route is behind the same gate');
    assert.equal(legacy.json.error.code, 'age_verification_required');
  }
  assert.equal(calls.length, before, 'provider never called');
  assert.equal((await ctx.db.query('select count(*)::int n from public.messages where conversation_id = $1', [s.id])).rows[0].n, 0);
  await ctx.makeAdult(u);
  assert.equal((await chat(u, s.id, 'hello')).status, 200);
});

test('pathway start: real catalogue, focused opening, retained reply with genuine source references, reload', async () => {
  const u = await adultWithConsent('path', { goal_focus: 'SLEEPY-ONBOARDING-MARKER' });
  const cat = await ctx.request('GET', '/api/v1/catalogue', { token: u.token });
  assert.equal(cat.json.items.length, 14);
  assert.deepEqual(cat.json.items.map(p => p.title).slice(0, 3), ['Mind & Performance', 'Mental Resilience', 'Mental Well-Being']);

  // only Jon's actual pathways are accepted; the pathway fixes its lens/track
  for (const bad of [{ kind: 'catalogue', area: 'Thinking & Strategy' }, { kind: 'catalogue', area: 'Sleep' }]) {
    assert.equal((await ctx.request('POST', '/api/v1/sessions', { token: u.token, body: { topic: bad } })).status, 400);
  }
  assert.equal((await ctx.request('POST', '/api/v1/sessions', { token: u.token, body: { lens: 'learning', topic: { kind: 'catalogue', area: 'Brain, Sleep & Biofeedback' } } })).status, 400, 'conflicting lens');
  const sport = await newSession(u, { topic: { kind: 'catalogue', area: 'sport' } });
  assert.equal(sport.track, 'sport');
  assert.equal(sport.topic.area, 'Sports Psychology');

  const s = await newSession(u, { topic: { kind: 'catalogue', area: 'Brain, Sleep & Biofeedback', panel: 'Sleep stages' } });
  assert.equal(s.lens, 'biofeedback');
  assert.deepEqual(s.topic, { kind: 'catalogue', area: 'Brain, Sleep & Biofeedback', pathway: 'biofeedback', panel: 'Sleep stages' });

  const n0 = calls.length;
  const r = await chat(u, s.id, 'I want to sleep better');
  if (r.status !== 200) console.error("BODY:", r.json); assert.equal(r.status, 200);
  assert.equal(r.json.content, 'Reply to: I want to sleep better');
  assert.equal(r.json.retrieval, 'ok');
  assert.deepEqual(r.json.sources.map(x => [x.source_type, x.source_file, x.title, x.section]), [
    ['guide', 'guide-sleep.md', 'Sleep and the brain', '3.2'], ['guide', 'guide-focus.md', 'Focus basics', '1.1']]);
  assert.ok(r.json.sources.every(x => x.id && !('content' in x)));
  assert.equal(calls.length, n0 + 1);

  const call = calls[n0];
  // Jon's prompt blocks stay first and untouched; app context is appended after them
  assert.deepEqual(call.system.slice(0, 2).map(b => b.text), ['SYSTEM-STUB', 'null|biofeedback']);
  assert.equal(call.system.length, 3);
  const data = systemData(call);
  assert.match(data, /opening turn of the session/);
  assert.match(data, /Warmly acknowledge/);
  assert.match(data, /<session_focus kind="pathway" name="Brain, Sleep &amp; Biofeedback"|<session_focus kind="pathway" name="Brain, Sleep & Biofeedback"/);
  assert.match(data, /Sleep consolidates learning/);
  assert.ok(!data.includes('INTERNAL-ONLY-NOTE'), 'other source tiers are never retrieved');
  assert.equal(call.messages.length, 1);
  assert.deepEqual(call.messages[0], { role: 'user', content: 'I want to sleep better' });

  // retained, with provenance, and the same references come back on reload
  const msgs = (await ctx.request('GET', `/api/v1/sessions/${s.id}/messages`, { token: u.token })).json.items;
  assert.deepEqual(msgs.map(m => [m.sender, m.content]), [['user', 'I want to sleep better'], ['assistant', 'Reply to: I want to sleep better']]);
  assert.equal(msgs[1].model, 'claude-sonnet-4-6');
  assert.deepEqual(msgs[1].sources, r.json.sources);
  assert.equal(r.json.message_id, msgs[1].id);
  const prov = (await ctx.db.query('select provenance from public.wiz_message_meta where message_id = $1', [msgs[1].id])).rows[0].provenance;
  assert.equal(prov.request_message_id, msgs[0].id);
  assert.deepEqual(prov.retrieval, { status: 'ok', tiers: { master_kb: { status: 'no_match' }, guide: { status: 'ok' }, reference_book: { status: 'no_match' } } });
  assert.deepEqual(prov.sources, r.json.sources);
  const sess = (await ctx.request('GET', `/api/v1/sessions/${s.id}`, { token: u.token })).json.item;
  assert.equal(sess.message_count, 2);
  assert.equal(sess.title, 'I want to sleep better', 'automatic title');
});

test('custom goal start: focus acknowledged on the first turn only', async () => {
  const u = await adultWithConsent('custom');
  const s = await newSession(u, { topic: { kind: 'custom', text: 'Stay calm in job interviews' } });
  
  // Test server-derived session start
  const kStart = key();
  const startReq = await ctx.request('POST', `/api/v1/sessions/${s.id}/start`, { token: u.token, headers: kStart });
  assert.equal(startReq.status, 200);
  assert.equal(startReq.json.content, 'Reply to: I want to focus on: Stay calm in job interviews');
  
  const startProvAssistant = (await ctx.db.query('select provenance from public.wiz_message_meta where message_id = $1', [startReq.json.message_id])).rows[0].provenance;
  const startProv = (await ctx.db.query('select provenance from public.wiz_message_meta where message_id = $1', [startProvAssistant.request_message_id])).rows[0].provenance;
  assert.equal(startProv.origin, 'server_start', 'Provenance should mark it as server_start');

  // Re-start should fail
  const startReq2 = await ctx.request('POST', `/api/v1/sessions/${s.id}/start`, { token: u.token, headers: key() });
  assert.equal(startReq2.status, 400);
  assert.equal(startReq2.json.error.code, 'session_already_started');

  // Same key retry should return identical without running model
  const startReq3 = await ctx.request('POST', `/api/v1/sessions/${s.id}/start`, { token: u.token, headers: kStart });
  assert.equal(startReq3.status, 200);
  assert.equal(startReq3.json.replayed, true);
  
  const n0 = calls.length;
  await chat(u, s.id, 'It is mostly the panel questions');
  const second = systemData(calls[n0]);
  assert.ok(!/opening turn/.test(second));
  assert.match(second, /Stay calm in job interviews/);
  assert.deepEqual(calls[n0].messages.map(m => m.role), ['user', 'assistant', 'user']);
});

test('pathway start using server route', async () => {
  const u = await adultWithConsent('path-start', { goal_focus: 'something' });
  const s = await newSession(u, { topic: { kind: 'catalogue', area: 'Brain, Sleep & Biofeedback', panel: 'Sleep stages' } });
  const r = await ctx.request('POST', `/api/v1/sessions/${s.id}/start`, { token: u.token, headers: key() });
  if (r.status !== 200) console.error("BODY:", r.json); assert.equal(r.status, 200);
  assert.equal(r.json.content, 'Reply to: I want to focus on: Brain, Sleep & Biofeedback (Sleep stages)');
  
  // title generated from server text
  const sess = (await ctx.request('GET', `/api/v1/sessions/${s.id}`, { token: u.token })).json.item;
  assert.ok(sess.title.includes('Brain, Sleep & Biofeedback'));
});

test('second session sees bounded, traceable account context; revocation excludes it; other accounts never do', async () => {
  const u = await adultWithConsent('ctx', { goal_focus: 'SLEEPY-ONBOARDING-MARKER', role: 'teacher' });
  const s1 = await newSession(u, { topic: { kind: 'catalogue', area: 'Learning & Development' } });
  await chat(u, s1.id, 'u1-secret-phrase: I revise late at night');
  const ev = (await ctx.request('POST', '/api/v1/evidence', { token: u.token, body: { statement: 'EVIDENCE-MARKER I teach year 9' } })).json.item;
  await ctx.request('PUT', `/api/v1/evidence/${ev.id}/ai-use`, { token: u.token, body: { enabled: true } });

  const s2 = await newSession(u, { topic: { kind: 'custom', text: 'Exam week plan' } });
  const n0 = calls.length;
  const r2 = await chat(u, s2.id, 'Where did we get to?');
  assert.equal(r2.status, 200);
  assert.equal(r2.json.personalised, true);
  const data = systemData(calls[n0]);
  assert.match(data, /<person_context>\n/);
  assert.match(data, /goal_focus: SLEEPY-ONBOARDING-MARKER/);
  assert.ok(!/over_18/.test(data));
  assert.match(data, /EVIDENCE-MARKER I teach year 9/);
  assert.match(data, /Session 1/);
  assert.match(data, /u1-secret-phrase: I revise late at night/);
  assert.match(data, /<\/person_context>/);
  // the current session's own messages are history, not "earlier sessions"
  assert.equal(calls[n0].messages.length, 1);

  // traceability: the recorded ids are this account's own session and messages
  const prov = (await ctx.db.query('select provenance from public.wiz_message_meta where message_id = $1', [r2.json.message_id])).rows[0].provenance;
  assert.equal(prov.personalisation.used, true);
  assert.deepEqual(prov.personalisation.session_ids, [s1.id]);
  assert.deepEqual(prov.personalisation.evidence_ids, [ev.id]);
  assert.ok(prov.personalisation.onboarding_version >= 1);
  const own = (await ctx.db.query('select message_id from public.wiz_message_meta where session_id = $1 and user_id = $2', [s1.id, u.id])).rows.map(r => r.message_id);
  assert.ok(prov.personalisation.message_ids.length >= 2);
  for (const id of prov.personalisation.message_ids) assert.ok(own.includes(id), 'selected message belongs to the account and the earlier session');

  // a second account never reaches this history, directly or through context
  const other = await adultWithConsent('ctx-other', { goal_focus: 'someone else' });
  const so = await newSession(other, { topic: { kind: 'custom', text: 'Their own goal' } });
  const m0 = calls.length;
  assert.equal((await chat(other, so.id, 'Hello')).status, 200);
  const otherData = systemData(calls[m0]);
  assert.ok(!/SLEEPY-ONBOARDING-MARKER|u1-secret-phrase|EVIDENCE-MARKER|Exam week/.test(otherData));
  assert.match(otherData, /goal_focus: someone else/, 'the other account only gets its own onboarding');
  assert.ok(!/^Session \d+/m.test(otherData), 'and has no earlier sessions to offer');
  const count = async () => (await ctx.db.query('select count(*)::int n from public.messages where conversation_id = $1', [s1.id])).rows[0].n;
  const c0 = await count();
  for (const [m, p, body] of [['POST', `/api/v1/sessions/${s1.id}/chat`, { messages: [{ role: 'user', content: 'intrude' }] }], ['GET', `/api/v1/sessions/${s1.id}/messages`], ['GET', `/api/v1/sessions/${s1.id}`]]) {
    const r = await ctx.request(m, p, { token: other.token, body, headers: m === 'POST' ? key() : undefined });
    assert.equal(r.status, 404, `${m} ${p}`);
  }
  assert.equal(await count(), c0);

  // revoking the personalisation consent removes it from the next turn (history of the same session still flows)
  await consent(u, 'personalisation', 'revoke');
  const n1 = calls.length;
  const r3 = await chat(u, s2.id, 'And now?');
  assert.equal(r3.json.personalised, false);
  const after = systemData(calls[n1]);
  assert.ok(!/<person_context>\n|SLEEPY-ONBOARDING-MARKER|EVIDENCE-MARKER|u1-secret-phrase/.test(after));
  assert.deepEqual(calls[n1].messages.map(m => m.role), ['user', 'assistant', 'user']);
  const prov3 = (await ctx.db.query('select provenance from public.wiz_message_meta where message_id = $1', [r3.json.message_id])).rows[0].provenance;
  assert.deepEqual(prov3.personalisation, { used: false });
});

test('personal context is bounded: at most 3 earlier sessions, 4 recent messages each, clipped text', async () => {
  const u = await adultWithConsent('bound');
  for (let k = 1; k <= 5; k++) {
    const s = await newSession(u, { topic: { kind: 'custom', text: 'goal ' + k } });
    await seed(u, s.id, 6, i => `S${k}M${i} ` + 'x'.repeat(2500));
  }
  const cur = await newSession(u, { topic: { kind: 'custom', text: 'now' } });
  const n0 = calls.length;
  const r = await chat(u, cur.id, 'Continue please');
  const data = systemData(calls[n0]);
  assert.equal((data.match(/^Session \d+/gm) || []).length, 3, 'at most 3 earlier sessions');
  assert.ok(!data.includes('x'.repeat(600)), 'message text clipped');
  const prov = (await ctx.db.query('select provenance from public.wiz_message_meta where message_id = $1', [r.json.message_id])).rows[0].provenance;
  assert.equal(prov.personalisation.session_ids.length, 3);
  assert.ok(prov.personalisation.message_ids.length <= 12);
  // most recent sessions win when nothing else makes one more relevant
  assert.match(data, /S5M6/);
  assert.ok(!/S1M/.test(data));
});

test('retrieval: failures are explicit and never block coaching; configuration gates it honestly', async () => {
  const u = await adultWithConsent('kb');
  const s = await newSession(u, {});
  const cases = [['embed_fail please', 'retrieval_failed'], ['bad_dim please', 'embedding_malformed']];
  for (const [text, reason] of cases) {
    const n0 = calls.length;
    const r = await chat(u, s.id, text);
    assert.equal(r.status, 200, text);
    assert.equal(r.json.retrieval, 'unavailable');
    assert.deepEqual(r.json.sources, []);
    assert.match(systemData(calls[n0]), /<knowledge_context tier="guide" status="unavailable">/);
    const prov = (await ctx.db.query('select provenance from public.wiz_message_meta where message_id = $1', [r.json.message_id])).rows[0].provenance;
    assert.deepEqual(prov.retrieval, { status: 'unavailable', reason, tiers: Object.fromEntries(['master_kb','guide','reference_book'].map(tier => [tier, { status: 'unavailable', reason }])) });
    assert.deepEqual(prov.sources, []);
  }
  const none = await chat(u, s.id, 'nothing relevant at all');
  assert.equal(none.json.retrieval, 'ok', 'fixture returns nearest guide rows regardless');

  // unit: configuration and validation of the retriever
  const store = rows => ({ matchKbChunksAttested: async () => rows });
  const embed = async () => Array(1024).fill(0.01);
  const cfg = env => loadConfig({ WIZ_KB_EMBEDDING_DIM: '1024', ...env });
  
  assert.equal((await createRetriever({ config: cfg({ VOYAGE_API_KEY: 'k' }), store: store([]), embed }).search('q')).reason, 'not_configured');
  assert.equal((await createRetriever({ config: cfg({ VOYAGE_API_KEY: 'k', WIZ_KB_PROVENANCE: 'invalid' }), store: store([]), embed }).search('q')).reason, 'not_configured');
  assert.equal((await createRetriever({ config: cfg({ WIZ_KB_PROVENANCE: 'on' }), store: store([]), embed }).search('q')).reason, 'not_configured');
  const on = cfg({ VOYAGE_API_KEY: 'k', WIZ_KB_PROVENANCE: 'on' });
  assert.equal((await createRetriever({ config: on, store: store('nope'), embed }).search('q')).tiers.master_kb.reason, 'results_malformed');
  const res = await createRetriever({ config: on, store: store([kbRow({ ingestion_key: null })]), embed }).search('q');
  assert.equal(res.status, 'unavailable', 'malformed provenance is a failed retrieval, not no_match');
  assert.equal((await createRetriever({ config: on, store: store([]), embed }).search('q')).status, 'no_match');
  assert.equal((await createRetriever({ config: on, store: store([]), embed: async () => [1, 2] }).search('q')).reason, 'embedding_malformed');
  assert.equal((await createRetriever({ config: on, store: store([]), embed: async () => { const a = Array(1024).fill(0); a[1] = NaN; return a; } }).search('q')).reason, 'embedding_malformed');
  assert.equal(on.kbProvenanceEnabled, true);
});

test('partial retrieval retains good tiers in prompt, saved provenance, response and replay', async () => {
  const u = await adultWithConsent('kb-partial');
  const s = await newSession(u, {});
  const k = key();
  state.kbFailureTier = 'reference_book';
  try {
    const n0 = calls.length;
    const r = await chat(u, s.id, 'sleep');
    assert.equal(r.status, 200);
    assert.equal(r.json.retrieval, 'partial');
    assert.equal(r.json.sources.length, 2);
    assert.match(systemData(calls[n0]), /<knowledge_retrieval status="partial">/);
    assert.match(systemData(calls[n0]), /Sleep consolidates learning/);
    assert.match(systemData(calls[n0]), /tier="reference_book" status="unavailable"/);
    const p = (await ctx.db.query('select provenance from public.wiz_message_meta where message_id=$1', [r.json.message_id])).rows[0].provenance;
    assert.equal(p.retrieval.status, 'partial');
    assert.deepEqual(p.sources, r.json.sources);
    const first = await chat(u, s.id, 'sleep again', k);
    const before = calls.length;
    const replay = await chat(u, s.id, 'sleep again', k);
    assert.equal(replay.json.retrieval, 'partial');
    assert.deepEqual(replay.json.sources, first.json.sources);
    assert.equal(calls.length, before);
  } finally { state.kbFailureTier = undefined; }
});

test('provider failure keeps one pending user turn; identical retry completes it; completed replay makes no model call', async () => {
  const u = await adultWithConsent('retry');
  const s = await newSession(u, { topic: { kind: 'custom', text: 'Retry goal' } });
  const k1 = key();
  const n0 = calls.length;
  state.failNext = true;
  const fail = await chat(u, s.id, 'first try', k1);
  assert.equal(fail.status, 502);
  assert.equal(fail.json.error.code, 'assistant_unavailable');
  assert.ok(!fail.text.includes('provider body must never surface'));
  const stored = async () => (await ctx.request('GET', `/api/v1/sessions/${s.id}/messages`, { token: u.token })).json.items;
  assert.deepEqual((await stored()).map(m => [m.sender, m.content]), [['user', 'first try']], 'the failed turn leaves exactly one pending user message');

  // identical retry (provider healthy now): still ONE user message, then the reply
  const done = await chat(u, s.id, 'first try', k1);
  assert.equal(done.status, 200);
  assert.deepEqual((await stored()).map(m => [m.sender, m.content]), [['user', 'first try'], ['assistant', 'Reply to: first try']], 'no duplicate user message');

  // completed identical retry returns the saved reply without calling the model
  const nBefore = calls.length;
  const replay = await chat(u, s.id, 'first try', k1);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.content, done.json.content);
  assert.equal(replay.json.message_id, done.json.message_id);
  assert.equal(replay.json.replayed, true);
  assert.equal(calls.length, nBefore, 'no provider call on replay');
  // changed input under the same key conflicts under the existing contract
  const conflict = await chat(u, s.id, 'different words', k1);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.code, 'idempotency_conflict');
  assert.equal(calls.length, nBefore);
  assert.ok(calls.length > n0);
});

test('an unanswered earlier user turn is kept, in order, and merged with the next one', async () => {
  const u = await adultWithConsent('pending');
  const s = await newSession(u, {});
  state.failNext = true;
  assert.equal((await chat(u, s.id, 'FIRST-UNANSWERED question')).status, 502);
  const n0 = calls.length;
  const r = await chat(u, s.id, 'SECOND message');
  if (r.status !== 200) console.error("BODY:", r.json); assert.equal(r.status, 200);
  const sent = calls[n0].messages;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].role, 'user');
  assert.ok(sent[0].content.indexOf('FIRST-UNANSWERED question') < sent[0].content.indexOf('SECOND message'), 'chronological order kept');
  assert.match(systemData(calls[n0]), /previous message in this conversation was never answered/);
  const rows = (await ctx.request('GET', `/api/v1/sessions/${s.id}/messages`, { token: u.token })).json.items;
  assert.deepEqual(rows.map(m => m.sender), ['user', 'user', 'assistant']);
  // unit: shaping keeps roles/chronology and starts with a user turn
  const shaped = shapeMessages([{ sender: 'assistant', content: 'old' }, { sender: 'user', content: 'a' }, { sender: 'assistant', content: 'b' }], 'c');
  assert.deepEqual(shaped.messages, [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]);
  assert.equal(shaped.pendingUserTurn, false);
});

test('history longer than 30 messages sends the genuinely recent ones; a replay older than the window still finds its reply', async () => {
  const u = await adultWithConsent('long');
  const s = await newSession(u, {});
  const tag = i => 'm' + String(i).padStart(3, '0');
  await seed(u, s.id, 70, tag);
  const n0 = calls.length;
  const r = await chat(u, s.id, 'NEW-TURN');
  if (r.status !== 200) console.error("BODY:", r.json); assert.equal(r.status, 200);
  const sent = calls[n0].messages;
  assert.equal(sent.length, 31, '30 recent messages + the new one');
  assert.equal(sent[0].content, tag(41));
  assert.equal(sent[29].content, tag(70));
  assert.equal(sent[30].content, 'NEW-TURN');
  assert.ok(!sent.some(m => textOf(m.content) === tag(1) || textOf(m.content) === tag(30)));
  assert.deepEqual(sent.map(m => m.role), Array.from({ length: 31 }, (_, i) => (i % 2 === 0 ? 'user' : 'assistant')).slice(0, 30).concat('user'));

  // push the completed turn far out of any 30-message window, then replay it
  const k = key();
  const first = await chat(u, s.id, 'REPLAYED-TURN', k);
  await seed(u, s.id, 40, i => 'later' + i);
  const nBefore = calls.length;
  const again = await chat(u, s.id, 'REPLAYED-TURN', k);
  assert.equal(again.status, 200);
  assert.equal(again.json.message_id, first.json.message_id);
  assert.equal(again.json.content, first.json.content);
  assert.equal(calls.length, nBefore, 'no provider call');
  assert.ok(assistantKey(k['Idempotency-Key']).length <= 128);
});

test('concurrent identical requests share one model call', async () => {
  const u = await adultWithConsent('conc');
  const s = await newSession(u, {});
  const k = key();
  const n0 = calls.length;
  state.delayMs = 150;
  try {
    const [a, b] = await Promise.all([chat(u, s.id, 'same request', k), chat(u, s.id, 'same request', k)]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.json.message_id, b.json.message_id);
    assert.equal(calls.length, n0 + 1);
  } finally { state.delayMs = 0; }
  const rows = (await ctx.db.query('select sender from public.messages where conversation_id = $1 order by created_at', [s.id])).rows.map(r => r.sender);
  assert.deepEqual(rows, ['user', 'assistant']);
});

test('uploaded media reaches the model for the turn but only a placeholder is retained', async () => {
  const u = await adultWithConsent('media');
  const s = await newSession(u, {});
  const n0 = calls.length;
  const r = await ctx.request('POST', `/api/v1/sessions/${s.id}/chat`, { token: u.token, headers: key(), body: { messages: [{ role: 'user', content: [
    { type: 'text', text: 'what does this show' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] }] } });
  if (r.status !== 200) console.error("BODY:", r.json); assert.equal(r.status, 200);
  assert.equal(calls[n0].messages[0].content[1].type, 'image');
  const rows = (await ctx.db.query("select content from public.messages where conversation_id = $1 and sender = 'user'", [s.id])).rows;
  assert.deepEqual(rows.map(x => x.content), ['what does this show\n[Ephemeral Media Attached]']);
  assert.ok(!JSON.stringify(rows).includes('iVBOR'));
});

test('Jon\'s prompt, tracks, lenses and opening pathways are preserved exactly', () => {
  const root = path.join(__dirname, '..');
  // Pinned Jon source baseline; never require the other owners' worktree to be clean.
  const cur = fs.readFileSync(path.join(root, 'server.js'));
  assert.ok(cur.toString('utf8').includes("model: 'claude-sonnet-4-6'"));
  // Verify the prompt literal and track/lens blocks against the explicit pinned source.
  const block = buf => { const s = buf.toString('utf8').replace(/\r\n/g, '\n'); return s.slice(s.indexOf('const TRACK_NOTES'), s.indexOf('function buildSystem')); };
  // Hashes verified from pinned 9ac2810, independent of child-process privileges.
  const promptLine = cur.toString('utf8').split(/\r?\n/).find(l => l.startsWith('var WIZ_SYSTEM = '));
  assert.ok(promptLine, 'prompt declaration exists');
  const expression = promptLine.slice('var WIZ_SYSTEM = '.length, -1);
  const decoded = (0, eval)(expression);
  const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
  assert.equal(decoded.length, 129861);
  assert.equal(sha(decoded), '8bfb297381f5127c84134d4d40232d69113c89051843217d797d525c818f5d39');
  assert.ok(decoded.includes('ANSWER FIRST WHEN ASKED:') && decoded.includes('PLAN NAME AND PHYSICAL RECOVERY'));
  assert.equal(sha(block(cur)), '44cb8ef0b9e69b9a7f68ff7bdc3db2c7ab37f24286482d190db182ee354c7f98');
  const keys = block(cur).match(/^\s{2}([a-z_]+):/gm).map(k => k.trim().replace(':', ''));
  const pathways = require('../lib/pathways.json');
  assert.equal(pathways.length, 14);
  for (const p of pathways) assert.ok(keys.includes(p.id), `pathway ${p.id} is a known track/lens`);
  // the 14 pathways match the current frontend catalogue
  assert.deepEqual(pathways, fromIndex());
  for (const [file, bytes] of Object.entries(preservation)) assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes, `${file} preserved during KB checks`);
});

test('normal composition: environment config switches retrieval on, and the default transport embeds with the attested model', async () => {
  const { createApp } = require('../lib/app');
  const { createVoyageEmbed } = require('../lib/retrieval');
  const make = env => createApp({ config: loadConfig(env), store: { matchKbChunksAttested: async () => [] }, auth: null, provider: null });
  const full = { VOYAGE_API_KEY: 'k', WIZ_KB_PROVENANCE: 'on' };
  assert.equal(make(full).locals.retrieval.enabled, true);
  assert.equal(make({ VOYAGE_API_KEY: 'k' }).locals.retrieval.enabled, false, 'key without provenance switch stays off');
  assert.equal(make({ WIZ_KB_EMBEDDING_MODEL_ATTESTATION: 'm' }).locals.retrieval.enabled, false);
  assert.equal(make({}).locals.retrieval.enabled, false);

  // the default (Voyage) transport, driven by a stub fetch: request shape and failure mapping, no network
  const seen = [];
  const fetchOk = async (url, opts) => { seen.push({ url, opts }); return { ok: true, json: async () => ({ data: [{ index: 0, embedding: Array(1024).fill(0.01) }] }) }; };
  const embed = createVoyageEmbed({ apiKey: 'secret-key', model: 'voyage-3', timeoutMs: 1000, fetchImpl: fetchOk });
  assert.deepEqual(await embed('hello'), Array(1024).fill(0.01));
  assert.equal(seen[0].url, 'https://api.voyageai.com/v1/embeddings');
  assert.equal(seen[0].opts.headers.Authorization, 'Bearer secret-key');
  assert.deepEqual(JSON.parse(seen[0].opts.body), { input: ['hello'], model: 'voyage-3', input_type: 'query' });
  const cfg = loadConfig({ ...full, WIZ_KB_EMBEDDING_DIM: '1024' });
  const reasonFor = async fetchImpl => (await createRetriever({ config: cfg, store: { matchKbChunksAttested: async () => [] }, embed: createVoyageEmbed({ apiKey: 'k', model: 'voyage-3', timeoutMs: 100, fetchImpl }) }).search('q')).reason;
  assert.equal(await reasonFor(async () => ({ ok: false })), 'embedding_rejected');
  assert.equal(await reasonFor(async () => { throw new Error('socket'); }), 'embedding_unreachable');
  assert.equal(await reasonFor(async () => ({ ok: true, json: async () => ({ data: [] }) })), 'embedding_malformed');
  assert.equal(await reasonFor(async () => ({ ok: true, json: async () => { throw new Error('bad json'); } })), 'embedding_malformed');

  const fetchHangingBody = async (url, opts) => ({
    ok: true,
    json: () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ data: [{ embedding: [1,2,3,4] }] }), 150);
      opts.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        const err = new Error('abort');
        err.name = 'AbortError';
        reject(err);
      });
    })
  });
  assert.equal(await reasonFor(fetchHangingBody), 'embedding_unreachable');
});


