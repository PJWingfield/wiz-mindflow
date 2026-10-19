'use strict';
// Owner-scoped durable store. Every method takes the VERIFIED user id as its first argument and passes it to a
// wiz_* database function that filters by that owner in SQL (the service role bypasses RLS, so ownership is
// enforced by the functions, not by policies). Nothing here accepts an owner from a request body.
const { fromRpcError } = require('./errors');
const { createCareerStore } = require('./career-store');
const { createPrivacyStore } = require('./privacy-store');

function createStore(rpc) {
  const call = async (fn, args) => {
    try { return await rpc(fn, args); } catch (err) { throw fromRpcError(err); }
  };
  const page = (cursor, limit) => ({ p_limit: limit, p_before_ts: cursor ? cursor.ts : null, p_before_id: cursor ? cursor.id : null });

  return {
    ...createPrivacyStore(rpc), // privacy extension: wiz_privacy_* exist only once 20261008180000_wiz_privacy_controls is applied
    ...createCareerStore(rpc), // career extension: its wiz_* functions exist only once 20261008120000_wiz_career_backend is applied
    // existing knowledge-base function in the live project; arguments exactly as it declares them
    matchKbChunks: (query_embedding, match_count, filter_source_type) => call('match_kb_chunks', { query_embedding, match_count, filter_source_type }),
    matchKbChunksAttested: (query_embedding, embedding_model, filter_source_type, match_count) => call('wiz_match_kb_chunks_attested', { query_embedding, embedding_model, filter_source_type, match_count }),

    ensureUser: (id, email) => call('wiz_ensure_user', { p_user_id: id, p_email: email }),
    getMe: id => call('wiz_get_me', { p_user_id: id }),
    updateProfile: (id, patch) => call('wiz_update_profile', { p_user_id: id, p_patch: patch }),
    getOnboarding: id => call('wiz_onboarding_get', { p_user_id: id }),
    putOnboarding: (id, answers, complete) => call('wiz_onboarding_put', { p_user_id: id, p_answers: answers, p_complete: !!complete }),

    consentState: id => call('wiz_consent_state', { p_user_id: id }),
    recordConsent: (id, purpose, version, action) => call('wiz_consent_record', { p_user_id: id, p_purpose: purpose, p_version: version, p_action: action }),

    createSession: (id, data, key) => call('wiz_session_create', { p_user_id: id, p_data: data, p_key: key }),
    listSessions: (id, cursor, limit, archived) => call('wiz_session_list', { p_user_id: id, ...page(cursor, limit), p_archived: archived }),
    getSession: (id, sid) => call('wiz_session_get', { p_user_id: id, p_id: sid }),
    updateSession: (id, sid, patch) => call('wiz_session_update', { p_user_id: id, p_id: sid, p_patch: patch }),
    getCheckpoint: (id, sid) => call('wiz_checkpoint_get', { p_user_id: id, p_id: sid }),
    putCheckpoint: (id, sid, checkpoint, expected) => call('wiz_checkpoint_put', { p_user_id: id, p_id: sid, p_checkpoint: checkpoint, p_expected_version: expected }),
    // sender/model/provenance are decided by server code only (browser routes always pass sender 'user').
    appendMessage: (id, sid, m) => call('wiz_message_append', {
      p_user_id: id, p_session_id: sid, p_sender: m.sender, p_content: m.content, p_tokens: m.tokens || 0,
      p_key: m.key || null, p_model: m.model || null, p_provenance: m.provenance || {}
    }),
    recentMessages: (id, sid, limit) => call('wiz_message_recent', { p_user_id: id, p_session_id: sid, p_limit: limit }),
    messageByKey: (id, sid, key) => call('wiz_message_by_key', { p_user_id: id, p_session_id: sid, p_key: key }),
    personalisationContext: (id, sid, maxSessions, perSession) => call('wiz_personalisation_context', { p_user_id: id, p_session_id: sid, p_max_sessions: maxSessions, p_per_session: perSession }),
    aiUsableEvidence: id => call('wiz_evidence_ai_usable', { p_user_id: id }),
    listMessages: (id, sid, after, limit) => call('wiz_message_list', { p_user_id: id, p_session_id: sid, p_limit: limit, p_after: after }),

    createGoal: (id, data, key) => call('wiz_goal_create', { p_user_id: id, p_data: data, p_key: key }),
    getGoal: (id, gid) => call('wiz_goal_get', { p_user_id: id, p_id: gid }),
    listGoals: (id, cursor, limit) => call('wiz_goal_list', { p_user_id: id, ...page(cursor, limit) }),
    updateGoal: (id, gid, patch, expected) => call('wiz_goal_update', { p_user_id: id, p_id: gid, p_patch: patch, p_expected_version: expected }),
    deleteGoal: (id, gid) => call('wiz_goal_delete', { p_user_id: id, p_id: gid }),

    createJournal: (id, data, key) => call('wiz_journal_create', { p_user_id: id, p_data: data, p_key: key }),
    getJournal: (id, jid) => call('wiz_journal_get', { p_user_id: id, p_id: jid }),
    listJournal: (id, cursor, limit) => call('wiz_journal_list', { p_user_id: id, ...page(cursor, limit) }),
    updateJournal: (id, jid, patch, expected) => call('wiz_journal_update', { p_user_id: id, p_id: jid, p_patch: patch, p_expected_version: expected }),
    deleteJournal: (id, jid) => call('wiz_journal_delete', { p_user_id: id, p_id: jid }),

    createReport: (id, data, key) => call('wiz_report_create', { p_user_id: id, p_data: data, p_key: key }),
    getReport: (id, rid) => call('wiz_report_get', { p_user_id: id, p_id: rid }),
    listReports: (id, cursor, limit) => call('wiz_report_list', { p_user_id: id, ...page(cursor, limit) }),
    deleteReport: (id, rid) => call('wiz_report_delete', { p_user_id: id, p_id: rid }),

    createEvidence: (id, data, key) => call('wiz_evidence_create', { p_user_id: id, p_data: data, p_key: key }),
    listEvidence: (id, cursor, limit) => call('wiz_evidence_list', { p_user_id: id, ...page(cursor, limit) }),
    correctEvidence: (id, eid, statement, expected) => call('wiz_evidence_correct', { p_user_id: id, p_id: eid, p_statement: statement, p_expected_version: expected }),
    confirmEvidence: (id, eid) => call('wiz_evidence_confirm', { p_user_id: id, p_id: eid }),
    setEvidenceAiUse: (id, eid, enabled) => call('wiz_evidence_set_ai_use', { p_user_id: id, p_id: eid, p_enabled: enabled }),
    deleteEvidence: (id, eid) => call('wiz_evidence_delete', { p_user_id: id, p_id: eid }),

    upsertTraining: (id, moduleKey, status, percent) => call('wiz_training_upsert', { p_user_id: id, p_module_key: moduleKey, p_status: status, p_percent: percent }),
    listTraining: id => call('wiz_training_list', { p_user_id: id }),
    getPairing: id => call('wiz_pairing_get', { p_user_id: id })
  };
}

module.exports = { createStore };
