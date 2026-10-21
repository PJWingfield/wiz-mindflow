'use strict';
// Three-plan billing (main GBP 20 / sol GBP 30 / shared GBP 10): configuration, plan->provider routing from the verified paid price, the OpenAI
// Responses boundary (mocked fetch only: no live provider call), explicit Shared Info consent and the saved + legacy coaching entry points.
// Real app + fake GoTrue + PGlite (with the billing, health-consent and tiers migrations) + FAKE Stripe. All ids/keys are synthetic fixtures.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers/db');
const { loadConfig } = require('../lib/config');
const { createOpenAiProvider, ProviderError, ENDPOINT, MODEL, MAX_OUTPUT_TOKENS } = require('../lib/openai-provider');
const { openFlowDb, decide } = require('./helpers/flow-api');
const { startBillingApi, applyBillingUp, FULL_ENV } = require('./helpers/billing-api');
const { createFakeStripe } = require('./helpers/fake-stripe');

const ROOT = path.join(__dirname, '..');
const TIERS_UP_SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261021180000_wiz_billing_tiers.sql'), 'utf8');
const TIERS_DOWN_SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'rollbacks', '20261021180000_wiz_billing_tiers.down.sql'), 'utf8');

const PRICE = { main: 'price_TESTmain0001', sol: 'price_TESTsol00001', shared: 'price_TESTshared01' };
const PRODUCT = { main: 'prod_TESTmain0001', sol: 'prod_TESTsol00001', shared: 'prod_TESTshared01' };
const AMOUNT = { main: 2000, sol: 3000, shared: 1000 };
const SOL = { key: 'sk-test-sol-key-0000000000000001', project: 'proj_TESTsol0001' };
const SHARED = { key: 'sk-test-shared-key-00000000002', project: 'proj_TESTshared01' };
const PLAN_ENV = {
  WIZ_PLAN_MAIN_PRICE_ID: PRICE.main, WIZ_PLAN_MAIN_PRODUCT_ID: PRODUCT.main,
  WIZ_PLAN_SOL_PRICE_ID: PRICE.sol, WIZ_PLAN_SOL_PRODUCT_ID: PRODUCT.sol,
  WIZ_PLAN_SHARED_PRICE_ID: PRICE.shared, WIZ_PLAN_SHARED_PRODUCT_ID: PRODUCT.shared
};
const OPENAI_ENV = {
  OPENAI_API_KEY_SOL: SOL.key, OPENAI_PROJECT_ID_SOL: SOL.project, WIZ_SOL_PROJECT_NONSHARING_ATTESTED: SOL.project,
  OPENAI_API_KEY_SHARED: SHARED.key, OPENAI_PROJECT_ID_SHARED: SHARED.project, WIZ_SHARED_PROJECT_SHARING_ATTESTED: SHARED.project,
  WIZ_SHARED_ELIGIBLE_DATA: 'message,session_history,profile,knowledge,health'
};

const code = r => r.json && r.json.error && r.json.error.code;
const rand = () => Math.random().toString(16).slice(2, 12);
const view = (ctx, u) => ctx.as(u).get('/billing').then(r => r.json);
const entRow = (ctx, uid) => ctx.db.query('select * from public.wiz_billing_entitlements where user_id = $1', [uid]).then(r => r.rows[0]);
const countMessages = ctx => ctx.db.query('select count(*)::int n from public.messages').then(r => r.rows[0].n);

// a fetch double that records every request and answers like the Responses API
function fetchSpy(calls, text = 'openai reply') {
  return async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }) };
  };
}

async function start(opts = {}) {
  const calls = { main: [], sol: [], shared: [] };
  const db = await openFlowDb();
  await applyBillingUp(db);
  await h.applyUp(db, TIERS_UP_SQL);
  const fake = createFakeStripe();
  for (const p of Object.keys(PRICE)) fake.addPrice({ id: PRICE[p], productId: PRODUCT[p], amount: AMOUNT[p] });
  const main = { model: 'claude-sonnet-4-6', async complete(args) { calls.main.push(args); return [{ type: 'text', text: 'main reply' }]; } };
  const providers = opts.providers || {
    sol: createOpenAiProvider({ apiKey: SOL.key, projectId: SOL.project, fetchImpl: fetchSpy(calls.sol, 'sol reply') }),
    shared: createOpenAiProvider({ apiKey: SHARED.key, projectId: SHARED.project, fetchImpl: fetchSpy(calls.shared, 'shared reply') })
  };
  const env = { ...PLAN_ENV, ...OPENAI_ENV, ...(opts.env || {}) };
  const ctx = await startBillingApi({ db, fake, env, provider: main, providers, retrieval: opts.retrieval });
  const approveSharing = () => db.query("update public.wiz_consent_versions set legal_approved = true where purpose = 'openai_training'"); // synthetic LOCAL approval
  const sharing = (u, action = 'grant') => decide(ctx, u, 'openai_training', action);
  // an adult with chat retention who holds a verified paid subscription on `plan` (the customer is bound through a Main checkout first)
  async function subscribe(label, plan) {
    const u = await ctx.coachable(label);
    assert.equal((await decide(ctx, u, 'save_chats', 'grant')).status, 200);
    assert.equal((await ctx.as(u).post('/billing/checkout', { plan: 'main' })).status, 200);
    const cus = (await entRow(ctx, u.id)).customer_id;
    const sub = fake.addSubscription({ customer: cus, priceId: PRICE[plan] });
    assert.equal((await ctx.as(u).post('/billing/refresh', {})).status, 200);
    return { u, cus, sub };
  }
  const session = async u => (await ctx.as(u).post('/sessions', {}, 'tier-sess-' + rand())).json.item.id;
  const say = (u, sid, text, key = 'tier-chat-' + rand()) => ctx.as(u).post(`/sessions/${sid}/chat`, { messages: [{ role: 'user', content: text }] }, key);
  const legacyChat = (u, messages) => ctx.request('POST', '/api/chat', { token: u.token, body: { messages } });
  const assistantMeta = (u, sid) => db.query("select x.model, x.provenance from public.wiz_message_meta x where x.session_id = $1 and x.model is not null order by x.created_at desc limit 1", [sid]).then(r => r.rows[0]);
  return { ...ctx, db, fake, calls, approveSharing, sharing, subscribe, session, say, legacyChat, assistantMeta, close: async () => { await ctx.close(); await db.close(); } };
}

// ---- configuration -------------------------------------------------------------------------------------------------------------
test('config: three-plan configuration is absent, valid or malformed; malformed never falls back to the legacy price; provider settings are per plan', () => {
  const legacy = loadConfig(FULL_ENV).billing;
  assert.equal(legacy.plans, null, 'no WIZ_PLAN_* variable: legacy single-price contract');
  assert.ok(legacy.price);

  const ok = loadConfig({ ...FULL_ENV, ...PLAN_ENV }).billing;
  assert.deepEqual(ok.plans.items, { main: { id: PRICE.main, productId: PRODUCT.main }, sol: { id: PRICE.sol, productId: PRODUCT.sol }, shared: { id: PRICE.shared, productId: PRODUCT.shared } });
  assert.ok(ok.price, 'the legacy fields stay parsed but are not used when plans are present');

  const partial = loadConfig({ ...FULL_ENV, ...PLAN_ENV, WIZ_PLAN_SOL_PRODUCT_ID: undefined }).billing;
  assert.deepEqual(partial.plans, { malformed: true });
  assert.deepEqual(loadConfig({ ...PLAN_ENV, WIZ_PLAN_SHARED_PRICE_ID: PRICE.sol }).billing.plans, { malformed: true }, 'a price reused across plans');
  assert.deepEqual(loadConfig({ ...PLAN_ENV, WIZ_PLAN_MAIN_PRICE_ID: 'not-a-price' }).billing.plans, { malformed: true });
  const none = loadConfig({ ...PLAN_ENV, WIZ_PLAN_SHARED_PRICE_ID: undefined, WIZ_PLAN_SHARED_PRODUCT_ID: undefined }).billing.plans;
  assert.equal(none.items.shared, null, 'a plan with neither id is simply not offered');

  assert.deepEqual(loadConfig(OPENAI_ENV).openai, { sol: { apiKey: SOL.key, projectId: SOL.project }, shared: { apiKey: SHARED.key, projectId: SHARED.project, eligible: true } });
  assert.deepEqual(loadConfig({}).openai, { sol: null, shared: null });
  assert.equal(loadConfig({ ...OPENAI_ENV, WIZ_SOL_PROJECT_NONSHARING_ATTESTED: undefined }).openai.sol, null, 'no non-sharing attestation');
  assert.equal(loadConfig({ ...OPENAI_ENV, WIZ_SHARED_PROJECT_SHARING_ATTESTED: 'proj_TESTother001' }).openai.shared, null, 'attestation must name the shared project');
  assert.equal(loadConfig({ ...OPENAI_ENV, WIZ_SHARED_ELIGIBLE_DATA: 'message,session_history,profile,knowledge' }).openai.shared, null, 'every bundle category must be declared eligible');
  assert.equal(loadConfig({ ...OPENAI_ENV, OPENAI_PROJECT_ID_SHARED: SOL.project, WIZ_SHARED_PROJECT_SHARING_ATTESTED: SOL.project }).openai.shared, null, 'shared and sol must be different projects');
  assert.equal(loadConfig({ ...OPENAI_ENV, OPENAI_API_KEY_SHARED: SOL.key }).openai.shared, null, 'shared and sol must use different keys');
  assert.notEqual(loadConfig({ ...OPENAI_ENV, WIZ_SHARED_ELIGIBLE_DATA: undefined }).openai.sol, null, 'Sol is independent of the Shared Info policy');
});

// ---- OpenAI Responses boundary (mocked fetch) -----------------------------------------------------------------------------------
test('openai provider: fixed endpoint/model/effort, store true, bounded output, own key + project, Responses output parsed to text blocks', async () => {
  const calls = [];
  const p = createOpenAiProvider({ apiKey: SOL.key, projectId: SOL.project, fetchImpl: fetchSpy(calls, 'hello there') });
  assert.equal(p.model, 'gpt-6.1-sol');
  const out = await p.complete({
    system: [{ type: 'text', text: 'BASE', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'NOTE' }],
    messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
      { role: 'user', content: [{ type: 'text', text: 'third' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }] }],
    signal: new AbortController().signal
  });
  assert.deepEqual(out, [{ type: 'text', text: 'hello there' }]);
  assert.equal(calls.length, 1, 'exactly one provider call');
  const { url, init, body } = calls[0];
  assert.equal(url, ENDPOINT);
  assert.equal(ENDPOINT, 'https://api.openai.com/v1/responses');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer ' + SOL.key);
  assert.equal(init.headers['OpenAI-Project'], SOL.project);
  assert.ok(init.signal, 'the caller\'s abort signal is propagated');
  assert.deepEqual([body.model, body.reasoning, body.store, body.max_output_tokens], [MODEL, { effort: 'low' }, true, MAX_OUTPUT_TOKENS]);
  assert.equal(body.instructions, 'BASE\n\nNOTE');
  assert.deepEqual(body.input, [
    { role: 'user', content: 'first' }, { role: 'assistant', content: 'second' },
    { role: 'user', content: [{ type: 'input_text', text: 'third' }, { type: 'input_image', image_url: 'data:image/png;base64,QUJD' }] }
  ]);
  assert.throws(() => createOpenAiProvider({ apiKey: SOL.key }), /own key and project/);
});

test('openai provider: every failure is a safe ProviderError, one call, no retry or fallback, nothing sensitive in the error', async () => {
  const run = async respond => {
    let n = 0;
    const p = createOpenAiProvider({ apiKey: SOL.key, projectId: SOL.project, fetchImpl: async () => { n++; return respond(); } });
    let err = null;
    try { await p.complete({ system: [{ type: 'text', text: 's' }], messages: [{ role: 'user', content: 'SECRET-PROMPT' }], signal: new AbortController().signal }); } catch (e) { err = e; }
    assert.equal(n, 1, 'no retry');
    return err;
  };
  const ok = body => ({ ok: true, status: 200, json: async () => body });
  const msg = parts => ({ type: 'message', content: parts });
  const cases = {
    rateLimited: [() => ({ ok: false, status: 429, json: async () => ({ error: { message: 'SECRET-PROMPT ' + SOL.key } }) }), 429],
    serverError: [() => ({ ok: false, status: 500, json: async () => ({}) }), 500],
    notJson: [() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } }), 502],
    noOutput: [() => ok({ status: 'completed' }), 502],
    emptyText: [() => ok({ status: 'completed', output: [msg([{ type: 'output_text', text: '  ' }])] }), 502],
    errorField: [() => ok({ status: 'completed', error: { message: 'x' }, output: [msg([{ type: 'output_text', text: 'hi' }])] }), 502],
    failed: [() => ok({ status: 'failed', output: [] }), 502],
    incomplete: [() => ok({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [msg([{ type: 'output_text', text: 'cut off' }])] }), 502],
    refusal: [() => ok({ status: 'completed', output: [msg([{ type: 'refusal', refusal: 'no' }])] }), 502],
    networkDown: [() => { throw new TypeError('fetch failed'); }, 0]
  };
  for (const [name, [respond, status]] of Object.entries(cases)) {
    const err = await run(respond);
    assert.ok(err instanceof ProviderError && err.name === 'ProviderError', name);
    assert.equal(err.status, status, name);
    assert.ok(!JSON.stringify(err).includes(SOL.key) && !err.message.includes('SECRET') && !String(err.stack).includes('SECRET-PROMPT'), name + ': no key/prompt/body in the error');
  }
  // text from several output parts is joined; unrelated output items (reasoning) are skipped
  const p = createOpenAiProvider({ apiKey: SOL.key, projectId: SOL.project, fetchImpl: async () => ok({ status: 'completed', output: [{ type: 'reasoning', summary: [] }, msg([{ type: 'output_text', text: 'a' }, { type: 'output_text', text: 'b' }])] }) });
  assert.deepEqual(await p.complete({ system: 's', messages: [{ role: 'user', content: 'q' }] }), [{ type: 'text', text: 'a\nb' }]);
});

test('openai provider: abort/timeout propagates to the request and fails once', async () => {
  let n = 0;
  const p = createOpenAiProvider({ apiKey: SOL.key, projectId: SOL.project, fetchImpl: (url, init) => { n++; return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))); } });
  const ctrl = new AbortController();
  const pending = p.complete({ system: 's', messages: [{ role: 'user', content: 'q' }], signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 10);
  await assert.rejects(pending, err => err.name === 'ProviderError' && err.status === 0);
  assert.equal(n, 1);
});

// ---- plans offered, purchase and tamper resistance ---------------------------------------------------------------------------
test('status lists the three approved GBP plans from the server; Shared Info is unavailable until approved notice + grant; no checkout for an unready plan', async () => {
  const ctx = await start();
  try {
    const u = await ctx.coachable('plans');
    const b = await view(ctx, u);
    assert.deepEqual(b.plans.map(p => [p.id, p.label, p.amount, p.currency, p.interval]), [['main', 'Main', 2000, 'gbp', 'month'], ['sol', 'Sol', 3000, 'gbp', 'month'], ['shared', 'Shared Info', 1000, 'gbp', 'month']]);
    assert.deepEqual(b.plans.map(p => p.available), [true, true, false], 'Shared Info: its notice is not approved');
    assert.ok(!JSON.stringify(b).includes('price_') && !JSON.stringify(b).includes('prod_') && !JSON.stringify(b).includes('proj_') && !JSON.stringify(b).includes('sk-'), 'safe labels only');
    assert.equal(b.plan, null);

    // unapproved notice: no grant can be recorded, the plan cannot be bought, and nothing is created at Stripe
    assert.notEqual((await ctx.sharing(u)).status, 200);
    const before = [ctx.fake.calls.customersCreate, ctx.fake.calls.checkoutCreate];
    let r = await ctx.as(u).post('/billing/checkout', { plan: 'shared' });
    assert.equal(r.status, 503); assert.equal(code(r), 'shared_unavailable');
    assert.deepEqual([ctx.fake.calls.customersCreate, ctx.fake.calls.checkoutCreate], before, 'no customer or Checkout session for an unready plan');

    // approved notice but no explicit grant yet
    await ctx.approveSharing();
    assert.equal((await view(ctx, u)).plans[2].available, true);
    assert.equal((await view(ctx, u)).plans[2].sharing_granted, false);
    r = await ctx.as(u).post('/billing/checkout', { plan: 'shared' });
    assert.equal(r.status, 403); assert.equal(code(r), 'sharing_consent_required');
    assert.deepEqual([ctx.fake.calls.customersCreate, ctx.fake.calls.checkoutCreate], before);

    // explicit current-version grant: purchasable at the shared price only
    assert.equal((await ctx.sharing(u)).status, 200);
    r = await ctx.as(u).post('/billing/checkout', { plan: 'shared' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(ctx.fake.checkouts.at(-1).params.line_items, [{ price: PRICE.shared, quantity: 1 }]);
  } finally { await ctx.close(); }
});

test('checkout: only an allowlisted plan id is read; each plan buys its own configured price; hostile fields and unknown plans are refused or ignored', async () => {
  const ctx = await start();
  try {
    const u = await ctx.coachable('buy');
    for (const bad of [undefined, 'enterprise', 'MAIN', '', 'sol ', { $ne: 1 }]) {
      const r = await ctx.as(u).post('/billing/checkout', bad === undefined ? {} : { plan: bad });
      assert.equal(r.status, 400, JSON.stringify(bad)); assert.equal(code(r), 'invalid_plan');
    }
    assert.equal(ctx.fake.calls.customersCreate, 0, 'nothing created for an invalid plan');

    for (const plan of ['main', 'sol']) {
      const r = await ctx.as(u).post('/billing/checkout', { plan, price: 'price_evil', amount: 1, currency: 'usd', model: 'gpt-evil', customer: 'cus_evil1234', tier: 'shared', trial_period_days: 30 });
      assert.equal(r.status, 200, r.text);
      const p = ctx.fake.checkouts.at(-1).params;
      assert.deepEqual(p.line_items, [{ price: PRICE[plan], quantity: 1 }]);
      assert.ok(!JSON.stringify(p).includes('evil') && !JSON.stringify(p).includes('trial'));
      // switching plans before paying leaves exactly one completable session, for the plan now chosen
      const open = ctx.fake.openSessions((await entRow(ctx, u.id)).customer_id);
      assert.equal(open.length, 1); assert.equal(open[0].metadata.wiz_price_id, PRICE[plan]);
    }
    // the same plan again reuses its open session
    const again = await ctx.as(u).post('/billing/checkout', { plan: 'sol' });
    assert.equal(again.status, 200);
    assert.equal(ctx.fake.calls.checkoutCreate, 2);

    // an existing subscriber is sent to Manage billing; no second purchase, no upgrade logic
    ctx.fake.addSubscription({ customer: (await entRow(ctx, u.id)).customer_id, priceId: PRICE.sol });
    const dup = await ctx.as(u).post('/billing/checkout', { plan: 'main' });
    assert.equal(dup.status, 409); assert.equal(code(dup), 'already_subscribed');
  } finally { await ctx.close(); }
});

test('a plan whose Stripe price does not match the approved amount is unavailable alone; Main and Sol stay purchasable and usable without Shared Info configured', async () => {
  const ctx = await start({ env: { WIZ_SHARED_PROJECT_SHARING_ATTESTED: undefined } }); // and the Shared project attestation is missing
  try {
    ctx.fake.priceTable.get(PRICE.sol).unit_amount = 2999; // Stripe disagrees with the approved GBP 30
    const u = await ctx.coachable('mixed');
    const b = await view(ctx, u);
    assert.deepEqual(b.plans.map(p => p.available), [true, false, false]);
    assert.equal(b.purchase_available, true);
    assert.equal((await ctx.as(u).post('/billing/checkout', { plan: 'main' })).status, 200);
    const bad = await ctx.as(u).post('/billing/checkout', { plan: 'sol' });
    assert.equal(bad.status, 503); assert.equal(code(bad), 'plan_unavailable');
    const sh = await ctx.as(u).post('/billing/checkout', { plan: 'shared' });
    assert.equal(sh.status, 503); assert.equal(code(sh), 'plan_unavailable');

    // Main works end to end with Shared Info unresolved
    const m = await ctx.subscribe('main-only', 'main');
    const res = await ctx.say(m.u, await ctx.session(m.u), 'hello');
    assert.equal(res.status, 200, res.text);
    assert.equal(ctx.calls.main.length, 1);
  } finally { await ctx.close(); }
});

test('malformed three-plan configuration fails purchase and routing closed (never the legacy price, never Main)', async () => {
  const ctx = await start({ env: { WIZ_PLAN_SOL_PRODUCT_ID: undefined } });
  try {
    const u = await ctx.coachable('malformed');
    const b = await view(ctx, u);
    assert.deepEqual([b.purchase_available, b.purchase_unavailable_reason, b.plans], [false, 'plans_misconfigured', []]);
    assert.equal(code(await ctx.as(u).post('/billing/checkout', { plan: 'main' })), 'billing_unavailable');
    assert.equal(ctx.fake.calls.customersCreate, 0);
    // even an entitlement already on file cannot route to a provider
    assert.equal((await decide(ctx, u, 'save_chats', 'grant')).status, 200);
    await ctx.db.query("insert into public.wiz_billing_entitlements (user_id, mode, status, price_id, paid_through) values ($1, 'test', 'active', $2, now() + interval '5 days')", [u.id, PRICE.main]);
    const r = await ctx.say(u, await ctx.session(u), 'hello');
    assert.equal(r.status, 503); assert.equal(code(r), 'plan_unavailable');
    assert.deepEqual([ctx.calls.main.length, ctx.calls.sol.length, ctx.calls.shared.length, await countMessages(ctx)], [0, 0, 0, 0]);
  } finally { await ctx.close(); }
});

// ---- routing from the verified paid price -------------------------------------------------------------------------------------
test('saved coaching: the verified paid price chooses exactly one provider, with that plan\'s own key and project; the actual model is stored', async () => {
  const ctx = await start();
  try {
    await ctx.approveSharing();
    const main = await ctx.subscribe('rm', 'main'), sol = await ctx.subscribe('rs', 'sol'), shared = await ctx.subscribe('rh', 'shared');
    assert.equal((await ctx.sharing(shared.u)).status, 200);
    assert.deepEqual([(await view(ctx, main.u)).plan, (await view(ctx, sol.u)).plan, (await view(ctx, shared.u)).plan], ['main', 'sol', 'shared']);

    let sid = await ctx.session(main.u);
    let r = await ctx.say(main.u, sid, 'hello main');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([ctx.calls.main.length, ctx.calls.sol.length, ctx.calls.shared.length], [1, 0, 0]);
    let meta = await ctx.assistantMeta(main.u, sid);
    assert.equal(meta.model, 'claude-sonnet-4-6');
    assert.deepEqual(meta.provenance.route, { plan: 'main', provider: 'anthropic' });

    sid = await ctx.session(sol.u);
    r = await ctx.say(sol.u, sid, 'hello sol');
    assert.equal(r.status, 200, r.text); assert.equal(r.json.content, 'sol reply');
    assert.deepEqual([ctx.calls.main.length, ctx.calls.sol.length, ctx.calls.shared.length], [1, 1, 0]);
    assert.equal(ctx.calls.sol[0].init.headers.Authorization, 'Bearer ' + SOL.key);
    assert.equal(ctx.calls.sol[0].init.headers['OpenAI-Project'], SOL.project);
    meta = await ctx.assistantMeta(sol.u, sid);
    assert.equal(meta.model, 'gpt-6.1-sol');
    assert.deepEqual(meta.provenance.route, { plan: 'sol', provider: 'openai' });

    sid = await ctx.session(shared.u);
    r = await ctx.say(shared.u, sid, 'hello shared');
    assert.equal(r.status, 200, r.text); assert.equal(r.json.content, 'shared reply');
    assert.deepEqual([ctx.calls.main.length, ctx.calls.sol.length, ctx.calls.shared.length], [1, 1, 1]);
    assert.equal(ctx.calls.shared[0].init.headers.Authorization, 'Bearer ' + SHARED.key);
    assert.equal(ctx.calls.shared[0].init.headers['OpenAI-Project'], SHARED.project);
    assert.deepEqual([ctx.calls.shared[0].body.model, ctx.calls.shared[0].body.reasoning, ctx.calls.shared[0].body.store], ['gpt-6.1-sol', { effort: 'low' }, true]);
    meta = await ctx.assistantMeta(shared.u, sid);
    assert.equal(meta.model, 'gpt-6.1-sol');
    assert.deepEqual(meta.provenance.route, { plan: 'shared', provider: 'openai', sharing_consent_version: '1' });

    // the sharing key never served a non-sharing plan and vice versa
    assert.ok(ctx.calls.sol.every(c => c.init.headers.Authorization === 'Bearer ' + SOL.key));
    assert.ok(ctx.calls.shared.every(c => c.init.headers.Authorization === 'Bearer ' + SHARED.key));
  } finally { await ctx.close(); }
});

test('no tier or provider fallback: unknown, conflicting or tampered prices and incomplete provider settings never grant or choose another route', async () => {
  const ctx = await start({ env: { WIZ_SOL_PROJECT_NONSHARING_ATTESTED: undefined } }); // Sol's project is not attested non-sharing
  try {
    const total = () => ctx.calls.main.length + ctx.calls.sol.length + ctx.calls.shared.length;

    // a subscription on a price that is not one of the three never grants
    const foreign = await ctx.subscribe('foreign', 'main');
    foreign.sub.items.data[0].price.id = 'price_TESTforeign01';
    assert.equal((await ctx.as(foreign.u).post('/billing/refresh', {})).status, 200);
    assert.equal((await view(ctx, foreign.u)).entitled, false);
    let r = await ctx.say(foreign.u, await ctx.session(foreign.u), 'hi');
    assert.equal(r.status, 402); assert.equal(code(r), 'subscription_required');

    // two live subscriptions on different approved plans: conflict, no access, Main is not chosen implicitly
    const both = await ctx.subscribe('both', 'main');
    ctx.fake.addSubscription({ customer: both.cus, priceId: PRICE.sol });
    assert.equal((await ctx.as(both.u).post('/billing/refresh', {})).status, 200);
    const bv = await view(ctx, both.u);
    assert.deepEqual([bv.entitled, bv.status, bv.plan], [false, 'conflict', null]);
    r = await ctx.say(both.u, await ctx.session(both.u), 'hi');
    assert.equal(r.status, 402);

    // an entitlement whose stored price is not on the allowlist (tampered/stale) is unavailable, not Main
    const tamper = await ctx.subscribe('tamper', 'main');
    await ctx.db.query("update public.wiz_billing_entitlements set price_id = 'price_TESTunknown01' where user_id = $1", [tamper.u.id]);
    r = await ctx.say(tamper.u, await ctx.session(tamper.u), 'hi');
    assert.equal(r.status, 503); assert.equal(code(r), 'plan_unavailable');
    assert.equal((await ctx.legacyChat(tamper.u, [{ role: 'user', content: 'hi' }])).status, 503);

    // Sol paid, but its provider settings are incomplete: unavailable, never Main or the Shared project
    const sol = await ctx.subscribe('sol-incomplete', 'sol');
    r = await ctx.say(sol.u, await ctx.session(sol.u), 'hi');
    assert.equal(r.status, 503); assert.equal(code(r), 'plan_unavailable');
    assert.equal((await ctx.legacyChat(sol.u, [{ role: 'user', content: 'hi' }])).status, 503);

    assert.equal(total(), 0, 'no provider was called for any of these');
    assert.equal(await countMessages(ctx), 0, 'nothing was appended before the refusal');
  } finally { await ctx.close(); }
});

test('missing provider for a paid plan is unavailable; the other providers are not used instead', async () => {
  const ctx = await start({ providers: {} });
  try {
    await ctx.approveSharing();
    const sol = await ctx.subscribe('noprov', 'sol');
    const r = await ctx.say(sol.u, await ctx.session(sol.u), 'hi');
    assert.equal(r.status, 503); assert.equal(code(r), 'plan_unavailable');
    assert.deepEqual([ctx.calls.main.length, ctx.calls.sol.length, ctx.calls.shared.length], [0, 0, 0]);
  } finally { await ctx.close(); }
});

// ---- Shared Info consent ------------------------------------------------------------------------------------------------------
test('Shared Info needs the current approved explicit grant before work and again immediately before the send (revocation during retrieval)', async () => {
  let hook = null;
  const retrieval = { async search() { if (hook) await hook(); return { status: 'unavailable', chunks: [], tiers: {} }; } };
  const ctx = await start({ retrieval });
  try {
    const { u } = await ctx.subscribe('shared', 'shared'); // subscribed first (the plan can exist while the notice is still unapproved)
    const calls = () => ctx.calls.shared.length + ctx.calls.sol.length + ctx.calls.main.length;
    const sid = await ctx.session(u);

    // notice unapproved: unavailable, nothing appended or sent
    let r = await ctx.say(u, sid, 'one');
    assert.equal(r.status, 503); assert.equal(code(r), 'shared_unavailable');
    // approved but never granted (paying is not consenting)
    await ctx.approveSharing();
    r = await ctx.say(u, sid, 'one');
    assert.equal(r.status, 403); assert.equal(code(r), 'sharing_consent_required');
    assert.equal(calls(), 0);
    assert.equal(await countMessages(ctx), 0);

    // other privacy choices do not stand in for it
    assert.equal((await decide(ctx, u, 'personalisation', 'grant')).status, 200);
    assert.equal((await ctx.say(u, sid, 'one')).status, 403);

    // granted: works, and revocation is honoured at the next request
    assert.equal((await ctx.sharing(u)).status, 200);
    r = await ctx.say(u, sid, 'two');
    assert.equal(r.status, 200, r.text);
    assert.equal(ctx.calls.shared.length, 1);
    assert.equal((await ctx.sharing(u, 'revoke')).status, 200);
    r = await ctx.say(u, sid, 'three');
    assert.equal(r.status, 403); assert.equal(code(r), 'sharing_consent_required');
    assert.equal(ctx.calls.shared.length, 1);

    // revoked WHILE the request is being prepared: refused unsent, never switched to another project or provider
    assert.equal((await ctx.sharing(u)).status, 200);
    hook = async () => { hook = null; assert.equal((await ctx.sharing(u, 'revoke')).status, 200); };
    r = await ctx.say(u, sid, 'four');
    assert.equal(r.status, 403); assert.equal(code(r), 'sharing_consent_required');
    assert.deepEqual([ctx.calls.shared.length, ctx.calls.sol.length, ctx.calls.main.length], [1, 0, 0]);

    // a re-grant after revocation works again; history, account and export stay available throughout
    assert.equal((await ctx.sharing(u)).status, 200);
    assert.equal((await ctx.say(u, sid, 'five')).status, 200);
    assert.equal((await ctx.sharing(u, 'revoke')).status, 200);
    assert.equal((await ctx.as(u).get('/sessions')).status, 200);
    assert.equal((await ctx.as(u).get(`/sessions/${sid}/messages`)).status, 200);
    assert.equal((await ctx.as(u).get('/me')).status, 200);
    assert.equal((await ctx.request('GET', '/api/v1/account/export', { token: u.token })).status, 200);
    assert.equal((await view(ctx, u)).status, 'active');
  } finally { await ctx.close(); }
});

test('Shared Info sends only this session\'s messages since the current grant: earlier Sol/Main history is never copied to the sharing project; completed retries replay without a call', async () => {
  const ctx = await start();
  try {
    await ctx.approveSharing();
    const { u, sub } = await ctx.subscribe('switch', 'sol');
    const sid = await ctx.session(u);
    assert.equal((await ctx.say(u, sid, 'EARLIER-SOL-MESSAGE')).status, 200);
    assert.equal(ctx.calls.sol.length, 1);

    // the account later moves to Shared Info (provider-side change reconciled), opts in, and continues the same session
    sub.items.data[0].price.id = PRICE.shared;
    assert.equal((await ctx.as(u).post('/billing/refresh', {})).status, 200);
    assert.equal((await view(ctx, u)).plan, 'shared');
    assert.equal((await ctx.say(u, sid, 'x')).status, 403, 'the plan change alone shares nothing');
    assert.equal(ctx.calls.shared.length, 0);
    assert.equal((await ctx.sharing(u)).status, 200);

    const key = 'tier-chat-fixed0001';
    let r = await ctx.say(u, sid, 'FIRST-SHARED-MESSAGE', key);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(ctx.calls.shared[0].body.input, [{ role: 'user', content: 'FIRST-SHARED-MESSAGE' }]);

    r = await ctx.say(u, sid, 'SECOND-SHARED-MESSAGE');
    assert.equal(r.status, 200, r.text);
    const sent = JSON.stringify(ctx.calls.shared[1].body.input);
    assert.ok(sent.includes('FIRST-SHARED-MESSAGE') && sent.includes('SECOND-SHARED-MESSAGE'));
    assert.ok(!sent.includes('EARLIER-SOL-MESSAGE') && !JSON.stringify(ctx.calls.shared[1].body).includes('EARLIER-SOL-MESSAGE'));

    // a completed identical retry returns the stored reply: no provider call at all
    r = await ctx.say(u, sid, 'FIRST-SHARED-MESSAGE', key);
    assert.equal(r.status, 200); assert.equal(r.json.replayed, true);
    assert.equal(ctx.calls.shared.length, 2);
    assert.equal(ctx.calls.sol.length, 1);
  } finally { await ctx.close(); }
});

// ---- legacy /api/chat -------------------------------------------------------------------------------------------------------
test('legacy /api/chat follows the same plan routing and consent checks', async () => {
  const ctx = await start();
  try {
    await ctx.approveSharing();
    const msgs = [{ role: 'user', content: 'EARLIER-CLIENT-TURN' }, { role: 'assistant', content: 'earlier answer' }, { role: 'user', content: 'LATEST' }];
    const main = await ctx.subscribe('lm', 'main'), sol = await ctx.subscribe('ls', 'sol'), shared = await ctx.subscribe('lh', 'shared');

    let r = await ctx.legacyChat(main.u, msgs);
    assert.equal(r.status, 200, r.text); assert.deepEqual(r.json.content, [{ type: 'text', text: 'main reply' }]);
    r = await ctx.legacyChat(sol.u, msgs);
    assert.equal(r.status, 200, r.text); assert.deepEqual(r.json.content, [{ type: 'text', text: 'sol reply' }]);
    assert.deepEqual(ctx.calls.sol[0].body.input.map(m => m.content), ['EARLIER-CLIENT-TURN', 'earlier answer', 'LATEST'], 'Sol keeps the client history as before');
    assert.deepEqual([ctx.calls.main.length, ctx.calls.sol.length, ctx.calls.shared.length], [1, 1, 0]);

    // Shared Info: consent first (no bypass through the legacy route), then only the final message leaves
    r = await ctx.legacyChat(shared.u, msgs);
    assert.equal(r.status, 403); assert.equal(code(r), 'sharing_consent_required');
    assert.equal(ctx.calls.shared.length, 0);
    assert.equal((await ctx.sharing(shared.u)).status, 200);
    r = await ctx.legacyChat(shared.u, msgs);
    assert.equal(r.status, 200, r.text); assert.deepEqual(r.json.content, [{ type: 'text', text: 'shared reply' }]);
    assert.deepEqual(ctx.calls.shared[0].body.input, [{ role: 'user', content: 'LATEST' }]);
    assert.equal(ctx.calls.shared[0].init.headers.Authorization, 'Bearer ' + SHARED.key);
    assert.equal((await ctx.sharing(shared.u, 'revoke')).status, 200);
    assert.equal((await ctx.legacyChat(shared.u, msgs)).status, 403);
    assert.deepEqual([ctx.calls.main.length, ctx.calls.sol.length, ctx.calls.shared.length], [1, 1, 1]);

    // unpaid: refused before any provider
    const unpaid = await ctx.coachable('lu');
    assert.equal((await ctx.legacyChat(unpaid, msgs)).status, 402);
  } finally { await ctx.close(); }
});

test('provider failure on a paid plan is a safe error with one call and no fallback to another provider', async () => {
  const solCalls = [];
  const failing = createOpenAiProvider({ apiKey: SOL.key, projectId: SOL.project, fetchImpl: async (url, init) => { solCalls.push(init); return { ok: false, status: 500, json: async () => ({ error: { message: 'LEAK-ME' } }) }; } });
  const ctx = await start({ providers: { sol: failing } });
  try {
    const { u } = await ctx.subscribe('fail', 'sol');
    const sid = await ctx.session(u);
    const r = await ctx.say(u, sid, 'hello');
    assert.equal(r.status, 502); assert.equal(code(r), 'assistant_unavailable');
    assert.ok(!r.text.includes('LEAK-ME') && !r.text.includes(SOL.key));
    assert.equal(solCalls.length, 1);
    assert.equal(ctx.calls.main.length, 0, 'no fallback to Claude');
    assert.ok(!JSON.stringify(ctx.logs).includes('LEAK-ME') && !JSON.stringify(ctx.logs).includes(SOL.key) && !JSON.stringify(ctx.logs).includes('hello'));
  } finally { await ctx.close(); }
});

// ---- legacy single-price compatibility ----------------------------------------------------------------------------------------
test('legacy single-price configuration is unchanged: no plan list, body ignored, existing provider, no routing provenance', async () => {
  const ctx = await startBillingApi();
  try {
    const u = await ctx.coachable('legacy');
    const b = await view(ctx, u);
    assert.deepEqual([b.purchase_available, b.plans], [true, undefined]);
    const r = await ctx.as(u).post('/billing/checkout', { plan: 'shared', price: 'price_evil' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(ctx.fake.checkouts.at(-1).params.line_items, [{ price: 'price_TESTfixture1', quantity: 1 }]);
    const cus = (await entRow(ctx, u.id)).customer_id;
    ctx.fake.addSubscription({ customer: cus });
    assert.equal((await ctx.as(u).post('/billing/refresh', {})).status, 200);
    await ctx.approveNotices();
    assert.equal((await ctx.grant(u, 'save_chats')).status, 200);
    const sid = (await ctx.as(u).post('/sessions', {}, 'legacy-sess-0001')).json.item.id;
    const chat = await ctx.as(u).post(`/sessions/${sid}/chat`, { messages: [{ role: 'user', content: 'hello' }] }, 'legacy-chat-0001');
    assert.equal(chat.status, 200, chat.text);
    assert.equal(ctx.providerCalls.length, 1);
    const meta = await ctx.db.query('select model, provenance from public.wiz_message_meta where session_id = $1 and model is not null', [sid]);
    assert.equal(meta.rows[0].model, 'test-model');
    assert.equal(meta.rows[0].provenance.route, undefined);
  } finally { await ctx.close(); }
});

// ---- migration ---------------------------------------------------------------------------------------------------------------------
test('migration: price_id exposed to the service role only; Shared Info consent registered unapproved; re-apply no-op; rollback preserves data and retires sharing; re-apply restores', async () => {
  const db = await openFlowDb();
  try {
    await h.applyUp(db, TIERS_UP_SQL).then(() => assert.fail('must refuse without the billing migration'), err => assert.match(String(err.message || err), /billing and health-consent-flow migrations must be applied first/));
    await applyBillingUp(db);
    await h.applyUp(db, TIERS_UP_SQL);
    await h.applyUp(db, TIERS_UP_SQL); // already applied: no-op

    const state = async () => (await db.query("select public.wiz_billing_state(gen_random_uuid(), 'test') s")).rows[0].s;
    assert.ok('price_id' in (await state()));
    const priv = async fn => (await db.query("select has_function_privilege('anon', $1, 'execute') a, has_function_privilege('authenticated', $1, 'execute') b, has_function_privilege('service_role', $1, 'execute') c", [fn])).rows[0];
    assert.deepEqual(await priv('public.wiz_billing_state(uuid, text)'), { a: false, b: false, c: true });

    const v = async () => (await db.query("select status, legal_approved, artifact_id from public.wiz_consent_versions where purpose = 'openai_training'")).rows;
    assert.deepEqual(await v(), [{ status: 'current', legal_approved: false, artifact_id: null }]);

    // an unapproved notice cannot be granted (direct function call, as the API would)
    const uid = await h.newAuthUser(db, 'mig-tiers@example.test');
    await db.query('insert into public.users (id, email) values ($1, $2) on conflict do nothing', [uid, 'mig-tiers@example.test']);
    await assert.rejects(db.query("select public.wiz_consent_record($1, 'openai_training', '1', 'grant')", [uid]), /notice_not_approved/);
    await db.query("update public.wiz_consent_versions set legal_approved = true where purpose = 'openai_training'");
    await db.query("select public.wiz_consent_record($1, 'openai_training', '1', 'grant')", [uid]);
    const events = async () => (await db.query("select count(*)::int n from public.wiz_consent_events where purpose = 'openai_training'")).rows[0].n;
    assert.equal(await events(), 1);

    await h.applyUp(db, TIERS_DOWN_SQL);
    assert.equal('price_id' in (await state()), false, 'previous function body restored');
    assert.deepEqual(await priv('public.wiz_billing_state(uuid, text)'), { a: false, b: false, c: true });
    assert.equal((await v())[0].status, 'retired', 'Shared Info disabled');
    assert.equal(await events(), 1, 'consent events are never deleted');
    const cs = (await db.query('select public.wiz_consent_state($1) s', [uid])).rows[0].s;
    assert.ok(!cs.some(p => p.purpose === 'openai_training'), 'a retired purpose is not offered or honoured');
    await h.applyUp(db, TIERS_DOWN_SQL); // second rollback: no-op

    await h.applyUp(db, TIERS_UP_SQL);
    assert.ok('price_id' in (await state()));
    assert.equal((await v())[0].status, 'current');
    assert.equal(await events(), 1);
    assert.equal((await db.query("select status from public.wiz_migration_state where name = 'wiz_billing_tiers_20261021'")).rows[0].status, 'applied');
  } finally { await db.close(); }
});
