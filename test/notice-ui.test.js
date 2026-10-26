'use strict';
// Account-settings display of the exact notices. Static checks always run; the browser check drives the real index.html in Chromium
// (Playwright, already a devDependency) against a stubbed /api/v1 and is skipped, with the reason shown, when no browser is available.
// Synthetic notice text only; nothing here contacts a real service.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const ORIGIN = 'http://wiz.test';
const PRIVACY = '/api/v1/notices/privacy-2026-10-24-v2';
const TERMS = '/api/v1/notices/terms-2026-10-24-v2';
const INJECTION = '<img src=x onerror="window.__pwn=1"><script>window.__pwn=1</script>&amp; **not bold**';
const body = label => `${label} synthetic paragraph one\n\n${label} paragraph two ${INJECTION}\n` + Array.from({ length: 150 }, (_, i) => `${label} line ${i}`).join('\n');
const doc = (id, kind, label) => ({ notice: { id, kind, content_type: 'text/plain; charset=utf-8', sha256: 'a'.repeat(64), bytes: 1, text: body(label), approval: { basis: 'owner_instruction', instructed_on: '2026-10-19', independent_legal_approval: false } } });

test('notice UI (static): fixed catalogue ids, text-only rendering, no acceptance or consent calls, no internal sources', () => {
  assert.ok(INDEX.includes("'/notices/' + n.id") && INDEX.includes('privacy-2026-10-24-v2') && INDEX.includes('terms-2026-10-24-v2'));
  const start = INDEX.indexOf('async function showNotice');
  const fn = INDEX.slice(start, INDEX.indexOf('function wireNotice', start)); // the reader itself; the consent dialog that reuses it follows
  assert.ok(fn.length > 100 && !/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(fn), 'notice text is set with textContent only');
  assert.ok(!/'POST'|'PUT'|'PATCH'|'DELETE'/.test(fn), 'the reader is read-only');
  assert.ok(!INDEX.includes('approved-sources'));
});

test('notice UI (browser): exact endpoint, safe rendering, failures, retry and return; mobile and desktop', async t => {
  let browser;
  try { browser = await require('playwright').chromium.launch(); } catch (err) { return t.skip('Chromium unavailable: ' + String(err.message).split('\n')[0]); }
  try {
    for (const viewportCase of [{ name: 'mobile 390x800', width: 390, height: 800 }, { name: 'desktop 1365x900', width: 1365, height: 900 }]) {
      await t.test(viewportCase.name, async () => {
    const context = await browser.newContext({ viewport: { width: viewportCase.width, height: viewportCase.height } });
    await context.addInitScript(() => { localStorage.setItem('wiz_access_token', 'fixture-token'); localStorage.setItem('wiz_refresh_token', 'fixture-refresh'); });
    const calls = [];
    const state = { failTerms: false };
    const json = (route, status, data) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    await context.route('**/*', route => {
      const u = new URL(route.request().url());
      if (u.origin !== ORIGIN) return route.abort();
      if (u.pathname === '/' || u.pathname === '/index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: INDEX });
      if (!u.pathname.startsWith('/api/v1/')) return route.fulfill({ status: 404, body: '' });
      calls.push(route.request().method() + ' ' + u.pathname);
      const p = u.pathname.slice('/api/v1'.length);
      if (p === '/notices/privacy-2026-10-24-v2') return json(route, 200, doc('privacy-2026-10-24-v2', 'privacy', 'PRIVACY'));
      if (p === '/notices/terms-2026-10-24-v2') {
        return state.failTerms ? json(route, 503, { error: { code: 'notice_unavailable', message: 'This notice is temporarily unavailable.' } }) : json(route, 200, doc('terms-2026-10-24-v2', 'terms', 'TERMS'));
      }
      if (p === '/me') return json(route, 200, { user: { id: 'u1', email: 'fixture@example.test', full_name: 'Fixture' }, profile: { preferences: {} } });
      if (p === '/me/onboarding') return json(route, 200, { answers: { over_18: true }, version: 1, completed_at: '2026-10-19T00:00:00Z' });
      if (p === '/consents') return json(route, 200, { purposes: [] });
      if (p === '/career-plan' || p === '/learning-profile') return json(route, 200, { item: null });
      if (p === '/pulses/trend') return json(route, 200, { trend: { stress: { direction: 'flat' }, energy: { direction: 'flat' } } });
      if (p === '/career/research') return json(route, 200, {});
      return json(route, 200, { items: [], next_cursor: null });
    });
    const page = await context.newPage();
    await page.goto(ORIGIN + '/');
    await page.click('#openAccBtn');
    await page.waitForSelector('#wizAccountModal', { state: 'visible' });
    await page.waitForFunction(() => { const s = document.getElementById('wizAccountStatus').textContent; return s && s !== 'Loading…'; });

    // labelled controls in existing settings; viewer hidden until asked
    assert.equal(await page.textContent('#wizPrivacyNoticeBtn'), 'Privacy notice');
    assert.equal(await page.textContent('#wizTermsNoticeBtn'), 'Terms');
    assert.equal(await page.isHidden('#wizNoticeView'), true);

    // privacy: exact endpoint, identified, text-only, scrolls inside the dialog
    calls.length = 0;
    await page.click('#wizPrivacyNoticeBtn');
    await page.waitForFunction(() => document.getElementById('wizNoticeText').textContent.startsWith('PRIVACY'), { timeout: 5000 });
    assert.deepEqual(calls.filter(c => c.includes('/notices')), ['GET ' + PRIVACY]);
    assert.equal(await page.textContent('#wizNoticeTitle'), 'Privacy Notice');
    const meta = await page.textContent('#wizNoticeMeta');
    assert.equal(meta, 'Privacy Notice · 24 October 2026');
    assert.ok(!/privacy-2026-10-24-v2|[a-f0-9]{64}|approval|owner_instruction/i.test(meta), 'internal metadata is not displayed');
    assert.equal(await page.textContent('#wizNoticeText'), body('PRIVACY'), 'text rendered exactly, as text');
    assert.equal(await page.locator('#wizNoticeText img, #wizNoticeText script').count(), 0, 'no HTML injected');
    assert.equal(await page.evaluate(() => window.__pwn), undefined, 'payload never executed');
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('wizNoticeText')).whiteSpace), 'pre-wrap', 'paragraphs preserved');
    const m = await page.evaluate(() => { const e = document.getElementById('wizNoticeText'); const r = e.getBoundingClientRect(); return { sh: e.scrollHeight, ch: e.clientHeight, right: r.right, vw: innerWidth, vh: innerHeight }; });
    assert.ok(m.sh > m.ch && m.ch <= m.vh * 0.6, 'long text scrolls within the viewer');
    assert.ok(m.right <= m.vw, 'fits the viewport width'); //its );

    // terms: its own exact endpoint
    await page.click('#wizTermsNoticeBtn');
    await page.waitForFunction(() => document.getElementById('wizNoticeText').textContent.startsWith('TERMS'));
    assert.deepEqual(calls.filter(c => c.includes('/notices')), ['GET ' + PRIVACY, 'GET ' + TERMS]);
    assert.equal(await page.textContent('#wizNoticeTitle'), 'Terms of Service');
    const evidenceDir = process.env.WIZ_NOTICE_UI_EVIDENCE_DIR;
    if (evidenceDir) await page.screenshot({ path: path.join(evidenceDir, 'notice-ui-' + (viewportCase.width < 600 ? 'mobile' : 'desktop') + '.png'), fullPage: true });

    // failure: previous document is cleared, requested title stays, honest message, no substitute text, recoverable
    state.failTerms = true;
    await page.click('#wizPrivacyNoticeBtn');
    await page.waitForFunction(() => document.getElementById('wizNoticeText').textContent.startsWith('PRIVACY'), { timeout: 5000 });
    await page.click('#wizTermsNoticeBtn');
    await page.waitForFunction(() => document.getElementById('wizNoticeMeta').textContent.includes('could not be loaded'));
    assert.equal(await page.textContent('#wizNoticeTitle'), 'Terms of Service');
    assert.equal(await page.textContent('#wizNoticeText'), '', 'no previous or synthetic document under the requested title');
    const failMeta = await page.textContent('#wizNoticeMeta');
    assert.ok(failMeta.includes('Terms of Service') && failMeta.includes('temporarily unavailable'));
    assert.ok(!/[A-Za-z]:\\|\.txt|\/notices\/|approved-sources/.test(failMeta), 'no path leaked');
    assert.equal(await page.isVisible('#wizNoticeRetry'), true);
    state.failTerms = false;
    await page.click('#wizNoticeRetry');
    await page.waitForFunction(() => document.getElementById('wizNoticeText').textContent.startsWith('TERMS'));
    assert.equal(await page.isHidden('#wizNoticeRetry'), true);

    // back to settings: viewer closed, account dialog still open and usable, focus returns to the opener
    await page.click('#wizNoticeBack');
    assert.equal(await page.isHidden('#wizNoticeView'), true);
    assert.equal(await page.isVisible('#wizAccountModal'), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'wizTermsNoticeBtn', 'focus returns to the control that opened the document');
    assert.equal(await page.isVisible('#wizPrivacyNoticeBtn'), true);
    await page.click('#wizPrivacyNoticeBtn');
    await page.waitForFunction(() => document.getElementById('wizNoticeText').textContent.startsWith('PRIVACY'), { timeout: 5000 });
    await page.click('#wizCloseAccountBtn');
    assert.equal(await page.isHidden('#wizAccountModal'), true);
    await page.click('#openAccBtn');
    assert.equal(await page.isHidden('#wizNoticeView'), true, 'reopened settings start without a stale document');

    // reading notices is read-only: only GETs, nothing to consent or terms-acceptance endpoints
    assert.ok(!calls.some(c => /^(POST|PUT|PATCH|DELETE) /.test(c) && /notices|terms|consents/.test(c)), calls.join('\n'));
    assert.ok(!calls.some(c => c.includes('/api/v1/terms')), 'no terms or terms-acceptance call');
    await context.close();
      });
    }
  } finally { await browser.close(); }
});
