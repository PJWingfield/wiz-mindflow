'use strict';
// Billing harness: foundation + career + privacy + billing migrations in PGlite, the privacy API harness on top, a fake Stripe client, and the
// paid gate at its real default (ON). The consent flow is switched off here: it is exercised by consent-flow.test.js and is independent.
// Price values are a SYNTHETIC TEST FIXTURE (see fake-stripe.js), not a WIZ price.
const fs = require('node:fs');
const path = require('node:path');
const h = require('./db');
const { openPrivacyDb, startPrivacyApi } = require('./privacy-api');
const { createFakeStripe, FIXTURE_PRICE, SECRET_KEY, WEBHOOK_SECRET, event, sign } = require('./fake-stripe');

const ROOT = path.join(__dirname, '..', '..');
const BILLING_UP_SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261021120000_wiz_billing.sql'), 'utf8');
const BILLING_DOWN_SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'rollbacks', '20261021120000_wiz_billing.down.sql'), 'utf8');
const applyBillingUp = db => h.applyUp(db, BILLING_UP_SQL);
const applyBillingDown = db => h.applyUp(db, BILLING_DOWN_SQL);

const FULL_ENV = {
  STRIPE_SECRET_KEY: SECRET_KEY, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  WIZ_STRIPE_PRICE_ID: FIXTURE_PRICE.id, WIZ_STRIPE_PRODUCT_ID: FIXTURE_PRICE.productId,
  WIZ_STRIPE_PRICE_AMOUNT: String(FIXTURE_PRICE.amount), WIZ_STRIPE_PRICE_CURRENCY: FIXTURE_PRICE.currency, WIZ_STRIPE_PRICE_INTERVAL: FIXTURE_PRICE.interval,
  CORS_ORIGINS: 'http://127.0.0.1:4000', WIZ_BILLING_RETURN_URL: 'http://127.0.0.1:4000/app'
};

async function openBillingDb() {
  const db = await openPrivacyDb();
  await applyBillingUp(db);
  return db;
}

// opts.env overrides FULL_ENV (use { WIZ_STRIPE_PRICE_ID: undefined } etc. to remove a piece); opts.unconfigured = no Stripe settings at all
async function startBillingApi(opts = {}) {
  const db = opts.db || await openBillingDb();
  const fake = opts.fake || createFakeStripe();
  const env = { WIZ_CONSENT_FLOW: 'off', WIZ_BILLING_GATE: undefined, ...(opts.unconfigured ? {} : FULL_ENV), ...(opts.env || {}) };
  const ctx = await startPrivacyApi({ ...opts, db, env, stripe: opts.unconfigured ? undefined : (opts.stripe || fake) });
  const hook = (ev, o = {}) => {
    const raw = typeof o.raw === 'string' ? o.raw : JSON.stringify(ev);
    return ctx.request('POST', '/api/v1/billing/webhook', { raw, headers: { 'Content-Type': 'application/json', ...(o.noSignature ? {} : { 'Stripe-Signature': o.signature || sign(raw, o.secret) }) } });
  };
  // an adult account that has granted chat retention (the paid gate is the only thing left between it and coaching)
  async function coachable(label) {
    const u = await ctx.newAccount(label);
    const put = await ctx.as(u).put('/me/onboarding', { answers: { over_18: true }, complete: true });
    if (put.status !== 200) throw new Error('onboarding failed');
    return u;
  }
  return { ...ctx, fake, hook, coachable, event, close: async () => { await ctx.close(); if (!opts.db) await db.close(); } };
}

module.exports = { startBillingApi, openBillingDb, applyBillingUp, applyBillingDown, BILLING_UP_SQL, BILLING_DOWN_SQL, FIXTURE_PRICE, WEBHOOK_SECRET, FULL_ENV };
