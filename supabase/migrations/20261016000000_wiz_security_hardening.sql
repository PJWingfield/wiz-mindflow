-- Additive hardening from Supabase advisors (16 Oct 2026). No data changes.
-- 1. SECURITY DEFINER trigger helpers must not be callable through /rest/v1/rpc by anon/authenticated/public.
--    Triggers (auth.users on_auth_user_created, event trigger ensure_rls) are unaffected: EXECUTE is not re-checked at fire time.
-- 2. Pin search_path on the two functions with a mutable one.
-- 3. Covering indexes for foreign keys (fast cascades/erasure and joins).
begin;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.rls_auto_enable() from public, anon, authenticated;
grant execute on function public.handle_new_user() to service_role;
grant execute on function public.rls_auto_enable() to service_role;
alter function public.match_kb_chunks(vector, integer, text) set search_path = pg_catalog, public, extensions, pg_temp;
alter function public.set_updated_at() set search_path = pg_catalog, public, pg_temp;
create index if not exists wiz_consent_events_purpose_version_idx on public.wiz_consent_events (purpose, version);
create index if not exists wiz_message_meta_user_id_idx on public.wiz_message_meta (user_id);
create index if not exists wiz_goals_session_id_idx on public.wiz_goals (session_id);
create index if not exists wiz_journal_entries_session_id_idx on public.wiz_journal_entries (session_id);
create index if not exists wiz_reports_session_id_idx on public.wiz_reports (session_id);
create index if not exists wiz_profile_evidence_session_id_idx on public.wiz_profile_evidence (session_id);
create index if not exists wiz_profile_evidence_revisions_user_id_idx on public.wiz_profile_evidence_revisions (user_id);
create index if not exists wiz_profile_evidence_revisions_evidence_user_idx on public.wiz_profile_evidence_revisions (evidence_id, user_id);
create index if not exists wiz_portfolio_entries_goal_id_idx on public.wiz_portfolio_entries (goal_id);
create index if not exists wiz_attachments_portfolio_entry_id_idx on public.wiz_attachments (portfolio_entry_id);
commit;
