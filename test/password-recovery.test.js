'use strict';
// Password recovery / change. Real app + real Supabase-Auth adapter against the local fake GoTrue; no network, no email sent.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApi } = require('./helpers/api');
const { loadConfig } = require('../lib/config');

const REDIRECT = 'https://app.mindflowpro.com/reset-password';
const BIG = { authPerMinute: 100000, apiPerMinute: 100000, publicPerMinute: 100000, chatPerMinute: 100000 };
const errCode = r => r.json && r.json.error && r.json.error.code;
let ctx;
test.before(async () => { ctx = await startApi({ limits: BIG, env: { WIZ_PASSWORD_RESET_REDIRECT_URL: REDIRECT } }); });
test.after(async () => { await ctx.close(); });

test('reset request: generic ack for known and unknown email, adapter payload carries only the configured redirect', async () => {
  const u = await ctx.newAccount('reset');
  ctx.gotrue.state.recoveries.length = 0;
  const known = await ctx.request('POST', '/api/v1/auth/password-reset', { body: { email: u.email.toUpperCase() } });
  const unknown = await ctx.request('POST', '/api/v1/auth/password-reset', { body: { email: 'nobody-here@example.test' } });
  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.deepEqual(known.json, unknown.json);
  assert.equal(known.text.includes(u.email), false);
  assert.deepEqual(ctx.gotrue.state.recoveries, [{ email: u.email, redirect_to: REDIRECT }, { email: 'nobody-here@example.test', redirect_to: REDIRECT }]);
});

test('reset request: validation, no client redirect, service failure, rate limit', async () => {
  const post = body => ctx.request('POST', '/api/v1/auth/password-reset', { body });
  assert.equal((await post({ email: 'not-an-email' })).status, 400);
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ email: 'a@example.test', redirect_to: 'https://evil.example/' })).status, 400);
  assert.equal((await post({ email: 'a@example.test', redirectTo: 'https://evil.example/' })).status, 400);
  assert.equal(ctx.gotrue.state.recoveries.some(r => /evil/.test(r.redirect_to || '')), false);
  assert.equal((await ctx.request('GET', '/api/v1/auth/password-reset')).status, 405);

  ctx.gotrue.state.mode = 'error500';
  const down = await post({ email: 'a@example.test' });
  ctx.gotrue.state.mode = 'ok';
  assert.equal(down.status, 503);
  assert.equal(errCode(down), 'auth_unavailable');
  assert.equal(down.text.includes('boom-secret-detail'), false);

  const small = await startApi({ limits: { ...BIG, authPerMinute: 2 }, env: { WIZ_PASSWORD_RESET_REDIRECT_URL: REDIRECT } });
  try {
    const s = () => small.request('POST', '/api/v1/auth/password-reset', { body: { email: 'a@example.test' } });
    assert.equal((await s()).status, 200);
    assert.equal((await s()).status, 200);
    const limited = await s();
    assert.equal(limited.status, 429);
    assert.ok(limited.headers['retry-after']);
  } finally { await small.close(); }
});

test('redirect gate: missing/unsafe configuration fails closed with 503 and sends nothing', async () => {
  const cfg = raw => loadConfig({ WIZ_PASSWORD_RESET_REDIRECT_URL: raw, CORS_ORIGINS: 'https://app.mindflowpro.com,http://127.0.0.1:4000' }).passwordResetRedirectUrl;
  assert.equal(cfg('https://app.mindflowpro.com/reset-password'), 'https://app.mindflowpro.com/reset-password');
  assert.equal(cfg('http://127.0.0.1:4000/recover'), 'http://127.0.0.1:4000/recover');
  for (const bad of ['', 'http://app.mindflowpro.com/x', 'https://other.example/x', 'https://u:p@app.mindflowpro.com/x', 'https://app.mindflowpro.com/x#frag', 'http://127.0.0.1:4000/#', 'javascript:alert(1)', 'not a url']) {
    assert.equal(cfg(bad), null, bad);
  }
  for (const env of [{}, { WIZ_PASSWORD_RESET_REDIRECT_URL: 'https://other.example/x' }]) {
    const c = await startApi({ limits: BIG, env });
    try {
      const r = await c.request('POST', '/api/v1/auth/password-reset', { body: { email: 'a@example.test' } });
      assert.equal(r.status, 503);
      assert.equal(errCode(r), 'recovery_unavailable');
      assert.equal(c.gotrue.state.recoveries.length, 0);
    } finally { await c.close(); }
  }
});

test('password change via the recovery-link session, then sign-in with the new password', async () => {
  const u = await ctx.newAccount('change');
  await ctx.request('POST', '/api/v1/auth/password-reset', { body: { email: u.email } });
  const recovery = ctx.gotrue.state.recoveryTokens.get(u.email); // what the emailed link would carry
  const ok = await ctx.request('POST', '/api/v1/auth/password', { token: recovery, body: { password: 'a brand new passphrase' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true });
  assert.equal(ok.text.includes('raw-provider-field'), false);
  assert.equal((await ctx.request('POST', '/api/v1/auth/login', { body: { email: u.email, password: u.password } })).status, 401);
  assert.equal((await ctx.request('POST', '/api/v1/auth/login', { body: { email: u.email, password: 'a brand new passphrase' } })).status, 200);
});

test('password change: rejects missing/invalid bearer, weak and malformed passwords, same password, service failure', async () => {
  const u = await ctx.newAccount('rejects');
  const post = (token, body) => ctx.request('POST', '/api/v1/auth/password', { token, body });
  assert.equal((await post(undefined, { password: 'long enough pw' })).status, 401);
  assert.equal((await post('at_not-a-real-token', { password: 'long enough pw' })).status, 401);
  const before = ctx.gotrue.state.userUpdates.length;
  const weak = await post(u.token, { password: 'password123' });
  assert.equal(weak.status, 400);
  assert.equal(errCode(weak), 'weak_password');
  assert.equal(weak.text.includes('provider-weak-detail'), false);
  assert.equal(errCode(await post(u.token, { password: 'short' })), 'invalid_request');
  assert.equal(errCode(await post(u.token, { password: 'ninechars9'.slice(0, 9) })), 'invalid_request'); // below the 10-character minimum
  assert.equal((await post(u.token, { password: 'x'.repeat(73) })).status, 400);
  assert.equal((await post(u.token, { password: 'long enough pw', email: 'x@example.test' })).status, 400);
  assert.equal((await post(u.token, {})).status, 400);
  assert.equal(ctx.gotrue.state.userUpdates.length - before, 1); // only the weak-password call reached Supabase
  const same = await post(u.token, { password: u.password });
  assert.equal(errCode(same), 'same_password');
  assert.equal(same.text.includes('provider-same-detail'), false);

  ctx.gotrue.state.mode = 'error500';
  const down = await post(u.token, { password: 'long enough pw' });
  ctx.gotrue.state.mode = 'ok';
  assert.equal(down.status, 503);
  assert.equal(down.text.includes('boom-secret-detail'), false);
  assert.equal(JSON.stringify(ctx.logs).includes('long enough pw'), false);
});
