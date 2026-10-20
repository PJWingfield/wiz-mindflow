'use strict';
// In-memory stand-in for the Stripe client surface lib/billing.js uses, shaped after the installed SDK 23 types (Invoice.parent.subscription_details,
// amount_paid_off_stripe, InvoicePayment.payment.type, item-level current_period_end, Checkout.Session list/expire). SYNTHETIC TEST FIXTURE: ids,
// amounts and currency below are made up for integration tests and are NOT a WIZ price. Real Stripe TEST-mode verification is a separate parent step.
const crypto = require('node:crypto');

const FIXTURE_PRICE = Object.freeze({ id: 'price_TESTfixture1', productId: 'prod_TESTfixture1', amount: 1234, currency: 'gbp', interval: 'month' });
const SECRET_KEY = 'sk_test_FIXTUREfixture0001';
const WEBHOOK_SECRET = 'whsec_FIXTUREfixture0001';

const sign = (raw, secret = WEBHOOK_SECRET) => 'fx=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
const clone = x => JSON.parse(JSON.stringify(x));

function createFakeStripe() {
  const f = { customers: new Map(), subs: [], sessions: [], checkouts: [], portals: [], cancelCalls: [], expireCalls: [], lastList: null,
    calls: { customersCreate: 0, subscriptionsList: 0, checkoutCreate: 0 }, hooks: {}, failList: null, delayCreateMs: 0 };
  const idem = new Map();
  let n = 0;
  f.price = { id: FIXTURE_PRICE.id, object: 'price', livemode: false, active: true, type: 'recurring', unit_amount: FIXTURE_PRICE.amount, currency: FIXTURE_PRICE.currency, product: FIXTURE_PRICE.productId, recurring: { interval: FIXTURE_PRICE.interval, interval_count: 1 } };
  const once = (key, make) => { if (key && idem.has(key)) return idem.get(key); const v = make(); if (key) idem.set(key, v); return v; };

  // A paid, Stripe-collected invoice for one period of one subscription; `patch` overrides any field (undefined removes it).
  f.makeInvoice = ({ customer, subId, periodEnd, patch = {} }) => {
    const id = patch.id || 'in_FIXTURE' + (++n);
    return { id, object: 'invoice', status: 'paid', livemode: false, currency: FIXTURE_PRICE.currency, customer,
      amount_paid: FIXTURE_PRICE.amount, amount_paid_off_stripe: 0,
      parent: { type: 'subscription_details', quote_details: null, subscription_details: { subscription: subId, metadata: null } },
      lines: { data: [{ period: { start: periodEnd - 30 * 86400, end: periodEnd } }] },
      payments: { data: [{ object: 'invoice_payment', status: 'paid', amount_paid: FIXTURE_PRICE.amount, currency: FIXTURE_PRICE.currency, invoice: id, payment: { type: 'payment_intent', payment_intent: 'pi_FIXTURE' + n } }] },
      ...patch };
  };
  // test helper: a subscription. invoice: undefined = a normal paid invoice, null = none, object = overrides on the normal one.
  f.addSubscription = ({ customer, status = 'active', priceId = FIXTURE_PRICE.id, periodEnd = Math.floor(Date.now() / 1000) + 25 * 86400, quantity = 1,
    invoice, cancel_at_period_end = false, created = Math.floor(Date.now() / 1000) } = {}) => {
    const id = 'sub_FIXTURE' + (++n);
    const sub = { id, object: 'subscription', customer, status, cancel_at_period_end, created,
      items: { data: [{ id: 'si_FIXTURE' + n, price: { id: priceId }, quantity, current_period_end: periodEnd }] },
      latest_invoice: invoice === null ? null : f.makeInvoice({ customer, subId: id, periodEnd, patch: invoice || {} }) };
    f.subs.push(sub);
    return sub;
  };
  f.setSub = (id, patch) => { Object.assign(f.subs.find(s => s.id === id), patch); };
  // test helper: an open Checkout session as another worker / an earlier hour would have left it
  f.seedSession = ({ customer, userId, priceId = FIXTURE_PRICE.id, expiresInSec = 20 * 3600, status = 'open', mode = 'subscription', metadata } = {}) => {
    const s = { id: 'cs_test_FIXTURE' + (++n), object: 'checkout.session', mode, status, customer, client_reference_id: userId,
      metadata: metadata || { wiz_user_id: userId, wiz_price_id: priceId }, url: 'https://checkout.stripe.test/c/pay/' + n, expires_at: Math.floor(Date.now() / 1000) + expiresInSec };
    f.sessions.push(s);
    return s;
  };
  f.openSessions = customer => f.sessions.filter(s => s.status === 'open' && (!customer || s.customer === customer));
  // test helper: the person finishes paying in hosted Checkout. Only an OPEN session can be completed; it creates a paid subscription.
  f.completeCheckout = id => {
    const s = f.sessions.find(x => x.id === id);
    if (!s || s.status !== 'open') throw new Error('This Checkout Session is no longer open');
    s.status = 'complete';
    return f.addSubscription({ customer: s.customer });
  };
  f.sign = sign;

  f.webhooks = {
    // stand-in for stripe.webhooks.constructEvent: the real HMAC check over the exact raw bytes
    constructEvent(raw, header, secret) {
      if (!Buffer.isBuffer(raw) && typeof raw !== 'string') throw new Error('payload must be the raw body');
      if (header !== sign(raw, secret)) throw new Error('No signatures found matching the expected signature for payload');
      return JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw);
    }
  };
  f.customers = Object.assign(new Map(), {
    async create(params, opts = {}) {
      f.calls.customersCreate++;
      if (f.delayCreateMs) await new Promise(r => setTimeout(r, f.delayCreateMs));
      return once(opts.idempotencyKey && 'c:' + opts.idempotencyKey, () => { const c = { id: 'cus_FIXTURE' + (++n), email: params.email, metadata: params.metadata }; f.customers.set(c.id, c); return c; });
    }
  });
  f.checkout = { sessions: {
    async create(params, opts = {}) {
      f.calls.checkoutCreate++;
      if (f.hooks.beforeCheckoutCreate) await f.hooks.beforeCheckoutCreate();
      return once(opts.idempotencyKey && 's:' + opts.idempotencyKey, () => {
        const s = f.seedSession({ customer: params.customer, userId: params.client_reference_id, metadata: params.metadata });
        f.checkouts.push({ params: clone(params), opts, session: s });
        return clone(s);
      });
    },
    async list(params) {
      return { data: clone(f.sessions.filter(s => (!params.customer || s.customer === params.customer) && (!params.status || s.status === params.status))) };
    },
    async expire(id) {
      f.expireCalls.push(id);
      if (f.hooks.onExpire) await f.hooks.onExpire(id);
      const s = f.sessions.find(x => x.id === id);
      if (!s || s.status !== 'open') throw new Error('Only open Checkout Sessions can be expired');
      s.status = 'expired';
      return clone(s);
    }
  } };
  f.billingPortal = { sessions: { async create(params) { const s = { id: 'bps_FIXTURE' + (++n), url: 'https://billing.stripe.test/p/session/' + n }; f.portals.push(clone(params)); return s; } } };
  f.prices = { async retrieve(id) { if (id !== f.price.id) throw new Error('no such price'); return clone(f.price); } };
  f.subscriptions = {
    async list(params) {
      f.calls.subscriptionsList++;
      f.lastList = clone(params);
      if (f.failList) throw f.failList;
      const snapshot = clone(f.subs.filter(s => s.customer === params.customer));
      if (f.hooks.afterSnapshot) await f.hooks.afterSnapshot(); // lets a test hold a reconciler between "fetched" and "committed"
      const expand = params.expand || [];
      const invoiceExpanded = expand.includes('data.latest_invoice') || expand.includes('data.latest_invoice.payments');
      const paymentsExpanded = expand.includes('data.latest_invoice.payments');
      return { data: snapshot.map(s => {
        if (!s.latest_invoice) return s;
        if (!invoiceExpanded) return { ...s, latest_invoice: s.latest_invoice.id };
        if (!paymentsExpanded) { const { payments, ...rest } = s.latest_invoice; return { ...s, latest_invoice: rest }; } // payments is only present when expanded
        return s;
      }) };
    },
    async cancel(id) { f.cancelCalls.push(id); f.setSub(id, { status: 'canceled' }); return { id, status: 'canceled' }; }
  };
  return f;
}

// a minimal Stripe-shaped event
let evn = 0;
const event = (type, customer, extra = {}, livemode = false) => ({ id: 'evt_FIXTURE' + (++evn), object: 'event', type, livemode, data: { object: { customer, ...extra } } });

module.exports = { createFakeStripe, event, sign, FIXTURE_PRICE, SECRET_KEY, WEBHOOK_SECRET };
