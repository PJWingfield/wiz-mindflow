'use strict';
// Owner-scoped privacy store (export, session deletion, erasure bookkeeping) over the same RPC transport as lib/store.js.
const { ApiError, fromRpcError } = require('./errors');

const PRIVACY_CODES = {
  export_too_large: [413, 'export_too_large', 'The export is too large to produce in one piece. Nothing partial was returned.'],
  erasure_pending: [403, 'account_erasure_pending', 'This account is being erased.']
};

function createPrivacyStore(rpc) {
  const call = async (fn, args) => {
    try { return await rpc(fn, args); } catch (err) {
      const m = err && err.name === 'RpcError' && err.kind === 'db' ? /^wiz:([a-z_]+)$/.exec(err.message || '') : null;
      if (m && PRIVACY_CODES[m[1]]) { const [s, c, msg] = PRIVACY_CODES[m[1]]; throw new ApiError(s, c, msg); }
      throw fromRpcError(err);
    }
  };
  return {
    accountExport: id => call('wiz_privacy_export', { p_user_id: id }),
    sessionDelete: (id, sid) => call('wiz_privacy_session_delete', { p_user_id: id, p_id: sid }),
    erasureState: id => call('wiz_privacy_erasure_state', { p_user_id: id }),
    erasureBegin: id => call('wiz_privacy_erasure_begin', { p_user_id: id }),
    erasureAttachments: id => call('wiz_privacy_erasure_attachments', { p_user_id: id }),
    erasureProgress: (id, phase, error) => call('wiz_privacy_erasure_progress', { p_user_id: id, p_phase: phase, p_error: error }),
    erasureFinish: id => call('wiz_privacy_erasure_finish', { p_user_id: id }),
    erasureReceipt: receiptId => call('wiz_privacy_erasure_receipt', { p_receipt_id: receiptId })
  };
}

module.exports = { createPrivacyStore };
