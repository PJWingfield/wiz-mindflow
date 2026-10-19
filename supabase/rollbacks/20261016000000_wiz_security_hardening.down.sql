-- Restores previous grants/search_path and drops the added indexes.
begin;
grant execute on function public.handle_new_user() to public, anon, authenticated;
grant execute on function public.rls_auto_enable() to public, anon, authenticated;
alter function public.match_kb_chunks(vector, integer, text) reset search_path;
alter function public.set_updated_at() reset search_path;
drop index if exists public.wiz_consent_events_purpose_version_idx, public.wiz_message_meta_user_id_idx, public.wiz_goals_session_id_idx,
 public.wiz_journal_entries_session_id_idx, public.wiz_reports_session_id_idx, public.wiz_profile_evidence_session_id_idx,
 public.wiz_profile_evidence_revisions_user_id_idx, public.wiz_profile_evidence_revisions_evidence_user_idx,
 public.wiz_portfolio_entries_goal_id_idx, public.wiz_attachments_portfolio_entry_id_idx;
commit;
