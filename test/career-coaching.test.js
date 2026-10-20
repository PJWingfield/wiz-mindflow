'use strict';
// Coaching reuse of retained career data: needs ACTIVE personalisation consent AND an explicit per-profile/item AI-use
// choice. Saving alone never enables it. Existing session-history personalisation is unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startCareerApi } = require('./helpers/career-api');

let ctx;
test.before(async () => { ctx = await startCareerApi(); await ctx.approveNotices(); });
test.after(async () => { await ctx.close(); });

const code = r => r.json && r.json.error && r.json.error.code;
let n = 0;
const key = () => `chat-key-${++n}-${Math.random().toString(36).slice(2, 10)}`;
const systemText = call => call.system.map(b => b.text).join('\n');
async function turn(u, sessionId, text = 'Help me think about my next step') {
  const before = ctx.providerCalls.length;
  const r = await u.request('POST', `/api/v1/sessions/${sessionId}/chat`, { token: u.token, body: { messages: [{ role: 'user', content: text }] }, headers: { 'Idempotency-Key': key() } });
  assert.equal(r.status, 200, r.text);
  assert.equal(ctx.providerCalls.length, before + 1);
  return { res: r, system: systemText(ctx.providerCalls[ctx.providerCalls.length - 1]) };
}

async function setup(label) {
  const u = await ctx.newAccount(label);
  u.request = ctx.request;
  const api = ctx.as(u);
  await ctx.grant(u, 'save_chats');
  await ctx.grant(u, 'career_records');
  assert.equal((await api.put('/me/onboarding', { answers: { over_18: true }, complete: true })).status, 200);
  const session = (await api.post('/sessions', { topic: { kind: 'custom', text: 'my career' } })).json.item;
  const goal = (await api.post('/goals', { title: 'Find an apprenticeship' })).json.item;
  const entry = (await api.post('/portfolio', { entry_type: 'project', title: 'Garden shed build', body: 'PORTFOLIO-MARKER built a shed with a mentor', competencies: ['planning'] })).json.item;
  await api.put('/career-plan', { plan: { direction: 'PLAN-MARKER hands-on trade', values: ['craft'], goal_ids: [goal.id], routes: [{ id: 'app', label: 'Apprenticeship', appeal: 'earn while learning', next_step: 'apply' }] } });
  await api.put('/learning-profile', { profile: { learning_styles: ['hands-on'], focus_notes: 'LEARNING-MARKER short bursts', self_recognition: 'SELFREC-MARKER private' } });
  await api.post('/networking', { contact_label: 'NETWORK-MARKER Sam', note: 'secret contact note' });
  await api.post('/support-map', { label: 'SUPPORT-MARKER Jo', support_role: 'lifts' });
  await api.post('/prior-learning', { experience: 'PRIOR-MARKER sport', skill: 's', application: 'a' });
  const pulses = [];
  for (const [s, e, d] of [[3, 8, '01'], [5, 6, '02'], [8, 4, '03']]) pulses.push((await api.post('/pulses', { stress: s, energy: e, observed_at: `2026-09-${d}T09:00:00Z`, note: `PULSE-MARKER-${d}` })).json.item);
  return { u, api, session, entry, pulses };
}
const MARKERS = ['PLAN-MARKER', 'LEARNING-MARKER', 'PORTFOLIO-MARKER', 'PULSE-MARKER'];
const NEVER = ['SELFREC-MARKER', 'NETWORK-MARKER', 'SUPPORT-MARKER', 'PRIOR-MARKER', 'secret contact note'];
const has = (text, list) => list.filter(m => text.includes(m));

test('saving alone never reaches the coach, even with personalisation consent granted', async () => {
  const { u, session } = await setup('save-only');
  await ctx.grant(u, 'personalisation');
  const { system } = await turn(u, session.id);
  assert.deepEqual(has(system, [...MARKERS, ...NEVER]), []);
  assert.ok(!system.includes('career_account_data'));
});

test('an AI-use choice without active personalisation consent is refused, and consent alone is not enough', async () => {
  const { u, api, session, entry, pulses } = await setup('choice-needs-consent');
  for (const [p, b] of [['/career-plan/ai-use', { enabled: true }], ['/learning-profile/ai-use', { enabled: true }], [`/portfolio/${entry.id}/ai-use`, { enabled: true }], [`/pulses/${pulses[0].id}/ai-use`, { enabled: true }]]) {
    assert.equal(code(await api.put(p, b)), 'consent_required', p);
  }
  await ctx.grant(u, 'personalisation');
  assert.deepEqual(has((await turn(u, session.id)).system, MARKERS), [], 'consent without a choice still excludes career data');
});

test('with consent AND explicit choices, only the chosen career data is included: bounded, labelled, no private extras', async () => {
  const { u, api, session, entry, pulses } = await setup('opt-in');
  await ctx.grant(u, 'personalisation');
  // enable one at a time: each choice affects only its own data
  assert.equal((await api.put('/career-plan/ai-use', { enabled: true })).json.item.ai_use_enabled, true);
  let s = (await turn(u, session.id)).system;
  assert.deepEqual(has(s, MARKERS), ['PLAN-MARKER']);
  assert.match(s, /<career_account_data>[\s\S]*Route "Apprenticeship"/);
  await api.put('/learning-profile/ai-use', { enabled: true });
  s = (await turn(u, session.id)).system;
  assert.deepEqual(has(s, MARKERS), ['PLAN-MARKER', 'LEARNING-MARKER']);
  await api.put(`/portfolio/${entry.id}/ai-use`, { enabled: true });
  for (const p of pulses) await api.put(`/pulses/${p.id}/ai-use`, { enabled: true });
  const last = await turn(u, session.id);
  s = last.system;
  assert.deepEqual(has(s, MARKERS), MARKERS);
  assert.deepEqual(has(s, NEVER), [], 'self-recognition, networking, support map and prior learning are never sent');
  assert.match(s, /Higher stress means more stressed or overwhelmed \(worse\); higher energy means more energetic \(better\)/);
  assert.match(s, /Trend: stress worsening, energy worsening/);
  assert.ok(s.indexOf('SYSTEM-STUB') < s.indexOf('career_account_data'), 'Jon\'s system blocks stay first');
  assert.match(s, /reference DATA|reference data/i);
  assert.ok(s.length < 40000);
  // provenance records which career items were used, and nothing else about them
  const prov = (await ctx.db.query('select provenance from public.wiz_message_meta where message_id = $1', [last.res.json.message_id])).rows[0].provenance.personalisation;
  assert.equal(prov.used, true);
  assert.deepEqual(prov.career.portfolio_ids, [entry.id]);
  assert.equal(prov.career.learning, true);
  assert.equal(prov.career.pulse_ids.length, 3);
  assert.equal(JSON.stringify(prov).includes('MARKER'), false);
  // withdrawing a single choice removes just that item
  await api.put(`/portfolio/${entry.id}/ai-use`, { enabled: false });
  assert.deepEqual(has((await turn(u, session.id)).system, MARKERS), ['PLAN-MARKER', 'LEARNING-MARKER', 'PULSE-MARKER']);
});

test('revoking personalisation consent excludes all retained career context; privacy controls keep working', async () => {
  const { u, api, session, entry } = await setup('revoke');
  await ctx.grant(u, 'personalisation');
  await api.put('/career-plan/ai-use', { enabled: true });
  await api.put(`/portfolio/${entry.id}/ai-use`, { enabled: true });
  assert.ok(has((await turn(u, session.id)).system, MARKERS).length >= 2);
  await ctx.grant(u, 'personalisation', 'revoke');
  const after = (await turn(u, session.id)).system;
  assert.deepEqual(has(after, [...MARKERS, ...NEVER]), []);
  // the person can still switch choices off, read and delete their data
  assert.equal((await api.put('/career-plan/ai-use', { enabled: false })).status, 200);
  assert.equal(code(await api.put('/career-plan/ai-use', { enabled: true })), 'consent_required');
  assert.equal((await api.get('/career-plan')).status, 200);
  assert.equal((await api.del('/career-plan')).status, 200);
});

test('another account\'s career data never appears, and existing session-history personalisation is unchanged', async () => {
  const a = await setup('owner');
  const b = await ctx.newAccount('bystander');
  b.request = ctx.request;
  await ctx.grant(a.u, 'personalisation');
  await a.api.put('/career-plan/ai-use', { enabled: true });
  await ctx.grant(b, 'save_chats');
  await ctx.grant(b, 'personalisation');
  const bApi = ctx.as(b);
  await bApi.put('/me/onboarding', { answers: { over_18: true, goal_hint: 'ONBOARDING-MARKER' }, complete: true });
  const bs = (await bApi.post('/sessions', { topic: { kind: 'custom', text: 'x' } })).json.item;
  const { system } = await turn(b, bs.id);
  assert.deepEqual(has(system, MARKERS), []);
  assert.ok(system.includes('ONBOARDING-MARKER'), 'onboarding personalisation still flows');
  const r = await turn(a.u, a.session.id);
  assert.ok(r.system.includes('PLAN-MARKER'));
});

test('career context failure does not take down the rest of the turn', async () => {
  const { u, session } = await setup('ctx-fail');
  await ctx.grant(u, 'personalisation');
  const r = await turn(u, session.id);
  assert.equal(r.res.status, 200);
  // simulate the career functions being unavailable (e.g. extension rolled back): chat still works
  const { applyCareerDown, applyCareerUp } = require('./helpers/career-db');
  await applyCareerDown(ctx.db);
  try {
    const out = await turn(u, session.id, 'still there?');
    assert.equal(out.res.status, 200);
    assert.ok(ctx.logs.some(l => l.event === 'career_context_unavailable'));
  } finally { await applyCareerUp(ctx.db); }
});
