'use strict';
// Local-only browser journey for career persistence. The real merged HTML is served by the real app; auth, PGlite and billing are
// synthetic fixtures (paid gate stays ON). The career_records grant is made by the user through the account consent checkbox.
// No providers and no external browser requests are allowed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const flow = require('./helpers/flow-api');
const billing = require('./helpers/billing-api');
const { createFakeStripe } = require('./helpers/fake-stripe');

test('local browser: consent UI grant, career plan and learning profile survive sign-out and relogin', async t => {
  let browser, ctx, db;
  try { browser = await require('playwright').chromium.launch(); }
  catch (err) { return t.skip('Chromium unavailable: ' + String(err.message).split('\n')[0]); }
  const fake = createFakeStripe();
  const externalAttempts = new Set();
  const continuedOrigins = [];
  try {
    db = await flow.openFlowDb();
    await billing.applyBillingUp(db);
    ctx = await flow.startFlowApi({ db, stripe: fake, env: { ...billing.FULL_ENV, WIZ_BILLING_GATE: 'on', WIZ_CONSENT_FLOW: 'on' } });
    const u = await ctx.newAccount('local-career-records');
    const onboarded = await ctx.as(u).put('/me/onboarding', { answers: { over_18: true }, complete: true });
    assert.equal(onboarded.status, 200, 'synthetic account onboarding is ready');

    // Establish the paid gate through the existing local fake Stripe surface (no network, no gate bypass).
    const checkout = await ctx.as(u).post('/billing/checkout', {});
    assert.equal(checkout.status, 200, 'local fake billing checkout is configured');
    const session = fake.openSessions().find(x => x.client_reference_id === u.id);
    assert.ok(session, 'one local synthetic Checkout session belongs to this user');
    fake.completeCheckout(session.id);
    assert.equal((await ctx.as(u).post('/billing/refresh', {})).status, 200, 'local fake billing subscription refresh succeeds');
    const entitlement = (await ctx.db.query('select status from public.wiz_billing_entitlements where user_id = $1', [u.id])).rows[0];
    assert.equal(entitlement?.status, 'active', 'synthetic local paid gate is active');

    const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
    const origin = `http://127.0.0.1:${ctx.port}`;
    await page.route('**/*', route => {
      let url;
      try { url = new URL(route.request().url()); } catch (_) { return route.abort(); }
      if (url.protocol === 'data:' || url.protocol === 'blob:' || url.origin === origin) { continuedOrigins.push(url.protocol === 'data:' || url.protocol === 'blob:' ? url.protocol : url.origin); return route.continue(); }
      externalAttempts.add(url.origin);
      return route.abort();
    });
    const signIn = async () => {
      await page.click('#openAccBtn');
      await page.fill('#wizEmail', u.email);
      await page.fill('#wizPassword', u.password);
      await page.click('#wizLoginBtn');
      await page.waitForSelector('#wizAuthOverlay', { state: 'hidden', timeout: 15000 });
      await page.click('#openAccBtn');
      await page.waitForSelector('#wizAccountModal', { state: 'visible', timeout: 15000 });
      await page.waitForFunction(() => document.getElementById('wizAccountStatus')?.textContent?.trim() === 'Account loaded.', null, { timeout: 15000 });
      const loadedStatus = await page.locator('#wizAccountStatus').innerText();
      assert.equal(loadedStatus, 'Account loaded.', 'account history and profile have finished hydrating');
    };
    await page.goto(origin + '/');
    await signIn();

    // The currently published career_records notice is rendered by the account consent UI and is approved (grant is enabled).
    const row = page.locator('#wizConsents .record-row').filter({ has: page.locator('#consent-career_records') });
    await row.waitFor({ state: 'visible', timeout: 15000 });
    const noticeText = await row.locator('p').innerText();
    assert.match(noticeText, /^career records — version 2: /, 'the current published career_records notice is shown');
    assert.match(noticeText, /\(Available\)$/, 'the notice is approved and available');
    const box = page.locator('#consent-career_records');
    assert.equal(await box.isEnabled(), true, 'an approved notice can be granted by the user');
    assert.equal(await box.isChecked(), false, 'no grant exists before the user acts');

    const grantResponse = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).origin === origin && new URL(r.url()).pathname === '/api/v1/consents');
    await box.check();
    assert.equal((await grantResponse).status(), 200, 'the consent UI grant is accepted');
    await page.waitForFunction(() => {
      const el = document.getElementById('consent-career_records');
      const status = document.getElementById('wizAccountStatus')?.textContent?.trim();
      return !!el && el.checked && !el.disabled && status === 'Privacy choice saved.';
    }, null, { timeout: 10000 });
    assert.equal(await page.locator('#consent-career_records').isChecked(), true, 'the UI shows the career_records grant');
    assert.equal(await page.locator('#wizAccountStatus').innerText(), 'Privacy choice saved.');

    // Save a minimal career plan and learning profile through the existing forms.
    await page.fill('#wizDirection', 'Local career direction');
    await page.fill('#wizValues', 'Autonomy\nCuriosity');
    const planResponse = page.waitForResponse(r => r.request().method() === 'PUT' && new URL(r.url()).origin === origin && new URL(r.url()).pathname === '/api/v1/career-plan');
    await page.click('#wizSaveCareerBtn');
    assert.equal((await planResponse).status(), 200, 'career plan save succeeds');
    await page.waitForFunction(() => document.getElementById('wizAccountStatus').textContent === 'Saved.', null, { timeout: 10000 });
    const planReadback = await ctx.as(u).get('/career-plan');
    const planReadbackOk = planReadback.status === 200
      && planReadback.json?.item?.plan?.direction === 'Local career direction'
      && JSON.stringify(planReadback.json?.item?.plan?.values) === JSON.stringify(['Autonomy', 'Curiosity']);
    if (!planReadbackOk) console.log('CAREER_PLAN_API_READBACK ' + JSON.stringify({ ok: false }));
    assert.equal(planReadbackOk, true, 'saved career plan is present in the read-only API response');

    await page.fill('#wizLearningStyles', 'Visual\nPractical');
    await page.fill('#wizLearningFocus', 'Local learning focus');
    await page.fill('#wizAdjustments', 'Local adjustment');
    await page.fill('#wizRecognition', 'Local recognition');
    const learningResponse = page.waitForResponse(r => r.request().method() === 'PUT' && new URL(r.url()).origin === origin && new URL(r.url()).pathname === '/api/v1/learning-profile');
    await page.click('#wizSaveLearningBtn');
    assert.equal((await learningResponse).status(), 200, 'learning profile save succeeds');
    await page.waitForFunction(() => document.getElementById('wizAccountStatus').textContent === 'Saved.', null, { timeout: 10000 });
    const learningReadback = await ctx.as(u).get('/learning-profile');
    const learningReadbackOk = learningReadback.status === 200
      && JSON.stringify(learningReadback.json?.item?.profile?.learning_styles) === JSON.stringify(['Visual', 'Practical'])
      && learningReadback.json?.item?.profile?.focus_notes === 'Local learning focus'
      && learningReadback.json?.item?.profile?.useful_adjustments === 'Local adjustment'
      && learningReadback.json?.item?.profile?.self_recognition === 'Local recognition';
    if (!learningReadbackOk) console.log('LEARNING_PROFILE_API_READBACK ' + JSON.stringify({ ok: false }));
    assert.equal(learningReadbackOk, true, 'saved learning profile is present in the read-only API response');

    // Sign out, reload to a clean page and sign back into the same synthetic account.
    await page.click('#wizLogoutBtn');
    await page.waitForSelector('#wizAuthOverlay', { state: 'visible', timeout: 10000 });
    await page.reload();
    await signIn();

    const expectValue = (selector, expected) => page.waitForFunction(([s, v]) => document.querySelector(s)?.value === v, [selector, expected], { timeout: 15000 });
    await expectValue('#wizDirection', 'Local career direction');
    await expectValue('#wizValues', 'Autonomy\nCuriosity');
    await expectValue('#wizLearningStyles', 'Visual\nPractical');
    await expectValue('#wizLearningFocus', 'Local learning focus');
    await expectValue('#wizAdjustments', 'Local adjustment');
    await expectValue('#wizRecognition', 'Local recognition');
    assert.equal(await page.locator('#consent-career_records').isChecked(), true, 'the grant persists after relogin');

    assert.equal(ctx.providerCalls.length, 0, 'this journey does not invoke a provider');
    assert.deepEqual(continuedOrigins.filter(x => x !== origin && x !== 'data:' && x !== 'blob:'), [], 'no external request was continued');
  } finally {
    if (browser) await browser.close();
    if (ctx) await ctx.close();
    if (db) await db.close();
  }
});
