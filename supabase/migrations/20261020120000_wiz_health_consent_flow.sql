-- WIZ health-consent flow: approved notice versions, coaching readiness state, and the pre-withdrawal context fence.
--
-- PREPARED ONLY: not applied to any database. Requires foundation, career, privacy and 20261019120000_wiz_consent_notices_terms.
-- Additive / data-preserving:
--   * publishes the smallest set of NEW approved consent versions under the owner's 2026-10-19 instruction, each linked to the
--     preserved Privacy Notice artifact + SHA-256: save_chats 2, personalisation 2, career_records 2 (same summaries as v1) and the new
--     purpose health_processing 1. The unapproved placeholder v1 rows are RETIRED, never deleted or rewritten; every historical event stays.
--     Nothing is granted: a person must still decide each purpose explicitly (an unanswered purpose grants nothing).
--   * wiz_user_profiles.context_fence_at: set by a trigger whenever a health_processing REVOKE (decline or withdrawal) is recorded; it only
--     ever moves forward and a later grant never clears it. Records that exist at or before the fence are excluded from future model context
--     (conversation history of other sessions, onboarding answers, evidence, career plan, learning profile, portfolio, pulses) even when their
--     own purpose grants are active. Chats stay readable, exportable and deletable.
--   * wiz_coaching_state / wiz_terms_current: read-only service-role functions the API uses to enforce Terms + the answered health choice.
--   * wiz_personalisation_context, wiz_career_context and wiz_evidence_ai_usable are re-created with the fence added (consent gates unchanged);
--     wiz_message_recent additionally returns each reply's request_fence so a reply to a request that began before a withdrawal is not reused.
--   * wiz_user_profiles.learning_fence_hashes: per-field fingerprints of the learning profile at the fence; unchanged fields stay out even when
--     the profile is re-saved or another field is edited (no profile text is copied).
--   * wiz_coaching_state also reports chat retention (save_chats) so the first-use dialog can ask for it explicitly. It is reported only: the
--     append gate still enforces it and nothing is granted here.
-- Browser roles get nothing. The API passes the VERIFIED bearer user id only.
-- Rollback (data-preserving): supabase/rollbacks/20261020120000_wiz_health_consent_flow.down.sql

begin;
select pg_advisory_xact_lock(hashtextextended('wiz_health_consent_flow_20261020', 0));

do $wiz_migration$
declare
  v_found text;
  v_career text;
  v_privacy text;
  v_notices text;
  v_status text;
  v_collision text;
begin
  if to_regclass('public.wiz_migration_state') is not null then
    execute $q$ select status from public.wiz_migration_state where name = 'wiz_account_foundation_20261003' $q$ into v_found;
    execute $q$ select status from public.wiz_migration_state where name = 'wiz_career_backend_20261008' $q$ into v_career;
    execute $q$ select status from public.wiz_migration_state where name = 'wiz_privacy_controls_20261008' $q$ into v_privacy;
    execute $q$ select status from public.wiz_migration_state where name = 'wiz_consent_notices_20261019' $q$ into v_notices;
    execute $q$ select status from public.wiz_migration_state where name = 'wiz_health_consent_flow_20261020' $q$ into v_status;
  end if;
  if v_found is distinct from 'applied' or v_career is distinct from 'applied' or v_privacy is distinct from 'applied' or v_notices is distinct from 'applied' then
    raise exception 'wiz health consent migration refused: foundation, career, privacy and consent-notices migrations must be applied first (%, %, %, %)',
      coalesce(v_found, 'absent'), coalesce(v_career, 'absent'), coalesce(v_privacy, 'absent'), coalesce(v_notices, 'absent');
  end if;
  if v_status = 'applied' then
    raise notice 'wiz health consent migration already applied; nothing changed';
    return;
  end if;
  if v_status = 'applying' then
    raise exception 'wiz health consent migration refused: a previous run left state applying';
  end if;
  if v_status is null then
    select string_agg(x, ', ') into v_collision from (
      select p.proname::text as x from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('wiz_coaching_state', 'wiz_terms_current', 'wiz_health_fence')
    ) q;
    if v_collision is not null then
      raise exception 'wiz health consent migration refused: objects already exist but are not recorded as this migration: %', v_collision;
    end if;
  end if;

  execute $wiz_body$
insert into public.wiz_migration_state (name, status, captured) values ('wiz_health_consent_flow_20261020', 'applying', '{}'::jsonb)
on conflict (name) do update set status = 'applying';

-- 1. fence column --------------------------------------------------------------------------------------------------------------
alter table public.wiz_user_profiles add column if not exists context_fence_at timestamptz;
-- per-field fingerprints (md5 of each top-level field's JSON, never the content itself) of the learning profile as it stood when the fence was
-- last set: a field whose value is unchanged stays out of model use even if the profile is re-saved or another field is edited
alter table public.wiz_user_profiles add column if not exists learning_fence_hashes jsonb;

-- 2. approved versions (owner instruction 2026-10-19; Privacy Notice artifact). Placeholders are retired, never altered. -----------
do $$
declare v_retired jsonb;
begin
  with r as (
    update public.wiz_consent_versions set status = 'retired'
    where status = 'current' and not legal_approved and version = '1' and purpose in ('save_chats', 'personalisation', 'career_records')
    returning purpose, version)
  select coalesce(jsonb_agg(jsonb_build_object('purpose', purpose, 'version', version)), '[]'::jsonb) into v_retired from r;
  update public.wiz_migration_state set captured = captured || jsonb_build_object('retired_placeholders', v_retired)
  where name = 'wiz_health_consent_flow_20261020';
end $$;

insert into public.wiz_consent_versions (purpose, version, status, summary, legal_approved, artifact_id, artifact_sha256, approval_provenance)
select v.purpose, '2', 'current', v.summary, true, 'privacy-2026-10-16-v1', 'ba1a8f905d6b3af9ede6d5bfa7ac18fc520629847f49448530044fc4339e6f70',
  'Owner instruction of 2026-10-19 to treat the supplied wording as approved for implementation; source control field "Approved by and date: PJW 16/10/2026". Not independently verified solicitor approval.'
from public.wiz_consent_versions v
where v.version = '1' and v.purpose in ('save_chats', 'personalisation', 'career_records')
  and not exists (select 1 from public.wiz_consent_versions c where c.purpose = v.purpose and c.status = 'current')
on conflict do nothing;

insert into public.wiz_consent_versions (purpose, version, status, summary, legal_approved, artifact_id, artifact_sha256, approval_provenance)
values ('health_processing', '1', 'current',
  'Let WIZ handle health, wellbeing or neurodiversity information I choose to share while it coaches me, as set out in the Privacy Notice. I can use WIZ without sharing it and can withdraw at any time.',
  true, 'privacy-2026-10-16-v1', 'ba1a8f905d6b3af9ede6d5bfa7ac18fc520629847f49448530044fc4339e6f70',
  'Owner instruction of 2026-10-19 to treat the supplied wording as approved for implementation; source control field "Approved by and date: PJW 16/10/2026". Not independently verified solicitor approval.')
on conflict do nothing;

-- re-attach after a rollback (the rows exist but were retired): only where no other version of the purpose is current
update public.wiz_consent_versions v set status = 'current'
where v.status = 'retired' and v.legal_approved and v.artifact_id = 'privacy-2026-10-16-v1'
  and (v.purpose, v.version) in (('save_chats', '2'), ('personalisation', '2'), ('career_records', '2'), ('health_processing', '1'))
  and not exists (select 1 from public.wiz_consent_versions c where c.purpose = v.purpose and c.status = 'current');

-- 3. the fence: any recorded health_processing revoke moves it forward; nothing here ever clears it ---------------------------------
create or replace function public.wiz_health_fence() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.purpose = 'health_processing' and new.action = 'revoke' then
    insert into public.wiz_user_profiles (user_id, context_fence_at, learning_fence_hashes) values (new.user_id, new.created_at, '{}'::jsonb)
    on conflict (user_id) do update set
      context_fence_at = greatest(coalesce(public.wiz_user_profiles.context_fence_at, '-infinity'::timestamptz), excluded.context_fence_at),
      learning_fence_hashes = coalesce((
        select jsonb_object_agg(e.key, md5(e.value::text))
        from jsonb_each(case when jsonb_typeof(public.wiz_user_profiles.learning_profile) = 'object' then public.wiz_user_profiles.learning_profile else '{}'::jsonb end) e
      ), '{}'::jsonb);
  end if;
  return new;
end $$;
drop trigger if exists wiz_health_fence on public.wiz_consent_events;
create trigger wiz_health_fence after insert on public.wiz_consent_events
  for each row execute function public.wiz_health_fence();

-- 4. read-only state for enforcement ----------------------------------------------------------------------------------------------
-- decision: unavailable (no approved current health notice) | unanswered (no decision for the CURRENT version, e.g. a changed notice) |
-- granted | declined (a current-version revoke: decline or withdrawal)
create or replace function public.wiz_coaching_state(p_user_id uuid) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_terms public.wiz_terms_versions;
  v_health public.wiz_consent_versions;
  v_save public.wiz_consent_versions;
  v_last public.wiz_consent_events;
  v_fence timestamptz;
  v_decision text;
begin
  perform 1 from public.users where id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  select * into v_terms from public.wiz_terms_versions where status = 'current';
  select * into v_health from public.wiz_consent_versions where purpose = 'health_processing' and status = 'current' and legal_approved;
  select * into v_save from public.wiz_consent_versions where purpose = 'save_chats' and status = 'current' and legal_approved;
  select * into v_last from public.wiz_consent_events where user_id = p_user_id and purpose = 'health_processing' order by seq desc limit 1;
  select p.context_fence_at into v_fence from public.wiz_user_profiles p where p.user_id = p_user_id;
  v_decision := case
    when v_health.version is null then 'unavailable'
    when v_last.seq is null or v_last.version <> v_health.version then 'unanswered'
    when v_last.action = 'grant' then 'granted'
    else 'declined' end;
  return jsonb_build_object(
    'terms', jsonb_build_object('version', v_terms.version, 'accepted', v_terms.version is not null and exists (
      select 1 from public.wiz_terms_acceptances a where a.user_id = p_user_id and a.version = v_terms.version)),
    'health', jsonb_build_object('version', v_health.version, 'decision', v_decision,
      'decided_at', case when v_decision in ('granted', 'declined') then v_last.created_at end),
    -- chat retention is required to save (and so to hold) any conversation; it is reported, never decided, here
    'retention', jsonb_build_object('version', v_save.version, 'summary', v_save.summary,
      'granted', v_save.version is not null and public.wiz_consent_active(p_user_id, 'save_chats')),
    'fence_at', v_fence);
end $$;

create or replace function public.wiz_terms_current() returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('version', t.version, 'artifact_id', t.artifact_id, 'artifact_sha256', t.artifact_sha256)
  from public.wiz_terms_versions t where t.status = 'current';
$$;

-- 5. consent-gated context readers, re-created from the earlier migrations with the fence added -----------------------------------
create or replace function public.wiz_personalisation_context(p_user_id uuid, p_session_id uuid, p_max_sessions integer, p_per_session integer) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_cur public.wiz_session_meta;
  v_onb jsonb;
  v_sessions jsonb;
  v_fence timestamptz;
  v_max integer := least(greatest(coalesce(p_max_sessions, 3), 1), 5);
  v_per integer := least(greatest(coalesce(p_per_session, 4), 1), 8);
begin
  select * into v_cur from public.wiz_session_meta where session_id = p_session_id and user_id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  if not public.wiz_consent_gate(p_user_id, 'personalisation') then
    return jsonb_build_object('allowed', false);
  end if;
  select p.context_fence_at into v_fence from public.wiz_user_profiles p where p.user_id = p_user_id;
  -- onboarding answers are one merged document: once fenced they are not offered again
  select jsonb_build_object('answers', case when v_fence is null then p.onboarding else '{}'::jsonb end, 'version', p.onboarding_version) into v_onb
  from public.wiz_user_profiles p where p.user_id = p_user_id;
  select coalesce(jsonb_agg(c.j order by c.rel desc, c.updated_at desc, c.session_id), '[]'::jsonb) into v_sessions from (
    select o.session_id, o.rel, o.updated_at, jsonb_build_object(
      'session_id', o.session_id, 'session_number', o.session_number, 'title', o.title, 'track', o.track, 'lens', o.lens, 'topic', o.topic,
      'checkpoint', case when o.checkpoint is not null and pg_column_size(o.checkpoint) <= 4096 then o.checkpoint end,
      'messages', coalesce((
        select jsonb_agg(t.mj order by t.seq) from (
          select x.seq, jsonb_build_object('id', mm.id, 'seq', x.seq, 'sender', mm.sender, 'content', left(mm.content, 600), 'created_at', mm.created_at) as mj
          from public.wiz_message_meta x join public.messages mm on mm.id = x.message_id and mm.conversation_id = x.session_id
          where x.session_id = o.session_id and x.user_id = p_user_id and mm.sender in ('user', 'assistant')
          order by x.seq desc limit v_per
        ) t), '[]'::jsonb)) as j
    from (
      select m.session_id, m.session_number, m.track, m.lens, m.topic, m.checkpoint, cv.title, cv.updated_at,
        (case when m.lens is not null and m.lens = v_cur.lens then 2 else 0 end
         + case when m.track is not null and m.track = v_cur.track then 2 else 0 end
         + case when m.topic ->> 'area' is not null and m.topic ->> 'area' = v_cur.topic ->> 'area' then 1 else 0 end) as rel
      from public.wiz_session_meta m join public.conversations cv on cv.id = m.session_id and cv.user_id = m.user_id
      where m.user_id = p_user_id and m.session_id <> p_session_id and m.message_count > 0
        and (v_fence is null or cv.created_at > v_fence) -- a whole session that began at or before the fence (messages, checkpoint, summaries) stays out
      order by 9 desc, cv.updated_at desc, m.session_id limit v_max
    ) o
  ) c;
  return jsonb_build_object('allowed', true, 'onboarding', coalesce(v_onb, '{}'::jsonb), 'sessions', v_sessions);
end $$;

-- Recent history gains request_fence: the fence a reply was assembled under (provenance.request_fence). A reply whose request began before a
-- later withdrawal can arrive after it with a new created_at; the API drops such replies from future context (they may be derived from
-- context that was then withdrawn). Everything else in the result is unchanged.
create or replace function public.wiz_message_recent(p_user_id uuid, p_session_id uuid, p_limit integer) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
begin
  perform 1 from public.conversations where id = p_session_id and user_id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(t.j order by t.seq) from (
      select x.seq, jsonb_build_object('id', m.id, 'seq', x.seq, 'sender', m.sender, 'content', m.content,
        'tokens_used', m.tokens_used, 'model', x.model, 'created_at', m.created_at, 'sources', x.provenance -> 'sources',
        'request_fence', x.provenance ->> 'request_fence') as j
      from public.wiz_message_meta x join public.messages m on m.id = x.message_id and m.conversation_id = x.session_id
      where x.session_id = p_session_id and x.user_id = p_user_id
      order by x.seq desc limit least(greatest(coalesce(p_limit, 30), 1), 100)
    ) t), '[]'::jsonb));
end $$;

create or replace function public.wiz_evidence_ai_usable(p_user_id uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_fence timestamptz;
begin
  if not public.wiz_consent_gate(p_user_id, 'personalisation') then return '[]'::jsonb; end if;
  select p.context_fence_at into v_fence from public.wiz_user_profiles p where p.user_id = p_user_id;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', e.id, 'statement', e.statement, 'source', e.source,
      'confirmed_at', e.confirmed_at, 'version', e.version) order by e.created_at, e.id)
    from public.wiz_profile_evidence e
    where e.user_id = p_user_id and e.ai_use_enabled and e.confirmed_at is not null and e.revoked_at is null
      and (v_fence is null or e.created_at > v_fence)
  ), '[]'::jsonb);
end $$;

-- Fenced records come back only as genuinely new content: a career plan (delete + create), a learning profile whose text changed, new
-- portfolio entries and pulses. Old content is never re-offered because a grant, an AI-use switch or a plain re-save is on.
create or replace function public.wiz_career_context(p_user_id uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_fence timestamptz;
begin
  if not public.wiz_consent_gate(p_user_id, 'personalisation') then return jsonb_build_object('allowed', false); end if;
  select p.context_fence_at into v_fence from public.wiz_user_profiles p where p.user_id = p_user_id;
  return jsonb_build_object(
    'allowed', true,
    'plan', (select c.plan - 'goal_ids' - 'portfolio_ids' from public.wiz_career_plans c where c.user_id = p_user_id and c.ai_use_enabled and (v_fence is null or c.created_at > v_fence)),
    'plan_version', (select c.version from public.wiz_career_plans c where c.user_id = p_user_id and c.ai_use_enabled and (v_fence is null or c.created_at > v_fence)),
    -- once fenced, only the FIELDS whose value differs from the fence-time fingerprint are offered (a missing fingerprint offers nothing);
    -- re-saving, or editing one field, does not bring back the unchanged ones. self_recognition is never offered.
    'learning', (select case when v_fence is null then p.learning_profile - 'self_recognition'
        else coalesce((
          select jsonb_object_agg(e.key, e.value)
          from jsonb_each(case when jsonb_typeof(p.learning_profile) = 'object' then p.learning_profile else '{}'::jsonb end) e
          where e.key <> 'self_recognition' and p.learning_fence_hashes is not null
            and (p.learning_fence_hashes ->> e.key) is distinct from md5(e.value::text)
        ), '{}'::jsonb) end
      from public.wiz_user_profiles p where p.user_id = p_user_id and p.learning_ai_use and p.learning_profile is not null),
    'portfolio', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'entry_date', e.entry_date, 'entry_type', e.entry_type, 'title', e.title,
        'body', left(e.body, 500), 'competencies', e.competencies, 'habits', e.habits) order by e.entry_date desc, e.id)
      from (select * from public.wiz_portfolio_entries x where x.user_id = p_user_id and x.ai_use_enabled and (v_fence is null or x.created_at > v_fence)
        order by x.entry_date desc, x.id limit 5) e), '[]'::jsonb),
    'pulses', coalesce((
      select jsonb_agg(jsonb_build_object('id', q.id, 'observed_at', q.observed_at, 'stress', q.stress, 'energy', q.energy, 'note', left(q.note, 200)) order by q.observed_at desc, q.id desc)
      from (select * from public.wiz_wellbeing_pulses x where x.user_id = p_user_id and x.ai_use_enabled and (v_fence is null or x.created_at > v_fence)
        order by x.observed_at desc, x.id desc limit 6) q), '[]'::jsonb));
end $$;

-- 6. access --------------------------------------------------------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('wiz_coaching_state', 'wiz_terms_current', 'wiz_health_fence')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;

update public.wiz_migration_state set status = 'applied', applied_at = now(), rolled_back_at = null,
  captured = captured || jsonb_build_object(
    'owned', jsonb_build_object('functions', jsonb_build_array('public.wiz_coaching_state(uuid)', 'public.wiz_terms_current()')),
    'published', jsonb_build_array(
      jsonb_build_object('purpose', 'save_chats', 'version', '2'), jsonb_build_object('purpose', 'personalisation', 'version', '2'),
      jsonb_build_object('purpose', 'career_records', 'version', '2'), jsonb_build_object('purpose', 'health_processing', 'version', '1')),
    'retained', jsonb_build_object(
      'columns', jsonb_build_array('public.wiz_user_profiles.context_fence_at', 'public.wiz_user_profiles.learning_fence_hashes'),
      'trigger', 'public.wiz_consent_events.wiz_health_fence',
      'recreated', jsonb_build_array('wiz_personalisation_context(uuid, uuid, integer, integer)', 'wiz_evidence_ai_usable(uuid)', 'wiz_career_context(uuid)', 'wiz_message_recent(uuid, uuid, integer)')))
where name = 'wiz_health_consent_flow_20261020';
  $wiz_body$;
end $wiz_migration$;

commit;
