'use strict';
// Career API: real app + real wiz_* SQL (foundation then career migration) in PGlite. No network beyond 127.0.0.1.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startCareerApi } = require('./helpers/career-api');

let ctx;
test.before(async () => { ctx = await startCareerApi(); await ctx.approveNotices(); });
test.after(async () => { await ctx.close(); });

const code = r => r.json && r.json.error && r.json.error.code;
const idem = () => 'k-' + Math.random().toString(36).slice(2, 12) + Date.now();
async function account(label, { storage = true } = {}) {
  const u = await ctx.newAccount(label);
  if (storage) assert.equal((await ctx.grant(u, 'career_records')).status, 200);
  return { ...u, api: ctx.as(u) };
}

test('content endpoint is credential-free and carries Jon\'s worked examples, six steps and questions; no full assessments', async () => {
  const r = await ctx.request('GET', '/api/v1/career/content');
  assert.equal(r.status, 200);
  assert.equal(r.json.prior_learning.worked_examples.length, 3);
  assert.match(r.json.prior_learning.worked_examples[0].experience, /English/);
  assert.equal(r.json.research.steps.length, 6);
  assert.deepEqual(r.json.research.steps.map(s => s.module_key), [1, 2, 3, 4, 5, 6].map(n => `career_research_step_${n}`));
  assert.equal(r.json.research.interview_questions.length, 4);
  assert.equal(r.json.wellbeing_scale.stress.higher_is, 'worse');
  assert.equal(r.json.wellbeing_scale.energy.higher_is, 'better');
  assert.equal(r.json.panels.length, 5);
  assert.ok(!/MFI/.test(JSON.stringify(r.json).replace(/Full one-to-one assessments[^"]*/, '')));
});

test('research walkthrough progress persists through the existing training seam', async () => {
  const u = await account('research');
  const first = await u.api.get('/career/research');
  assert.equal(first.status, 200);
  assert.deepEqual(first.json.steps.map(s => s.status), Array(6).fill('not_started'));
  assert.equal((await u.api.put('/training/career_research_step_1', { status: 'completed', percent: 100 })).status, 200);
  assert.equal((await u.api.put('/training/career_research_step_2', { status: 'in_progress', percent: 40 })).status, 200);
  const again = await u.api.get('/career/research');
  assert.deepEqual(again.json.steps.map(s => s.status), ['completed', 'in_progress', 'not_started', 'not_started', 'not_started', 'not_started']);
  assert.equal(again.json.steps[1].percent, 40);
  const other = await account('research-other');
  assert.equal((await other.api.get('/career/research')).json.steps[0].status, 'not_started');
  assert.equal((await ctx.request('GET', '/api/v1/career/research')).status, 401);
});

test('every career write needs an explicit storage grant; reads and deletes never do; nothing is granted automatically', async () => {
  const u = await account('nogrant', { storage: false });
  const purposes = (await u.api.get('/consents')).json.purposes;
  const cr = purposes.find(p => p.purpose === 'career_records');
  assert.ok(cr, 'career_records purpose exists');
  assert.equal(cr.granted, false);
  const writes = [
    ['post', '/portfolio', { entry_type: 'other', title: 't', body: 'b' }],
    ['post', '/prior-learning', { experience: 'e', skill: 's', application: 'a' }],
    ['post', '/networking', { contact_label: 'n' }],
    ['post', '/support-map', { label: 'l', support_role: 'r' }],
    ['post', '/pulses', { stress: 5, energy: 5 }],
    ['put', '/career-plan', { plan: { direction: 'x' } }],
    ['put', '/learning-profile', { profile: { focus_notes: 'x' } }]
  ];
  for (const [m, p, b] of writes) { const r = await u.api[m](p, b); assert.equal(r.status, 403, p); assert.equal(code(r), 'consent_required', p); }
  for (const p of ['/portfolio', '/prior-learning', '/networking', '/support-map', '/pulses']) assert.deepEqual((await u.api.get(p)).json.items, []);
  assert.equal((await u.api.get('/career-plan')).json.item, null);
  assert.equal((await u.api.get('/learning-profile')).json.item, null);
  // grant -> write -> revoke: existing records stay readable and deletable, new writes stop
  await ctx.grant(u, 'career_records');
  const e = (await u.api.post('/portfolio', { entry_type: 'other', title: 't', body: 'b' })).json.item;
  await ctx.grant(u, 'career_records', 'revoke');
  assert.equal((await u.api.get('/portfolio/' + e.id)).status, 200);
  assert.equal(code(await u.api.patch('/portfolio/' + e.id, { title: 'x', expected_version: 1 })), 'consent_required');
  assert.equal(code(await u.api.post('/prior-learning', { experience: 'e', skill: 's', application: 'a' })), 'consent_required');
  assert.equal((await u.api.del('/portfolio/' + e.id)).status, 200);
});

test('save and reload: plan with route comparison, learning profile, portfolio, prior learning, networking, support map, pulses', async () => {
  const u = await account('reload');
  const goal = (await u.api.post('/goals', { title: 'Become a electrician' })).json.item;
  const entry = (await u.api.post('/portfolio', {
    entry_type: 'work_experience', title: 'Placement at Smith Electrical', body: 'Wired a consumer unit under supervision.', entry_date: '2026-06-30',
    goal_id: goal.id, competencies: ['safe working'], habits: ['daily log']
  })).json.item;
  assert.equal(entry.goal_id, goal.id);
  assert.equal(entry.ai_use_enabled, false);
  const plan = {
    direction: 'Hands-on trade', values: ['independence', 'craft'], competencies: ['safe working'], habits: ['daily log'], readiness: 'Ready to apply',
    goal_ids: [goal.id], portfolio_ids: [entry.id],
    routes: [
      { id: 'apprenticeship', label: 'Apprenticeship', appeal: 'Earn while learning', concerns: 'Competitive', funding: 'Employer-paid', next_step: 'Apply to two firms' },
      { id: 'college', label: 'Further training', appeal: 'Flexible', concerns: 'Costs', funding: 'Loan', next_step: 'Open day' }
    ]
  };
  const saved = await u.api.put('/career-plan', { plan });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.item.version, 1);
  assert.equal(saved.json.item.ai_use_enabled, false);
  assert.deepEqual((await u.api.get('/career-plan')).json.item.plan, plan);

  const lp = { learning_styles: ['hands-on', 'visual'], focus_notes: 'short bursts', useful_adjustments: 'written steps', self_recognition: 'I recognise some ADHD-like patterns' };
  assert.equal((await u.api.put('/learning-profile', { profile: lp })).status, 200);
  const lpGet = (await u.api.get('/learning-profile')).json.item;
  assert.deepEqual(lpGet.profile, lp);
  assert.equal(lpGet.ai_use_enabled, false);
  assert.equal(lpGet.version, 1);
  assert.equal(JSON.stringify((await u.api.get('/me')).json).includes('ADHD'), false, 'never surfaced through /me');

  const pl = (await u.api.post('/prior-learning', { experience: 'Duke of Edinburgh', skill: 'Resilience', application: 'Any team role', recorded_on: '2026-05-01' })).json.item;
  const net = (await u.api.post('/networking', { contact_label: 'Sam, met at careers fair', note: 'Suggested a taster day', interaction_date: '2026-07-01', follow_up_date: '2026-07-15' })).json.item;
  const sup = (await u.api.post('/support-map', { label: 'Aunt Jo', support_role: 'Practical: lifts to interviews', direction: 'supports', last_contact_date: '2026-07-02', next_contact_date: '2026-07-20' })).json.item;
  const pulse = (await u.api.post('/pulses', { stress: 4, energy: 7, note: 'ok week', observed_at: '2026-07-03T09:00:00Z' })).json.item;

  assert.equal((await u.api.get('/portfolio/' + entry.id)).json.item.title, 'Placement at Smith Electrical');
  assert.deepEqual((await u.api.get('/portfolio')).json.items.map(x => x.id), [entry.id]);
  assert.equal((await u.api.get('/prior-learning/' + pl.id)).json.item.skill, 'Resilience');
  assert.equal((await u.api.get('/networking/' + net.id)).json.item.follow_up_date, '2026-07-15');
  assert.equal((await u.api.get('/support-map/' + sup.id)).json.item.next_contact_date, '2026-07-20');
  assert.equal((await u.api.get('/pulses/' + pulse.id)).json.item.stress, 4);
  // independent stores: the networking log and the support map hold separate records
  assert.equal((await u.api.get('/networking')).json.items.length, 1);
  assert.equal((await u.api.get('/support-map')).json.items.length, 1);
  assert.equal((await u.api.get('/networking/' + sup.id)).status, 404);
  // updating the plan keeps the structure and bumps the version; goal deletion clears links, not content
  await u.api.del('/goals/' + goal.id);
  assert.equal((await u.api.get('/portfolio/' + entry.id)).json.item.goal_id, null);
  const afterGoal = (await u.api.get('/career-plan')).json.item;
  assert.deepEqual(afterGoal.plan.goal_ids, []);
  assert.deepEqual(afterGoal.plan.portfolio_ids, [entry.id]);
  assert.equal(afterGoal.plan.routes.length, 2);
});

test('optimistic versions: stale and missing expected_version are refused; plan and learning profile are compare-and-set', async () => {
  const u = await account('versions');
  const e = (await u.api.post('/portfolio', { entry_type: 'project', title: 'v1', body: 'b' })).json.item;
  const ok = await u.api.patch('/portfolio/' + e.id, { title: 'v2', expected_version: 1 });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.item.version, 2);
  const stale = await u.api.patch('/portfolio/' + e.id, { title: 'v3', expected_version: 1 });
  assert.equal(stale.status, 409);
  assert.equal(code(stale), 'version_conflict');
  assert.equal(code(await u.api.patch('/portfolio/' + e.id, { title: 'v3' })), 'invalid_request', 'expected_version is required');
  assert.equal((await u.api.get('/portfolio/' + e.id)).json.item.title, 'v2');
  for (const [p, b, expectedField] of [['/networking', { contact_label: 'n' }], ['/support-map', { label: 'l', support_role: 'r' }], ['/prior-learning', { experience: 'e', skill: 's', application: 'a' }], ['/pulses', { stress: 5, energy: 5 }]]) {
    const item = (await u.api.post(p, b)).json.item;
    const field = Object.keys(b)[0];
    assert.equal(code(await u.api.patch(`${p}/${item.id}`, { [field]: b[field] === 5 ? 6 : 'changed', expected_version: 9 })), 'version_conflict', p);
    assert.equal((await u.api.patch(`${p}/${item.id}`, { [field]: b[field] === 5 ? 6 : 'changed', expected_version: 1 })).json.item.version, 2, p);
  }

  assert.equal((await u.api.put('/career-plan', { plan: { direction: 'a' } })).json.item.version, 1);
  assert.equal(code(await u.api.put('/career-plan', { plan: { direction: 'b' } })), 'version_conflict', 'existing plan needs expected_version');
  assert.equal(code(await u.api.put('/career-plan', { plan: { direction: 'b' }, expected_version: 5 })), 'version_conflict');
  assert.equal((await u.api.put('/career-plan', { plan: { direction: 'b' }, expected_version: 1 })).json.item.version, 2);
  assert.equal((await u.api.put('/learning-profile', { profile: { focus_notes: 'a' } })).json.item.version, 1);
  assert.equal(code(await u.api.put('/learning-profile', { profile: { focus_notes: 'b' } })), 'version_conflict');
  assert.equal((await u.api.put('/learning-profile', { profile: { focus_notes: 'b' }, expected_version: 1 })).json.item.version, 2);
  // duplicate route ids / unknown fields / owner-like fields are refused
  assert.equal((await u.api.put('/career-plan', { plan: { routes: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }, expected_version: 2 })).status, 400);
  assert.equal((await u.api.put('/career-plan', { plan: { user_id: u.id }, expected_version: 2 })).status, 400);
  assert.equal((await u.api.post('/portfolio', { entry_type: 'other', title: 't', body: 'b', user_id: u.id })).status, 400);
});

test('idempotent creation and promotion: same key replays, different payload conflicts, promotion yields exactly one entry', async () => {
  const u = await account('idem');
  const k = idem();
  const a = await u.api.post('/networking', { contact_label: 'Once' }, k);
  const b = await u.api.post('/networking', { contact_label: 'Once' }, k);
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.json.item.id, a.json.item.id);
  assert.equal(code(await u.api.post('/networking', { contact_label: 'Different' }, k)), 'idempotency_conflict');
  assert.equal((await u.api.get('/networking')).json.items.length, 1);

  const pl = (await u.api.post('/prior-learning', { experience: 'Retail job', skill: 'Handling money', application: 'Any accountable role', recorded_on: '2026-04-01' })).json.item;
  assert.equal(pl.promoted_entry_id, null);
  const pk = idem();
  const p1 = await u.api.post(`/prior-learning/${pl.id}/promote`, undefined, pk);
  const p2 = await u.api.post(`/prior-learning/${pl.id}/promote`, undefined, pk);
  const p3 = await u.api.post(`/prior-learning/${pl.id}/promote`);
  assert.equal(p1.status, 201);
  assert.equal(p2.status, 200);
  assert.equal(p3.status, 200);
  assert.equal(p2.json.item.id, p1.json.item.id);
  assert.equal(p3.json.item.id, p1.json.item.id);
  assert.equal(p1.json.item.entry_type, 'prior_learning');
  assert.equal(p1.json.item.prior_learning_id, pl.id);
  assert.equal(p1.json.item.entry_date, '2026-04-01');
  assert.match(p1.json.item.body, /Retail job/);
  assert.equal((await u.api.get('/portfolio')).json.items.length, 1);
  assert.equal((await u.api.get('/prior-learning/' + pl.id)).json.item.promoted_entry_id, p1.json.item.id);
  // a key reused for another prior-learning row conflicts
  const pl2 = (await u.api.post('/prior-learning', { experience: 'Sport', skill: 'Teamwork', application: 'Any team role' })).json.item;
  assert.equal(code(await u.api.post(`/prior-learning/${pl2.id}/promote`, undefined, pk)), 'idempotency_conflict');

  // the promoted entry is independent content: deleting the prior-learning row keeps it, clears only the link
  assert.equal((await u.api.del('/prior-learning/' + pl.id)).status, 200);
  const kept = (await u.api.get('/portfolio/' + p1.json.item.id)).json.item;
  assert.equal(kept.prior_learning_id, null);
  assert.match(kept.body, /Handling money/);
  assert.equal(kept.title, 'Handling money');
  assert.equal((await u.api.patch('/portfolio/' + kept.id, { title: 'Edited after promotion', expected_version: kept.version })).status, 200);
  // replaying the old key after the source is gone resolves to the surviving entry (no duplicate)
  assert.equal((await u.api.post(`/prior-learning/${pl.id}/promote`, undefined, pk)).json.item.id, kept.id);
  assert.equal((await u.api.get('/portfolio')).json.items.length, 1);
});

test('two-account isolation: records, references and plan links never cross accounts', async () => {
  const a = await account('iso-a');
  const b = await account('iso-b');
  const goalA = (await a.api.post('/goals', { title: 'A goal' })).json.item;
  const entryA = (await a.api.post('/portfolio', { entry_type: 'other', title: 'A secret', body: 'A body', goal_id: goalA.id })).json.item;
  const items = {
    '/portfolio': entryA.id,
    '/prior-learning': (await a.api.post('/prior-learning', { experience: 'e', skill: 's', application: 'a' })).json.item.id,
    '/networking': (await a.api.post('/networking', { contact_label: 'n' })).json.item.id,
    '/support-map': (await a.api.post('/support-map', { label: 'l', support_role: 'r' })).json.item.id,
    '/pulses': (await a.api.post('/pulses', { stress: 5, energy: 5 })).json.item.id
  };
  await a.api.put('/career-plan', { plan: { direction: 'A direction' } });
  await a.api.put('/learning-profile', { profile: { focus_notes: 'A private' } });
  for (const [p, id] of Object.entries(items)) {
    assert.equal((await b.api.get(`${p}/${id}`)).status, 404, 'GET ' + p);
    assert.equal((await b.api.patch(`${p}/${id}`, { expected_version: 1, ...(p === '/pulses' ? { stress: 9 } : p === '/portfolio' ? { title: 'hijack' } : p === '/prior-learning' ? { skill: 'hijack' } : p === '/networking' ? { contact_label: 'hijack' } : { label: 'hijack' }) })).status, 404, 'PATCH ' + p);
    assert.equal((await b.api.del(`${p}/${id}`)).status, 404, 'DELETE ' + p);
    assert.deepEqual((await b.api.get(p)).json.items, [], 'list ' + p);
  }
  assert.equal((await b.api.post(`/prior-learning/${items['/prior-learning']}/promote`)).status, 404);
  assert.equal((await b.api.put(`/portfolio/${entryA.id}/ai-use`, { enabled: true })).status, 404);
  assert.equal((await b.api.put(`/pulses/${items['/pulses']}/ai-use`, { enabled: true })).status, 404);
  assert.equal((await b.api.get('/career-plan')).json.item, null);
  assert.equal((await b.api.get('/learning-profile')).json.item, null);
  // another account's ids as references: identical refusal whether the id is foreign or unknown
  const foreign = await b.api.post('/portfolio', { entry_type: 'other', title: 't', body: 'b', goal_id: goalA.id });
  const unknown = await b.api.post('/portfolio', { entry_type: 'other', title: 't', body: 'b', goal_id: '00000000-0000-4000-8000-000000000000' });
  assert.equal(foreign.status, 422);
  assert.equal(code(foreign), 'invalid_reference');
  assert.deepEqual(foreign.json.error.message, unknown.json.error.message);
  assert.equal(code(await b.api.put('/career-plan', { plan: { goal_ids: [goalA.id] } })), 'invalid_reference');
  assert.equal(code(await b.api.put('/career-plan', { plan: { portfolio_ids: [entryA.id] } })), 'invalid_reference');
  assert.equal(code(await b.api.patch(`/portfolio/${(await b.api.post('/portfolio', { entry_type: 'other', title: 'mine', body: 'b' })).json.item.id}`, { goal_id: goalA.id, expected_version: 1 })), 'invalid_reference');
  // A's data is untouched
  assert.equal((await a.api.get('/portfolio/' + entryA.id)).json.item.title, 'A secret');
  assert.equal((await a.api.get('/career-plan')).json.item.plan.direction, 'A direction');
});

test('stable cursor pagination across a collection with ties and new inserts', async () => {
  const u = await account('paging');
  const made = [];
  for (let i = 0; i < 5; i++) made.push((await u.api.post('/networking', { contact_label: 'c' + i })).json.item.id);
  const seen = [];
  let cursor = null;
  for (let n = 0; n < 10; n++) {
    const r = await u.api.get('/networking?limit=2' + (cursor ? '&cursor=' + cursor : ''));
    assert.equal(r.status, 200);
    seen.push(...r.json.items.map(x => x.id));
    if (n === 0) await u.api.post('/networking', { contact_label: 'late' }); // inserted mid-walk: must not duplicate or skip older rows
    cursor = r.json.next_cursor;
    if (!cursor) break;
  }
  assert.equal(new Set(seen).size, seen.length, 'no duplicates');
  assert.deepEqual([...seen].sort(), [...made].sort(), 'every original row seen exactly once');
  assert.equal((await u.api.get('/networking?cursor=garbage')).status, 400);
  assert.equal((await u.api.get('/networking?limit=0')).status, 400);
});

test('pulses: multiple observations kept, ordered by observation time, direction is stress-up = worse / energy-up = better', async () => {
  const u = await account('pulse');
  const mk = (stress, energy, at) => u.api.post('/pulses', { stress, energy, observed_at: at, note: `s${stress}` });
  // two readings on the same day are both kept
  await mk(3, 8, '2026-08-01T08:00:00Z');
  await mk(4, 8, '2026-08-01T18:00:00Z');
  assert.equal((await u.api.get('/pulses')).json.items.length, 2);
  assert.equal((await u.api.get('/pulses/trend')).json.trend.stress.direction, 'insufficient_data');
  await mk(7, 4, '2026-08-03T08:00:00Z'); // back-dated insert order does not matter: observed_at decides
  const t1 = (await u.api.get('/pulses/trend')).json;
  assert.equal(t1.trend.observations, 3);
  assert.deepEqual(t1.trend.stress.values, [3, 4, 7]);
  assert.equal(t1.trend.stress.direction, 'worsening', 'rising stress score = worse');
  assert.equal(t1.trend.energy.direction, 'stable', '8,8,4 is not a steady fall');
  assert.equal(t1.trend.gentle_check_in_suggested, true);
  assert.match(t1.trend.scale, /Higher stress means more stressed/);
  assert.deepEqual(t1.items.map(x => x.stress), [7, 4, 3], 'newest first');

  const v = await account('pulse2');
  for (const [s, e2, d] of [[8, 3, '01'], [6, 5, '02'], [4, 7, '03']]) await v.api.post('/pulses', { stress: s, energy: e2, observed_at: `2026-09-${d}T09:00:00Z` });
  const t2 = (await v.api.get('/pulses/trend')).json.trend;
  assert.equal(t2.stress.direction, 'improving', 'falling stress score = better');
  assert.equal(t2.energy.direction, 'improving', 'rising energy = better');
  assert.equal(t2.gentle_check_in_suggested, false);
  await v.api.post('/pulses', { stress: 5, energy: 2, observed_at: '2026-09-04T09:00:00Z' });
  await v.api.post('/pulses', { stress: 5, energy: 1, observed_at: '2026-09-05T09:00:00Z' });
  const t3 = (await v.api.get('/pulses/trend')).json.trend;
  assert.equal(t3.energy.direction, 'worsening', 'falling energy = worse');
  assert.equal(t3.stress.direction, 'stable');
  // validation: integers 1-10 only, no future timestamps, no owner fields
  for (const bad of [{ stress: 0, energy: 5 }, { stress: 11, energy: 5 }, { stress: 5.5, energy: 5 }, { stress: '5', energy: 5 }, { stress: 5 }, { stress: 5, energy: 5, observed_at: '2999-01-01T00:00:00Z' }, { stress: 5, energy: 5, observed_at: 'yesterday' }, { stress: 5, energy: 5, user_id: v.id }]) {
    assert.equal((await v.api.post('/pulses', bad)).status, 400, JSON.stringify(bad));
  }
  // editing keeps history semantics: patch changes the one observation only
  const first = (await v.api.get('/pulses?limit=100')).json.items;
  assert.equal(first.length, 5);
});

test('learning profile is private: not in /me, no AI use by default, clearing removes content and the choice', async () => {
  const u = await account('learn');
  await u.api.put('/learning-profile', { profile: { learning_styles: ['visual'], self_recognition: 'private note' } });
  assert.equal((await u.api.get('/learning-profile')).json.item.ai_use_enabled, false);
  assert.equal(JSON.stringify((await u.api.get('/me')).json).includes('private note'), false);
  assert.equal(JSON.stringify((await u.api.get('/me/onboarding')).json).includes('private note'), false);
  // enabling AI use needs active personalisation consent; saving never enables it
  assert.equal(code(await u.api.put('/learning-profile/ai-use', { enabled: true })), 'consent_required');
  await ctx.grant(u, 'personalisation');
  assert.equal((await u.api.put('/learning-profile/ai-use', { enabled: true })).json.item.ai_use_enabled, true);
  const saved = await u.api.put('/learning-profile', { profile: { learning_styles: ['visual'], focus_notes: 'x' }, expected_version: 1 });
  assert.equal(saved.json.item.ai_use_enabled, true, 'a deliberate choice survives an edit');
  assert.equal((await u.api.del('/learning-profile')).status, 200);
  assert.equal((await u.api.get('/learning-profile')).json.item, null);
  assert.equal(code(await u.api.del('/learning-profile')), 'not_found');
  assert.equal((await u.api.put('/learning-profile', { profile: { focus_notes: 'again' } })).status, 409, 'stale client after a clear must reload (version kept rising)');
  const re = await u.api.put('/learning-profile', { profile: { focus_notes: 'again' }, expected_version: 3 });
  assert.equal(re.status, 200);
  assert.equal(re.json.item.ai_use_enabled, false, 'choice was cleared with the content');
});

test('portfolio deletion, validation and anonymous access', async () => {
  const u = await account('misc');
  assert.equal((await ctx.request('GET', '/api/v1/portfolio')).status, 401);
  assert.equal((await ctx.request('POST', '/api/v1/pulses', { body: { stress: 5, energy: 5 } })).status, 401);
  assert.equal((await u.api.post('/portfolio', { entry_type: 'bogus', title: 't', body: 'b' })).status, 400);
  assert.equal((await u.api.post('/portfolio', { entry_type: 'other', title: 't', body: 'b', entry_date: '2026-02-30' })).status, 400);
  assert.equal((await u.api.post('/portfolio', { entry_type: 'other', title: 't', body: 'b', prior_learning_id: '00000000-0000-4000-8000-000000000000' })).status, 400, 'link is set only by promotion');
  assert.equal((await u.api.get('/portfolio/not-a-uuid')).status, 400);
  const e = (await u.api.post('/portfolio', { entry_type: 'reference', title: 'Ref', body: 'b', competencies: ['a', 'b'] })).json.item;
  assert.deepEqual(e.competencies, ['a', 'b']);
  assert.equal((await u.api.del('/portfolio/' + e.id)).status, 200);
  assert.equal((await u.api.get('/portfolio/' + e.id)).status, 404);
});
