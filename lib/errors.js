'use strict';
// Canonical API errors: { error: { code, message, request_id } }. Messages are fixed strings; nothing from
// users, providers or the database is ever echoed back.

class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

const e = {
  invalid: (message, fields) => new ApiError(400, 'invalid_request', message, fields ? { fields } : undefined),
  unauthorized: (code = 'unauthorized', message = 'Authentication required.') => new ApiError(401, code, message),
  forbidden: (code = 'forbidden', message = 'Not allowed.') => new ApiError(403, code, message),
  notFound: () => new ApiError(404, 'not_found', 'Not found.'),
  conflict: (code, message) => new ApiError(409, code, message),
  unavailable: (code = 'service_unavailable', message = 'Service temporarily unavailable.') => new ApiError(503, code, message)
};

// wiz:<code> raised by the database functions -> HTTP
const DB_CODES = {
  not_found: [404, 'not_found', 'Not found.'],
  consent_required: [403, 'consent_required', 'This action needs your consent first.'],
  idempotency_conflict: [409, 'idempotency_conflict', 'This Idempotency-Key was already used for a different request.'],
  idempotent_target_gone: [409, 'idempotent_target_gone', 'The record created by this request no longer exists.'],
  version_conflict: [409, 'version_conflict', 'The record changed since you loaded it.'],
  stale_consent_version: [409, 'stale_consent_version', 'A newer version of this consent is current.'],
  notice_not_approved: [409, 'notice_not_approved', 'This consent notice is not available yet, so it cannot be accepted.'],
  not_confirmed: [409, 'not_confirmed', 'Confirm this item before enabling it.'],
  unknown_purpose: [400, 'unknown_purpose', 'Unknown consent purpose.'],
  invalid_input: [400, 'invalid_request', 'Invalid request.']
};

function fromRpcError(err) {
  if (err && err.name === 'RpcError') {
    if (err.kind === 'unavailable') return e.unavailable('store_unavailable', 'Data store unavailable.');
    const m = /^wiz:([a-z_]+)$/.exec(err.message || '');
    if (m && DB_CODES[m[1]]) { const [s, c, msg] = DB_CODES[m[1]]; return new ApiError(s, c, msg); }
  }
  return new ApiError(500, 'internal_error', 'Something went wrong.');
}

module.exports = { ApiError, e, fromRpcError };
