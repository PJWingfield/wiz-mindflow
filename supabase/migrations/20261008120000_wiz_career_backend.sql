-- WIZ Career Development backend (extension of 20261003120000_wiz_account_foundation).
--
-- PREPARED ONLY: not applied to any database. Requires the foundation migration to be applied first.
-- Purely additive:
--   * new tables (career plan, portfolio, prior learning, networking log, support map, wellbeing pulses, attachment metadata)
--   * three new columns on public.wiz_user_profiles (private learning profile + its version + explicit AI-use choice)
--   * one new consent purpose, career_records (seeded legal_approved = false, like the foundation notices)
--   * new owner-scoped service-role functions; browser roles (anon, authenticated, PUBLIC) get nothing
-- No foundation table, constraint, grant, policy or function is altered or dropped.
-- Ownership: every function filters by the caller-supplied owner (the API passes the VERIFIED bearer user id only).
-- Cross-record references (goal, prior learning, portfolio entry) are validated as same-owner by trigger.
-- Writes need an active career_records grant (wiz_consent_gate). Reads and deletes never do (privacy controls stay usable).
-- Rollback (data-preserving, drops only functions/triggers): supabase/rollbacks/20261008120000_wiz_career_backend.down.sql
-- Storage bucket provisioning is a SEPARATE, unapplied staging operation (see docs/CAREER-BACKEND.md); nothing here touches storage.

begin;
select pg_advisory_xact_lock(hashtextextended('wiz_career_backend_20261008', 0));

do $wiz_migration$
declare
  v_foundation text;
  v_status text;
  v_collision text;
begin
  if to_regclass('public.wiz_migration_state') is not null then
    execute $q$ select status from public.wiz_migration_state where name = 'wiz_account_foundation_20261003' $q$ into v_foundation;
  end if;
  if v_foundation is distinct from 'applied' then
    raise exception 'wiz career migration refused: the account foundation migration must be applied first (state: %)', coalesce(v_foundation, 'absent');
  end if;
  select status into v_status from public.wiz_migration_state where name = 'wiz_career_backend_20261008';
  if v_status = 'applied' then
    raise notice 'wiz career migration already applied; nothing changed';
    return;
  end if;
  if v_status = 'applying' then
    raise exception 'wiz career migration refused: a previous run left state applying';
  end if;
  if v_status is null then
    select string_agg(x, ', ') into v_collision from (
      select relname::text as x from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname in ('wiz_career_plans', 'wiz_portfolio_entries', 'wiz_prior_learning', 'wiz_networking_log', 'wiz_support_map', 'wiz_wellbeing_pulses', 'wiz_attachments')
      union all
      select p.proname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname ~ '^wiz_(career|portfolio|prior_learning|networking|support|pulse|learning|attachment)_'
    ) q;
    if v_collision is not null then
      raise exception 'wiz career migration refused: objects already exist but are not recorded as this migration: %', v_collision;
    end if;
  end if;

  execute $wiz_body$
insert into public.wiz_migration_state (name, status, captured) values ('wiz_career_backend_20261008', 'applying', '{}'::jsonb)
on conflict (name) do update set status = 'applying';

-- 1. consent purpose --------------------------------------------------------------------------------------
insert into public.wiz_consent_versions (purpose, version, status, summary, legal_approved) values
  ('career_records', '1', 'current', 'Keep the career plan, portfolio, networking, prior-learning, wellbeing and attachment records I choose to save on my account.', false)
on conflict do nothing;

-- 2. private learning profile on the existing profile row (additive columns) ---------------------------------
alter table public.wiz_user_profiles
  add column if not exists learning_profile jsonb check (learning_profile is null or (jsonb_typeof(learning_profile) = 'object' and pg_column_size(learning_profile) <= 8192)),
  add column if not exists learning_profile_version integer not null default 0,
  add column if not exists learning_ai_use boolean not null default false,
  add column if not exists learning_updated_at timestamptz;

-- 3. tables --------------------------------------------------------------------------------------------------
create table if not exists public.wiz_career_plans (
  user_id        uuid primary key references public.users (id) on delete cascade,
  plan           jsonb not null check (jsonb_typeof(plan) = 'object' and pg_column_size(plan) <= 24576),
  ai_use_enabled boolean not null default false,
  version        integer not null default 1,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists public.wiz_prior_learning (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users (id) on delete cascade,
  recorded_on date not null default current_date,
  experience  text not null check (char_length(experience) between 1 and 500),
  skill       text not null check (char_length(skill) between 1 and 500),
  application text not null check (char_length(application) between 1 and 500),
  version     integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists wiz_prior_learning_user_idx on public.wiz_prior_learning (user_id, created_at desc, id desc);

create table if not exists public.wiz_portfolio_entries (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users (id) on delete cascade,
  entry_date       date not null default current_date,
  entry_type       text not null check (entry_type in ('reference', 'work_experience', 'qualification', 'project', 'feedback', 'prior_learning', 'other')),
  title            text not null check (char_length(title) between 1 and 200),
  body             text not null check (char_length(body) between 1 and 5000),
  goal_id          uuid references public.wiz_goals (id) on delete set null,
  prior_learning_id uuid references public.wiz_prior_learning (id) on delete set null,
  competencies     jsonb not null default '[]'::jsonb check (jsonb_typeof(competencies) = 'array' and jsonb_array_length(competencies) <= 10 and pg_column_size(competencies) <= 2048),
  habits           jsonb not null default '[]'::jsonb check (jsonb_typeof(habits) = 'array' and jsonb_array_length(habits) <= 10 and pg_column_size(habits) <= 2048),
  ai_use_enabled   boolean not null default false,
  version          integer not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists wiz_portfolio_user_idx on public.wiz_portfolio_entries (user_id, created_at desc, id desc);
-- one promoted entry per prior-learning row (idempotent promotion); the link clears if the prior-learning row is deleted
create unique index if not exists wiz_portfolio_prior_learning_uidx on public.wiz_portfolio_entries (prior_learning_id) where prior_learning_id is not null;

create table if not exists public.wiz_networking_log (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users (id) on delete cascade,
  contact_label    text not null check (char_length(contact_label) between 1 and 200),
  interaction_date date not null default current_date,
  note             text check (note is null or char_length(note) <= 2000),
  follow_up_date   date,
  version          integer not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists wiz_networking_user_idx on public.wiz_networking_log (user_id, created_at desc, id desc);

create table if not exists public.wiz_support_map (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users (id) on delete cascade,
  label             text not null check (char_length(label) between 1 and 200),
  support_role      text not null check (char_length(support_role) between 1 and 300),
  direction         text check (direction is null or direction in ('supports', 'makes_harder')),
  note              text check (note is null or char_length(note) <= 2000),
  last_contact_date date,
  next_contact_date date,
  version           integer not null default 1,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists wiz_support_user_idx on public.wiz_support_map (user_id, created_at desc, id desc);

-- Higher stress = more stressed/overwhelmed (worse). Higher energy = more energetic (better). Multiple observations are kept.
create table if not exists public.wiz_wellbeing_pulses (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.users (id) on delete cascade,
  observed_at    timestamptz not null default now(),
  stress         smallint not null check (stress between 1 and 10),
  energy         smallint not null check (energy between 1 and 10),
  note           text check (note is null or char_length(note) <= 500),
  ai_use_enabled boolean not null default false,
  version        integer not null default 1,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists wiz_pulses_user_idx on public.wiz_wellbeing_pulses (user_id, observed_at desc, id desc);

-- Metadata only. The bytes live in a PRIVATE storage bucket under the server-selected object_key; the key is never client-supplied.
create table if not exists public.wiz_attachments (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.users (id) on delete cascade,
  portfolio_entry_id uuid not null references public.wiz_portfolio_entries (id),
  object_key         text not null unique check (object_key ~ '^u/[0-9a-f-]{36}/[0-9a-f-]{36}$'),
  filename           text not null check (char_length(filename) between 1 and 120),
  mime_type          text not null check (mime_type in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain')),
  declared_size      integer not null check (declared_size between 1 and 5242880),
  size_bytes         integer check (size_bytes is null or size_bytes between 1 and 5242880),
  sha256             text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  state              text not null default 'pending' check (state in ('pending', 'ready', 'deleting', 'delete_failed')),
  cleanup_attempts   integer not null default 0,
  cleanup_error      text check (cleanup_error is null or char_length(cleanup_error) <= 100),
  created_at         timestamptz not null default now(),
  finalised_at       timestamptz,
  updated_at         timestamptz not null default now()
);
create index if not exists wiz_attachments_user_idx on public.wiz_attachments (user_id, portfolio_entry_id);

-- 4. triggers ------------------------------------------------------------------------------------------------
-- same-owner reference validation (goal, prior learning, portfolio entry); a foreign or unknown id is rejected identically
create or replace function public.wiz_career_assert_refs() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare j jsonb := to_jsonb(new);
begin
  if j ->> 'goal_id' is not null and not exists (select 1 from public.wiz_goals g where g.id = (j ->> 'goal_id')::uuid and g.user_id = new.user_id) then
    raise exception 'wiz:invalid_reference' using errcode = 'P0001';
  end if;
  if j ->> 'prior_learning_id' is not null and not exists (select 1 from public.wiz_prior_learning p where p.id = (j ->> 'prior_learning_id')::uuid and p.user_id = new.user_id) then
    raise exception 'wiz:invalid_reference' using errcode = 'P0001';
  end if;
  if j ->> 'portfolio_entry_id' is not null and not exists (select 1 from public.wiz_portfolio_entries e where e.id = (j ->> 'portfolio_entry_id')::uuid and e.user_id = new.user_id) then
    raise exception 'wiz:invalid_reference' using errcode = 'P0001';
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['wiz_career_plans', 'wiz_prior_learning', 'wiz_portfolio_entries', 'wiz_networking_log', 'wiz_support_map', 'wiz_wellbeing_pulses', 'wiz_attachments'] loop
    execute format('drop trigger if exists wiz_touch_updated_at on public.%I', t);
    execute format('create trigger wiz_touch_updated_at before update on public.%I for each row execute function public.wiz_touch_updated_at()', t);
  end loop;
  foreach t in array array['wiz_portfolio_entries', 'wiz_attachments'] loop
    execute format('drop trigger if exists wiz_career_assert_refs on public.%I', t);
    execute format('create trigger wiz_career_assert_refs before insert or update on public.%I for each row execute function public.wiz_career_assert_refs()', t);
  end loop;
end $$;

-- 5. functions -------------------------------------------------------------------------------------------------
-- kind registry for the generic get/list/delete functions: table, ordering column, JSON projection (alias t)
create or replace function public.wiz_career_kind(p_kind text) returns table (tbl text, ord text, expr text)
language sql immutable set search_path = public, pg_temp as $$
  select k.tbl, k.ord, k.expr from (values
    ('portfolio', 'wiz_portfolio_entries', 'created_at', '(to_jsonb(t) - ''user_id'')'),
    ('prior_learning', 'wiz_prior_learning', 'created_at',
      '((to_jsonb(t) - ''user_id'') || jsonb_build_object(''promoted_entry_id'', (select e.id from public.wiz_portfolio_entries e where e.prior_learning_id = t.id and e.user_id = t.user_id)))'),
    ('networking', 'wiz_networking_log', 'created_at', '(to_jsonb(t) - ''user_id'')'),
    ('support', 'wiz_support_map', 'created_at', '(to_jsonb(t) - ''user_id'')'),
    ('pulse', 'wiz_wellbeing_pulses', 'observed_at', '(to_jsonb(t) - ''user_id'')')
  ) as k(kind, tbl, ord, expr) where k.kind = p_kind;
$$;

create or replace function public.wiz_career_require_user(p_user_id uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
begin
  perform 1 from public.users where id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
end $$;

-- every career WRITE calls this first (lock order: notice -> user consent -> rows)
create or replace function public.wiz_career_write_gate(p_user_id uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
begin
  perform public.wiz_career_require_user(p_user_id);
  if not public.wiz_consent_gate(p_user_id, 'career_records') then perform public.wiz_fail('consent_required'); end if;
end $$;

create or replace function public.wiz_career_get(p_user_id uuid, p_kind text, p_id uuid) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare k record; v jsonb;
begin
  select * into k from public.wiz_career_kind(p_kind);
  if k.tbl is null then perform public.wiz_fail('invalid_input'); end if;
  execute format('select %s from public.%I t where t.id = $1 and t.user_id = $2', k.expr, k.tbl) into v using p_id, p_user_id;
  if v is null then perform public.wiz_fail('not_found'); end if;
  return v;
end $$;

create or replace function public.wiz_career_list(p_user_id uuid, p_kind text, p_limit integer, p_before_ts timestamptz, p_before_id uuid) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare k record; v_all jsonb; v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100); v_items jsonb; v_next jsonb;
begin
  select * into k from public.wiz_career_kind(p_kind);
  if k.tbl is null then perform public.wiz_fail('invalid_input'); end if;
  execute format($f$
    select coalesce(jsonb_agg(jsonb_build_object('j', x.j, 'o', x.o, 'id', x.id) order by x.o desc, x.id desc), '[]'::jsonb) from (
      select %1$s as j, t.%3$I as o, t.id from public.%2$I t
      where t.user_id = $1 and ($2::timestamptz is null or (t.%3$I, t.id) < ($2::timestamptz, $3::uuid))
      order by t.%3$I desc, t.id desc limit $4 + 1) x$f$, k.expr, k.tbl, k.ord)
    into v_all using p_user_id, p_before_ts, p_before_id, v_limit;
  select coalesce(jsonb_agg(w.e -> 'j' order by w.n), '[]'::jsonb) into v_items from jsonb_array_elements(v_all) with ordinality as w(e, n) where w.n <= v_limit;
  if jsonb_array_length(v_all) > v_limit then
    v_next := jsonb_build_object('ts', v_all -> (v_limit - 1) -> 'o', 'id', v_all -> (v_limit - 1) -> 'id');
  end if;
  return jsonb_build_object('items', v_items, 'next', v_next);
end $$;

create or replace function public.wiz_career_delete(p_user_id uuid, p_kind text, p_id uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare k record; v_n integer;
begin
  select * into k from public.wiz_career_kind(p_kind);
  if k.tbl is null then perform public.wiz_fail('invalid_input'); end if;
  -- attachment bytes must be removed first (the API orchestrates), so metadata is never orphaned from its object
  if p_kind = 'portfolio' and exists (select 1 from public.wiz_attachments a where a.portfolio_entry_id = p_id and a.user_id = p_user_id) then
    perform public.wiz_fail('has_attachments');
  end if;
  execute format('delete from public.%I where id = $1 and user_id = $2', k.tbl) using p_id, p_user_id;
  get diagnostics v_n = row_count;
  if v_n = 0 then perform public.wiz_fail('not_found'); end if;
  return jsonb_build_object('deleted', true);
end $$;

-- career plan (singleton) -----------------------------------------------------------------------------------
create or replace function public.wiz_career_plan_json(p_user_id uuid) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'plan', jsonb_set(jsonb_set(c.plan, '{goal_ids}', coalesce((
        select jsonb_agg(g) from jsonb_array_elements_text(coalesce(c.plan -> 'goal_ids', '[]'::jsonb)) g
        where exists (select 1 from public.wiz_goals x where x.id = g::uuid and x.user_id = c.user_id)), '[]'::jsonb)),
      '{portfolio_ids}', coalesce((
        select jsonb_agg(g) from jsonb_array_elements_text(coalesce(c.plan -> 'portfolio_ids', '[]'::jsonb)) g
        where exists (select 1 from public.wiz_portfolio_entries x where x.id = g::uuid and x.user_id = c.user_id)), '[]'::jsonb)),
    'ai_use_enabled', c.ai_use_enabled, 'version', c.version, 'created_at', c.created_at, 'updated_at', c.updated_at)
  from public.wiz_career_plans c where c.user_id = p_user_id;
$$;

create or replace function public.wiz_career_plan_get(p_user_id uuid) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('item', public.wiz_career_plan_json(p_user_id));
$$;

create or replace function public.wiz_career_plan_put(p_user_id uuid, p_plan jsonb, p_expected_version integer) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_row public.wiz_career_plans; g text;
begin
  perform public.wiz_career_write_gate(p_user_id);
  for g in select jsonb_array_elements_text(coalesce(p_plan -> 'goal_ids', '[]'::jsonb)) loop
    if not exists (select 1 from public.wiz_goals x where x.id = g::uuid and x.user_id = p_user_id) then perform public.wiz_fail('invalid_reference'); end if;
  end loop;
  for g in select jsonb_array_elements_text(coalesce(p_plan -> 'portfolio_ids', '[]'::jsonb)) loop
    if not exists (select 1 from public.wiz_portfolio_entries x where x.id = g::uuid and x.user_id = p_user_id) then perform public.wiz_fail('invalid_reference'); end if;
  end loop;
  select * into v_row from public.wiz_career_plans where user_id = p_user_id for update;
  if not found then
    if coalesce(p_expected_version, 0) <> 0 then perform public.wiz_fail('version_conflict'); end if;
    insert into public.wiz_career_plans (user_id, plan) values (p_user_id, p_plan);
  else
    if p_expected_version is distinct from v_row.version then perform public.wiz_fail('version_conflict'); end if;
    update public.wiz_career_plans set plan = p_plan, version = version + 1 where user_id = p_user_id;
  end if;
  return jsonb_build_object('item', public.wiz_career_plan_json(p_user_id));
end $$;

create or replace function public.wiz_career_plan_delete(p_user_id uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_n integer;
begin
  delete from public.wiz_career_plans where user_id = p_user_id;
  get diagnostics v_n = row_count;
  if v_n = 0 then perform public.wiz_fail('not_found'); end if;
  return jsonb_build_object('deleted', true);
end $$;

create or replace function public.wiz_career_plan_set_ai_use(p_user_id uuid, p_enabled boolean) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
begin
  perform 1 from public.wiz_career_plans where user_id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  if p_enabled and not public.wiz_consent_gate(p_user_id, 'personalisation') then perform public.wiz_fail('consent_required'); end if;
  update public.wiz_career_plans set ai_use_enabled = p_enabled where user_id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  return jsonb_build_object('item', public.wiz_career_plan_json(p_user_id));
end $$;

-- private learning profile -----------------------------------------------------------------------------------
create or replace function public.wiz_learning_json(p_user_id uuid) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select case when p.learning_profile is null then null else jsonb_build_object(
    'profile', p.learning_profile, 'version', p.learning_profile_version, 'ai_use_enabled', p.learning_ai_use, 'updated_at', p.learning_updated_at) end
  from public.wiz_user_profiles p where p.user_id = p_user_id;
$$;

create or replace function public.wiz_learning_get(p_user_id uuid) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('item', public.wiz_learning_json(p_user_id));
$$;

create or replace function public.wiz_learning_put(p_user_id uuid, p_profile jsonb, p_expected_version integer) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_row public.wiz_user_profiles;
begin
  perform public.wiz_career_write_gate(p_user_id);
  insert into public.wiz_user_profiles (user_id) values (p_user_id) on conflict do nothing;
  select * into v_row from public.wiz_user_profiles where user_id = p_user_id for update;
  if coalesce(p_expected_version, 0) <> v_row.learning_profile_version then perform public.wiz_fail('version_conflict'); end if;
  update public.wiz_user_profiles set learning_profile = p_profile, learning_profile_version = learning_profile_version + 1, learning_updated_at = now()
    where user_id = p_user_id;
  return jsonb_build_object('item', public.wiz_learning_json(p_user_id));
end $$;

-- clearing removes the content and the AI-use choice; the version counter keeps rising so stale clients conflict
create or replace function public.wiz_learning_delete(p_user_id uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
begin
  perform 1 from public.wiz_user_profiles where user_id = p_user_id and learning_profile is not null for update;
  if not found then perform public.wiz_fail('not_found'); end if;
  update public.wiz_user_profiles set learning_profile = null, learning_ai_use = false, learning_profile_version = learning_profile_version + 1, learning_updated_at = now()
    where user_id = p_user_id;
  return jsonb_build_object('deleted', true);
end $$;

create or replace function public.wiz_learning_set_ai_use(p_user_id uuid, p_enabled boolean) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
begin
  perform 1 from public.wiz_user_profiles where user_id = p_user_id and learning_profile is not null;
  if not found then perform public.wiz_fail('not_found'); end if;
  if p_enabled and not public.wiz_consent_gate(p_user_id, 'personalisation') then perform public.wiz_fail('consent_required'); end if;
  update public.wiz_user_profiles set learning_ai_use = p_enabled where user_id = p_user_id and learning_profile is not null;
  if not found then perform public.wiz_fail('not_found'); end if;
  return jsonb_build_object('item', public.wiz_learning_json(p_user_id));
end $$;

-- portfolio -----------------------------------------------------------------------------------------------------
create or replace function public.wiz_portfolio_create(p_user_id uuid, p_data jsonb, p_key text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_existing uuid; v_row public.wiz_portfolio_entries;
begin
  perform public.wiz_career_write_gate(p_user_id);
  v_existing := public.wiz_idem_claim(p_user_id, 'portfolio', p_key, p_data);
  if v_existing is not null then
    if not exists (select 1 from public.wiz_portfolio_entries where id = v_existing and user_id = p_user_id) then perform public.wiz_fail('idempotent_target_gone'); end if;
    return jsonb_build_object('item', public.wiz_career_get(p_user_id, 'portfolio', v_existing), 'replayed', true);
  end if;
  insert into public.wiz_portfolio_entries (user_id, entry_date, entry_type, title, body, goal_id, competencies, habits)
  values (p_user_id, coalesce(nullif(p_data ->> 'entry_date', '')::date, current_date), p_data ->> 'entry_type', p_data ->> 'title', p_data ->> 'body',
    nullif(p_data ->> 'goal_id', '')::uuid, coalesce(p_data -> 'competencies', '[]'::jsonb), coalesce(p_data -> 'habits', '[]'::jsonb))
  returning * into v_row;
  perform public.wiz_idem_set(p_user_id, 'portfolio', p_key, v_row.id);
  return jsonb_build_object('item', public.wiz_career_get(p_user_id, 'portfolio', v_row.id), 'replayed', false);
end $$;

create or replace function public.wiz_portfolio_update(p_user_id uuid, p_id uuid, p_patch jsonb, p_expected_version integer) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_row public.wiz_portfolio_entries;
begin
  perform public.wiz_career_write_gate(p_user_id);
  select * into v_row from public.wiz_portfolio_entries where id = p_id and user_id = p_user_id for update;
  if not found then perform public.wiz_fail('not_found'); end if;
  if p_expected_version is distinct from v_row.version then perform public.wiz_fail('version_conflict'); end if;
  update public.wiz_portfolio_entries set
    entry_date = case when p_patch ? 'entry_date' then (p_patch ->> 'entry_date')::date else entry_date end,
    entry_type = case when p_patch ? 'entry_type' then p_patch ->> 'entry_type' else entry_type end,
    title = case when p_patch ? 'title' then p_patch ->> 'title' else title end,
    body = case when p_patch ? 'body' then p_patch ->> 'body' else body end,
    goal_id = case when p_patch ? 'goal_id' then nullif(p_patch ->> 'goal_id', '')::uuid else goal_id end,
    competencies = case when p_patch ? 'competencies' then p_patch -> 'competencies' else competencies end,
    habits = case when p_patch ? 'habits' then p_patch -> 'habits' else habits end,
    version = version + 1
  where id = p_id and user_id = p_user_id;
  return public.wiz_career_get(p_user_id, 'portfolio', p_id);
end $$;

-- enabling needs the personalisation consent; disabling never does. Saving alone never sets this.
create or replace function public.wiz_portfolio_set_ai_use(p_user_id uuid, p_id uuid, p_enabled boolean) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
begin
  perform 1 from public.wiz_portfolio_entries where id = p_id and user_id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  if p_enabled and not public.wiz_consent_gate(p_user_id, 'personalisation') then perform public.wiz_fail('consent_required'); end if;
  update public.wiz_portfolio_entries set ai_use_enabled = p_enabled where id = p_id and user_id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  return public.wiz_career_get(p_user_id, 'portfolio', p_id);
end $$;

-- prior learning ---------------------------------------------------------------------------------------------------
create or replace function public.wiz_prior_learning_create(p_user_id uuid, p_data jsonb, p_key text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_existing uuid; v_row public.wiz_prior_learning;
begin
  perform public.wiz_career_write_gate(p_user_id);
  v_existing := public.wiz_idem_claim(p_user_id, 'prior_learning', p_key, p_data);
  if v_existing is not null then
    if not exists (select 1 from public.wiz_prior_learning where id = v_existing and user_id = p_user_id) then perform public.wiz_fail('idempotent_target_gone'); end if;
    return jsonb_build_object('item', public.wiz_career_get(p_user_id, 'prior_learning', v_existing), 'replayed', true);
  end if;
  insert into public.wiz_prior_learning (user_id, recorded_on, experience, skill, application)
  values (p_user_id, coalesce(nullif(p_data ->> 'recorded_on', '')::date, current_date), p_data ->> 'experience', p_data ->> 'skill', p_data ->> 'application')
  returning * into v_row;
  perform public.wiz_idem_set(p_user_id, 'prior_learning', p_key, v_row.id);
  return jsonb_build_object('item', public.wiz_career_get(p_user_id, 'prior_learning', v_row.id), 'replayed', false);
end $$;

create or replace function public.wiz_prior_learning_update(p_user_id uuid, p_id uuid, p_patch jsonb, p_expected_version integer) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_row public.wiz_prior_learning;
begin
  perform public.wiz_career_write_gate(p_user_id);
  select * into v_row from public.wiz_prior_learning where id = p_id and user_id = p_user_id for update;
  if not found then perform public.wiz_fail('not_found'); end if;
  if p_expected_version is distinct from v_row.version then perform public.wiz_fail('version_conflict'); end if;
  update public.wiz_prior_learning set
    recorded_on = case when p_patch ? 'recorded_on' then (p_patch ->> 'recorded_on')::date else recorded_on end,
    experience = case when p_patch ? 'experience' then p_patch ->> 'experience' else experience end,
    skill = case when p_patch ? 'skill' then p_patch ->> 'skill' else skill end,
    application = case when p_patch ? 'application' then p_patch ->> 'application' else application end,
    version = version + 1
  where id = p_id and user_id = p_user_id;
  return public.wiz_career_get(p_user_id, 'prior_learning', p_id);
end $$;

-- Explicit promotion: copies the content into ONE linked portfolio entry (independent afterwards). Repeating it, with or
-- without an Idempotency-Key, returns the same entry. Deleting the prior-learning row later clears the link only.
create or replace function public.wiz_prior_learning_promote(p_user_id uuid, p_id uuid, p_key text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_existing uuid; v_pl public.wiz_prior_learning; v_entry uuid;
begin
  perform public.wiz_career_write_gate(p_user_id);
  v_existing := public.wiz_idem_claim(p_user_id, 'prior_promote', p_key, jsonb_build_object('id', p_id));
  if v_existing is not null then
    if not exists (select 1 from public.wiz_portfolio_entries where id = v_existing and user_id = p_user_id) then perform public.wiz_fail('idempotent_target_gone'); end if;
    return jsonb_build_object('item', public.wiz_career_get(p_user_id, 'portfolio', v_existing), 'replayed', true);
  end if;
  select * into v_pl from public.wiz_prior_learning where id = p_id and user_id = p_user_id for update;
  if not found then perform public.wiz_fail('not_found'); end if;
  select e.id into v_entry from public.wiz_portfolio_entries e where e.prior_learning_id = p_id and e.user_id = p_user_id;
  if v_entry is not null then
    perform public.wiz_idem_set(p_user_id, 'prior_promote', p_key, v_entry);
    return jsonb_build_object('item', public.wiz_career_get(p_user_id, 'portfolio', v_entry), 'replayed', true);
  end if;
  insert into public.wiz_portfolio_entries (user_id, entry_date, entry_type, title, body, prior_learning_id)
  values (p_user_id, v_pl.recorded_on, 'prior_learning', left(v_pl.skill, 200),
    left('Experience: ' || v_pl.experience || E'\nSkill built: ' || v_pl.skill || E'\nWhere I could use this: ' || v_pl.application, 5000), p_id)
  returning id into v_entry;
  perform public.wiz_idem_set(p_user_id, 'prior_promote', p_key, v_entry);
  return jsonb_build_object('item', public.wiz_career_get(p_user_id, 'portfolio', v_entry), 'replayed', false);
end $$;

-- networking log and support map (independent records) ---------------------------------------------------------------
create or replace function public.wiz_networking_create(p_user_id uuid, p_data jsonb, p_key text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_existing uuid; v_row public.wiz_networking_log;
begin
  perform public.wiz_career_write_gate(p_user_id);
  v_existing := public.wiz_idem_claim(p_user_id, 'networking', p_key, p_data);
  if v_existing is not null then
    if not exists (select 1 from public.wiz_networking_log where id = v_existing and user_id = p_user_id) then perform public.wiz_fail('idempotent_target_gone'); end if;
    return jsonb_build_object('item', public.wiz_career_get(p_user_id, 'networking', v_existing), 'replayed', true);
  end if;
  insert into public.wiz_networking_log (user_id, contact_label, interaction_date, note, follow_up_date)
  values (p_user_id, p_data ->> 'contact_label', coalesce(nullif(p_data ->> 'interaction_date', '')::date, current_date), p_data ->> 'note', nullif(p_data ->> 'follow_up_date', '')::date)
  returning * into v_row;
  perform public.wiz_idem_set(p_user_id, 'networking', p_key, v_row.id);
  return jsonb_build_object('item', public.wiz_career_get(p_user_id, 'networking', v_row.id), 'replayed', false);
end $$;

create or replace function public.wiz_networking_update(p_user_id uuid, p_id uuid, p_patch jsonb, p_expected_version integer) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_row public.wiz_networking_log;
begin
  perform public.wiz_career_write_gate(p_user_id);
  select * into v_row from public.wiz_networking_log where id = p_id and user_id = p_user_id for update;
  if not found then perform public.wiz_fail('not_found'); end if;
  if p_expected_version is distinct from v_row.version then perform public.wiz_fail('version_conflict'); end if;
  update public.wiz_networking_log set
    contact_label = case when p_patch ? 'contact_label' then p_patch ->> 'contact_label' else contact_label end,
    interaction_date = case when p_patch ? 'interaction_date' then (p_patch ->> 'interaction_date')::date else interaction_date end,
    note = case when p_patch ? 'note' then p_patch ->> 'note' else note end,
    follow_up_date = case when p_patch ? 'follow_up_date' then nullif(p_patch ->> 'follow_up_date', '')::date else follow_up_date end,
    version = version + 1
  where id = p_id and user_id = p_user_id;
  return public.wiz_career_get(p_user_id, 'networking', p_id);
end $$;

create or replace function public.wiz_support_create(p_user_id uuid, p_data jsonb, p_key text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_existing uuid; v_row public.wiz_support_map;
begin
  perform public.wiz_career_write_gate(p_user_id);
  v_existing := public.wiz_idem_claim(p_user_id, 'support', p_key, p_data);
  if v_existing is not null then
    if not exists (select 1 from public.wiz_support_map where id = v_existing and user_id = p_user_id) then perform public.wiz_fail('idempotent_target_gone'); end if;
    return jsonb_build_object('item', public.wiz_career_get(p_user_id, 'support', v_existing), 'replayed', true);
  end if;
  insert into public.wiz_support_map (user_id, label, support_role, direction, note, last_contact_date, next_contact_date)
  values (p_user_id, p_data ->> 'label', p_data ->> 'support_role', p_data ->> 'direction', p_data ->> 'note',
    nullif(p_data ->> 'last_contact_date', '')::date, nullif(p_data ->> 'next_contact_date', '')::date)
  returning * into v_row;
  perform public.wiz_idem_set(p_user_id, 'support', p_key, v_row.id);
  return jsonb_build_object('item', public.wiz_career_get(p_user_id, 'support', v_row.id), 'replayed', false);
end $$;

create or replace function public.wiz_support_update(p_user_id uuid, p_id uuid, p_patch jsonb, p_expected_version integer) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_row public.wiz_support_map;
begin
  perform public.wiz_career_write_gate(p_user_id);
  select * into v_row from public.wiz_support_map where id = p_id and user_id = p_user_id for update;
  if not found then perform public.wiz_fail('not_found'); end if;
  if p_expected_version is distinct from v_row.version then perform public.wiz_fail('version_conflict'); end if;
  update public.wiz_support_map set
    label = case when p_patch ? 'label' then p_patch ->> 'label' else label end,
    support_role = case when p_patch ? 'support_role' then p_patch ->> 'support_role' else support_role end,
    direction = case when p_patch ? 'direction' then p_patch ->> 'direction' else direction end,
    note = case when p_patch ? 'note' then p_patch ->> 'note' else note end,
    last_contact_date = case when p_patch ? 'last_contact_date' then nullif(p_patch ->> 'last_contact_date', '')::date else last_contact_date end,
    next_contact_date = case when p_patch ? 'next_contact_date' then nullif(p_patch ->> 'next_contact_date', '')::date else next_contact_date end,
    version = version + 1
  where id = p_id and user_id = p_user_id;
  return public.wiz_career_get(p_user_id, 'support', p_id);
end $$;

-- wellbeing pulses -----------------------------------------------------------------------------------------------------
create or replace function public.wiz_pulse_create(p_user_id uuid, p_data jsonb, p_key text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_existing uuid; v_row public.wiz_wellbeing_pulses; v_at timestamptz := coalesce(nullif(p_data ->> 'observed_at', '')::timestamptz, now());
begin
  perform public.wiz_career_write_gate(p_user_id);
  if v_at > now() + interval '1 minute' then perform public.wiz_fail('invalid_input'); end if;
  v_existing := public.wiz_idem_claim(p_user_id, 'pulse', p_key, p_data);
  if v_existing is not null then
    if not exists (select 1 from public.wiz_wellbeing_pulses where id = v_existing and user_id = p_user_id) then perform public.wiz_fail('idempotent_target_gone'); end if;
    return jsonb_build_object('item', public.wiz_career_get(p_user_id, 'pulse', v_existing), 'replayed', true);
  end if;
  insert into public.wiz_wellbeing_pulses (user_id, observed_at, stress, energy, note)
  values (p_user_id, v_at, (p_data ->> 'stress')::smallint, (p_data ->> 'energy')::smallint, p_data ->> 'note')
  returning * into v_row;
  perform public.wiz_idem_set(p_user_id, 'pulse', p_key, v_row.id);
  return jsonb_build_object('item', public.wiz_career_get(p_user_id, 'pulse', v_row.id), 'replayed', false);
end $$;

create or replace function public.wiz_pulse_update(p_user_id uuid, p_id uuid, p_patch jsonb, p_expected_version integer) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_row public.wiz_wellbeing_pulses;
begin
  perform public.wiz_career_write_gate(p_user_id);
  select * into v_row from public.wiz_wellbeing_pulses where id = p_id and user_id = p_user_id for update;
  if not found then perform public.wiz_fail('not_found'); end if;
  if p_expected_version is distinct from v_row.version then perform public.wiz_fail('version_conflict'); end if;
  if p_patch ? 'observed_at' and (p_patch ->> 'observed_at')::timestamptz > now() + interval '1 minute' then perform public.wiz_fail('invalid_input'); end if;
  update public.wiz_wellbeing_pulses set
    observed_at = case when p_patch ? 'observed_at' then (p_patch ->> 'observed_at')::timestamptz else observed_at end,
    stress = case when p_patch ? 'stress' then (p_patch ->> 'stress')::smallint else stress end,
    energy = case when p_patch ? 'energy' then (p_patch ->> 'energy')::smallint else energy end,
    note = case when p_patch ? 'note' then p_patch ->> 'note' else note end,
    version = version + 1
  where id = p_id and user_id = p_user_id;
  return public.wiz_career_get(p_user_id, 'pulse', p_id);
end $$;

create or replace function public.wiz_pulse_set_ai_use(p_user_id uuid, p_id uuid, p_enabled boolean) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
begin
  perform 1 from public.wiz_wellbeing_pulses where id = p_id and user_id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  if p_enabled and not public.wiz_consent_gate(p_user_id, 'personalisation') then perform public.wiz_fail('consent_required'); end if;
  update public.wiz_wellbeing_pulses set ai_use_enabled = p_enabled where id = p_id and user_id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  return public.wiz_career_get(p_user_id, 'pulse', p_id);
end $$;

-- Retained career context for coaching. Needs ACTIVE personalisation consent (checked here, at assembly time) AND the
-- separate per-item/profile AI-use choice. Networking, support map and prior learning are never included. The
-- learning profile's self-recognition text is never included even when the rest is allowed.
create or replace function public.wiz_career_context(p_user_id uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
begin
  if not public.wiz_consent_gate(p_user_id, 'personalisation') then return jsonb_build_object('allowed', false); end if;
  return jsonb_build_object(
    'allowed', true,
    'plan', (select c.plan - 'goal_ids' - 'portfolio_ids' from public.wiz_career_plans c where c.user_id = p_user_id and c.ai_use_enabled),
    'plan_version', (select c.version from public.wiz_career_plans c where c.user_id = p_user_id and c.ai_use_enabled),
    'learning', (select p.learning_profile - 'self_recognition' from public.wiz_user_profiles p where p.user_id = p_user_id and p.learning_ai_use and p.learning_profile is not null),
    'portfolio', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'entry_date', e.entry_date, 'entry_type', e.entry_type, 'title', e.title,
        'body', left(e.body, 500), 'competencies', e.competencies, 'habits', e.habits) order by e.entry_date desc, e.id)
      from (select * from public.wiz_portfolio_entries x where x.user_id = p_user_id and x.ai_use_enabled order by x.entry_date desc, x.id limit 5) e), '[]'::jsonb),
    'pulses', coalesce((
      select jsonb_agg(jsonb_build_object('id', q.id, 'observed_at', q.observed_at, 'stress', q.stress, 'energy', q.energy, 'note', left(q.note, 200)) order by q.observed_at desc, q.id desc)
      from (select * from public.wiz_wellbeing_pulses x where x.user_id = p_user_id and x.ai_use_enabled order by x.observed_at desc, x.id desc limit 6) q), '[]'::jsonb));
end $$;

-- attachment metadata ------------------------------------------------------------------------------------------------
create or replace function public.wiz_attachment_create(p_user_id uuid, p_entry_id uuid, p_data jsonb, p_key text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_existing uuid; v_row public.wiz_attachments; v_id uuid := gen_random_uuid();
begin
  perform public.wiz_career_write_gate(p_user_id);
  perform 1 from public.wiz_portfolio_entries where id = p_entry_id and user_id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  v_existing := public.wiz_idem_claim(p_user_id, 'attachment', p_key, p_data || jsonb_build_object('entry', p_entry_id));
  if v_existing is not null then
    select * into v_row from public.wiz_attachments where id = v_existing and user_id = p_user_id;
    if not found then perform public.wiz_fail('idempotent_target_gone'); end if;
    return jsonb_build_object('item', to_jsonb(v_row) - 'user_id', 'replayed', true);
  end if;
  if (select count(*) from public.wiz_attachments where portfolio_entry_id = p_entry_id and user_id = p_user_id) >= 5
     or (select count(*) from public.wiz_attachments where user_id = p_user_id) >= 100 then
    perform public.wiz_fail('attachment_limit');
  end if;
  insert into public.wiz_attachments (id, user_id, portfolio_entry_id, object_key, filename, mime_type, declared_size)
  values (v_id, p_user_id, p_entry_id, 'u/' || p_user_id::text || '/' || v_id::text, p_data ->> 'filename', p_data ->> 'mime_type', (p_data ->> 'size')::integer)
  returning * into v_row;
  perform public.wiz_idem_set(p_user_id, 'attachment', p_key, v_row.id);
  return jsonb_build_object('item', to_jsonb(v_row) - 'user_id', 'replayed', false);
end $$;

create or replace function public.wiz_attachment_get(p_user_id uuid, p_id uuid) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare v_row public.wiz_attachments;
begin
  select * into v_row from public.wiz_attachments where id = p_id and user_id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  return to_jsonb(v_row) - 'user_id';
end $$;

create or replace function public.wiz_attachment_list(p_user_id uuid, p_entry_id uuid) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
begin
  perform 1 from public.wiz_portfolio_entries where id = p_entry_id and user_id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  return coalesce((select jsonb_agg(to_jsonb(a) - 'user_id' order by a.created_at, a.id) from public.wiz_attachments a where a.portfolio_entry_id = p_entry_id and a.user_id = p_user_id), '[]'::jsonb);
end $$;

create or replace function public.wiz_attachment_finalise(p_user_id uuid, p_id uuid, p_size integer, p_sha256 text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_row public.wiz_attachments;
begin
  perform public.wiz_career_write_gate(p_user_id);
  select * into v_row from public.wiz_attachments where id = p_id and user_id = p_user_id for update;
  if not found then perform public.wiz_fail('not_found'); end if;
  if v_row.state = 'ready' and v_row.size_bytes = p_size and v_row.sha256 = p_sha256 then return to_jsonb(v_row) - 'user_id'; end if;
  if v_row.state <> 'pending' then perform public.wiz_fail('invalid_state'); end if;
  update public.wiz_attachments set state = 'ready', size_bytes = p_size, sha256 = p_sha256, finalised_at = now()
    where id = p_id and user_id = p_user_id returning * into v_row;
  return to_jsonb(v_row) - 'user_id';
end $$;

-- deletion protocol: mark deleting -> remove object -> delete row; a failed removal is recorded and stays retryable
create or replace function public.wiz_attachment_mark_deleting(p_user_id uuid, p_id uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_row public.wiz_attachments;
begin
  update public.wiz_attachments set state = 'deleting' where id = p_id and user_id = p_user_id returning * into v_row;
  if not found then perform public.wiz_fail('not_found'); end if;
  return to_jsonb(v_row) - 'user_id';
end $$;

create or replace function public.wiz_attachment_delete_done(p_user_id uuid, p_id uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_n integer;
begin
  delete from public.wiz_attachments where id = p_id and user_id = p_user_id and state = 'deleting';
  get diagnostics v_n = row_count;
  if v_n = 0 then perform public.wiz_fail('not_found'); end if;
  return jsonb_build_object('deleted', true);
end $$;

create or replace function public.wiz_attachment_delete_failed(p_user_id uuid, p_id uuid, p_reason text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_row public.wiz_attachments;
begin
  update public.wiz_attachments set state = 'delete_failed', cleanup_attempts = cleanup_attempts + 1, cleanup_error = left(coalesce(p_reason, 'unknown'), 100)
    where id = p_id and user_id = p_user_id and state in ('deleting', 'delete_failed') returning * into v_row;
  if not found then perform public.wiz_fail('not_found'); end if;
  return to_jsonb(v_row) - 'user_id';
end $$;

-- 6. access hardening (same posture as the foundation) -----------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select * from (values
      ('wiz_career_plans', 'select, insert, update, delete'), ('wiz_prior_learning', 'select, insert, update, delete'),
      ('wiz_portfolio_entries', 'select, insert, update, delete'), ('wiz_networking_log', 'select, insert, update, delete'),
      ('wiz_support_map', 'select, insert, update, delete'), ('wiz_wellbeing_pulses', 'select, insert, update, delete'),
      ('wiz_attachments', 'select, insert, update, delete')
    ) as v(t, privs)
  loop
    execute format('alter table public.%I enable row level security', r.t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', r.t);
    execute format('grant %s on table public.%I to service_role', r.privs, r.t);
  end loop;
  -- the foundation already denies browsers on wiz_user_profiles; the new columns inherit that. service_role keeps its select/insert/update.
  for r in
    select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname ~ '^wiz_(career|portfolio|prior_learning|networking|support|pulse|learning|attachment)_'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;

-- 7. record the exact owned inventory for the rollback ----------------------------------------------------------------
update public.wiz_migration_state set status = 'applied', applied_at = now(), rolled_back_at = null,
  captured = jsonb_build_object(
    'owned', jsonb_build_object(
      'functions', (select coalesce(jsonb_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text), '[]'::jsonb) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname ~ '^wiz_(career|portfolio|prior_learning|networking|support|pulse|learning|attachment)_'),
      'triggers', jsonb_build_array(
        'public.wiz_career_plans.wiz_touch_updated_at', 'public.wiz_prior_learning.wiz_touch_updated_at', 'public.wiz_portfolio_entries.wiz_touch_updated_at',
        'public.wiz_networking_log.wiz_touch_updated_at', 'public.wiz_support_map.wiz_touch_updated_at', 'public.wiz_wellbeing_pulses.wiz_touch_updated_at',
        'public.wiz_attachments.wiz_touch_updated_at', 'public.wiz_portfolio_entries.wiz_career_assert_refs', 'public.wiz_attachments.wiz_career_assert_refs'),
      'tables', jsonb_build_array('public.wiz_career_plans', 'public.wiz_prior_learning', 'public.wiz_portfolio_entries', 'public.wiz_networking_log',
        'public.wiz_support_map', 'public.wiz_wellbeing_pulses', 'public.wiz_attachments'),
      'profile_columns', jsonb_build_array('learning_profile', 'learning_profile_version', 'learning_ai_use', 'learning_updated_at')))
where name = 'wiz_career_backend_20261008';
  $wiz_body$;
end $wiz_migration$;

commit;
