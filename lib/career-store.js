'use strict';
// Owner-scoped career store over the same RPC transport as lib/store.js. Every method takes the VERIFIED user id first.
const { ApiError, fromRpcError } = require('./errors');

// database codes specific to the career extension (the shared map lives in lib/errors.js)
const CAREER_CODES = {
  invalid_reference: [422, 'invalid_reference', 'A referenced record was not found.'],
  has_attachments: [409, 'has_attachments', "Remove this entry's attachments first."],
  attachment_limit: [409, 'attachment_limit', 'Attachment limit reached.'],
  invalid_state: [409, 'invalid_state', 'The record is not in a state that allows this.']
};

const KINDS = ['portfolio', 'prior_learning', 'networking', 'support', 'pulse'];

function createCareerStore(rpc) {
  const call = async (fn, args) => {
    try { return await rpc(fn, args); } catch (err) {
      const m = err && err.name === 'RpcError' && err.kind === 'db' ? /^wiz:([a-z_]+)$/.exec(err.message || '') : null;
      if (m && CAREER_CODES[m[1]]) { const [s, c, msg] = CAREER_CODES[m[1]]; throw new ApiError(s, c, msg); }
      throw fromRpcError(err);
    }
  };
  const page = (cursor, limit) => ({ p_limit: limit, p_before_ts: cursor ? cursor.ts : null, p_before_id: cursor ? cursor.id : null });
  const kind = k => { if (!KINDS.includes(k)) throw new Error('unknown career kind'); return k; };

  return {
    careerPlanGet: id => call('wiz_career_plan_get', { p_user_id: id }),
    careerPlanPut: (id, plan, expected) => call('wiz_career_plan_put', { p_user_id: id, p_plan: plan, p_expected_version: expected }),
    careerPlanDelete: id => call('wiz_career_plan_delete', { p_user_id: id }),
    careerPlanSetAiUse: (id, enabled) => call('wiz_career_plan_set_ai_use', { p_user_id: id, p_enabled: enabled }),

    learningGet: id => call('wiz_learning_get', { p_user_id: id }),
    learningPut: (id, profile, expected) => call('wiz_learning_put', { p_user_id: id, p_profile: profile, p_expected_version: expected }),
    learningDelete: id => call('wiz_learning_delete', { p_user_id: id }),
    learningSetAiUse: (id, enabled) => call('wiz_learning_set_ai_use', { p_user_id: id, p_enabled: enabled }),

    careerCreate: (id, k, data, key) => call(`wiz_${kind(k)}_create`, { p_user_id: id, p_data: data, p_key: key }),
    careerGet: (id, k, rid) => call('wiz_career_get', { p_user_id: id, p_kind: kind(k), p_id: rid }),
    careerList: (id, k, cursor, limit) => call('wiz_career_list', { p_user_id: id, p_kind: kind(k), ...page(cursor, limit) }),
    careerUpdate: (id, k, rid, patch, expected) => call(`wiz_${kind(k)}_update`, { p_user_id: id, p_id: rid, p_patch: patch, p_expected_version: expected }),
    careerDelete: (id, k, rid) => call('wiz_career_delete', { p_user_id: id, p_kind: kind(k), p_id: rid }),
    portfolioSetAiUse: (id, rid, enabled) => call('wiz_portfolio_set_ai_use', { p_user_id: id, p_id: rid, p_enabled: enabled }),
    pulseSetAiUse: (id, rid, enabled) => call('wiz_pulse_set_ai_use', { p_user_id: id, p_id: rid, p_enabled: enabled }),
    priorLearningPromote: (id, rid, key) => call('wiz_prior_learning_promote', { p_user_id: id, p_id: rid, p_key: key }),
    careerContext: id => call('wiz_career_context', { p_user_id: id }),

    attachmentCreate: (id, entryId, data, key) => call('wiz_attachment_create', { p_user_id: id, p_entry_id: entryId, p_data: data, p_key: key }),
    attachmentGet: (id, aid) => call('wiz_attachment_get', { p_user_id: id, p_id: aid }),
    attachmentList: (id, entryId) => call('wiz_attachment_list', { p_user_id: id, p_entry_id: entryId }),
    attachmentFinalise: (id, aid, size, sha256) => call('wiz_attachment_finalise', { p_user_id: id, p_id: aid, p_size: size, p_sha256: sha256 }),
    attachmentMarkDeleting: (id, aid) => call('wiz_attachment_mark_deleting', { p_user_id: id, p_id: aid }),
    attachmentDeleteDone: (id, aid) => call('wiz_attachment_delete_done', { p_user_id: id, p_id: aid }),
    attachmentDeleteFailed: (id, aid, reason) => call('wiz_attachment_delete_failed', { p_user_id: id, p_id: aid, p_reason: reason }),
    // operator sweep only (not user-scoped): abandoned pending/interrupted-delete rows older than the given age
    attachmentListAbandoned: (olderThanSeconds, limit) => call('wiz_attachment_list_abandoned', { p_older_than_seconds: olderThanSeconds, p_limit: limit })
  };
}

module.exports = { createCareerStore, CAREER_CODES };
