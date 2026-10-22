'use strict';
// Local-only diagnostic for the hosted first goal-save timeout. The real merged HTML is served by the real app;
// auth, PGlite, and billing are synthetic fixtures. No providers or external browser requests are allowed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const flow = require('./helpers/flow-api');
const billing = require('./helpers/billing-api');
const { createFakeStripe } = require('./helpers/fake-stripe');

test('local diagnostic: paid synthetic account saves goal, journal and training with relogin readback', async t => {
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
    const u = await ctx.newAccount('local-records-diagnostic');
    const onboarded = await ctx.as(u).put('/me/onboarding', { answers: { over_18: true }, complete: true });
    assert.equal(onboarded.status, 200, 'synthetic account onboarding is ready');

    // Use the existing local fake Stripe surface to establish the paid gate without changing app code or making network calls.
    const checkout = await ctx.as(u).post('/billing/checkout', {});
    assert.equal(checkout.status, 200, 'local fake billing checkout is configured');
    const session = fake.openSessions().find(x => x.client_reference_id === u.id);
    assert.ok(session, 'one local synthetic Checkout session belongs to this user');
    fake.completeCheckout(session.id);
    const refresh = await ctx.as(u).post('/billing/refresh', {});
    assert.equal(refresh.status, 200, 'local fake billing subscription refresh succeeds');
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
    await page.goto(origin + '/');
    await page.click('#openAccBtn');
    await page.fill('#wizEmail', u.email);
    await page.fill('#wizPassword', u.password);
    await page.click('#wizLoginBtn');
    await page.waitForSelector('#wizAuthOverlay', { state: 'hidden', timeout: 15000 });
    await page.click('#openAccBtn');
    await page.waitForSelector('#wizAccountModal', { state: 'visible', timeout: 15000 });
    await page.locator('#wizGoals form [name="title"]').fill('Local diagnostic goal');

    const priorStatus = await page.locator('#wizAccountStatus').innerText().catch(() => '');
    const responsePromise = page.waitForResponse(r => {
      try { return r.request().method() === 'POST' && new URL(r.url()).origin === origin && new URL(r.url()).pathname === '/api/v1/goals'; }
      catch (_) { return false; }
    }, { timeout: 6000 }).catch(() => null);
    await page.locator('#wizGoals form').getByRole('button', { name: 'Add record' }).click();
    const response = await responsePromise;
    const payload = response ? await response.json().catch(() => null) : null;
    const errorCode = payload?.error?.code;
    const goalResponse = { requestObserved: !!response, status: response ? response.status() : null, errorCode: typeof errorCode === 'string' && /^[a-z_]{3,70}$/.test(errorCode) ? errorCode : null };
    await page.waitForFunction(({ title, previous }) => {
      const status = document.getElementById('wizAccountStatus')?.textContent || '';
      const row = [...document.querySelectorAll('#wizGoals .record-row')].some(x => x.textContent.includes(title));
      const explicitError = /error|failed|something went wrong|subscription|consent|required|unavailable/i.test(status)
        && status !== previous && !/saving|loading|account loaded/i.test(status);
      return row || explicitError;
    }, { title: 'Local diagnostic goal', previous: priorStatus }, { timeout: 10000 }).catch(() => {});
    const visible = await page.locator('#wizAccountStatus').innerText().catch(() => '');
    const rowVisible = await page.locator('#wizGoals .record-row').filter({ hasText: 'Local diagnostic goal' }).isVisible().catch(() => false);
    const dbRows = (await ctx.db.query("select count(*)::int n from public.wiz_goals where user_id = $1 and title = $2", [u.id, 'Local diagnostic goal'])).rows[0].n;
    const diagnostic = { goalResponse, uiStatusExact: visible.slice(0, 200), dbGoalRows: dbRows, goalRowVisible: rowVisible,
      providerCalls: ctx.providerCalls.length, externalOriginsBlocked: [...externalAttempts].sort(),
      continuedOriginsLocalOnly: continuedOrigins.every(x => x === origin || x === 'data:' || x === 'blob:') };
    console.log('LOCAL_GOAL_SAVE_DIAGNOSTIC ' + JSON.stringify(diagnostic));
    if (goalResponse.status !== 201 || dbRows !== 1 || !rowVisible || visible !== 'Record saved.') {
      const evidence = path.resolve(__dirname, '..', '..', '..', 'reviewer-orchestrator', 'runs', '2026-10-22-merged-stage', 'LOCAL-GOAL-SAVE-DIAGNOSTIC-R2.png');
      await page.screenshot({ path: evidence, fullPage: true, timeout: 5000 }).catch(() => {});
    }
    assert.equal(continuedOrigins.every(x => x === origin || x === 'data:' || x === 'blob:'), true, 'every continued browser request was loopback/data/blob');
    assert.equal(ctx.providerCalls.length, 0, 'this journey does not invoke a provider');
    assert.equal(goalResponse.status, 201, 'the first goal save should succeed under the synthetic paid fixture');
    assert.equal(dbRows, 1, 'the synthetic goal row exists in local PGlite');
    assert.equal(rowVisible, true, 'the saved goal row appears in the account UI');
    assert.equal(visible, 'Record saved.', 'account UI reports the first goal save');

    // Only extend the diagnostic to other records if the first goal save succeeds.
    await page.locator('#wizJournal form [name="body"]').fill('Local diagnostic journal entry');
    const journalResponse = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).origin === origin && new URL(r.url()).pathname === '/api/v1/journal');
    await page.locator('#wizJournal form').getByRole('button', { name: 'Add record' }).click();
    assert.equal((await journalResponse).status(), 201);
    await page.locator('#wizJournal .record-row').filter({ hasText: 'Local diagnostic journal entry' }).waitFor({ state: 'visible' });
    await page.fill('#wizTrainingKey', 'local-diagnostic-training');
    await page.locator('#wizTrainingStatus').selectOption('in_progress');
    await page.fill('#wizTrainingPercent', '25');
    const trainingResponse = page.waitForResponse(r => r.request().method() === 'PUT' && new URL(r.url()).origin === origin && new URL(r.url()).pathname === '/api/v1/training/local-diagnostic-training');
    await page.click('#wizSaveTrainingBtn');
    assert.equal((await trainingResponse).status(), 200);
    await page.locator('#wizTrainingList').getByText(/local-diagnostic-training: in_progress \(25%\)/).waitFor({ state: 'visible' });

    // The modal is open: sign out, reload to a clean page, and sign back into the same synthetic account.
    await page.click('#wizLogoutBtn');
    await page.waitForSelector('#wizAuthOverlay', { state: 'visible', timeout: 10000 });
    await page.reload();
    await page.click('#openAccBtn');
    await page.fill('#wizEmail', u.email);
    await page.fill('#wizPassword', u.password);
    await page.click('#wizLoginBtn');
    await page.waitForSelector('#wizAuthOverlay', { state: 'hidden', timeout: 15000 });
    await page.click('#openAccBtn');
    await page.waitForSelector('#wizAccountModal', { state: 'visible', timeout: 15000 });
    await page.locator('#wizGoals .record-row').filter({ hasText: 'Local diagnostic goal' }).waitFor({ state: 'visible' });
    await page.locator('#wizJournal .record-row').filter({ hasText: 'Local diagnostic journal entry' }).waitFor({ state: 'visible' });
    await page.locator('#wizTrainingList').getByText(/local-diagnostic-training: in_progress \(25%\)/).waitFor({ state: 'visible' });
    assert.equal(ctx.providerCalls.length, 0);
    console.log('LOCAL_ACCOUNT_RECORDS_READBACK ' + JSON.stringify({ goal: true, journal: true, training: true, providerCalls: 0,
      externalOriginsBlocked: [...externalAttempts].sort(), allContinuedRequestsLocal: continuedOrigins.every(x => x === origin || x === 'data:' || x === 'blob:') }));
  } finally {
    if (browser) await browser.close();
    if (ctx) await ctx.close();
    if (db) await db.close();
  }
});
