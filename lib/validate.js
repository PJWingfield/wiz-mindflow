'use strict';
// Strict request validation. Unknown fields are rejected (so owners, billing and provenance fields can never
// be assigned by a browser). Free text is length-bounded and screened for embedded binary/image payloads,
// because raw biofeedback and images must not be retained.
const { e } = require('./errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

function fieldName(k) { return /^[A-Za-z0-9_]{1,40}$/.test(k) ? k : '?'; }

function obj(v, what = 'body') {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw e.invalid(`${what} must be a JSON object.`);
  return v;
}

// spec: { field: (value, field) => cleaned }, required: [field...]
function parse(input, spec, required = []) {
  obj(input);
  const unknown = Object.keys(input).filter(k => !Object.prototype.hasOwnProperty.call(spec, k));
  if (unknown.length) throw e.invalid('Unknown field(s).', unknown.slice(0, 5).map(fieldName));
  const out = {};
  for (const k of required) if (input[k] === undefined) throw e.invalid(`${k} is required.`, [k]);
  for (const k of Object.keys(input)) if (input[k] !== undefined) out[k] = spec[k](input[k], k);
  return out;
}

const BLOB_RE = /data:[a-z]+\/[a-z0-9.+-]+;base64,|[A-Za-z0-9+/]{400,}={0,2}/i;
function noBlob(s, field) {
  if (BLOB_RE.test(s)) throw e.invalid(`${field} must be plain text (embedded images or binary data are not accepted).`, [field]);
  return s;
}

const text = (min, max, { trim = true, nullable = false, blobCheck = true } = {}) => (v, field) => {
  if (v === null && nullable) return null;
  if (typeof v !== 'string') throw e.invalid(`${field} must be a string.`, [field]);
  if (v.includes('\u0000')) throw e.invalid(`${field} contains invalid characters.`, [field]);
  const s = trim ? v.trim() : v;
  if (nullable && s === '') return null;
  if (s.length < min || s.length > max) throw e.invalid(`${field} must be ${min}-${max} characters.`, [field]);
  return blobCheck ? noBlob(s, field) : s;
};
const uuid = (v, field) => {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw e.invalid(`${field} must be a UUID.`, [field]);
  return v.toLowerCase();
};
const bool = (v, field) => { if (typeof v !== 'boolean') throw e.invalid(`${field} must be true or false.`, [field]); return v; };
const int = (min, max) => (v, field) => {
  if (!Number.isInteger(v) || v < min || v > max) throw e.invalid(`${field} must be an integer ${min}-${max}.`, [field]);
  return v;
};
const oneOf = list => (v, field) => {
  if (typeof v !== 'string' || !list.includes(v)) throw e.invalid(`${field} is not an accepted value.`, [field]);
  return v;
};
const pattern = (re, max) => (v, field) => {
  if (typeof v !== 'string' || v.length > max || !re.test(v)) throw e.invalid(`${field} is invalid.`, [field]);
  return v;
};
const date = (v, field) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw e.invalid(`${field} must be YYYY-MM-DD.`, [field]);
  const d = new Date(v + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw e.invalid(`${field} is not a real date.`, [field]);
  return v;
};
const nullable = fn => (v, field) => (v === null ? null : fn(v, field));

// JSON documents (checkpoints, preferences...): plain data only, bounded size and depth, no embedded blobs.
function jsonDoc(maxBytes) {
  return (v, field) => {
    obj(v, field);
    if (Buffer.byteLength(JSON.stringify(v)) > maxBytes) throw e.invalid(`${field} is too large.`, [field]);
    const walk = (x, depth) => {
      if (depth > 8) throw e.invalid(`${field} is nested too deeply.`, [field]);
      if (typeof x === 'string') noBlob(x, field);
      else if (Array.isArray(x)) x.forEach(y => walk(y, depth + 1));
      else if (x && typeof x === 'object') Object.entries(x).forEach(([k, y]) => { noBlob(k, field); walk(y, depth + 1); });
    };
    walk(v, 0);
    return v;
  };
}

function email(v, field = 'email') {
  if (typeof v !== 'string' || v.length > 254 || !EMAIL_RE.test(v.trim())) throw e.invalid('A valid email address is required.', [field]);
  return v.trim().toLowerCase();
}
function password(v, field = 'password') {
  if (typeof v !== 'string' || v.length < 10 || v.length > 72) throw e.invalid('Password must be 10-72 characters.', [field]);
  return v;
}

function idempotencyKey(req, { required = false } = {}) {
  const raw = req.get('idempotency-key');
  if (raw === undefined) {
    if (required) throw e.invalid('Idempotency-Key header is required.', ['Idempotency-Key']);
    return null;
  }
  if (!KEY_RE.test(raw)) throw e.invalid('Idempotency-Key must be 8-128 characters of A-Z a-z 0-9 _ . : -', ['Idempotency-Key']);
  return raw;
}

function pageLimit(req, def = 20, max = 100) {
  const raw = req.query.limit;
  if (raw === undefined) return def;
  if (typeof raw !== 'string' || !/^\d{1,4}$/.test(raw) || +raw < 1 || +raw > max) throw e.invalid(`limit must be 1-${max}.`, ['limit']);
  return +raw;
}
function encodeCursor(next) { return next ? Buffer.from(JSON.stringify(next)).toString('base64url') : null; }
function decodeCursor(req) {
  const raw = req.query.cursor;
  if (raw === undefined) return { ts: null, id: null };
  try {
    if (typeof raw !== 'string' || raw.length > 200) throw new Error('bad');
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof c.ts !== 'string' || Number.isNaN(Date.parse(c.ts)) || !UUID_RE.test(c.id)) throw new Error('bad');
    return { ts: c.ts, id: c.id };
  } catch (_) { throw e.invalid('cursor is invalid.', ['cursor']); }
}

module.exports = { parse, obj, text, uuid, bool, int, oneOf, pattern, date, nullable, jsonDoc, email, password, idempotencyKey, pageLimit, encodeCursor, decodeCursor, UUID_RE, noBlob };
