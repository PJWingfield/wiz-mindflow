'use strict';
// Privacy controls: account export, retained-session deletion, account erasure. Everything is owner-scoped by the VERIFIED bearer
// user; no body field names an owner. These routes keep working after any consent revocation. No consent is changed here.
//   GET    /account/export             complete JSON export or an explicit error (never a partial document)
//   DELETE /sessions/:id               body {"confirm":"delete_session"}
//   POST   /account/erasure            body {"confirm":"erase_my_account"}; 200 only when identity AND owned records are confirmed gone
//   GET    /account/erasure            erasure status for a pending account
// Erasure phases (a receipt row, outside every user cascade, records progress): mark pending (account denied) -> delete private
// storage objects -> delete the Auth identity and confirm it is gone -> delete application rows and COUNT what remains.
// Any uncertainty returns 503 erasure_incomplete with the receipt; repeating the call (or the operator resume by receipt, which
// works after the identity is gone) continues from the recorded phase. No queue service.
const { ApiError, e } = require('./errors');
const V = require('./validate');

const PHASE_ORDER = { requested: 0, storage_done: 1, auth_done: 2 };
const CONFIRM_SESSION = 'delete_session';
const CONFIRM_ERASE = 'erase_my_account';

function createPrivacy({ store, transport, authAdmin, logger = () => {}, forget = () => {} }) {
  const incomplete = (receipt, phase, why) => new ApiError(503, 'erasure_incomplete',
    'Erasure is not finished. Your account stays closed. Repeat the request to continue; the receipt identifies it.',
    { erasure: { receipt_id: receipt.receipt_id, state: 'pending', phase, reason: why, retry: 'repeat POST /api/v1/account/erasure' } });

  async function note(userId, text) { try { await store.erasureProgress(userId, null, text); } catch (_) { /* best effort */ } }

  // Runs from the recorded phase. userId comes from the verified bearer, or from the receipt for an operator resume.
  async function run(userId, receipt) {
    let phase = receipt.phase;
    if (PHASE_ORDER[phase] < 1) {
      const seen = new Set();
      try {
        for (let pass = 0; pass < 5; pass++) {
          const fresh = (await store.erasureAttachments(userId)).filter(a => !seen.has(a.id));
          if (!fresh.length) break;
          if (!transport) throw new Error('no_storage_transport');
          if (transport.deleteMany) {
            await transport.deleteMany(fresh.map(a => a.object_key));
            for (const a of fresh) seen.add(a.id);
          } else {
            for (const a of fresh) { await transport.delete(a.object_key); seen.add(a.id); }
          }
        }
      } catch (err) {
        logger('erasure_storage_failed', { receipt_id: receipt.receipt_id, upstream_status: err && err.status });
        await note(userId, 'storage_cleanup_failed');
        throw incomplete(receipt, 'storage', 'storage_cleanup_failed');
      }
      await store.erasureProgress(userId, 'storage_done', null);
      phase = 'storage_done';
    }
    if (PHASE_ORDER[phase] < 2) {
      try {
        await authAdmin.deleteUser(userId);
        if (await authAdmin.exists(userId)) throw new Error('identity_still_present');
      } catch (err) {
        logger('erasure_auth_failed', { receipt_id: receipt.receipt_id, kind: err && err.name });
        await note(userId, 'auth_deletion_unconfirmed');
        throw incomplete(receipt, 'auth', 'auth_deletion_unconfirmed');
      }
      await store.erasureProgress(userId, 'auth_done', null);
    }
    let fin;
    try { fin = await store.erasureFinish(userId); } catch (err) {
      logger('erasure_cleanup_failed', { receipt_id: receipt.receipt_id, kind: err && err.name });
      throw incomplete(receipt, 'cleanup', 'cleanup_unconfirmed');
    }
    if (!fin.complete) {
      await note(userId, 'records_remain');
      throw incomplete(receipt, 'cleanup', 'records_remain');
    }
    forget(userId);
    return { erased: true, receipt: { id: receipt.receipt_id, state: 'completed' } };
  }

  return {
    ready: () => !!(store && store.erasureBegin),

    async exportAccount(userId) { return store.accountExport(userId); },

    async deleteSession(userId, sessionId) { return store.sessionDelete(userId, sessionId); },

    async erase(userId) {
      if (!authAdmin) throw e.unavailable('erasure_unavailable', 'Account erasure is not available.');
      const files = await store.erasureAttachments(userId);
      if (files.length && !transport) throw e.unavailable('storage_unavailable', 'File storage is not available, so the account cannot be erased yet.');
      const receipt = await store.erasureBegin(userId); // from here on the API denies the account
      forget(userId);
      if (receipt.state === 'completed') return { erased: true, receipt: { id: receipt.receipt_id, state: 'completed' } };
      return run(userId, receipt);
    },

    // Operator retry by receipt id: does not need a bearer token (the identity may already be gone).
    async resume(receiptId) {
      const r = await store.erasureReceipt(receiptId);
      if (!r) throw e.notFound();
      if (r.state === 'completed') return { erased: true, receipt: { id: r.receipt_id, state: 'completed' } };
      if (!authAdmin) throw e.unavailable('erasure_unavailable', 'Account erasure is not available.');
      return run(r.user_id, r);
    },

    status: async userId => (await store.erasureState(userId)) || { state: 'none' }
  };
}

function mount({ v1, route, securePending, json, wrap, body, privacy, enabled }) {
  const gate = (req, res, next) => (enabled() && privacy.ready() ? next() : next(e.unavailable('privacy_unavailable', 'Privacy controls are not enabled.')));
  const confirmed = (req, phrase) => {
    const b = V.parse(body(req), { confirm: V.text(1, 40) });
    if (b.confirm !== phrase) throw new ApiError(400, 'confirmation_required', `Send {"confirm":"${phrase}"} to confirm.`, { fields: ['confirm'] });
  };

  route(v1, '/account/export', {
    GET: [gate, ...securePending, wrap(async (req, res) => {
      const doc = await privacy.exportAccount(req.user.id);
      res.set({ 'Cache-Control': 'private, no-store', 'Content-Disposition': 'attachment; filename="wiz-account-export.json"' });
      res.json(doc);
    })]
  });
  route(v1, '/account/erasure', {
    GET: [gate, ...securePending, wrap(async (req, res) => res.json(await privacy.status(req.user.id)))],
    POST: [gate, ...securePending, ...json('1kb'), wrap(async (req, res) => {
      confirmed(req, CONFIRM_ERASE);
      res.json(await privacy.erase(req.user.id));
    })]
  });
  return { sessionDelete: (secure) => [gate, ...secure, ...json('1kb'), wrap(async (req, res) => {
    confirmed(req, CONFIRM_SESSION);
    res.json(await privacy.deleteSession(req.user.id, V.uuid(req.params.id, 'id')));
  })] };
}

module.exports = { createPrivacy, mount, CONFIRM_SESSION, CONFIRM_ERASE };
