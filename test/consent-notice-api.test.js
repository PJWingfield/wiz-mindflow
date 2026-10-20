'use strict';
// HTTP-level regression: granting consent against an unapproved notice returns 409 notice_not_approved (not 500),
// records nothing, and leaves the consent-gated write refused. Real app + fake GoTrue + PGlite; fresh isolated fixture.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startApi } = require('./helpers/api');

test('POST /consents grant on an unapproved notice -> 409 notice_not_approved, no grant, gate stays closed', async () => {
  const api = await startApi();
  try {
    const user = await api.newAccount('notice');
    const before = await api.db.query("select purpose, version, legal_approved from public.wiz_consent_versions where purpose = 'save_chats' and status = 'current'");
    assert.equal(before.rows.length, 1);
    assert.equal(before.rows[0].legal_approved, false, 'fixture notice must start unapproved');
    const version = before.rows[0].version;

    const res = await api.request('POST', '/api/v1/consents', { token: user.token, body: { purpose: 'save_chats', version, action: 'grant' } });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'notice_not_approved');
    assert.equal(res.json.error.message, 'This consent notice is not available yet, so it cannot be accepted.');

    const after = await api.db.query("select legal_approved from public.wiz_consent_versions where purpose = 'save_chats' and version = $1", [version]);
    assert.equal(after.rows[0].legal_approved, false);
    const events = await api.db.query('select count(*)::int as n from public.wiz_consent_events where user_id = $1', [user.id]);
    assert.equal(events.rows[0].n, 0);

    // The consent-gated write (save_chats) is still refused. Session creation itself is not consent-gated.
    const session = await api.request('POST', '/api/v1/sessions', { token: user.token, body: {}, headers: { 'Idempotency-Key': 'notice-session-0001' } });
    assert.equal(session.status, 201);
    const msg = await api.request('POST', `/api/v1/sessions/${session.json.item.id}/messages`, {
      token: user.token, body: { content: 'hello' }, headers: { 'Idempotency-Key': 'notice-message-0001' }
    });
    assert.equal(msg.status, 403);
    assert.equal(msg.json.error.code, 'consent_required');
  } finally {
    await api.close();
  }
});
