'use strict';
// Paid subscription (Stripe hosted Checkout + Customer Portal), reconciled from CURRENT provider state. See docs/billing.md.
//   store      owner-scoped billing RPCs (createBillingStore below; spread into lib/store.js)
//   stripe     the official Stripe client, injected (tests pass a fake); created lazily from config only when a key is configured
// Principles: the owner is the Auth-verified user (or the owner bound to a verified webhook customer), never a browser value; the price is server
// configuration verified against Stripe before purchase is offered; a success redirect proves nothing; every reconciliation takes a persistent
// per-owner lease BEFORE the provider fetch and commits event + entitlement atomically; only an active subscription with a verified PAID invoice
// and an unexpired item period grants access (no trials, grace or past-due access).
const crypto = require('node:crypto');
const express = require('express');
const { ApiError, e, fromRpcError } = require('./errors');
const { PLAN_IDS, PLANS, createPlans } = require('./plans');

const TERMINAL = new Set(['canceled', 'incomplete_expired']);
const KNOWN = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'incomplete_expired', 'paused', 'canceled']);
const HANDLED = new Set(['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'customer.subscription.paused', 'customer.subscription.resumed', 'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required']);
const LEASE_SECONDS = 30;
const EVENT_ID_RE = /^evt_[A-Za-z0-9_]{3,100}$/;

const BUSY = [503, 'billing_busy', 'Another billing action is in progress. Try again shortly.'];
const BILLING_CODES = {
  billing_busy: BUSY,
  billing_lease_lost: BUSY,
  billing_conflict: [409, 'billing_conflict', 'This billing account is already linked elsewhere, so it cannot be used.']
};

// ---- database functions (service role only; the owner argument is always a verified id) -----------------------------------------
function createBillingStore(rpc) {
  const call = async (fn, args) => {
    try { return await rpc(fn, args); } catch (err) {
      const m = err && err.name === 'RpcError' && err.kind === 'db' ? /^wiz:([a-z_]+)$/.exec(err.message || '') : null;
      if (m && BILLING_CODES[m[1]]) { const [s, c, msg] = BILLING_CODES[m[1]]; throw new ApiError(s, c, msg); }
      throw fromRpcError(err);
    }
  };
  return {
    billingOwner: (mode, customerId) => call('wiz_billing_owner', { p_mode: mode, p_customer_id: customerId }),
    billingBinding: (id, mode) => call('wiz_billing_binding', { p_user_id: id, p_mode: mode }),
    billingState: (id, mode) => call('wiz_billing_state', { p_user_id: id, p_mode: mode }),
    billingLease: (id, mode, eventId, ttl) => call('wiz_billing_lease', { p_user_id: id, p_mode: mode, p_event_id: eventId || null, p_ttl: ttl }),
    billingBind: (id, mode, token, customerId) => call('wiz_billing_bind_customer', { p_user_id: id, p_mode: mode, p_token: token, p_customer_id: customerId }),
    billingRelease: (id, mode, token) => call('wiz_billing_release', { p_user_id: id, p_mode: mode, p_token: token }),
    billingCommit: (id, mode, token, eventId, eventType, state) => call('wiz_billing_commit', { p_user_id: id, p_mode: mode, p_token: token, p_event_id: eventId || null, p_event_type: eventType || null, p_state: state }),
    billingExport: id => call('wiz_billing_export', { p_user_id: id })
  };
}

// ---- Stripe adapter: every SDK-shape assumption lives here ------------------------------------------------------------------------
function createStripeClient(cfg) {
  const mod = require('stripe'); // loaded only when a key is configured
  const Stripe = mod.default || mod;
  return new Stripe(cfg.secretKey, { maxNetworkRetries: 2, timeout: 20000 });
}

// The prices this server will verify, offer and honour. Legacy single-price configuration: that one price (plan null). Three-plan
// configuration: the configured plans' prices with the FIXED approved amount/currency/interval. A malformed three-plan configuration: none.
function priceList(cfg) {
  if (!cfg.plans) return cfg.price ? [{ ...cfg.price, plan: null }] : [];
  if (cfg.plans.malformed) return [];
  return PLAN_IDS.filter(id => cfg.plans.items[id]).map(id => ({
    id: cfg.plans.items[id].id, productId: cfg.plans.items[id].productId, amount: PLANS[id].amount, currency: PLANS[id].currency, interval: PLANS[id].interval, plan: id
  }));
}

function createStripeAdapter(stripe, cfg, now = Date.now) {
  const prices = priceList(cfg);
  const needPrice = plan => { const p = prices.find(x => x.plan === (plan === undefined ? null : plan)); if (!p) throw new Error('price_not_configured'); return p; };
  const custId = c => (typeof c === 'string' ? c : c && typeof c.id === 'string' ? c.id : null);
  const fail = code => { const err = new Error(code); err.code = code; return err; };

  async function listSubscriptions(customerId, expand) {
    const out = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100, ...(expand ? { expand: ['data.latest_invoice', 'data.latest_invoice.payments'] } : {}) });
    return (out.data || []).filter(s => custId(s.customer) === customerId);
  }

  // Proof that Stripe COLLECTED money for this subscription's current period. `status: paid` and `amount_paid > 0` are not enough: an invoice marked
  // paid out of band reports amount_paid > 0 too (its off-Stripe part is amount_paid_off_stripe). Everything must line up, else no access:
  // paid, this mode, configured currency, this customer, generated by THIS subscription, no off-Stripe part, a PAID InvoicePayment backed by a
  // payment_intent/charge (payments must be expanded: unverifiable = denied), and an invoice line covering exactly the item's current period.
  function collectedPayment(inv, { customerId, subscription, item, p }) {
    if (!inv || typeof inv !== 'object' || inv.status !== 'paid') return false;
    if (inv.livemode !== (cfg.mode === 'live') || inv.currency !== p.currency || custId(inv.customer) !== customerId) return false;
    const parent = inv.parent && inv.parent.subscription_details;
    if (!parent || custId(parent.subscription) !== subscription.id) return false;
    const off = inv.amount_paid_off_stripe === undefined || inv.amount_paid_off_stripe === null ? 0 : inv.amount_paid_off_stripe;
    if (!Number.isFinite(off) || off !== 0 || !Number.isFinite(inv.amount_paid) || !(inv.amount_paid > 0)) return false;
    const payments = inv.payments && Array.isArray(inv.payments.data) ? inv.payments.data : null;
    if (!payments || !payments.some(x => x && x.status === 'paid' && x.payment && (x.payment.type === 'payment_intent' || x.payment.type === 'charge')
      && Number.isFinite(x.amount_paid) && x.amount_paid > 0 && x.currency === p.currency && custId(x.invoice) === inv.id)) return false;
    const lines = inv.lines && Array.isArray(inv.lines.data) ? inv.lines.data : [];
    return lines.some(l => l && l.period && l.period.end === item.current_period_end);
  }

  return {
    // Purchase is offered only if Stripe's own record of the configured price matches the owner-approved values.
    prices,
    async verifyPrice(plan) {
      const p = needPrice(plan);
      const x = await stripe.prices.retrieve(p.id);
      const productId = custId(x.product);
      const checks = {
        mode: x.livemode === (cfg.mode === 'live'), active: x.active === true, recurring: x.type === 'recurring' && !!x.recurring,
        amount: x.unit_amount === p.amount, currency: x.currency === p.currency, product: productId === p.productId,
        interval: !!x.recurring && x.recurring.interval === p.interval && (x.recurring.interval_count || 1) === 1
      };
      const bad = Object.keys(checks).filter(k => !checks[k]);
      if (bad.length) throw fail('price_mismatch:' + bad.join(','));
    },

    // Stable key: a retry (or a second worker) gets the SAME customer back instead of creating another.
    async createCustomer(user, mode) {
      const c = await stripe.customers.create({ email: user.email, metadata: { wiz_user_id: user.id } }, { idempotencyKey: `wiz-customer-${mode}-${user.id}` });
      if (!c || !/^cus_[A-Za-z0-9]{3,64}$/.test(c.id || '')) throw fail('customer_invalid');
      return c.id;
    },

    // Created only under the owner lease and only after open sessions were listed (see service.checkout), so the idempotency key just
    // protects this one call from network retries; the identity of "the open purchase" lives at Stripe, not in memory or a time bucket.
    async createCheckout({ customerId, userId, plan }) {
      const p = needPrice(plan);
      const u = new URL(cfg.returnUrl);
      const withParam = v => { const x = new URL(u); x.searchParams.set('billing', v); return x.href; };
      const s = await stripe.checkout.sessions.create({
        mode: 'subscription', customer: customerId, client_reference_id: userId,
        line_items: [{ price: p.id, quantity: 1 }],
        success_url: withParam('success'), cancel_url: withParam('cancel'),
        metadata: { wiz_user_id: userId, wiz_price_id: p.id }, subscription_data: { metadata: { wiz_user_id: userId } }
      }, { idempotencyKey: `wiz-checkout-${crypto.randomUUID()}` });
      if (!s || typeof s.url !== 'string' || !/^https:\/\//.test(s.url)) throw fail('checkout_invalid');
      return s.url;
    },

    // Checkout sessions of this customer that can still be completed.
    async openCheckouts(customerId) {
      const out = await stripe.checkout.sessions.list({ customer: customerId, status: 'open', limit: 100 });
      return (out.data || []).filter(s => custId(s.customer) === customerId && (s.status === undefined || s.status === 'open'));
    },
    expireCheckout: id => stripe.checkout.sessions.expire(id),

    async createPortal(customerId) {
      const u = new URL(cfg.returnUrl); u.searchParams.set('billing', 'return');
      const s = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: u.href });
      if (!s || typeof s.url !== 'string' || !/^https:\/\//.test(s.url)) throw fail('portal_invalid');
      return s.url;
    },

    // Subscriptions of this customer that can still charge, whatever their price (used for purchase and erasure decisions).
    async chargeable(customerId) {
      return (await listSubscriptions(customerId, false)).filter(s => !TERMINAL.has(s.status));
    },
    cancel: id => stripe.subscriptions.cancel(id),

    // The CURRENT entitlement-relevant state of a customer, fetched from the provider. Never built from an event payload.
    async currentState(customerId) {
      if (!prices.length) throw new Error('price_not_configured');
      const approved = id => prices.find(x => x.id === id);
      // Subscriptions on ANY approved price. Two live ones (even on different approved plans) are ambiguous: never grant, never pick one.
      const ours = (await listSubscriptions(customerId, true)).filter(s => ((s.items && s.items.data) || []).some(i => i.price && approved(i.price.id)));
      const live = ours.filter(s => !TERMINAL.has(s.status));
      if (live.length > 1) return { status: 'conflict' }; // ambiguous: never silently grant
      const s = live[0] || [...ours].sort((a, b) => (b.created || 0) - (a.created || 0))[0];
      if (!s) return { status: 'none' };
      const items = s.items.data;
      const item = items[0];
      const p = item && item.price && approved(item.price.id);
      if (items.length !== 1 || !p || (item.quantity !== undefined && item.quantity !== 1)) return { status: 'conflict', subscription_id: s.id };
      const state = { subscription_id: s.id, price_id: p.id, status: KNOWN.has(s.status) ? s.status : 'conflict', cancel_at_period_end: !!s.cancel_at_period_end, paid_through: null, last_invoice_id: null };
      if (s.status === 'active') {
        // Active alone is not payment: see collectedPayment. The period end is the item-level field (the subscription-level one no longer exists).
        const inv = s.latest_invoice;
        const periodEnd = item.current_period_end;
        if (Number.isFinite(periodEnd) && periodEnd > 0 && collectedPayment(inv, { customerId, subscription: s, item, p })) {
          state.paid_through = new Date(periodEnd * 1000).toISOString();
          state.last_invoice_id = inv.id;
        }
      }
      return state;
    }
  };
}

// ---- paid gate -----------------------------------------------------------------------------------------------------------------------
// Used before coaching append/retrieval/provider work and before paid feature writes. Everything else stays available unpaid.
// Returns the verified entitlement state (including the paid price_id that selects the coaching provider), or null when the gate is off.
async function requirePaid(store, userId, config) {
  const cfg = config && config.billing;
  if (!cfg || !cfg.gate) return null;
  const s = await store.billingState(userId, cfg.mode || 'test');
  if (!s || s.entitled !== true) throw new ApiError(402, 'subscription_required', 'An active WIZ subscription is needed to use coaching. Open your account to subscribe.');
  return s;
}

// ---- service -------------------------------------------------------------------------------------------------------------------------
function createBilling({ config, store, stripe = null, logger = () => {}, now = Date.now, plans = null }) {
  const cfg = (config && config.billing) || {};
  const mode = cfg.mode;
  const adapter = stripe ? createStripeAdapter(stripe, cfg, now) : null;
  const planSvc = plans || createPlans({ config, providers: {}, store });
  const tiers = planSvc.tiers;
  const active = !!(cfg.gate || cfg.secretKey); // legacy fixtures (gate off, no key) never touch the billing tables
  const unavailable = () => e.unavailable('billing_unavailable', 'Subscriptions are not available yet.');
  const providerDown = err => {
    logger('billing_provider_error', { kind: err && err.name, code: err && err.code, type: err && err.type });
    return e.unavailable('billing_provider_unavailable', 'The payment provider could not be reached. Please try again.');
  };
  const asApi = err => (err instanceof ApiError ? err : providerDown(err));

  // Stripe's own record of a configured price must match the owner-approved values before it is offered. Cached per plan (legacy: key 'legacy').
  const priceCache = new Map();
  async function availability(plan = null) {
    const configured = tiers ? !planSvc.malformed && !!planSvc.priceFor(plan) : !!cfg.price;
    if (!adapter || !mode || !configured || !cfg.returnUrl) return { ok: false, reason: tiers && planSvc.malformed ? 'plans_misconfigured' : 'not_configured' };
    const k = plan || 'legacy', hit = priceCache.get(k);
    if (hit && now() - hit.at < (hit.ok ? 600000 : 60000)) return hit;
    let r;
    try { await adapter.verifyPrice(plan); r = { at: now(), ok: true }; } catch (err) {
      logger('billing_price_unverified', { plan: plan || undefined, reason: String((err && err.code) || (err && err.message) || 'error').slice(0, 120) });
      r = { at: now(), ok: false, reason: 'price_unverified' };
    }
    priceCache.set(k, r);
    return r;
  }

  async function release(userId, token) { try { await store.billingRelease(userId, mode || 'test', token); } catch (_) { /* the lease expires */ } }

  // Under the owner lease: expire every open Checkout session of this customer except `keepId`, then confirm none other is still completable.
  // A session that completed meanwhile cannot be expired; the caller's subscription check catches the subscription it created.
  async function expireOpen(customerId, keepId) {
    const open = (await adapter.openCheckouts(customerId)).filter(s => s.id !== keepId);
    for (const s of open) { try { await adapter.expireCheckout(s.id); } catch (_) { /* see above */ } }
    if (open.length && (await adapter.openCheckouts(customerId)).some(s => s.id !== keepId)) throw new Error('checkout_not_neutralised');
  }
  // At most ONE open, owned, current-price session exists per owner: reuse it (so hours/workers/retries cannot mint a second completable one).
  async function singleOpenCheckout(customerId, userId, priceId) {
    const usable = (await adapter.openCheckouts(customerId)).filter(s => s.mode === 'subscription' && s.client_reference_id === userId
      && s.metadata && s.metadata.wiz_price_id === priceId && typeof s.url === 'string' && s.url && Number(s.expires_at) * 1000 > now() + 5 * 60000)
      .sort((a, b) => b.expires_at - a.expires_at);
    const keep = usable[0] || null;
    await expireOpen(customerId, keep && keep.id);
    return keep ? keep.url : null;
  }

  // Lease -> fetch CURRENT provider state -> atomic commit (event + entitlement). A duplicate event returns without fetching.
  async function reconcile(userId, { eventId, eventType } = {}) {
    const lease = await store.billingLease(userId, mode, eventId, LEASE_SECONDS);
    if (lease.duplicate) return { duplicate: true };
    try {
      const state = lease.customer_id ? await adapter.currentState(lease.customer_id) : { status: 'none' };
      return await store.billingCommit(userId, mode, lease.token, eventId, eventType, state);
    } catch (err) {
      await release(userId, lease.token);
      throw asApi(err);
    }
  }

  return {
    active,
    mode,
    webhookReady: !!(adapter && cfg.webhookSecret && mode),

    async entitlement(userId) { return (await store.billingState(userId, mode || 'test')).entitled === true; },

    async status(userId) {
      const s = await store.billingState(userId, mode || 'test');
      const out = {
        gate: !!cfg.gate, mode: mode || null, entitled: s.entitled === true, status: s.status, paid_through: s.paid_through, cancel_at_period_end: s.cancel_at_period_end,
        can_manage: !!(s.bound && adapter), reconciled_at: s.reconciled_at
      };
      if (!tiers) {
        const a = await availability();
        return { ...out, purchase_available: a.ok, purchase_unavailable_reason: a.ok ? null : a.reason };
      }
      // Three plans: a safe server-owned list (label, GBP price, availability). Which plan the account holds is derived from the verified
      // paid price; an unknown price reports no plan (and coaching stays unavailable).
      const list = await planSvc.describe(userId);
      for (const p of list) {
        if (!p.ready) continue;
        const a = await availability(p.id);
        if (!a.ok) { p.ready = false; p.reason = 'not_available'; }
      }
      const held = s.entitled === true ? planSvc.planIds.find(id => planSvc.priceFor(id) === s.price_id) || null : null;
      return {
        ...out, plan: held, plans: list.map(({ ready, ...p }) => ({ ...p, available: ready })),
        purchase_available: list.some(p => p.ready), purchase_unavailable_reason: list.some(p => p.ready) ? null : planSvc.malformed ? 'plans_misconfigured' : 'not_configured'
      };
    },

    // Serialised per owner: customer binding persisted BEFORE Checkout; an existing/pending subscription refuses a second purchase.
    // Three-plan configuration: `planId` must be one of the fixed identifiers and is the ONLY browser input; the price comes from server config.
    async checkout(user, planId) {
      let plan = null;
      if (tiers) {
        if (planSvc.malformed) throw unavailable();
        await planSvc.requirePurchasable(planId, user.id); // invalid / unready / (Shared Info) no approved notice or grant: refused before anything is created
        plan = planId;
      }
      const a = await availability(plan);
      if (!a.ok) throw tiers ? e.unavailable('plan_unavailable', `${PLANS[plan].label} is not available yet.`) : unavailable();
      const priceId = tiers ? planSvc.priceFor(plan) : cfg.price.id;
      const lease = await store.billingLease(user.id, mode, null, LEASE_SECONDS);
      try {
        let customerId = lease.customer_id;
        if (!customerId) {
          customerId = await adapter.createCustomer(user, mode);
          await store.billingBind(user.id, mode, lease.token, customerId);
        }
        if ((await adapter.chargeable(customerId)).length) {
          const state = await adapter.currentState(customerId);
          await store.billingCommit(user.id, mode, lease.token, null, null, state); // keep local state truthful; releases the lease
          throw new ApiError(409, 'already_subscribed', 'You already have a subscription. Use Manage billing to change it.');
        }
        const url = (await singleOpenCheckout(customerId, user.id, priceId)) || await adapter.createCheckout({ customerId, userId: user.id, plan });
        await release(user.id, lease.token);
        return { url };
      } catch (err) {
        await release(user.id, lease.token);
        throw asApi(err);
      }
    },

    async portal(userId) {
      if (!adapter || !cfg.returnUrl || !mode) throw unavailable();
      const b = await store.billingBinding(userId, mode);
      if (!b || !b.customer_id) throw new ApiError(409, 'no_billing_account', 'There is no billing account to manage yet.');
      try { return { url: await adapter.createPortal(b.customer_id) }; } catch (err) { throw asApi(err); }
    },

    // Owner-triggered re-check against the provider (e.g. after returning from Checkout). The redirect itself is never trusted.
    async refresh(userId) {
      if (!adapter || !adapter.prices.length || !mode) throw unavailable();
      await reconcile(userId);
      return this.status(userId);
    },

    // Verified event -> owner via the persisted customer binding -> reconcile current state. Returns what the webhook route answers.
    async handleEvent(event) {
      if (!event || typeof event.id !== 'string' || !EVENT_ID_RE.test(event.id) || typeof event.type !== 'string') throw new ApiError(400, 'invalid_event', 'Invalid event.');
      if ((event.livemode === true ? 'live' : 'test') !== mode) throw new ApiError(400, 'wrong_mode', 'Event is for a different Stripe mode.');
      if (!HANDLED.has(event.type)) return { ignored: 'type' };
      const obj = (event.data && event.data.object) || {};
      const customer = typeof obj.customer === 'string' ? obj.customer : obj.customer && obj.customer.id;
      if (!customer) return { ignored: 'no_customer' };
      const userId = await store.billingOwner(mode, customer);
      if (!userId) return { ignored: 'unbound_customer' };
      if (event.type === 'checkout.session.completed' && obj.client_reference_id && obj.client_reference_id !== userId) {
        logger('billing_owner_mismatch', { event_id: event.id });
        return { ignored: 'owner_mismatch' };
      }
      const r = await reconcile(userId, { eventId: event.id, eventType: event.type });
      return r.duplicate ? { duplicate: true } : { applied: true };
    },

    // Erasure must never leave a charging subscription, or one that can still be started, behind. Runs before erasure starts and again before
    // the identity is removed, under the SAME owner lease as purchase (so checkout and erasure never interleave: the loser gets a retryable
    // billing_busy). Established subscriptions follow the owner policy: 'block' (default until the owner decides) refuses while one can still
    // charge; 'cancel' cancels it at the provider first. Uncompleted purchases are not an owner-policy matter: their open Checkout sessions
    // are expired, then the subscriptions are checked once more in case one completed during the expiry.
    async beforeErasure(userId) {
      if (!active) return;
      const lease = await store.billingLease(userId, mode || 'test', null, LEASE_SECONDS);
      try {
        const customerId = lease.customer_id;
        if (!customerId) return;
        if (!adapter) throw unavailable();
        const settle = async () => {
          const live = await adapter.chargeable(customerId);
          if (!live.length) return;
          if (cfg.erasurePolicy !== 'cancel') {
            throw new ApiError(409, 'subscription_active', 'Your subscription is still active. Cancel it with Manage billing, then request erasure again.');
          }
          for (const s of live) await adapter.cancel(s.id);
          if ((await adapter.chargeable(customerId)).length) throw new Error('still_chargeable');
        };
        await settle();
        await expireOpen(customerId, null);
        await settle();
      } catch (err) { throw asApi(err); } finally { await release(userId, lease.token); }
    },

    async exportFor(userId) { return active ? store.billingExport(userId) : null; }
  };
}

// ---- routes --------------------------------------------------------------------------------------------------------------------------
function mount({ v1, route, secure, securePending, json, wrap, billing, getStripe, getSecret }) {
  route(v1, '/billing', { GET: [...secure, wrap(async (req, res) => res.json(await billing.status(req.user.id)))] });
  route(v1, '/billing/checkout', { POST: [...secure, ...json('1kb'), wrap(async (req, res) => {
    // Legacy single price: the body is ignored. Three plans: ONLY an allowlisted plan id is read; amount/price/customer/model fields are ignored.
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    res.json(await billing.checkout(req.user, typeof b.plan === 'string' ? b.plan : undefined));
  })] });
  // reachable while an erasure is pending so a subscriber can cancel and then finish erasing
  route(v1, '/billing/portal', { POST: [...securePending, ...json('1kb'), wrap(async (req, res) => res.json(await billing.portal(req.user.id)))] });
  route(v1, '/billing/refresh', { POST: [...secure, ...json('1kb'), wrap(async (req, res) => res.json(await billing.refresh(req.user.id)))] });
  // Public by design: authenticity is the Stripe signature over the UNTOUCHED raw bytes (express.raw runs here, before any JSON parsing).
  route(v1, '/billing/webhook', { POST: [express.raw({ type: 'application/json', limit: '256kb' }), wrap(async (req, res) => {
    const stripe = getStripe(), secret = getSecret();
    if (!billing.webhookReady || !stripe || !secret) throw e.unavailable('billing_unavailable', 'Billing webhooks are not enabled.');
    const sig = req.get('stripe-signature');
    if (!sig || !Buffer.isBuffer(req.body) || !req.body.length) throw new ApiError(400, 'invalid_signature', 'Invalid webhook signature.');
    let event;
    try { event = stripe.webhooks.constructEvent(req.body, sig, secret); } catch (_) { throw new ApiError(400, 'invalid_signature', 'Invalid webhook signature.'); }
    res.json({ received: true, ...(await billing.handleEvent(event)) });
  })] });
}

module.exports = { createBilling, createBillingStore, createStripeClient, createStripeAdapter, requirePaid, mount };
