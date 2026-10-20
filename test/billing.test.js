'use strict';
// Paid subscription: server-configured price, hosted Checkout/Portal, signed webhook, lease-serialised reconciliation from CURRENT provider
// state, the paid gate, export and the erasure boundary. Real app + fake GoTrue + PGlite with the billing migration; a FAKE Stripe client
// (test/helpers/fake-stripe.js, synthetic fixture values, not a WIZ price). Real Stripe TEST-mode verification is a separate parent step.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers/db');
const { loadConfig } = require('../lib/config');
const { startBillingApi, openBillingDb, applyBillingUp, applyBillingDown, FIXTURE_PRICE, WEBHOOK_SECRET, FULL_ENV } = require('./helpers/billing-api');
const { createFakeStripe, event, sign } = require('./helpers/fake-stripe');

const code = r => r.json && r.json.error && r.json.error.code;
const ent = (ctx, uid) => ctx.db.query('select * from public.wiz_billing_entitlements where user_id = $1', [uid]).then(r => r.rows[0]);
const countOf = (ctx, table, uid) => ctx.db.query(`select count(*)::int n from public.${table}${uid ? ' where user_id = $1' : ''}`, uid ? [uid] : []).then(r => r.rows[0].n);
const view = (ctx, u) => ctx.as(u).get('/billing').then(r => r.json);
const epoch = days => Math.floor(Date.now() / 1000) + Math.round(days * 86400);

async function bind(ctx, u) { // Checkout binds the server-created customer before anything else
  const r = await ctx.as(u).post('/billing/checkout', {});
  assert.equal(r.status, 200, r.text);
  return (await ent(ctx, u.id)).customer_id;
}
async function subscribed(ctx, label, patch = {}) {
  const u = await ctx.coachable(label);
  const cus = await bind(ctx, u);
  const sub = ctx.fake.addSubscription({ customer: cus, ...patch });
  return { u, cus, sub };
}
async function chat(ctx, u, text = 'hello') {
  const sid = (await ctx.as(u).post('/sessions', {}, 'bill-sess-' + Math.random().toString(16).slice(2, 12))).json.item.id;
  return { sid, res: await ctx.as(u).post(`/sessions/${sid}/chat`, { messages: [{ role: 'user', content: text }] }, 'bill-chat-' + Math.random().toString(16).slice(2, 12)) };
}

test('config: nothing has a default price; gate on by default; erasure policy defaults to block; malformed pieces are off', () => {
  const c = loadConfig({});
  assert.deepEqual([c.billing.gate, c.billing.secretKey, c.billing.mode, c.billing.webhookSecret, c.billing.price, c.billing.returnUrl, c.billing.erasurePolicy], [true, null, null, null, null, null, 'block']);
  const full = loadConfig(FULL_ENV).billing;
  assert.deepEqual([full.mode, full.price, full.returnUrl], ['test', { id: FIXTURE_PRICE.id, productId: FIXTURE_PRICE.productId, amount: 1234, currency: 'gbp', interval: 'month' }, 'http://127.0.0.1:4000/app']);
  assert.equal(loadConfig({ ...FULL_ENV, WIZ_STRIPE_PRICE_AMOUNT: '0' }).billing.price, null);
  assert.equal(loadConfig({ ...FULL_ENV, WIZ_STRIPE_PRICE_INTERVAL: 'week' }).billing.price, null);
  assert.equal(loadConfig({ ...FULL_ENV, WIZ_STRIPE_PRODUCT_ID: undefined }).billing.price, null);
  assert.equal(loadConfig({ ...FULL_ENV, WIZ_BILLING_RETURN_URL: 'https://evil.example/x' }).billing.returnUrl, null, 'return URL must be on an allowlisted origin');
  assert.equal(loadConfig({ ...FULL_ENV, STRIPE_SECRET_KEY: 'not-a-key' }).billing.secretKey, null);
  assert.equal(loadConfig({ ...FULL_ENV, STRIPE_SECRET_KEY: 'sk_live_FIXTUREfixture0001' }).billing.mode, 'live');
  assert.equal(loadConfig({ WIZ_BILLING_GATE: 'off' }).billing.gate, false);
  assert.equal(loadConfig({ WIZ_BILLING_ERASURE_POLICY: 'cancel' }).billing.erasurePolicy, 'cancel');
});

test('unverified or missing price disables purchase truthfully; account, privacy and verification stay open; coaching waits', async () => {
  const db = await openBillingDb();
  try {
    // no Stripe settings at all
    let ctx = await startBillingApi({ db, unconfigured: true });
    try {
      const u = await ctx.coachable('nocfg');
      const b = await view(ctx, u);
      assert.deepEqual([b.purchase_available, b.purchase_unavailable_reason, b.entitled, b.can_manage, b.gate], [false, 'not_configured', false, false, true]);
      assert.equal(code(await ctx.as(u).post('/billing/checkout', {})), 'billing_unavailable');
      assert.equal(code(await ctx.as(u).post('/billing/portal', {})), 'billing_unavailable');
      assert.equal(code(await ctx.hook(event('invoice.paid', 'cus_x1234'))), 'billing_unavailable');
      assert.equal((await ctx.as(u).get('/me')).status, 200);
      assert.equal((await ctx.as(u).get('/consents')).status, 200);
      assert.equal((await ctx.request('GET', '/api/v1/account/export', { token: u.token })).status, 200);
      const { res } = await chat(ctx, u);
      assert.equal(res.status, 402); assert.equal(code(res), 'subscription_required');
    } finally { await ctx.close(); }

    // Stripe's own record of the price disagrees with what the owner configured: each mismatch keeps purchase off, creates nothing
    const mismatches = {
      amount: f => { f.price.unit_amount = 9999; }, currency: f => { f.price.currency = 'usd'; }, interval: f => { f.price.recurring.interval = 'year'; },
      product: f => { f.price.product = 'prod_SOMEONEelse'; }, livemode: f => { f.price.livemode = true; }, inactive: f => { f.price.active = false; },
      oneOff: f => { f.price.type = 'one_time'; f.price.recurring = null; }
    };
    for (const [name, mutate] of Object.entries(mismatches)) {
      const fake = createFakeStripe(); mutate(fake);
      ctx = await startBillingApi({ db, fake });
      try {
        const u = await ctx.coachable('mm-' + name);
        const b = await view(ctx, u);
        assert.deepEqual([b.purchase_available, b.purchase_unavailable_reason], [false, 'price_unverified'], name);
        assert.equal(code(await ctx.as(u).post('/billing/checkout', {})), 'billing_unavailable', name);
        assert.deepEqual([fake.calls.customersCreate, fake.calls.checkoutCreate], [0, 0], name + ': no customer or session was created');
      } finally { await ctx.close(); }
    }
  } finally { await db.close(); }
});

test('checkout and portal: owner from Auth only, persisted server-created customer, configured price only, nothing from the browser', async () => {
  const ctx = await startBillingApi();
  try {
    const a = await ctx.coachable('a'), b = await ctx.coachable('b');
    assert.equal((await ctx.request('POST', '/api/v1/billing/checkout', { body: {} })).status, 401);
    assert.equal((await ctx.request('POST', '/api/v1/billing/portal', { body: {} })).status, 401);
    assert.equal((await ctx.request('GET', '/api/v1/billing')).status, 401);

    const avail = await view(ctx, a);
    assert.deepEqual([avail.purchase_available, avail.mode, avail.entitled], [true, 'test', false]);

    // hostile browser fields are ignored: price, customer, owner and return URLs come from the server
    const r = await ctx.as(a).post('/billing/checkout', { price: 'price_evil', customer: 'cus_evil1234', user_id: b.id, success_url: 'https://evil.example', trial_period_days: 30 });
    assert.equal(r.status, 200);
    assert.match(r.json.url, /^https:\/\/checkout\.stripe\.test\//);
    const p = ctx.fake.checkouts.at(-1).params;
    const aRow = await ent(ctx, a.id);
    assert.deepEqual(p.line_items, [{ price: FIXTURE_PRICE.id, quantity: 1 }]);
    assert.deepEqual([p.mode, p.customer, p.client_reference_id, p.success_url, p.cancel_url], ['subscription', aRow.customer_id, a.id, 'http://127.0.0.1:4000/app?billing=success', 'http://127.0.0.1:4000/app?billing=cancel']);
    assert.ok(!JSON.stringify(p).includes('evil') && !JSON.stringify(p).includes('trial'));
    assert.equal(ctx.fake.customers.get(aRow.customer_id).metadata.wiz_user_id, a.id);

    // the customer is reused, never duplicated; the other owner gets their own and the portal follows each owner's own binding
    assert.equal((await ctx.as(a).post('/billing/checkout', {})).status, 200);
    assert.equal(ctx.fake.calls.customersCreate, 1);
    assert.equal((await ctx.as(b).post('/billing/checkout', {})).status, 200);
    const bRow = await ent(ctx, b.id);
    assert.notEqual(bRow.customer_id, aRow.customer_id);
    assert.equal((await ctx.as(b).post('/billing/portal', { customer: aRow.customer_id })).status, 200);
    assert.equal(ctx.fake.portals.at(-1).customer, bRow.customer_id);
    assert.equal(ctx.fake.portals.at(-1).return_url, 'http://127.0.0.1:4000/app?billing=return');
    const nobody = await ctx.coachable('nobody');
    assert.equal(code(await ctx.as(nobody).post('/billing/portal', {})), 'no_billing_account');

    // concurrent purchase attempts by one owner serialise: one customer, no duplicate binding
    ctx.fake.delayCreateMs = 60;
    const c = await ctx.coachable('conc');
    const rs = await Promise.all(Array.from({ length: 5 }, () => ctx.as(c).post('/billing/checkout', {})));
    assert.ok(rs.every(x => x.status === 200 || (x.status === 503 && code(x) === 'billing_busy')), rs.map(x => x.status).join());
    assert.ok(rs.some(x => x.status === 200));
    assert.equal([...ctx.fake.customers.values()].filter(x => x.metadata.wiz_user_id === c.id).length, 1);
    assert.equal(await countOf(ctx, 'wiz_billing_entitlements', c.id), 1);
  } finally { await ctx.close(); }
});

test('checkout is refused when a subscription already exists, and the same customer can never be bound to two owners', async () => {
  const ctx = await startBillingApi();
  try {
    const { u, cus } = await subscribed(ctx, 'dup');
    const r = await ctx.as(u).post('/billing/checkout', {});
    assert.equal(r.status, 409); assert.equal(code(r), 'already_subscribed');
    assert.equal(ctx.fake.calls.checkoutCreate, 1, 'no second session');
    assert.equal((await ent(ctx, u.id)).status, 'active', 'local state was brought up to date');
    // foreign customer substitution at the database boundary
    const other = await ctx.coachable('other');
    await ctx.as(other).post('/billing/checkout', {});
    await assert.rejects(ctx.db.query("update public.wiz_billing_entitlements set customer_id = $1 where user_id = $2", [cus, other.id]), /duplicate key|unique/i);
  } finally { await ctx.close(); }
});

test('webhook: signature over the raw bytes, mode, bound customer, event id; unhandled and foreign events change nothing', async () => {
  const ctx = await startBillingApi();
  try {
    const { cus } = await subscribed(ctx, 'wh');
    const ev = event('invoice.paid', cus);
    const raw = JSON.stringify(ev);
    const post = (r, headers) => ctx.request('POST', '/api/v1/billing/webhook', { raw: r, headers: { 'Content-Type': 'application/json', ...headers } });

    assert.equal(code(await post(raw, {})), 'invalid_signature', 'no signature');
    assert.equal(code(await post(raw, { 'Stripe-Signature': sign(raw, 'whsec_WRONGsecret0001') })), 'invalid_signature', 'wrong secret');
    assert.equal(code(await post(raw, { 'Stripe-Signature': sign(raw + ' ') })), 'invalid_signature', 'signature of different bytes');
    assert.equal(code(await post(raw + ' ', { 'Stripe-Signature': sign(raw) })), 'invalid_signature', 'body altered after signing');
    assert.equal((await ctx.request('POST', '/api/v1/billing/webhook', { body: ev, headers: { 'Stripe-Signature': sign(JSON.stringify(ev)) } })).status, 200, 'parsed-then-reserialised identical bytes only because JSON.stringify is stable');
    assert.equal(await countOf(ctx, 'wiz_billing_events'), 1);

    // the exact bytes are what is verified: pretty-printed JSON signed as sent is accepted
    const pretty = JSON.stringify(event('invoice.paid', cus), null, 2);
    assert.equal((await post(pretty, { 'Stripe-Signature': sign(pretty) })).status, 200);

    // valid signature but the wrong Stripe mode (a live event on a test-mode server)
    const live = event('invoice.paid', cus, {}, true);
    const w = await ctx.hook(live);
    assert.equal(w.status, 400); assert.equal(code(w), 'wrong_mode');
    assert.equal(code(await ctx.hook({ ...event('invoice.paid', cus), id: 'not-an-event-id' })), 'invalid_event');

    // not a handled type / no customer / a customer WIZ never bound: acknowledged, recorded nowhere
    const before = await countOf(ctx, 'wiz_billing_events');
    assert.equal((await ctx.hook(event('charge.refunded', cus))).json.ignored, 'type');
    assert.equal((await ctx.hook({ ...event('invoice.paid', cus), data: { object: {} } })).json.ignored, 'no_customer');
    assert.equal((await ctx.hook(event('invoice.paid', 'cus_NEVERbound1'))).json.ignored, 'unbound_customer');
    assert.equal(await countOf(ctx, 'wiz_billing_events'), before);
  } finally { await ctx.close(); }
});

test('entitlement comes only from a verified PAID period on an active subscription of the allowlisted price', async () => {
  const ctx = await startBillingApi();
  try {
    const past = epoch(-1);
    const cases = [
      ['active, paid, future period', {}, true, 'active'],
      ['active, paid, cancel at period end', { cancel_at_period_end: true }, true, 'active'],
      ['active but latest invoice open', { invoice: { status: 'open', amount_paid: 0 } }, false, 'active'],
      ['active but zero-amount "paid" invoice', { invoice: { status: 'paid', amount_paid: 0 } }, false, 'active'],
      // payment-proof regressions (installed SDK shapes): "paid" with money that Stripe did not collect, or evidence that cannot be verified
      ['paid out of band: amount_paid_off_stripe only', { invoice: { amount_paid: 1234, amount_paid_off_stripe: 1234 } }, false, 'active'],
      ['part of the payment off Stripe', { invoice: { amount_paid_off_stripe: 200 } }, false, 'active'],
      ['malformed off-Stripe amount', { invoice: { amount_paid_off_stripe: 'lots' } }, false, 'active'],
      ['paid invoice with no invoice payments at all', { invoice: { payments: { data: [] } } }, false, 'active'],
      ['payments not available (unverifiable)', { invoice: { payments: undefined } }, false, 'active'],
      ['only a payment_record payment', { invoice: { id: 'in_FIXTUREoob1', payments: { data: [{ object: 'invoice_payment', status: 'paid', amount_paid: 1234, currency: 'gbp', invoice: 'in_FIXTUREoob1', payment: { type: 'payment_record' } }] } } }, false, 'active'],
      ['invoice payment not paid', { invoice: { id: 'in_FIXTUREopen1', payments: { data: [{ object: 'invoice_payment', status: 'open', amount_paid: null, currency: 'gbp', invoice: 'in_FIXTUREopen1', payment: { type: 'payment_intent' } }] } } }, false, 'active'],
      ['invoice payment belongs to another invoice', { invoice: { payments: { data: [{ object: 'invoice_payment', status: 'paid', amount_paid: 1234, currency: 'gbp', invoice: 'in_SOMEOTHER1', payment: { type: 'charge' } }] } } }, false, 'active'],
      ['invoice in the wrong currency', { invoice: { currency: 'usd' } }, false, 'active'],
      ['invoice of another customer', { invoice: { customer: 'cus_SOMEONEelse1' } }, false, 'active'],
      ['live-mode invoice on a test-mode server', { invoice: { livemode: true } }, false, 'active'],
      ['invoice generated by another subscription', { invoice: { parent: { type: 'subscription_details', quote_details: null, subscription_details: { subscription: 'sub_OTHERsub1', metadata: null } } } }, false, 'active'],
      ['invoice with no subscription parent', { invoice: { parent: null } }, false, 'active'],
      ['invoice period does not cover the current period', { invoice: { lines: { data: [{ period: { start: 1, end: 12345 } }] } } }, false, 'active'],
      ['invoice with no lines', { invoice: { lines: undefined } }, false, 'active'],
      ['collected payment, off-Stripe field absent (legitimate)', { invoice: { amount_paid_off_stripe: undefined } }, true, 'active'],
      ['collected payment via charge (legitimate)', { invoice: { id: 'in_FIXTUREchg1', payments: { data: [{ object: 'invoice_payment', status: 'paid', amount_paid: 1234, currency: 'gbp', invoice: 'in_FIXTUREchg1', payment: { type: 'charge' } }] } } }, true, 'active'],
      ['active with no invoice', { invoice: null }, false, 'active'],
      ['active, paid, period already ended', { periodEnd: past }, false, 'active'],
      ['trialing', { status: 'trialing' }, false, 'trialing'],
      ['past_due', { status: 'past_due' }, false, 'past_due'],
      ['unpaid', { status: 'unpaid' }, false, 'unpaid'],
      ['incomplete', { status: 'incomplete' }, false, 'incomplete'],
      ['paused', { status: 'paused' }, false, 'paused'],
      ['canceled', { status: 'canceled' }, false, 'canceled'],
      ['unknown status', { status: 'brand_new_status' }, false, 'conflict'],
      ['subscription on a price WIZ does not sell', { priceId: 'price_OTHERprice1' }, false, 'none'],
      ['two items', null, false, 'conflict']
    ];
    for (const [name, patch, entitled, status] of cases) {
      const { u, cus, sub } = await subscribed(ctx, 'm', patch || {});
      if (!patch) ctx.fake.setSub(sub.id, { items: { data: [...sub.items.data, { id: 'si_X', price: { id: 'price_OTHERprice1' }, quantity: 1, current_period_end: epoch(5) }] } });
      const r = await ctx.hook(event('invoice.paid', cus));
      assert.equal(r.status, 200, name);
      const b = await view(ctx, u);
      assert.deepEqual([b.entitled, b.status], [entitled, status], name);
    }

    assert.ok(ctx.fake.lastList.expand.includes('data.latest_invoice.payments'), 'the adapter asks Stripe for the invoice payments it relies on');

    // two live subscriptions of our price are ambiguous: never silently granted
    const dupe = await subscribed(ctx, 'amb');
    ctx.fake.addSubscription({ customer: dupe.cus });
    await ctx.hook(event('customer.subscription.created', dupe.cus));
    assert.deepEqual(await view(ctx, dupe.u).then(b => [b.entitled, b.status]), [false, 'conflict']);

    // paid-through is the item-level period end; renewal moves it; cancel-at-period-end keeps only the verified paid time
    const { u, cus, sub } = await subscribed(ctx, 'renew', { periodEnd: epoch(10), cancel_at_period_end: true });
    await ctx.hook(event('invoice.paid', cus));
    let row = await ent(ctx, u.id);
    assert.equal(row.paid_through.getTime(), sub.items.data[0].current_period_end * 1000);
    assert.equal(row.cancel_at_period_end, true);
    const newEnd = epoch(40);
    ctx.fake.setSub(sub.id, { cancel_at_period_end: false, items: { data: [{ ...sub.items.data[0], current_period_end: newEnd }] },
      latest_invoice: ctx.fake.makeInvoice({ customer: cus, subId: sub.id, periodEnd: newEnd, patch: { id: 'in_FIXTURErenew2' } }) });
    await ctx.hook(event('customer.subscription.updated', cus));
    row = await ent(ctx, u.id);
    assert.ok(row.paid_through.getTime() > Date.now() + 39 * 86400e3 && row.last_invoice_id === 'in_FIXTURErenew2' && row.cancel_at_period_end === false);

    // a missed renewal reconciliation fails closed: the stored period simply ends (database clock), nothing else is needed
    assert.equal((await view(ctx, u)).entitled, true);
    await ctx.db.query("update public.wiz_billing_entitlements set paid_through = now() - interval '1 minute' where user_id = $1", [u.id]);
    assert.equal((await view(ctx, u)).entitled, false);
  } finally { await ctx.close(); }
});

test('idempotent replay and out-of-order delivery: the event is applied once, and state always comes from the provider, not the payload', async () => {
  const ctx = await startBillingApi();
  try {
    const { u, cus, sub } = await subscribed(ctx, 'replay');
    const ev = event('invoice.paid', cus);
    assert.equal((await ctx.hook(ev)).json.applied, true);
    const listed = ctx.fake.calls.subscriptionsList;
    const again = await ctx.hook(ev);
    assert.equal(again.status, 200); assert.equal(again.json.duplicate, true);
    assert.equal(ctx.fake.calls.subscriptionsList, listed, 'a committed duplicate does not even fetch');
    assert.equal(await countOf(ctx, 'wiz_billing_events', u.id), 1);
    assert.equal((await view(ctx, u)).entitled, true);

    // a STALE event whose payload says "canceled" arrives while the provider still says active+paid: payload is ignored
    const stale = event('customer.subscription.deleted', cus, { status: 'canceled', id: sub.id });
    assert.equal((await ctx.hook(stale)).status, 200);
    assert.equal((await view(ctx, u)).entitled, true);

    // the provider moves on (canceled); an OLD "paid" event delivered afterwards cannot restore access
    ctx.fake.setSub(sub.id, { status: 'canceled' });
    assert.equal((await ctx.hook(event('invoice.paid', cus, { status: 'paid' }))).status, 200);
    assert.deepEqual(await view(ctx, u).then(b => [b.entitled, b.status]), [false, 'canceled']);
  } finally { await ctx.close(); }
});

test('concurrency: a second reconciler waits (retryable) instead of racing; a stale holder cannot overwrite a newer state', async () => {
  const ctx = await startBillingApi();
  try {
    const { u, cus, sub } = await subscribed(ctx, 'race');
    await ctx.hook(event('invoice.paid', cus));
    const hold = () => { let release; const held = new Promise(r => { release = r; }); let reached; const at = new Promise(r => { reached = r; }); return { release, held, reached, at }; };

    // A holds the lease between "fetched" and "committed"; B must not run its own fetch
    let g = hold();
    ctx.fake.hooks.afterSnapshot = async () => { g.reached(); await g.held; };
    const e1 = event('customer.subscription.updated', cus), e2 = event('customer.subscription.updated', cus);
    const first = ctx.hook(e1);
    await g.at;
    ctx.fake.hooks.afterSnapshot = null;
    const busy = await ctx.hook(e2);
    assert.equal(busy.status, 503); assert.equal(code(busy), 'billing_busy');
    assert.equal(await countOf(ctx, 'wiz_billing_events', u.id) , 1, 'only the first invoice.paid so far');
    g.release();
    assert.equal((await first).status, 200);
    assert.equal((await ctx.hook(e2)).status, 200, 'the retry succeeds');
    assert.equal(await countOf(ctx, 'wiz_billing_events', u.id), 3);

    // A stalls past its lease (simulated), the provider moves on, B reconciles; A's late commit of its older snapshot is refused
    g = hold();
    ctx.fake.hooks.afterSnapshot = async () => { g.reached(); await g.held; };
    const eA = event('customer.subscription.updated', cus), eB = event('customer.subscription.updated', cus);
    const stalled = ctx.hook(eA);
    await g.at;
    ctx.fake.hooks.afterSnapshot = null;
    await ctx.db.query("update public.wiz_billing_entitlements set lease_until = now() - interval '1 second' where user_id = $1", [u.id]);
    ctx.fake.setSub(sub.id, { status: 'canceled' });
    assert.equal((await ctx.hook(eB)).status, 200);
    g.release();
    const late = await stalled;
    assert.equal(late.status, 503); assert.equal(code(late), 'billing_busy');
    assert.deepEqual(await view(ctx, u).then(b => [b.entitled, b.status]), [false, 'canceled'], 'the newer state stands');
    const ids = (await ctx.db.query('select event_id from public.wiz_billing_events where user_id = $1', [u.id])).rows.map(r => r.event_id);
    assert.ok(ids.includes(eB.id) && !ids.includes(eA.id), 'the refused commit recorded nothing');
  } finally { await ctx.close(); }
});

test('atomic commit: a failure rolls back the event and the entitlement together, frees the lease, and the retry succeeds', async () => {
  const ctx = await startBillingApi();
  try {
    const { u, cus } = await subscribed(ctx, 'atomic');
    await ctx.db.exec(`create function public.boom() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$;
      create trigger boom before update on public.wiz_billing_entitlements for each row when (new.status = 'active') execute function public.boom()`);
    const ev = event('invoice.paid', cus);
    const r = await ctx.hook(ev);
    assert.equal(r.status, 500, 'retryable: Stripe will redeliver');
    assert.equal(await countOf(ctx, 'wiz_billing_events', u.id), 0, 'event rolled back');
    const row = await ent(ctx, u.id);
    assert.deepEqual([row.status, row.paid_through, row.lease_token], ['none', null, null], 'entitlement untouched, lease released');
    await ctx.db.exec('drop trigger boom on public.wiz_billing_entitlements');
    const ok = await ctx.hook(ev);
    assert.equal(ok.status, 200); assert.equal(ok.json.applied, true);
    assert.equal(await countOf(ctx, 'wiz_billing_events', u.id), 1);
    assert.equal((await view(ctx, u)).entitled, true);

    // provider unreachable: retryable, nothing recorded, lease freed
    const { u: u2, cus: c2 } = await subscribed(ctx, 'down');
    ctx.fake.failList = Object.assign(new Error('network'), { type: 'StripeConnectionError' });
    const down = await ctx.hook(event('invoice.paid', c2));
    assert.equal(down.status, 503); assert.equal(code(down), 'billing_provider_unavailable');
    assert.equal(await countOf(ctx, 'wiz_billing_events', u2.id), 0);
    ctx.fake.failList = null;
    assert.equal((await ctx.hook(event('invoice.paid', c2))).status, 200);
  } finally { await ctx.close(); }
});

test('paid gate: coaching and paid-feature writes are refused before any work; every account, privacy and verification route stays open', async () => {
  const ctx = await startBillingApi();
  try {
    const u = await ctx.coachable('gate');
    await ctx.approveNotices();
    await ctx.db.query("update public.users set subscription_status = 'active', subscription_tier = 'pro' where id = $1", [u.id]); // legacy billing columns are NOT authority
    assert.equal((await ctx.grant(u, 'save_chats')).status, 200);
    const sid = (await ctx.as(u).post('/sessions', { topic: { kind: 'custom', text: 'a focus' } }, 'bill-gate-sess-01')).json.item.id;
    const blocked = async (res, what) => { assert.equal(res.status, 402, what); assert.equal(code(res), 'subscription_required', what); };
    await blocked(await ctx.as(u).post(`/sessions/${sid}/chat`, { messages: [{ role: 'user', content: 'hi' }] }, 'bill-gate-chat-01'), 'chat');
    await blocked(await ctx.as(u).post(`/sessions/${sid}/start`, {}, 'bill-gate-start-01'), 'start');
    await blocked(await ctx.request('POST', '/api/chat', { token: u.token, body: { messages: [{ role: 'user', content: 'hi' }] } }), 'legacy chat');
    await blocked(await ctx.as(u).put('/career-plan', { plan: { direction: 'x', values: [], routes: [] }, expected_version: 0 }), 'career plan write');
    await blocked(await ctx.as(u).post('/portfolio', { title: 't', entry_type: 'project', body: 'b', entry_date: '2026-01-01' }, 'bill-gate-port-01'), 'portfolio write');
    assert.equal(await ctx.db.query('select count(*)::int n from public.messages').then(r => r.rows[0].n), 0, 'nothing appended');
    assert.equal(ctx.providerCalls.length, 0, 'no provider work');

    // unpaid but fully functional elsewhere
    const api = ctx.as(u);
    assert.equal((await api.get('/me')).status, 200);
    assert.equal((await api.patch('/me', { full_name: 'Still Me' })).status, 200);
    assert.equal((await api.get('/consents')).status, 200);
    assert.equal((await ctx.grant(u, 'career_records')).status, 200);
    assert.equal((await api.get('/career-plan')).status, 200);
    // deleting an actually seeded, owned plan works unpaid; another account's plan is untouched
    const other = await ctx.coachable('plan-other');
    await ctx.db.query(`insert into public.wiz_career_plans (user_id, plan) values ($1, '{"direction":"mine"}'), ($2, '{"direction":"theirs"}')`, [u.id, other.id]);
    assert.equal((await api.del('/career-plan')).status, 200);
    assert.equal(await countOf(ctx, 'wiz_career_plans', u.id), 0);
    assert.equal(await countOf(ctx, 'wiz_career_plans', other.id), 1);
    assert.equal((await api.get(`/sessions/${sid}/messages`)).status, 200);
    assert.equal((await api.get('/sessions')).status, 200);
    assert.equal((await ctx.request('GET', '/api/v1/account/export', { token: u.token })).status, 200);
    assert.equal((await ctx.request('DELETE', `/api/v1/sessions/${sid}`, { token: u.token, body: { confirm: 'delete_session' } })).status, 200);
    assert.equal((await api.get('/billing')).status, 200);
    assert.equal((await api.post('/billing/checkout', {})).status, 200);

    // paid: the same calls get through the gate (a career write then meets its own consent rule, not the paid gate)
    const cus = (await ent(ctx, u.id)).customer_id;
    ctx.fake.addSubscription({ customer: cus });
    assert.equal((await ctx.hook(event('invoice.paid', cus))).status, 200);
    const sid2 = (await api.post('/sessions', {}, 'bill-gate-sess-02')).json.item.id;
    assert.equal((await api.post(`/sessions/${sid2}/chat`, { messages: [{ role: 'user', content: 'hi' }] }, 'bill-gate-chat-02')).status, 200);
    assert.notEqual((await api.put('/career-plan', { plan: { direction: 'x', values: [], routes: [] }, expected_version: 0 })).status, 402);
    assert.equal((await ctx.request('POST', '/api/chat', { token: u.token, body: { messages: [{ role: 'user', content: 'hi' }] } })).status, 200);
  } finally { await ctx.close(); }
});

test('browser roles and the application role cannot read or write billing records directly', async () => {
  const ctx = await startBillingApi();
  try {
    const { u } = await subscribed(ctx, 'priv');
    for (const role of ['anon', 'authenticated']) {
      for (const sql of ['select * from public.wiz_billing_entitlements', 'select * from public.wiz_billing_events',
        "update public.wiz_billing_entitlements set status = 'active', paid_through = now() + interval '1 year'", "insert into public.wiz_billing_events (mode, event_id, event_type, user_id) values ('test', 'evt_x1234', 'x.y', '" + u.id + "')"]) {
        await assert.rejects(h.asRole(ctx.db, role, u.id, tx => tx.query(sql)), /permission denied/, `${role}: ${sql}`);
      }
      await assert.rejects(h.asRole(ctx.db, role, u.id, tx => tx.query("select public.wiz_billing_state($1, 'test')", [u.id])), /permission denied/, role + ' functions');
      await assert.rejects(h.asRole(ctx.db, role, u.id, tx => tx.query("select public.wiz_billing_commit($1, 'test', gen_random_uuid(), null, null, '{}'::jsonb)", [u.id])), /permission denied/, role + ' commit');
    }
    for (const sql of ['delete from public.wiz_billing_entitlements', 'delete from public.wiz_billing_events', "update public.wiz_billing_events set event_type = 'x.y'", 'truncate public.wiz_billing_events']) {
      await assert.rejects(h.asRole(ctx.db, 'service_role', null, tx => tx.query(sql)), /permission denied/, sql);
    }
    // the legacy columns are untouched by all of this
    const legacy = (await ctx.db.query('select subscription_status, stripe_customer_id from public.users where id = $1', [u.id])).rows[0];
    assert.deepEqual(legacy, { subscription_status: 'inactive', stripe_customer_id: null });
  } finally { await ctx.close(); }
});

test('export includes the owner\'s local billing records only; erasure never orphans a charging subscription (default policy: block)', async () => {
  const ctx = await startBillingApi();
  try {
    const a = await subscribed(ctx, 'erase-a'), b = await subscribed(ctx, 'erase-b');
    await ctx.hook(event('invoice.paid', a.cus)); await ctx.hook(event('invoice.paid', b.cus));
    const expA = await ctx.request('GET', '/api/v1/account/export', { token: a.u.token });
    assert.equal(expA.json.billing.entitlements.length, 1);
    assert.deepEqual([expA.json.billing.entitlements[0].customer_id, expA.json.billing.entitlements[0].subscription_id, expA.json.billing.entitlements[0].status], [a.cus, a.sub.id, 'active']);
    assert.equal(expA.json.billing.events.length, 1);
    assert.ok(!JSON.stringify(expA.json).includes(b.cus) && !JSON.stringify(expA.json).includes('lease_token'), "no other account's data, no lease internals");

    // chargeable subscription: refused BEFORE the account closes, nothing cancelled on the owner's behalf, account fully usable
    const refuse = await ctx.request('POST', '/api/v1/account/erasure', { token: a.u.token, body: { confirm: 'erase_my_account' } });
    assert.equal(refuse.status, 409); assert.equal(code(refuse), 'subscription_active');
    assert.deepEqual(ctx.fake.cancelCalls, []);
    assert.equal((await ctx.as(a.u).get('/me')).status, 200);
    assert.equal((await ctx.request('GET', '/api/v1/account/erasure', { token: a.u.token })).json.state, 'none');

    // after the owner cancels at the provider, erasure completes and the local billing records go with the account; the other account is untouched
    ctx.fake.setSub(a.sub.id, { status: 'canceled' });
    const done = await ctx.request('POST', '/api/v1/account/erasure', { token: a.u.token, body: { confirm: 'erase_my_account' } });
    assert.equal(done.status, 200, done.text);
    assert.equal(await countOf(ctx, 'wiz_billing_entitlements', a.u.id), 0);
    assert.equal(await countOf(ctx, 'wiz_billing_events', a.u.id), 0);
    assert.equal(await countOf(ctx, 'wiz_billing_entitlements', b.u.id), 1);
    assert.equal((await view(ctx, b.u)).entitled, true);
  } finally { await ctx.close(); }
});

test('erasure in progress: the guard is re-run before the identity goes, and the portal stays reachable so a subscriber can cancel', async () => {
  const ctx = await startBillingApi();
  try {
    const u = await ctx.coachable('pending');
    const cus = await bind(ctx, u);
    ctx.admin.state.failDelete = true; // erasure starts, then stalls at the identity step
    const first = await ctx.request('POST', '/api/v1/account/erasure', { token: u.token, body: { confirm: 'erase_my_account' } });
    assert.equal(first.status, 503); assert.equal(code(first), 'erasure_incomplete');
    const receipt = first.json.error.erasure.receipt_id;

    const sub = ctx.fake.addSubscription({ customer: cus }); // a purchase completes while erasure is pending
    ctx.admin.state.failDelete = false;
    await assert.rejects(ctx.app.locals.privacy.resume(receipt), err => err.code === 'erasure_incomplete' && err.extra.erasure.reason === 'subscription_active');
    const again = await ctx.request('POST', '/api/v1/account/erasure', { token: u.token, body: { confirm: 'erase_my_account' } });
    assert.equal(again.status, 409); assert.equal(code(again), 'subscription_active');
    assert.equal((await ctx.as(u).post('/billing/portal', {})).status, 200, 'portal is available while erasure is pending');
    assert.equal((await ctx.as(u).get('/me')).status, 403, 'other routes stay closed while pending');

    ctx.fake.setSub(sub.id, { status: 'canceled' });
    assert.equal((await ctx.request('POST', '/api/v1/account/erasure', { token: u.token, body: { confirm: 'erase_my_account' } })).status, 200);
    assert.equal(await countOf(ctx, 'wiz_billing_entitlements', u.id), 0);
  } finally { await ctx.close(); }
});

test('erasure policy "cancel": the subscription is cancelled at the provider first, verified, then the account is erased', async () => {
  const ctx = await startBillingApi({ env: { WIZ_BILLING_ERASURE_POLICY: 'cancel' } });
  try {
    const { u, cus, sub } = await subscribed(ctx, 'cancel');
    await ctx.hook(event('invoice.paid', cus));
    const done = await ctx.request('POST', '/api/v1/account/erasure', { token: u.token, body: { confirm: 'erase_my_account' } });
    assert.equal(done.status, 200, done.text);
    assert.deepEqual(ctx.fake.cancelCalls, [sub.id]);
    assert.equal(await countOf(ctx, 'wiz_billing_entitlements', u.id), 0);
  } finally { await ctx.close(); }
});

test('paid gate covers every value-adding saved-data write; reads, deletes, empty session creation and account operations stay open unpaid', async () => {
  const ctx = await startBillingApi();
  try {
    const { u, cus } = await subscribed(ctx, 'writes'); // customer bound and a paid subscription exists at the provider, but nothing is reconciled yet
    await ctx.approveNotices();
    assert.equal((await ctx.grant(u, 'save_chats')).status, 200);
    assert.equal((await ctx.grant(u, 'career_records')).status, 200);
    const api = ctx.as(u);
    const created = await api.post('/sessions', {}, 'bill-w-sess-0001'); // first-use flow: an empty session is fine unpaid
    assert.equal(created.status, 201);
    const sid = created.json.item.id;
    const writes = {
      goal: () => api.post('/goals', { title: 'a goal' }, 'bill-w-goal-0001'),
      journal: () => api.post('/journal', { body: 'an entry', entry_date: '2026-10-20' }, 'bill-w-jrnl-0001'),
      report: () => api.post('/reports', { kind: 'summary', title: 'a report', body: 'text' }, 'bill-w-rept-0001'),
      evidence: () => api.post('/evidence', { statement: 'a statement' }, 'bill-w-evid-0001'),
      training: () => api.put('/training/module_one', { status: 'in_progress', percent: 10 }),
      checkpoint: () => api.put(`/sessions/${sid}/checkpoint`, { checkpoint: { a: 1 }, expected_version: 0 }),
      message: () => api.post(`/sessions/${sid}/messages`, { content: 'a saved message' }, 'bill-w-msg-00001'),
      plan: () => api.put('/career-plan', { plan: { direction: 'x', values: [], routes: [] }, expected_version: 0 })
    };
    const tables = ['wiz_goals', 'wiz_journal_entries', 'wiz_reports', 'wiz_profile_evidence', 'wiz_training_progress', 'wiz_career_plans'];
    const stored = async () => {
      const n = [];
      for (const t of tables) n.push(await countOf(ctx, t, u.id));
      n.push((await ctx.db.query('select count(*)::int n from public.messages where conversation_id = $1', [sid])).rows[0].n);
      return n;
    };

    for (const [name, call] of Object.entries(writes)) { const r = await call(); assert.equal(r.status, 402, name); assert.equal(code(r), 'subscription_required', name); }
    assert.deepEqual(await stored(), [0, 0, 0, 0, 0, 0, 0], 'nothing was written');
    const open = [['/goals', 200], ['/journal', 200], ['/reports', 200], ['/evidence', 200], ['/training', 200], [`/sessions/${sid}/messages`, 200], [`/sessions/${sid}/checkpoint`, 200], ['/sessions', 200], ['/career-plan', 200], ['/me', 200], ['/billing', 200]];
    for (const [p, status] of open) assert.equal((await api.get(p)).status, status, 'GET ' + p);
    assert.equal((await api.patch(`/sessions/${sid}`, { title: 'renamed' })).status, 200);
    assert.equal((await api.put('/me/onboarding', { answers: { over_18: true }, complete: true })).status, 200);
    assert.equal((await api.patch('/me', { full_name: 'Unpaid Person' })).status, 200);

    // paid: every one of them goes through
    assert.equal((await ctx.hook(event('invoice.paid', cus))).status, 200);
    const made = {};
    for (const [name, call] of Object.entries(writes)) { made[name] = await call(); assert.ok([200, 201].includes(made[name].status), name + ' ' + made[name].text); }
    assert.deepEqual(await stored(), [1, 1, 1, 1, 1, 1, 1]);

    // lapsed: new writes and edits stop, deleting what the owner saved still works
    await ctx.db.query("update public.wiz_billing_entitlements set paid_through = now() - interval '1 minute' where user_id = $1", [u.id]);
    assert.equal(code(await api.post('/goals', { title: 'another' }, 'bill-w-goal-0002')), 'subscription_required');
    assert.equal(code(await api.patch(`/goals/${made.goal.json.item.id}`, { title: 'edited' })), 'subscription_required');
    assert.equal(code(await api.post(`/evidence/${made.evidence.json.item.id}/confirm`)), 'subscription_required');
    for (const p of [`/goals/${made.goal.json.item.id}`, `/journal/${made.journal.json.item.id}`, `/reports/${made.report.json.item.id}`, `/evidence/${made.evidence.json.item.id}`, '/career-plan']) {
      assert.equal((await api.del(p)).status, 200, 'DELETE ' + p);
    }
    assert.equal((await ctx.request('GET', '/api/v1/account/export', { token: u.token })).status, 200);
  } finally { await ctx.close(); }
});

test('checkout keeps at most ONE open purchase per owner across retries, earlier sessions, other workers, expiry and concurrency', async () => {
  const ctx = await startBillingApi();
  try {
    const fake = ctx.fake;
    const createdFor = cus => fake.checkouts.filter(c => c.params.customer === cus).length;
    const foreign = fake.seedSession({ customer: 'cus_FOREIGNone1', userId: 'someone-else' });

    // a retry returns the very same open session
    const a = await ctx.coachable('single-a');
    const r1 = await ctx.as(a).post('/billing/checkout', {}), r2 = await ctx.as(a).post('/billing/checkout', {});
    const cusA = (await ent(ctx, a.id)).customer_id;
    assert.deepEqual([r1.status, r2.status, r2.json.url === r1.json.url, createdFor(cusA), fake.openSessions(cusA).length], [200, 200, true, 1, 1]);

    // a predecessor not made by this process (an earlier hour / another worker) is reused or superseded, never duplicated
    const b = await ctx.coachable('single-b');
    const cusB = await bind(ctx, b);
    const mine = fake.openSessions(cusB)[0];
    const older = fake.seedSession({ customer: cusB, userId: b.id, expiresInSec: 22 * 3600 });
    const rb = await ctx.as(b).post('/billing/checkout', {});
    assert.equal(rb.json.url, older.url, 'the longest-lived valid session is the one kept');
    assert.deepEqual([fake.openSessions(cusB).map(s => s.id), mine.status, createdFor(cusB)], [[older.id], 'expired', 1]);

    // about to expire, or for a different price, or someone else's reference: expired and replaced by exactly one fresh session
    for (const [name, mutate] of Object.entries({
      nearExpiry: s => { s.expires_at = Math.floor(Date.now() / 1000) + 120; },
      otherPrice: s => { s.metadata = { ...s.metadata, wiz_price_id: 'price_OLDone' }; },
      otherOwner: s => { s.client_reference_id = 'not-the-owner'; }
    })) {
      const c = await ctx.coachable('single-' + name);
      const cus = await bind(ctx, c);
      const stale = fake.openSessions(cus)[0];
      mutate(stale);
      const rc = await ctx.as(c).post('/billing/checkout', {});
      assert.equal(rc.status, 200, name);
      const nowOpen = fake.openSessions(cus);
      assert.deepEqual([nowOpen.length, nowOpen[0].url === rc.json.url, nowOpen[0].id !== stale.id, stale.status, createdFor(cus)], [1, true, true, 'expired', 2], name);
      assert.throws(() => fake.completeCheckout(stale.id), /no longer open/, name + ': the superseded session cannot be paid');
      assert.equal(fake.subs.filter(s => s.customer === cus).length, 0, name);
    }

    // concurrent attempts by one owner (fresh customer): serialised, one open session, one creation
    fake.delayCreateMs = 40;
    const d = await ctx.coachable('single-conc');
    const rs = await Promise.all(Array.from({ length: 5 }, () => ctx.as(d).post('/billing/checkout', {})));
    assert.ok(rs.every(x => x.status === 200 || (x.status === 503 && code(x) === 'billing_busy')), rs.map(x => x.status).join());
    const cusD = (await ent(ctx, d.id)).customer_id;
    assert.deepEqual([fake.openSessions(cusD).length, createdFor(cusD)], [1, 1]);
    assert.ok(rs.filter(x => x.status === 200).every(x => x.json.url === fake.openSessions(cusD)[0].url));

    assert.equal(foreign.status, 'open', "another customer's session is never touched");
    assert.ok(!fake.expireCalls.includes(foreign.id));
  } finally { await ctx.close(); }
});

test('erasure neutralises uncompleted purchases: an open Checkout cannot complete afterwards; checkout and erasure never interleave', async () => {
  const ctx = await startBillingApi();
  try {
    const fake = ctx.fake;
    const erase = u => ctx.request('POST', '/api/v1/account/erasure', { token: u.token, body: { confirm: 'erase_my_account' } });
    const foreign = fake.seedSession({ customer: 'cus_FOREIGNone1', userId: 'someone-else' });

    // open Checkout -> account erased -> the late payment is impossible and no unbound subscription appears
    const a = await ctx.coachable('late');
    const cusA = await bind(ctx, a);
    const open = fake.openSessions(cusA)[0];
    const done = await erase(a);
    assert.equal(done.status, 200, done.text);
    assert.deepEqual([open.status, fake.expireCalls.includes(open.id), fake.subs.filter(s => s.customer === cusA).length], ['expired', true, 0]);
    assert.throws(() => fake.completeCheckout(open.id), /no longer open/);
    assert.equal(await countOf(ctx, 'wiz_billing_entitlements', a.id), 0);
    assert.equal((await ctx.hook(event('invoice.paid', cusA))).json.ignored, 'unbound_customer');

    // the payment completes at the very moment the session is expired: that is now an established subscription, so the owner policy applies
    const b = await ctx.coachable('racing');
    const cusB = await bind(ctx, b);
    fake.hooks.onExpire = async id => { fake.completeCheckout(id); };
    const refused = await erase(b);
    fake.hooks.onExpire = null;
    assert.equal(refused.status, 409); assert.equal(code(refused), 'subscription_active');
    assert.equal((await ctx.as(b).get('/me')).status, 200, 'the account was not closed');
    assert.equal(await countOf(ctx, 'wiz_billing_entitlements', b.id), 1, 'binding kept: no orphaned subscription');
    assert.equal(fake.subs.filter(s => s.customer === cusB).length, 1);

    // a purchase in progress holds the owner lease: erasure waits (retryable), then succeeds and expires what the purchase created
    const d = await ctx.coachable('interleave');
    fake.delayCreateMs = 300;
    const purchase = ctx.as(d).post('/billing/checkout', {});
    await new Promise(r => setTimeout(r, 100));
    const busy = await erase(d);
    assert.equal(busy.status, 503); assert.equal(code(busy), 'billing_busy');
    assert.equal((await purchase).status, 200);
    fake.delayCreateMs = 0;
    const cusD = (await ent(ctx, d.id)).customer_id;
    assert.equal(fake.openSessions(cusD).length, 1);
    assert.equal((await erase(d)).status, 200);
    assert.equal(fake.openSessions(cusD).length, 0);

    // while an erasure is pending no new purchase can start
    const e2 = await ctx.coachable('pending-buy');
    await bind(ctx, e2);
    ctx.admin.state.failDelete = true;
    assert.equal((await erase(e2)).status, 503);
    const buy = await ctx.as(e2).post('/billing/checkout', {});
    assert.equal(buy.status, 403); assert.equal(code(buy), 'account_erasure_pending');
    ctx.admin.state.failDelete = false;
    assert.equal((await erase(e2)).status, 200);

    assert.equal(foreign.status, 'open', "another customer's session is never touched");
    assert.ok(!fake.expireCalls.includes(foreign.id));
  } finally { await ctx.close(); }
});

test('migration: re-apply is a no-op; rollback keeps every binding and event and only removes the functions; re-apply restores service', async () => {
  const ctx = await startBillingApi();
  try {
    const { u, cus } = await subscribed(ctx, 'mig');
    await ctx.hook(event('invoice.paid', cus));
    await applyBillingUp(ctx.db); // already applied
    const before = [(await ent(ctx, u.id)).customer_id, await countOf(ctx, 'wiz_billing_events', u.id)];

    await applyBillingDown(ctx.db);
    assert.equal((await ctx.db.query("select count(*)::int n from pg_proc where proname ~ '^wiz_billing_'")).rows[0].n, 0);
    assert.deepEqual([(await ent(ctx, u.id)).customer_id, await countOf(ctx, 'wiz_billing_events', u.id)], before, 'records preserved');
    await assert.rejects(h.asRole(ctx.db, 'service_role', null, tx => tx.query('select * from public.wiz_billing_entitlements')), /permission denied/);
    await applyBillingDown(ctx.db); // second rollback: not applied -> no-op

    await applyBillingUp(ctx.db);
    assert.equal((await view(ctx, u)).entitled, true, 'restored over the preserved record');
    assert.equal((await ctx.db.query("select status from public.wiz_migration_state where name = 'wiz_billing_20261021'")).rows[0].status, 'applied');
  } finally { await ctx.close(); }
});

test('real Stripe SDK signature verification over the raw body (when the SDK is installed)', async t => {
  let Stripe;
  try { const mod = require('stripe'); Stripe = mod.default || mod; } catch (err) { return t.skip('stripe SDK not installed: ' + err.message.split('\n')[0]); }
  const real = new Stripe('sk_test_FIXTUREfixture0001');
  const fake = createFakeStripe();
  const hybrid = { webhooks: real.webhooks, subscriptions: fake.subscriptions, customers: fake.customers, checkout: fake.checkout, billingPortal: fake.billingPortal, prices: fake.prices };
  const ctx = await startBillingApi({ fake, stripe: hybrid });
  try {
    const { cus } = await subscribed(ctx, 'sdk');
    const raw = JSON.stringify(event('invoice.paid', cus));
    const send = (payload, header) => ctx.request('POST', '/api/v1/billing/webhook', { raw: payload, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header } });
    const header = real.webhooks.generateTestHeaderString({ payload: raw, secret: WEBHOOK_SECRET });
    assert.equal((await send(raw, header)).status, 200);
    assert.equal(code(await send(raw + ' ', header)), 'invalid_signature');
    assert.equal(code(await send(raw, real.webhooks.generateTestHeaderString({ payload: raw, secret: 'whsec_WRONGsecret0001' }))), 'invalid_signature');
    const old = real.webhooks.generateTestHeaderString({ payload: raw, secret: WEBHOOK_SECRET, timestamp: Math.floor(Date.now() / 1000) - 3600 });
    assert.equal(code(await send(raw, old)), 'invalid_signature', 'replayed old signature is outside the tolerance');
  } finally { await ctx.close(); }
});
