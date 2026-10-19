-- WIZ privacy controls: account export, retained-session deletion, account erasure bookkeeping.
--
-- PREPARED ONLY: not applied to any database. Requires BOTH earlier migrations (account foundation, career backend).
-- Additive:
--   * table wiz_erasure_receipts: a minimal receipt that deliberately has NO foreign key, so it outlives the account's cascade
--   * wiz_privacy_* service-role functions (export, session delete, erasure state/begin/progress/finish/receipt)
--   * two guard triggers (insert into public.users, insert/update of wiz_attachments) that refuse work for an account with an erasure receipt
--   * two narrow grants to service_role: DELETE on public.conversations and public.users (the foundation granted neither)
-- (plus DELETE on public.wiz_idempotency, so session deletion can clear that session's replay keys)
-- Nothing in the foundation or career migrations is altered. No consent is granted, approved or changed here.
-- Browser roles (anon, authenticated, PUBLIC) get nothing. Functions filter by the caller-supplied owner; the API passes the VERIFIED
-- bearer user id only.
-- Rollback (data-preserving; keeps the receipts table and all records): supabase/rollbacks/20261008180000_wiz_privacy_controls.down.sql
-- Cascade behaviour of public.users / conversations / messages / user_documents is taken from test/fixtures/baseline.sql, which is a
-- FIXTURE, not production DDL. Nothing here proves production cascades; the erasure function therefore deletes explicitly and verifies.

begin;
select pg_advisory_xact_lock(hashtextextended('wiz_privacy_controls_20261008', 0));

do $wiz_migration$
declare
  v_found text;
  v_career text;
  v_status text;
  v_collision text;
begin
  if to_regclass('public.wiz_migration_state') is not null then
    execute $q$ select status from public.wiz_migration_state where name = 'wiz_account_foundation_20261003' $q$ into v_found;
    execute $q$ select status from public.wiz_migration_state where name = 'wiz_career_backend_20261008' $q$ into v_career;
    execute $q$ select status from public.wiz_migration_state where name = 'wiz_privacy_controls_20261008' $q$ into v_status;
  end if;
  if v_found is distinct from 'applied' or v_career is distinct from 'applied' then
    raise exception 'wiz privacy migration refused: the account foundation and career migrations must be applied first (foundation: %, career: %)', coalesce(v_found, 'absent'), coalesce(v_career, 'absent');
  end if;
  if v_status = 'applied' then
    raise notice 'wiz privacy migration already applied; nothing changed';
    return;
  end if;
  if v_status = 'applying' then
    raise exception 'wiz privacy migration refused: a previous run left state applying';
  end if;
  if v_status is null then
    select string_agg(x, ', ') into v_collision from (
      select relname::text as x from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'wiz_erasure_receipts'
      union all
      select p.proname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname ~ '^wiz_privacy_'
    ) q;
    if v_collision is not null then
      raise exception 'wiz privacy migration refused: objects already exist but are not recorded as this migration: %', v_collision;
    end if;
  end if;

  execute $wiz_body$
insert into public.wiz_migration_state (name, status, captured) values ('wiz_privacy_controls_20261008', 'applying', '{}'::jsonb)
on conflict (name) do update set status = 'applying';

-- 1. erasure receipt ------------------------------------------------------------------------------------------------
-- No foreign key on purpose. user_id is kept only while an erasure is unfinished (needed to resume after the identity is gone);
-- on completion it is cleared and only the one-way subject_hash remains, which stops the same id from being re-created.
create table if not exists public.wiz_erasure_receipts (
  id           uuid primary key default gen_random_uuid(),
  subject_hash text not null unique check (subject_hash ~ '^[0-9a-f]{64}$'),
  user_id      uuid,
  state        text not null default 'pending' check (state in ('pending', 'completed')),
  phase        text not null default 'requested' check (phase in ('requested', 'storage_done', 'auth_done', 'completed')),
  attempts     integer not null default 1,
  last_error   text check (last_error is null or char_length(last_error) <= 200),
  requested_at timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  completed_at timestamptz,
  check ((state = 'pending' and user_id is not null) or (state = 'completed' and user_id is null))
);

-- 2. functions --------------------------------------------------------------------------------------------------------
create or replace function public.wiz_privacy_subject_hash(p_user_id uuid) returns text
language sql immutable set search_path = public, pg_temp as $$
  select encode(sha256(convert_to('wiz_erasure:' || p_user_id::text, 'UTF8')), 'hex');
$$;

-- Backstop only (the API checks the receipt on every request): no new application row for an account that has a receipt.
create or replace function public.wiz_privacy_block() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare v_owner uuid;
begin
  v_owner := coalesce(to_jsonb(new) ->> 'user_id', to_jsonb(new) ->> 'id')::uuid; -- users has no user_id column; attachments do
  if exists (select 1 from public.wiz_erasure_receipts r where r.subject_hash = public.wiz_privacy_subject_hash(v_owner)) then
    raise exception 'wiz:erasure_pending' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists wiz_privacy_block on public.users;
create trigger wiz_privacy_block before insert on public.users for each row execute function public.wiz_privacy_block();
drop trigger if exists wiz_privacy_block on public.wiz_attachments;
create trigger wiz_privacy_block before insert or update on public.wiz_attachments for each row execute function public.wiz_privacy_block();

-- 2a. export: ONE statement, so every section is read from the same snapshot. A complete document or an explicit error.
create or replace function public.wiz_privacy_export(p_user_id uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v jsonb;
  v_legacy text := '''[]''::jsonb';
begin
  perform 1 from public.users where id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  if to_regclass('public.user_documents') is not null then
    v_legacy := '(select coalesce(jsonb_agg(to_jsonb(d) - ''user_id'' order by d.created_at, d.id), ''[]''::jsonb) from public.user_documents d where d.user_id = $1)';
  end if;
  execute format($f$
    select jsonb_build_object(
      'schema', 'wiz.account-export',
      'version', 1,
      'generated_at', now(),
      'account', (select jsonb_build_object('id', u.id, 'email', u.email, 'full_name', u.full_name, 'avatar_url', u.avatar_url, 'created_at', u.created_at) from public.users u where u.id = $1),
      'profile', (select jsonb_build_object('preferences', p.preferences, 'onboarding', p.onboarding, 'onboarding_version', p.onboarding_version,
          'onboarding_completed_at', p.onboarding_completed_at, 'learning_profile', p.learning_profile, 'learning_profile_version', p.learning_profile_version,
          'learning_ai_use_enabled', p.learning_ai_use, 'learning_updated_at', p.learning_updated_at) from public.wiz_user_profiles p where p.user_id = $1),
      'consents', jsonb_build_object(
        'current', public.wiz_consent_state($1),
        'events', coalesce((select jsonb_agg(jsonb_build_object('seq', e.seq, 'purpose', e.purpose, 'version', e.version, 'action', e.action, 'created_at', e.created_at) order by e.seq)
          from public.wiz_consent_events e where e.user_id = $1), '[]'::jsonb)),
      'sessions', coalesce((select jsonb_agg(jsonb_build_object(
          'id', c.id, 'title', c.title, 'is_archived', c.is_archived, 'created_at', c.created_at, 'updated_at', c.updated_at,
          'session_number', s.session_number, 'title_source', s.title_source, 'track', s.track, 'lens', s.lens, 'topic', s.topic,
          'checkpoint', s.checkpoint, 'checkpoint_version', s.checkpoint_version, 'checkpoint_updated_at', s.checkpoint_updated_at,
          'message_count', s.message_count, 'last_message_at', s.last_message_at,
          'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'seq', mm.seq, 'sender', m.sender, 'content', m.content,
              'tokens_used', m.tokens_used, 'created_at', m.created_at, 'model', mm.model, 'provenance', mm.provenance)
              order by coalesce(mm.seq, 0), m.created_at, m.id)
            from public.messages m left join public.wiz_message_meta mm on mm.message_id = m.id where m.conversation_id = c.id), '[]'::jsonb))
          order by s.session_number nulls last, c.created_at, c.id)
        from public.conversations c left join public.wiz_session_meta s on s.session_id = c.id where c.user_id = $1), '[]'::jsonb),
      'goals', coalesce((select jsonb_agg(to_jsonb(x) - 'user_id' order by x.created_at, x.id) from public.wiz_goals x where x.user_id = $1), '[]'::jsonb),
      'journal_entries', coalesce((select jsonb_agg(to_jsonb(x) - 'user_id' order by x.created_at, x.id) from public.wiz_journal_entries x where x.user_id = $1), '[]'::jsonb),
      'reports', coalesce((select jsonb_agg(to_jsonb(x) - 'user_id' order by x.created_at, x.id) from public.wiz_reports x where x.user_id = $1), '[]'::jsonb),
      'profile_evidence', coalesce((select jsonb_agg(to_jsonb(x) - 'user_id' order by x.created_at, x.id) from public.wiz_profile_evidence x where x.user_id = $1), '[]'::jsonb),
      'profile_evidence_revisions', coalesce((select jsonb_agg(to_jsonb(x) - 'user_id' order by x.changed_at, x.id) from public.wiz_profile_evidence_revisions x where x.user_id = $1), '[]'::jsonb),
      'training', coalesce((select jsonb_agg(to_jsonb(x) - 'user_id' order by x.module_key) from public.wiz_training_progress x where x.user_id = $1), '[]'::jsonb),
      'pairing', (select to_jsonb(x) - 'user_id' from public.wiz_pairing_status x where x.user_id = $1),
      'career', jsonb_build_object(
        'plan', (select to_jsonb(x) - 'user_id' from public.wiz_career_plans x where x.user_id = $1),
        'prior_learning', coalesce((select jsonb_agg(to_jsonb(x) - 'user_id' order by x.created_at, x.id) from public.wiz_prior_learning x where x.user_id = $1), '[]'::jsonb),
        'portfolio', coalesce((select jsonb_agg(to_jsonb(x) - 'user_id' order by x.created_at, x.id) from public.wiz_portfolio_entries x where x.user_id = $1), '[]'::jsonb),
        'networking_log', coalesce((select jsonb_agg(to_jsonb(x) - 'user_id' order by x.created_at, x.id) from public.wiz_networking_log x where x.user_id = $1), '[]'::jsonb),
        'support_map', coalesce((select jsonb_agg(to_jsonb(x) - 'user_id' order by x.created_at, x.id) from public.wiz_support_map x where x.user_id = $1), '[]'::jsonb),
        'wellbeing_pulses', coalesce((select jsonb_agg(to_jsonb(x) - 'user_id' order by x.observed_at, x.id) from public.wiz_wellbeing_pulses x where x.user_id = $1), '[]'::jsonb),
        'attachments', coalesce((select jsonb_agg((to_jsonb(x) - 'user_id' - 'object_key') || jsonb_build_object('download_path', '/api/v1/attachments/' || x.id::text || '/content') order by x.created_at, x.id)
          from public.wiz_attachments x where x.user_id = $1), '[]'::jsonb)),
      'legacy_documents', %s
    )$f$, v_legacy) into v using p_user_id;
  -- the document is returned whole or not at all
  if pg_column_size(v) > 33554432 then perform public.wiz_fail('export_too_large'); end if;
  return v;
end $$;

-- 2b. retained-session deletion: transcript, metadata and the session's own idempotency results; independent records survive
-- (goals/journal/reports/evidence only lose their optional session link through their existing ON DELETE SET NULL)
create or replace function public.wiz_privacy_session_delete(p_user_id uuid, p_id uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_msgs bigint; v_n integer;
begin
  perform 1 from public.conversations where id = p_id and user_id = p_user_id for update;
  if not found then perform public.wiz_fail('not_found'); end if;
  select count(*) into v_msgs from public.messages where conversation_id = p_id;
  delete from public.wiz_idempotency where user_id = p_user_id
    and (scope = 'message:' || p_id::text or (scope = 'session' and result_id = p_id));
  delete from public.conversations where id = p_id and user_id = p_user_id;
  get diagnostics v_n = row_count;
  if v_n = 0 then perform public.wiz_fail('not_found'); end if;
  return jsonb_build_object('deleted', true, 'messages_removed', v_msgs);
end $$;

-- 2c. erasure bookkeeping ------------------------------------------------------------------------------------------------
create or replace function public.wiz_privacy_erasure_state(p_user_id uuid) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('receipt_id', r.id, 'state', r.state, 'phase', r.phase)
  from public.wiz_erasure_receipts r where r.subject_hash = public.wiz_privacy_subject_hash(p_user_id);
$$;

-- Marks the account pending (idempotent). From this point the API denies the account; a repeated call resumes.
create or replace function public.wiz_privacy_erasure_begin(p_user_id uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_r public.wiz_erasure_receipts;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':consent', 0)); -- same per-user lock the consent gate takes
  select * into v_r from public.wiz_erasure_receipts where subject_hash = public.wiz_privacy_subject_hash(p_user_id) for update;
  if found then
    if v_r.state = 'completed' then return jsonb_build_object('receipt_id', v_r.id, 'state', v_r.state, 'phase', v_r.phase); end if;
    update public.wiz_erasure_receipts set attempts = attempts + 1 where id = v_r.id returning * into v_r;
  else
    perform 1 from public.users where id = p_user_id;
    if not found then perform public.wiz_fail('not_found'); end if;
    insert into public.wiz_erasure_receipts (subject_hash, user_id) values (public.wiz_privacy_subject_hash(p_user_id), p_user_id) returning * into v_r;
  end if;
  return jsonb_build_object('receipt_id', v_r.id, 'state', v_r.state, 'phase', v_r.phase);
end $$;

create or replace function public.wiz_privacy_erasure_attachments(p_user_id uuid) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'object_key', a.object_key) order by a.created_at, a.id), '[]'::jsonb)
  from public.wiz_attachments a where a.user_id = p_user_id;
$$;

create or replace function public.wiz_privacy_erasure_progress(p_user_id uuid, p_phase text, p_error text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_r public.wiz_erasure_receipts;
begin
  if p_phase is not null and p_phase not in ('requested', 'storage_done', 'auth_done') then perform public.wiz_fail('invalid_input'); end if;
  update public.wiz_erasure_receipts set
    phase = case when p_phase is not null and array_position(array['requested', 'storage_done', 'auth_done'], p_phase) > array_position(array['requested', 'storage_done', 'auth_done'], phase) then p_phase else phase end,
    last_error = left(p_error, 200)
  where subject_hash = public.wiz_privacy_subject_hash(p_user_id) and state = 'pending' returning * into v_r;
  if not found then perform public.wiz_fail('not_found'); end if;
  return jsonb_build_object('receipt_id', v_r.id, 'state', v_r.state, 'phase', v_r.phase);
end $$;

-- Deletes the application account explicitly (never trusts a cascade), then COUNTS what is left for the owner. The receipt is
-- completed only when nothing owned remains; otherwise it stays pending and the remaining counts are returned.
create or replace function public.wiz_privacy_erasure_finish(p_user_id uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  t text;
  n bigint;
  v_left jsonb := '{}'::jsonb;
  v_r public.wiz_erasure_receipts;
begin
  select * into v_r from public.wiz_erasure_receipts where subject_hash = public.wiz_privacy_subject_hash(p_user_id) for update;
  if not found then perform public.wiz_fail('not_found'); end if;
  if v_r.state = 'completed' then return jsonb_build_object('complete', true, 'remaining', '{}'::jsonb, 'receipt_id', v_r.id); end if;
  delete from public.conversations where user_id = p_user_id;
  delete from public.users where id = p_user_id;
  foreach t in array array['conversations', 'wiz_user_profiles', 'wiz_consent_events', 'wiz_idempotency', 'wiz_session_meta', 'wiz_message_meta', 'wiz_goals',
    'wiz_journal_entries', 'wiz_reports', 'wiz_profile_evidence', 'wiz_profile_evidence_revisions', 'wiz_training_progress', 'wiz_pairing_status',
    'wiz_career_plans', 'wiz_prior_learning', 'wiz_portfolio_entries', 'wiz_networking_log', 'wiz_support_map', 'wiz_wellbeing_pulses', 'wiz_attachments', 'user_documents']
  loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('select count(*) from public.%I where user_id = $1', t) into n using p_user_id;
    if n > 0 then v_left := v_left || jsonb_build_object(t, n); end if;
  end loop;
  select count(*) into n from public.users where id = p_user_id;
  if n > 0 then v_left := v_left || jsonb_build_object('users', n); end if;
  if v_left = '{}'::jsonb then
    update public.wiz_erasure_receipts set state = 'completed', phase = 'completed', user_id = null, last_error = null, completed_at = now() where id = v_r.id;
    return jsonb_build_object('complete', true, 'remaining', '{}'::jsonb, 'receipt_id', v_r.id);
  end if;
  return jsonb_build_object('complete', false, 'remaining', v_left, 'receipt_id', v_r.id);
end $$;

-- Operator resume by receipt (identity may already be gone): returns the id only while the erasure is unfinished.
create or replace function public.wiz_privacy_erasure_receipt(p_receipt_id uuid) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('receipt_id', r.id, 'user_id', r.user_id, 'state', r.state, 'phase', r.phase, 'attempts', r.attempts,
    'last_error', r.last_error, 'requested_at', r.requested_at, 'completed_at', r.completed_at)
  from public.wiz_erasure_receipts r where r.id = p_receipt_id;
$$;

-- 3. access ----------------------------------------------------------------------------------------------------------------------
alter table public.wiz_erasure_receipts enable row level security;
revoke all on table public.wiz_erasure_receipts from public, anon, authenticated, service_role;
grant select, insert, update on table public.wiz_erasure_receipts to service_role;
-- the only privilege additions on foundation tables (recorded; the rollback revokes exactly these)
grant delete on table public.conversations to service_role;
grant delete on table public.users to service_role;
-- session deletion clears that session's own replay keys
grant delete on table public.wiz_idempotency to service_role;

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname ~ '^wiz_privacy_'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;

update public.wiz_migration_state set status = 'applied', applied_at = now(), rolled_back_at = null,
  captured = jsonb_build_object(
    'owned', jsonb_build_object(
      'functions', (select coalesce(jsonb_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text), '[]'::jsonb) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname ~ '^wiz_privacy_'),
      'triggers', jsonb_build_array('public.users.wiz_privacy_block', 'public.wiz_attachments.wiz_privacy_block'),
      'tables', jsonb_build_array('public.wiz_erasure_receipts'),
      'grants', jsonb_build_array('delete on public.conversations to service_role', 'delete on public.users to service_role', 'delete on public.wiz_idempotency to service_role')))
where name = 'wiz_privacy_controls_20261008';
  $wiz_body$;
end $wiz_migration$;

commit;
