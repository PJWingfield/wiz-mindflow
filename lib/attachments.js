'use strict';
// Portfolio attachments: metadata in the database (wiz_attachments), bytes in a PRIVATE storage bucket reached only
// through an injected transport { put(key, buffer, contentType), get(key) -> Buffer|null, delete(key) }.
//   * keys are chosen by the database (u/<owner id>/<attachment id>), never by the client, and are re-checked against the
//     verified owner before every storage call
//   * no public bucket, no signed/public URL, no client-supplied URL: downloads are proxied after an ownership check
//   * type allow-list + size cap + magic-byte check + digest recorded at finalisation; downloads re-verify the digest
//   * deleting is mark -> remove object -> delete row; a failed removal stays visible (state delete_failed) and retryable
// The Supabase Storage adapter below is NOT live-verified (no storage call is made in this stage); tests use the in-memory
// transport in test/helpers/memory-storage.js.
const crypto = require('node:crypto');
const { ApiError } = require('./errors');

const MAX_BYTES = 5 * 1024 * 1024;
const KEY_RE = /^u\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const startsWith = (buf, bytes) => buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b);
const TYPES = {
  'application/pdf': buf => startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d]),
  'image/png': buf => startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': buf => startsWith(buf, [0xff, 0xd8, 0xff]),
  'image/webp': buf => buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP',
  'text/plain': buf => { if (buf.includes(0)) return false; try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch (_) { return false; } }
};
const ALLOWED_MIME = Object.keys(TYPES);

// display name only: never used as a storage key or path
function safeFilename(name) {
  const base = String(name).split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"<>:|?*]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return base && base !== '.' && base !== '..' ? base : null;
}

const sha256Hex = buf => crypto.createHash('sha256').update(buf).digest('hex');

// Supabase Storage REST (service role, private bucket). Bucket provisioning is a separate staging operation.
function createSupabaseStorageTransport({ url, serviceKey, bucket, fetchImpl, timeoutMs = 15000 }) {
  const base = new URL(url);
  const doFetch = fetchImpl || require('node-fetch');
  const bucketUrl = () => new URL(`/storage/v1/object/${encodeURIComponent(bucket)}`, base).toString();
  const objectUrl = key => new URL(`/storage/v1/object/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`, base).toString();
  const auth = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const fail = res => { const err = new Error('storage error'); err.status = res.status; return err; };
  // The timeout covers the whole exchange INCLUDING reading the response body; a stalled body is aborted and rejected.
  async function exchange(target, init, read) {
    const ctrl = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { ctrl.abort(); const err = new Error('storage timeout'); err.name = 'StorageTimeout'; reject(err); }, timeoutMs);
    });
    const work = (async () => {
      const res = await doFetch(target, { ...init, signal: ctrl.signal });
      return { res, data: await read(res) };
    })();
    work.catch(() => {}); // a late failure after the deadline must not surface as an unhandled rejection
    try { return await Promise.race([work, deadline]); } finally { clearTimeout(timer); }
  }
  const drain = res => (res && typeof res.text === 'function' ? res.text() : undefined);
  return {
    async put(key, buffer, contentType) {
      const { res } = await exchange(objectUrl(key), { method: 'POST', headers: { ...auth, 'Content-Type': contentType, 'x-upsert': 'false' }, body: buffer }, drain);
      if (!res.ok) throw fail(res);
    },
    async get(key) {
      const { res, data } = await exchange(objectUrl(key), { method: 'GET', headers: auth }, r => (r.ok ? r.arrayBuffer() : drain(r)));
      if (res.status === 404 || res.status === 400) return null;
      if (!res.ok) throw fail(res);
      return Buffer.from(data);
    },
    // Official delete-objects call: DELETE /storage/v1/object/{bucket} with {"prefixes":[key]}. A 2xx means the object is gone
    // (the provider answers 2xx with an empty list when it was already absent). Anything else, including 404 (unknown bucket
    // or route), is a real failure: the caller keeps the metadata and retries.
    async delete(key) {
      const { res } = await exchange(bucketUrl(), { method: 'DELETE', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [key] }) }, drain);
      if (!res.ok) throw fail(res);
    },
    async deleteMany(keys) {
      if (!keys || !keys.length) return;
      const { res } = await exchange(bucketUrl(), { method: 'DELETE', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: keys }) }, drain);
      if (!res.ok) throw fail(res);
    }
  };
}

function createAttachments({ store, transport, logger = () => {} }) {
  const need = () => { if (!transport) throw new ApiError(503, 'storage_unavailable', 'File storage is not available.'); return transport; };
  const publicItem = ({ object_key, ...rest }) => rest; // storage keys never leave the server
  const keyFor = (userId, row) => {
    const m = KEY_RE.exec(row.object_key || '');
    if (!m || m[1] !== userId) throw new ApiError(500, 'internal_error', 'Something went wrong.'); // a key not owned by the verified user is never used
    return row.object_key;
  };
  const storage = async (op, userId, fn) => {
    try { return await fn(); } catch (err) {
      logger('storage_error', { op, kind: err && err.name, upstream_status: err && err.status });
      throw new ApiError(502, 'storage_unavailable', 'File storage is temporarily unavailable.');
    }
  };

  async function remove(userId, id) {
    const t = need();
    const row = (await store.attachmentMarkDeleting(userId, id));
    const key = keyFor(userId, row);
    try {
      await t.delete(key);
    } catch (err) {
      logger('attachment_cleanup_failed', { attachment_id: id, upstream_status: err && err.status });
      const failed = await store.attachmentDeleteFailed(userId, id, `storage_${(err && err.status) || 'error'}`);
      throw new ApiError(502, 'attachment_cleanup_failed', 'The stored file could not be removed yet. Nothing was lost; retry the delete.', { attachment: publicItem(failed) });
    }
    await store.attachmentDeleteDone(userId, id);
    return { deleted: true };
  }

  return {
    publicItem,
    enabled: () => !!transport,
    limits: { max_bytes: MAX_BYTES, mime_types: ALLOWED_MIME },

    async createIntent(userId, entryId, b, key) {
      need();
      const filename = safeFilename(b.filename);
      if (!filename) throw new ApiError(400, 'invalid_request', 'filename is invalid.', { fields: ['filename'] });
      const r = await store.attachmentCreate(userId, entryId, { filename, mime_type: b.mime_type, size: b.size }, key);
      return { item: publicItem(r.item), replayed: r.replayed };
    },

    list: async (userId, entryId) => (await store.attachmentList(userId, entryId)).map(publicItem),
    get: async (userId, id) => publicItem(await store.attachmentGet(userId, id)),

    // bytes arrive through the API (bounded body); the type must match what was declared and the size must match exactly
    async upload(userId, id, buffer, contentType) {
      const t = need();
      const row = await store.attachmentGet(userId, id);
      if (row.state !== 'pending') throw new ApiError(409, 'invalid_state', 'This attachment is not awaiting upload.');
      if (!Buffer.isBuffer(buffer) || buffer.length !== row.declared_size) throw new ApiError(422, 'attachment_invalid', 'The uploaded file does not match the declared size.');
      if (String(contentType || '').split(';')[0].trim().toLowerCase() !== row.mime_type) throw new ApiError(422, 'attachment_invalid', 'The uploaded file type does not match the declared type.');
      await storage('put', userId, () => t.put(keyFor(userId, row), buffer, row.mime_type));
      return publicItem(row);
    },

    // read the stored object back and verify size, magic bytes and digest before the attachment becomes usable
    async finalise(userId, id) {
      const t = need();
      const row = await store.attachmentGet(userId, id);
      if (row.state === 'ready') return publicItem(await store.attachmentFinalise(userId, id, row.size_bytes, row.sha256));
      if (row.state !== 'pending') throw new ApiError(409, 'invalid_state', 'This attachment is not awaiting finalisation.');
      const buf = await storage('get', userId, () => t.get(keyFor(userId, row)));
      if (!buf) throw new ApiError(409, 'attachment_not_uploaded', 'No file has been uploaded for this attachment yet.');
      if (buf.length !== row.declared_size || buf.length > MAX_BYTES || !TYPES[row.mime_type](buf)) {
        await remove(userId, id).catch(() => {}); // an object that fails verification is discarded; a failed discard stays visible as delete_failed
        throw new ApiError(422, 'attachment_invalid', 'The stored file did not pass verification and was discarded.');
      }
      return publicItem(await store.attachmentFinalise(userId, id, buf.length, sha256Hex(buf)));
    },

    // authorised proxy download: ownership is checked in SQL, then the private object is streamed through the API
    async download(userId, id) {
      const t = need();
      const row = await store.attachmentGet(userId, id);
      if (row.state !== 'ready') throw new ApiError(409, 'invalid_state', 'This attachment is not available.');
      const buf = await storage('get', userId, () => t.get(keyFor(userId, row)));
      if (!buf) throw new ApiError(502, 'attachment_missing', 'The stored file is missing.');
      if (buf.length !== row.size_bytes || sha256Hex(buf) !== row.sha256) throw new ApiError(502, 'attachment_corrupt', 'The stored file failed its integrity check.');
      return { buffer: buf, mime: row.mime_type, filename: row.filename };
    },

    remove,

    // Operator sweep (CLI, never an HTTP route): removes abandoned pending uploads and interrupted/failed deletions older than the
    // given age, through the same mark-deleting -> remove object -> delete row protocol. 'ready' attachments are never touched.
    async sweepAbandoned({ olderThanSeconds = 86400, limit = 50 } = {}) {
      need();
      if (!Number.isInteger(olderThanSeconds) || olderThanSeconds < 3600) throw new Error('olderThanSeconds must be an integer of at least 3600');
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 to 100');
      const rows = await store.attachmentListAbandoned(olderThanSeconds, limit);
      const result = { found: rows.length, removed: 0, failed: 0 };
      for (const r of rows) {
        try { await remove(r.user_id, r.id); result.removed++; } catch (_) { result.failed++; }
      }
      logger('attachment_sweep', result);
      return result;
    }
  };
}

module.exports = { createAttachments, createSupabaseStorageTransport, safeFilename, ALLOWED_MIME, MAX_BYTES, KEY_RE };
