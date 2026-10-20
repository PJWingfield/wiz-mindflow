-- WIZ exact-notice linkage + separate terms acceptance.
--
-- PREPARED ONLY: not applied to any database. Requires the account foundation, career and privacy migrations.
-- Additive:
--   * wiz_consent_versions gains nullable artifact_id / artifact_sha256 / approval_provenance. Existing rows are untouched and stay
--     unlinked; no consent version is approved, published or changed here (the unapproved placeholders remain unapproved)
--   * wiz_terms_versions: small catalogue of published Terms versions, each tied to an immutable notice artifact + SHA-256.
--     Seeded with Terms v1.0 (notices/terms-2026-10-16-v1.txt)
--   * wiz_terms_acceptances: append-only record (verified user, version, artifact, hash, server time). One row per user and version,
--     so a repeat acceptance is harmless. Deleted only by the account-erasure cascade; never revocable through the consent events
--   * wiz_publication_lock trigger: published artifact/hash/provenance cannot be rewritten (new wording = new version); acceptances
--     cannot be updated
--   * wiz_terms_state / wiz_terms_accept service-role functions (they filter by the caller-supplied owner; the API passes the
--     VERIFIED bearer user id only)
--   * wiz_privacy_export and wiz_privacy_erasure_finish are re-created with the acceptance data added (export section; erasure
--     count-check). Their grants are kept
-- Browser roles (anon, authenticated, PUBLIC) get nothing. service_role: select on versions, select+insert on acceptances.
-- Records no paid-contract formation and takes no position on signup, subscriptions or coaching/health behaviour.
-- Rollback (data-preserving; keeps tables, columns and every acceptance): supabase/rollbacks/20261019120000_wiz_consent_notices_terms.down.sql

begin;
select pg_advisory_xact_lock(hashtextextended('wiz_consent_notices_20261019', 0));

do $wiz_migration$
declare
  v_found text;
  v_career text;
  v_privacy text;
  v_status text;
  v_collision text;
begin
  if to_regclass('public.wiz_migration_state') is not null then
    execute $q$ select status from public.wiz_migration_state where name = 'wiz_account_foundation_20261003' $q$ into v_found;
    execute $q$ select status from public.wiz_migration_state where name = 'wiz_career_backend_20261008' $q$ into v_career;
    execute $q$ select status from public.wiz_migration_state where name = 'wiz_privacy_controls_20261008' $q$ into v_privacy;
    execute $q$ select status from public.wiz_migration_state where name = 'wiz_consent_notices_20261019' $q$ into v_status;
  end if;
  if v_found is distinct from 'applied' or v_career is distinct from 'applied' or v_privacy is distinct from 'applied' then
    raise exception 'wiz consent notices migration refused: the foundation, career and privacy migrations must be applied first (foundation: %, career: %, privacy: %)',
      coalesce(v_found, 'absent'), coalesce(v_career, 'absent'), coalesce(v_privacy, 'absent');
  end if;
  if v_status = 'applied' then
    raise notice 'wiz consent notices migration already applied; nothing changed';
    return;
  end if;
  if v_status = 'applying' then
    raise exception 'wiz consent notices migration refused: a previous run left state applying';
  end if;
  if v_status is null then
    select string_agg(x, ', ') into v_collision from (
      select relname::text as x from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname in ('wiz_terms_versions', 'wiz_terms_acceptances')
      union all
      select p.proname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and (p.proname ~ '^wiz_terms_' or p.proname = 'wiz_publication_lock')
    ) q;
    if v_collision is not null then
      raise exception 'wiz consent notices migration refused: objects already exist but are not recorded as this migration: %', v_collision;
    end if;
  end if;

  execute $wiz_body$
insert into public.wiz_migration_state (name, status, captured) values ('wiz_consent_notices_20261019', 'applying', '{}'::jsonb)
on conflict (name) do update set status = 'applying';

-- 1. artifact linkage on consent versions (all nullable: existing rows are preserved exactly) -------------------------------
alter table public.wiz_consent_versions
  add column if not exists artifact_id          text check (artifact_id ~ '^[a-z0-9][a-z0-9._-]{2,79}$'),
  add column if not exists artifact_sha256      text check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  add column if not exists approval_provenance  text check (char_length(approval_provenance) between 1 and 500);
alter table public.wiz_consent_versions drop constraint if exists wiz_consent_artifact_pair;
alter table public.wiz_consent_versions add constraint wiz_consent_artifact_pair check ((artifact_id is null) = (artifact_sha256 is null));

-- 2. terms catalogue + append-only acceptances -------------------------------------------------------------------------------
create table if not exists public.wiz_terms_versions (
  version             text primary key check (version ~ '^[A-Za-z0-9._-]{1,20}$'),
  status              text not null default 'current' check (status in ('current', 'retired')),
  artifact_id         text not null check (artifact_id ~ '^[a-z0-9][a-z0-9._-]{2,79}$'),
  artifact_sha256     text not null check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  approval_provenance text not null check (char_length(approval_provenance) between 1 and 500),
  published_at        timestamptz not null default now()
);
create unique index if not exists wiz_terms_one_current_idx on public.wiz_terms_versions (status) where status = 'current';

create table if not exists public.wiz_terms_acceptances (
  seq             bigint generated always as identity primary key,
  user_id         uuid not null references public.users (id) on delete cascade,
  version         text not null references public.wiz_terms_versions (version),
  artifact_id     text not null,
  artifact_sha256 text not null check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  accepted_at     timestamptz not null default now(),
  unique (user_id, version)
);

-- 3. functions ----------------------------------------------------------------------------------------------------------------
-- Published content identity is write-once. Consent versions: the artifact link may be set once (null -> value) and provenance
-- likewise, never changed or cleared; approval / status / summary keep their existing owner-only handling. Terms versions: only
-- status may change (retire); nothing is deleted. Acceptances are append-only (the erasure cascade is the only deletion path).
create or replace function public.wiz_publication_lock() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_table_name = 'wiz_terms_acceptances' then
    raise exception 'wiz:published_immutable' using errcode = 'P0001';
  elsif tg_table_name = 'wiz_terms_versions' then
    if tg_op = 'DELETE' then raise exception 'wiz:published_immutable' using errcode = 'P0001'; end if;
    if new.version is distinct from old.version or new.artifact_id is distinct from old.artifact_id
       or new.artifact_sha256 is distinct from old.artifact_sha256 or new.approval_provenance is distinct from old.approval_provenance
       or new.published_at is distinct from old.published_at then
      raise exception 'wiz:published_immutable' using errcode = 'P0001';
    end if;
  else
    if (old.artifact_id is not null and (new.artifact_id is distinct from old.artifact_id or new.artifact_sha256 is distinct from old.artifact_sha256))
       or (old.approval_provenance is not null and new.approval_provenance is distinct from old.approval_provenance) then
      raise exception 'wiz:published_immutable' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists wiz_publication_lock on public.wiz_consent_versions;
create trigger wiz_publication_lock before update on public.wiz_consent_versions
  for each row execute function public.wiz_publication_lock();
drop trigger if exists wiz_publication_lock on public.wiz_terms_versions;
create trigger wiz_publication_lock before update or delete on public.wiz_terms_versions
  for each row execute function public.wiz_publication_lock();
drop trigger if exists wiz_publication_lock on public.wiz_terms_acceptances;
create trigger wiz_publication_lock before update on public.wiz_terms_acceptances
  for each row execute function public.wiz_publication_lock();

-- current terms (artifact + hash + provenance), whether THIS account has accepted the current version, and its acceptance history
create or replace function public.wiz_terms_state(p_user_id uuid) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
begin
  perform 1 from public.users where id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  return jsonb_build_object(
    'current', (select jsonb_build_object('version', t.version, 'artifact_id', t.artifact_id, 'artifact_sha256', t.artifact_sha256,
        'approval_provenance', t.approval_provenance, 'published_at', t.published_at)
      from public.wiz_terms_versions t where t.status = 'current'),
    'accepted', exists (select 1 from public.wiz_terms_acceptances a join public.wiz_terms_versions t on t.version = a.version
      where a.user_id = p_user_id and t.status = 'current'),
    'acceptances', coalesce((select jsonb_agg(jsonb_build_object('version', a.version, 'artifact_id', a.artifact_id,
        'artifact_sha256', a.artifact_sha256, 'accepted_at', a.accepted_at) order by a.seq)
      from public.wiz_terms_acceptances a where a.user_id = p_user_id), '[]'::jsonb));
end $$;

-- Records acceptance of the CURRENT version only, and only when the caller names that version and its exact hash. Time is the
-- database clock; version/artifact/hash are copied from the catalogue, never from the caller. A repeat is a no-op (replayed).
create or replace function public.wiz_terms_accept(p_user_id uuid, p_version text, p_sha256 text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_terms public.wiz_terms_versions;
  v_n integer;
begin
  perform 1 from public.users where id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  select * into v_terms from public.wiz_terms_versions where status = 'current';
  if v_terms.version is null then perform public.wiz_fail('terms_unavailable'); end if;
  perform 1 from public.wiz_terms_versions where version = p_version;
  if not found then perform public.wiz_fail('unknown_terms_version'); end if;
  if p_version is distinct from v_terms.version or p_sha256 is distinct from v_terms.artifact_sha256 then
    perform public.wiz_fail('stale_terms_version');
  end if;
  insert into public.wiz_terms_acceptances (user_id, version, artifact_id, artifact_sha256)
    values (p_user_id, v_terms.version, v_terms.artifact_id, v_terms.artifact_sha256)
    on conflict (user_id, version) do nothing;
  get diagnostics v_n = row_count;
  return public.wiz_terms_state(p_user_id) || jsonb_build_object('replayed', v_n = 0);
end $$;

-- 4. privacy lifecycle: the privacy functions re-created from 20261008180000 with the acceptance data added -----------------------
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
      'terms_acceptances', coalesce((select jsonb_agg(jsonb_build_object('seq', a.seq, 'version', a.version, 'artifact_id', a.artifact_id,
          'artifact_sha256', a.artifact_sha256, 'accepted_at', a.accepted_at) order by a.seq)
        from public.wiz_terms_acceptances a where a.user_id = $1), '[]'::jsonb),
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

-- Same as 20261008180000 plus wiz_terms_acceptances in the leftover count. Acceptances are removed by the users foreign-key cascade
-- (service_role deliberately has no DELETE on them); the count proves it, and the receipt stays pending if any remain.
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
  foreach t in array array['conversations', 'wiz_user_profiles', 'wiz_consent_events', 'wiz_terms_acceptances', 'wiz_idempotency', 'wiz_session_meta', 'wiz_message_meta', 'wiz_goals',
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

-- 5. seed: Terms v1.0 -> its preserved artifact. Consent versions are NOT linked, approved or changed here. -----------------------
insert into public.wiz_terms_versions (version, status, artifact_id, artifact_sha256, approval_provenance) values
  ('1.0', 'current', 'terms-2026-10-16-v1', '8570e1f5fac7f9a67597a672024fcdbe48bc85e90de9e6df907352ea987ed60d',
   'Owner instruction of 2026-10-19 to treat the supplied wording as approved for implementation; source control field "Approved by and date: PJW 16/10/2026". Not independently verified solicitor approval.')
on conflict do nothing;

-- 6. access ------------------------------------------------------------------------------------------------------------------------
alter table public.wiz_terms_versions enable row level security;
alter table public.wiz_terms_acceptances enable row level security;
revoke all on table public.wiz_terms_versions, public.wiz_terms_acceptances from public, anon, authenticated, service_role;
grant select on table public.wiz_terms_versions to service_role;
grant select, insert on table public.wiz_terms_acceptances to service_role;
do $$
declare r record;
begin
  execute format('revoke all on sequence %s from public, anon, authenticated', pg_get_serial_sequence('public.wiz_terms_acceptances', 'seq'));
  for r in
    select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and (p.proname ~ '^wiz_terms_' or p.proname = 'wiz_publication_lock')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;

update public.wiz_migration_state set status = 'applied', applied_at = now(), rolled_back_at = null,
  captured = jsonb_build_object(
    'owned', jsonb_build_object(
      'functions', jsonb_build_array('public.wiz_terms_state(uuid)', 'public.wiz_terms_accept(uuid, text, text)'),
      'grants', jsonb_build_array('insert on public.wiz_terms_acceptances to service_role', 'select on public.wiz_terms_versions to service_role')),
    'retained', jsonb_build_object(
      'tables', jsonb_build_array('public.wiz_terms_versions', 'public.wiz_terms_acceptances'),
      'columns', jsonb_build_array('public.wiz_consent_versions.artifact_id', 'public.wiz_consent_versions.artifact_sha256', 'public.wiz_consent_versions.approval_provenance'),
      'locks', jsonb_build_array('public.wiz_publication_lock()', 'wiz_publication_lock triggers on wiz_consent_versions, wiz_terms_versions, wiz_terms_acceptances'),
      'recreated', jsonb_build_array('public.wiz_privacy_export(uuid)', 'public.wiz_privacy_erasure_finish(uuid)')))
where name = 'wiz_consent_notices_20261019';
  $wiz_body$;
end $wiz_migration$;

commit;
