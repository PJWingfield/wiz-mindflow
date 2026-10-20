'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fromRpcError } = require('../lib/errors');
const { RpcError } = require('../lib/rpc');

test('unapproved consent notice maps to a stable 409 with a fixed message', () => {
  const r = fromRpcError(new RpcError('db', 'wiz:notice_not_approved'));
  assert.equal(r.status, 409);
  assert.equal(r.code, 'notice_not_approved');
  assert.equal(r.message, 'This consent notice is not available yet, so it cannot be accepted.');
  assert.doesNotMatch(r.message, /legal|approved|wiz:/i);
});

test('existing mappings are unchanged', () => {
  const c = fromRpcError(new RpcError('db', 'wiz:consent_required'));
  assert.deepEqual([c.status, c.code], [403, 'consent_required']);
  const u = fromRpcError(new RpcError('unavailable', 'timeout'));
  assert.deepEqual([u.status, u.code, u.message], [503, 'store_unavailable', 'Data store unavailable.']);
});

test('unknown database errors stay generic 500 and leak nothing', () => {
  for (const msg of ['wiz:something_new', 'relation "kb_chunks" does not exist', 'wiz:notice_not_approved; drop table x']) {
    const r = fromRpcError(new RpcError('db', msg));
    assert.deepEqual([r.status, r.code, r.message], [500, 'internal_error', 'Something went wrong.']);
  }
});
