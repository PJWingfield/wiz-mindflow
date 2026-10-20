'use strict';
// First-use browser proof against the REAL stack (index.html served by the app, fake GoTrue, PGlite with every migration, enforcement at its
// default ON): a new person signs up with the Terms, is asked the health choice and for chat retention explicitly (nothing pre-ticked),
// and actually receives the first reply. Needs Chromium (Playwright is already a devDependency); skipped with the reason otherwise.
// Run:  node --test test/first-use-ui.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const f = require('./helpers/flow-api');

test('first use: sign up with Terms, explicit health + retention choices, first reply arrives', async t => {
  let browser;
  try { browser = await require('playwright').chromium.launch(); } catch (err) { return t.skip('Chromium unavailable: ' + String(err.message).split('\n')[0]); }
  const ctx = await f.startFlowApi();
  try {
    const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
    await page.goto(`http://127.0.0.1:${ctx.port}/`);

    // sign-up form: the Terms are readable and the acceptance is a separate, UNTICKED box that is enforced
    await page.click('#openAccBtn');
    await page.waitForSelector('#wizSignupTermsBox', { state: 'visible', timeout: 15000 });
    assert.equal(await page.isChecked('#wizSignupTerms'), false);
    await page.fill('#wizEmail', 'first.use@example.test');
    await page.fill('#wizPassword', 'correct horse battery');
    await page.check('#wizSignupAdult');
    await page.click('#wizSignupBtn');
    await page.waitForFunction(() => /Terms/.test(document.getElementById('wizAuthError').textContent));
    assert.equal(ctx.gotrue.users.size, 0, 'no account without accepting the Terms');
    await page.click('#wizAuthTermsBtn');
    await page.waitForFunction(() => document.getElementById('wizAuthNoticeText').textContent.includes('WIZ Terms of Service'));
    await page.click('#wizAuthNoticeBack');
    await page.check('#wizSignupTerms');
    await page.click('#wizSignupBtn');

    // skip the optional onboarding if it opens, then send the first message
    await page.locator('#wizOnbSkip').click({ timeout: 8000 }).catch(() => {});
    await page.waitForSelector('#wizAuthOverlay', { state: 'hidden', timeout: 15000 });
    await page.fill('#userInput', 'Hello, this is my first message');
    await page.click('#sendBtn');

    // the dialog: Terms already accepted at sign-up; health and retention are separate and unticked, their buttons disabled until ticked
    await page.waitForSelector('#wizGate', { state: 'visible', timeout: 20000 });
    assert.equal(await page.isHidden('#wizGateTerms'), true);
    assert.equal(await page.isVisible('#wizGateHealth'), true);
    assert.equal(await page.isVisible('#wizGateSave'), true);
    assert.equal(await page.isChecked('#wizGateHealthAllow'), false);
    assert.equal(await page.isChecked('#wizGateSaveAllow'), false);
    assert.equal(await page.isDisabled('#wizGateHealthYes'), true);
    assert.equal(await page.isDisabled('#wizGateSaveYes'), true);
    assert.match(await page.textContent('#wizGateSave'), /cannot chat without saving/);
    assert.deepEqual((await ctx.db.query('select purpose from public.wiz_consent_events')).rows, [], 'nothing was granted for them');

    await page.click('#wizGateHealthNo'); // continue without sharing = a recorded decline
    await page.waitForSelector('#wizGateHealth', { state: 'hidden' });
    assert.equal(await page.isVisible('#wizGate'), true, 'retention is still to be decided');
    await page.check('#wizGateSaveAllow');
    await page.click('#wizGateSaveYes');
    await page.waitForSelector('#wizGate', { state: 'hidden', timeout: 15000 });

    // the first chat actually completes and its reply is shown
    await page.waitForFunction(() => document.getElementById('messages').textContent.includes('fake reply'), null, { timeout: 30000 });
    assert.equal(ctx.providerCalls.length, 1);
    assert.equal(await page.isVisible('#wizGeneralNotice'), true, 'the general-coaching note stays beside the composer after a decline');
    const events = (await ctx.db.query('select purpose, version, action from public.wiz_consent_events order by seq')).rows;
    assert.deepEqual(events.map(e => `${e.purpose}:${e.version}:${e.action}`), ['health_processing:1:revoke', 'save_chats:2:grant'], 'only what they chose; no personalisation');
    assert.equal((await ctx.db.query('select count(*)::int n from public.wiz_terms_acceptances')).rows[0].n, 1);
    assert.equal((await ctx.db.query('select count(*)::int n from public.messages')).rows[0].n, 2, 'the exchange is retained');
  } finally { await browser.close(); await ctx.close(); }
});
