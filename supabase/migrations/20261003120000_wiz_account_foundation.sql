-- WIZ account ownership + durable record foundation.
--
-- PREPARED ONLY: not applied to any production database.
-- Adopts the observed baseline (public.users / conversations / messages, Supabase roles) additively:
--   * no existing column, constraint, policy or trigger is altered or dropped (two guard triggers and one index are added)
--   * existing rows are preserved (sessions/messages get sibling metadata rows, never rewritten)
--   * browser roles (anon, authenticated) and PUBLIC lose ALL direct table/column/function access to the touched
--     objects; the API uses the service role through the wiz_* functions, which filter by owner in SQL
--   * service_role is cut down to least privilege. It is a TRUSTED server credential: the functions protect correct
--     calls (the server must derive p_user_id from verified auth), not a holder who can run arbitrary SQL
--   * consent: a notice only becomes active once legal_approved = true. The seeded notices are NOT approved. An owner
--     must configure real approved notice text first (update public.wiz_consent_versions as the migration owner)
--   * prior grants / RLS flags of the touched tables, and the exact owned-object inventory, are captured in
--     wiz_migration_state so the paired rollback restores/removes exactly those
-- Lifecycle: serialised by an advisory lock; an already-applied run is an explicit no-op; collisions with unrecorded
-- objects and unexpected schemas are refused. One transaction: any failure leaves nothing applied.
-- Browser-callable SECURITY DEFINER functions already in public must be reviewed; see wiz.reviewed_definer_functions.
-- Rollback (data-preserving): supabase/rollbacks/20261003120000_wiz_account_foundation.down.sql

begin;
select pg_advisory_xact_lock(hashtextextended('wiz_account_foundation_20261003', 0));

do $wiz_migration$
declare
  v_status text;
begin
  if to_regclass('public.wiz_migration_state') is not null then
    execute $q$ select status from public.wiz_migration_state where name = 'wiz_account_foundation_20261003' $q$ into v_status;
  end if;
  if v_status = 'applied' then
    raise notice 'wiz migration already applied; nothing changed';
    return;
  end if;

  execute $wiz_body$
-- 0. migration state + explicit inventory of the objects this migration owns ----------------------------
create table if not exists public.wiz_migration_state (
  name           text primary key,
  status         text not null check (status in ('applying', 'applied', 'rolled_back')),
  captured       jsonb not null default '{}'::jsonb,
  applied_at     timestamptz,
  rolled_back_at timestamptz
);

-- The rollback removes exactly these objects (recorded into wiz_migration_state.captured.owned), never by name pattern.
create temp table wiz_inventory (kind text not null, name text not null) on commit drop;
insert into wiz_inventory (kind, name)
select 'table', 'public.' || t from unnest(array[
  'wiz_user_profiles', 'wiz_consent_versions', 'wiz_consent_events', 'wiz_idempotency', 'wiz_session_meta', 'wiz_message_meta',
  'wiz_goals', 'wiz_journal_entries', 'wiz_reports', 'wiz_profile_evidence', 'wiz_profile_evidence_revisions',
  'wiz_training_progress', 'wiz_pairing_status']) t
union all select 'function', f from unnest(array[
    'public.wiz_touch_updated_at()',
    'public.wiz_assert_session_owner()',
    'public.wiz_assert_message_session()',
    'public.wiz_guard_reparent()',
    'public.wiz_notice_lock()',
    'public.wiz_fail(text)',
    'public.wiz_idem_claim(uuid, text, text, jsonb)',
    'public.wiz_idem_set(uuid, text, text, uuid)',
    'public.wiz_consent_active(uuid, text)',
    'public.wiz_consent_gate(uuid, text)',
    'public.wiz_ensure_user(uuid, text)',
    'public.wiz_get_me(uuid)',
    'public.wiz_update_profile(uuid, jsonb)',
    'public.wiz_onboarding_get(uuid)',
    'public.wiz_onboarding_put(uuid, jsonb, boolean)',
    'public.wiz_consent_state(uuid)',
    'public.wiz_consent_record(uuid, text, text, text)',
    'public.wiz_session_json(uuid, uuid)',
    'public.wiz_session_create(uuid, jsonb, text)',
    'public.wiz_session_get(uuid, uuid)',
    'public.wiz_session_list(uuid, integer, timestamptz, uuid, boolean)',
    'public.wiz_session_update(uuid, uuid, jsonb)',
    'public.wiz_checkpoint_get(uuid, uuid)',
    'public.wiz_checkpoint_put(uuid, uuid, jsonb, integer)',
    'public.wiz_message_append(uuid, uuid, text, text, integer, text, text, jsonb)',
    'public.wiz_message_list(uuid, uuid, integer, bigint)',
    'public.wiz_message_recent(uuid, uuid, integer)',
    'public.wiz_message_by_key(uuid, uuid, text)',
    'public.wiz_personalisation_context(uuid, uuid, integer, integer)',
    'public.wiz_goal_create(uuid, jsonb, text)',
    'public.wiz_goal_get(uuid, uuid)',
    'public.wiz_goal_list(uuid, integer, timestamptz, uuid)',
    'public.wiz_goal_update(uuid, uuid, jsonb, integer)',
    'public.wiz_goal_delete(uuid, uuid)',
    'public.wiz_journal_create(uuid, jsonb, text)',
    'public.wiz_journal_get(uuid, uuid)',
    'public.wiz_journal_list(uuid, integer, timestamptz, uuid)',
    'public.wiz_journal_update(uuid, uuid, jsonb, integer)',
    'public.wiz_journal_delete(uuid, uuid)',
    'public.wiz_report_create(uuid, jsonb, text)',
    'public.wiz_report_get(uuid, uuid)',
    'public.wiz_report_list(uuid, integer, timestamptz, uuid)',
    'public.wiz_report_delete(uuid, uuid)',
    'public.wiz_evidence_create(uuid, jsonb, text)',
    'public.wiz_evidence_list(uuid, integer, timestamptz, uuid)',
    'public.wiz_evidence_correct(uuid, uuid, text, integer)',
    'public.wiz_evidence_confirm(uuid, uuid)',
    'public.wiz_evidence_set_ai_use(uuid, uuid, boolean)',
    'public.wiz_evidence_ai_usable(uuid)',
    'public.wiz_evidence_delete(uuid, uuid)',
    'public.wiz_training_upsert(uuid, text, text, integer)',
    'public.wiz_training_list(uuid)',
    'public.wiz_pairing_get(uuid)',
    'public.wiz_pairing_set(uuid, text)']) f
union all select 'index', i from unnest(array[
  'public.wiz_conversations_user_updated_idx', 'public.wiz_consent_one_current_idx', 'public.wiz_consent_events_user_idx',
  'public.wiz_message_meta_session_idx', 'public.wiz_goals_user_idx', 'public.wiz_journal_user_idx', 'public.wiz_reports_user_idx',
  'public.wiz_evidence_user_idx']) i
union all select 'trigger', 'public.' || t || '.wiz_touch_updated_at' from unnest(array[
  'wiz_user_profiles', 'wiz_goals', 'wiz_journal_entries', 'wiz_profile_evidence', 'wiz_training_progress', 'wiz_pairing_status']) t
union all select 'trigger', 'public.' || t || '.wiz_assert_session_owner' from unnest(array[
  'wiz_session_meta', 'wiz_message_meta', 'wiz_goals', 'wiz_journal_entries', 'wiz_reports', 'wiz_profile_evidence']) t
union all select 'trigger', x from unnest(array[
  'public.wiz_message_meta.wiz_assert_message_session', 'public.wiz_consent_versions.wiz_notice_lock',
  'public.conversations.wiz_guard_reparent', 'public.messages.wiz_guard_reparent']) x;

-- Functions in public that a browser role can already EXECUTE (excluding extensions, triggers and ours). Their table
-- access is closed by the revokes below; SECURITY DEFINER ones are not, so they need a human decision.
create temp table wiz_callable on commit drop as
select p.oid::regprocedure::text as sig, p.prosecdef as security_definer
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind = 'f' and p.prorettype <> 'trigger'::regtype
  and p.oid not in (select to_regprocedure(i.name)::oid from wiz_inventory i where i.kind = 'function' and to_regprocedure(i.name) is not null)
  and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  and (p.proacl is null or exists (
    select 1 from aclexplode(p.proacl) a
    where a.privilege_type = 'EXECUTE' and (a.grantee = 0 or a.grantee::regrole::text in ('anon', 'authenticated'))));


-- 1. preflight: reject an unexpected schema instead of assuming ---------------------------------
do $$
declare
  r record;
  v_state text;
  v_bad text;
  v_cnt bigint;
  v_exists boolean;
begin
  for r in
    select * from (values
      ('users', 'id', 'uuid', 'NO'), ('users', 'email', 'text', 'NO'), ('users', 'full_name', 'text', 'YES'),
      ('users', 'avatar_url', 'text', 'YES'), ('users', 'subscription_status', 'text', 'NO'),
      ('users', 'subscription_tier', 'text', 'YES'), ('users', 'stripe_customer_id', 'text', 'YES'),
      ('users', 'created_at', 'timestamp with time zone', null), ('users', 'updated_at', 'timestamp with time zone', null),
      ('conversations', 'id', 'uuid', 'NO'), ('conversations', 'user_id', 'uuid', 'NO'),
      ('conversations', 'title', 'text', 'NO'), ('conversations', 'is_archived', 'boolean', null),
      ('conversations', 'created_at', 'timestamp with time zone', null), ('conversations', 'updated_at', 'timestamp with time zone', null),
      ('messages', 'id', 'uuid', 'NO'), ('messages', 'conversation_id', 'uuid', 'NO'),
      ('messages', 'sender', 'text', 'NO'), ('messages', 'content', 'text', 'NO'),
      ('messages', 'tokens_used', 'integer', null), ('messages', 'created_at', 'timestamp with time zone', null)
    ) as v(t, c, ty, nullable)
  loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = r.t and column_name = r.c and data_type = r.ty
        and (r.nullable is null or is_nullable = r.nullable)
    ) then
      raise exception 'wiz migration refused: unexpected schema for public.%.% (expected % nullable=%)', r.t, r.c, r.ty, coalesce(r.nullable, 'any');
    end if;
  end loop;

  -- keys, referential actions and defaults that the functions below depend on
  for r in select * from (values ('users', 'id'), ('conversations', 'id'), ('messages', 'id')) as v(t, c) loop
    if not exists (
      select 1 from pg_constraint k
      where k.conrelid = format('public.%I', r.t)::regclass and k.contype = 'p'
        and k.conkey = array[(select a.attnum from pg_attribute a where a.attrelid = k.conrelid and a.attname = r.c)]::int2[]
    ) then
      raise exception 'wiz migration refused: public.%.% is not the primary key', r.t, r.c;
    end if;
  end loop;
  for r in
    select * from (values
      ('public.users', 'id', 'auth.users', 'id'),
      ('public.conversations', 'user_id', 'public.users', 'id'),
      ('public.messages', 'conversation_id', 'public.conversations', 'id')
    ) as v(t, c, rt, rc)
  loop
    if not exists (
      select 1 from pg_constraint k
      where k.conrelid = r.t::regclass and k.contype = 'f' and k.confrelid = r.rt::regclass and k.confdeltype = 'c'
        and k.conkey = array[(select a.attnum from pg_attribute a where a.attrelid = k.conrelid and a.attname = r.c)]::int2[]
        and k.confkey = array[(select a.attnum from pg_attribute a where a.attrelid = k.confrelid and a.attname = r.rc)]::int2[]
    ) then
      raise exception 'wiz migration refused: expected foreign key %(%) -> %(%) ON DELETE CASCADE', r.t, r.c, r.rt, r.rc;
    end if;
  end loop;
  for r in
    select * from (values
      ('conversations', 'id', 'gen_random_uuid'), ('conversations', 'title', 'New Conversation'),
      ('messages', 'id', 'gen_random_uuid'), ('users', 'subscription_status', 'inactive')
    ) as v(t, c, frag)
  loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = r.t and column_name = r.c and column_default like '%' || r.frag || '%'
    ) then
      raise exception 'wiz migration refused: public.%.% does not have the expected default (%)', r.t, r.c, r.frag;
    end if;
  end loop;
  -- legacy rows with NULL timestamps would be dropped from keyset lists / copied into NOT NULL metadata: reject, do not guess
  select count(*) into v_cnt from public.conversations where created_at is null or updated_at is null;
  if v_cnt > 0 then
    raise exception 'wiz migration refused: % conversations rows have NULL created_at/updated_at; repair them first', v_cnt;
  end if;
  select count(*) into v_cnt from public.messages where created_at is null;
  if v_cnt > 0 then
    raise exception 'wiz migration refused: % messages rows have NULL created_at; repair them first', v_cnt;
  end if;
  if exists (select 1 from pg_attribute where attrelid = 'public.users'::regclass and attname in ('is_practitioner') and not attisdropped) then
    raise exception 'wiz migration refused: unexpected column users.is_practitioner';
  end if;
  if (select count(*) from pg_roles where rolname in ('anon', 'authenticated', 'service_role')) <> 3 then
    raise exception 'wiz migration refused: Supabase roles anon/authenticated/service_role are missing';
  end if;
  if to_regprocedure('auth.uid()') is null or to_regclass('auth.users') is null then
    raise exception 'wiz migration refused: auth.uid() / auth.users are missing';
  end if;

  -- browser-callable functions bypass table privileges or expose logic: an operator must review them first.
  -- Review, then list the exact signatures (as printed here, separated by ';') in the session setting
  -- wiz.reviewed_callable_functions before applying.
  select string_agg(sig, '; ' order by sig) into v_bad from wiz_callable
  where not (sig = any (string_to_array(coalesce(current_setting('wiz.reviewed_callable_functions', true), ''), ';')));
  if v_bad is not null then
    raise exception 'wiz migration refused: browser-callable function(s) need review: %', v_bad;
  end if;

  select status into v_state from public.wiz_migration_state where name = 'wiz_account_foundation_20261003';
  if v_state = 'applying' then
    raise exception 'wiz migration refused: a previous run left state applying';
  end if;
  for r in select kind, name from wiz_inventory loop
    v_exists := case r.kind
      when 'table' then to_regclass(r.name) is not null
      when 'index' then to_regclass(r.name) is not null
      when 'function' then to_regprocedure(r.name) is not null
      else exists (
        select 1 from pg_trigger t
        where t.tgrelid = to_regclass(split_part(r.name, '.', 1) || '.' || split_part(r.name, '.', 2))
          and t.tgname = split_part(r.name, '.', 3) and not t.tgisinternal)
    end;
    if v_exists and v_state is null then
      raise exception 'wiz migration refused: % % already exists but is not recorded as this migration', r.kind, r.name;
    end if;
    if v_exists and v_state = 'rolled_back' and (r.kind in ('function', 'trigger') or r.name = 'public.wiz_conversations_user_updated_idx') then
      raise exception 'wiz migration refused: % % exists although the migration is rolled back', r.kind, r.name;
    end if;
  end loop;
end $$;


-- 2. capture prior grants / RLS flags / policies (only when not already applied) -----------------
insert into public.wiz_migration_state (name, status, captured)
select 'wiz_account_foundation_20261003', 'applying',
  jsonb_build_object(
    'owned', jsonb_build_object(
      'tables', (select jsonb_agg(name order by name) from wiz_inventory where kind = 'table'),
      'functions', (select jsonb_agg(name order by name) from wiz_inventory where kind = 'function'),
      'indexes', (select jsonb_agg(name order by name) from wiz_inventory where kind = 'index'),
      'triggers', (select jsonb_agg(name order by name) from wiz_inventory where kind = 'trigger')),
    'callable_functions', (select coalesce(jsonb_agg(jsonb_build_object('signature', sig, 'security_definer', security_definer) order by sig), '[]'::jsonb) from wiz_callable),
    'grants', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'rel', c.relname,
        'grantee', case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end,
        'privilege', a.privilege_type, 'grantable', a.is_grantable
      ) order by c.relname, a.grantee, a.privilege_type), '[]'::jsonb)
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(c.relacl) a
      where n.nspname = 'public' and c.relkind = 'r' and c.relname in ('users', 'conversations', 'messages', 'user_documents')
    ),
    'column_grants', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'rel', c.relname, 'column', t.attname,
        'grantee', case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end,
        'privilege', a.privilege_type, 'grantable', a.is_grantable
      ) order by c.relname, t.attname, a.grantee, a.privilege_type), '[]'::jsonb)
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute t on t.attrelid = c.oid and t.attnum > 0 and not t.attisdropped
      cross join lateral aclexplode(t.attacl) a
      where n.nspname = 'public' and c.relkind = 'r' and c.relname in ('users', 'conversations', 'messages', 'user_documents')
    ),
    'rls', (
      select coalesce(jsonb_agg(jsonb_build_object('rel', c.relname, 'enabled', c.relrowsecurity, 'forced', c.relforcerowsecurity) order by c.relname), '[]'::jsonb)
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname in ('users', 'conversations', 'messages', 'user_documents')
    ),
    'policies', (
      select coalesce(jsonb_agg(to_jsonb(p) order by p.tablename, p.policyname), '[]'::jsonb)
      from pg_policies p where p.schemaname = 'public' and p.tablename in ('users', 'conversations', 'messages', 'user_documents')
    )
  )
on conflict (name) do update set status = 'applying', captured = excluded.captured;

-- 3. shared trigger functions ---------------------------------------------------------------------
create function public.wiz_touch_updated_at() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Defence in depth: a row that names a session must name one owned by the same user.
create function public.wiz_assert_session_owner() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  v_session uuid := nullif(to_jsonb(new) ->> 'session_id', '')::uuid;
begin
  if v_session is not null and not exists (
    select 1 from public.conversations c where c.id = v_session and c.user_id = new.user_id
  ) then
    raise exception 'wiz:not_found' using errcode = 'P0001';
  end if;
  return new;
end $$;

create function public.wiz_fail(p_code text) returns void
language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'wiz:%', p_code using errcode = 'P0001';
end $$;

-- message metadata must name the session that really holds the message
create function public.wiz_assert_message_session() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from public.messages m where m.id = new.message_id and m.conversation_id = new.session_id) then
    raise exception 'wiz:not_found' using errcode = 'P0001';
  end if;
  return new;
end $$;

-- ownership/parent of a record that already has wiz metadata cannot be moved underneath it
create function public.wiz_guard_reparent() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_table_name = 'conversations' then
    if new.user_id is distinct from old.user_id and exists (select 1 from public.wiz_session_meta where session_id = old.id) then
      raise exception 'wiz:ownership_locked' using errcode = 'P0001';
    end if;
  elsif tg_table_name = 'messages' then
    if new.conversation_id is distinct from old.conversation_id and exists (select 1 from public.wiz_message_meta where message_id = old.id) then
      raise exception 'wiz:ownership_locked' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

-- Consent notice changes (publish, approve, retire) take the exclusive notice lock, so they wait for in-flight
-- consent-dependent writes (which hold it shared) and vice versa. Lock order everywhere: notice -> user consent -> rows.
create function public.wiz_notice_lock() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('wiz_notice:' || coalesce(new.purpose, old.purpose), 0));
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

-- 4. tables -----------------------------------------------------------------------------------------
create table if not exists public.wiz_user_profiles (
  user_id                 uuid primary key references public.users (id) on delete cascade,
  preferences             jsonb not null default '{}'::jsonb
    check (jsonb_typeof(preferences) = 'object' and pg_column_size(preferences) <= 8192),
  onboarding              jsonb not null default '{}'::jsonb
    check (jsonb_typeof(onboarding) = 'object' and pg_column_size(onboarding) <= 16384),
  onboarding_version      integer not null default 0,
  onboarding_completed_at timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create table if not exists public.wiz_consent_versions (
  purpose        text not null check (purpose ~ '^[a-z_]{3,40}$'),
  version        text not null check (version ~ '^[A-Za-z0-9._-]{1,20}$'),
  status         text not null default 'current' check (status in ('current', 'retired')),
  summary        text not null check (char_length(summary) between 1 and 500),
  legal_approved boolean not null default false,
  published_at   timestamptz not null default now(),
  primary key (purpose, version)
);
create unique index if not exists wiz_consent_one_current_idx on public.wiz_consent_versions (purpose) where status = 'current';

create table if not exists public.wiz_consent_events (
  seq        bigint generated always as identity primary key,
  user_id    uuid not null references public.users (id) on delete cascade,
  purpose    text not null,
  version    text not null,
  action     text not null check (action in ('grant', 'revoke')),
  created_at timestamptz not null default now(),
  foreign key (purpose, version) references public.wiz_consent_versions (purpose, version)
);
create index if not exists wiz_consent_events_user_idx on public.wiz_consent_events (user_id, purpose, seq desc);

create table if not exists public.wiz_idempotency (
  user_id      uuid not null references public.users (id) on delete cascade,
  scope        text not null,
  key          text not null check (key ~ '^[A-Za-z0-9_.:-]{8,128}$'),
  request_hash text not null,
  result_id    uuid,
  created_at   timestamptz not null default now(),
  primary key (user_id, scope, key)
);

create table if not exists public.wiz_session_meta (
  session_id            uuid primary key references public.conversations (id) on delete cascade,
  user_id               uuid not null references public.users (id) on delete cascade,
  session_number        integer not null check (session_number > 0),
  title_source          text not null default 'auto' check (title_source in ('auto', 'user')),
  track                 text check (track is null or track ~ '^[a-z_]{1,30}$'),
  lens                  text check (lens is null or lens ~ '^[a-z_]{1,30}$'),
  topic                 jsonb check (topic is null or (jsonb_typeof(topic) = 'object' and pg_column_size(topic) <= 2048)),
  checkpoint            jsonb check (checkpoint is null or pg_column_size(checkpoint) <= 65536),
  checkpoint_version    integer not null default 0,
  checkpoint_updated_at timestamptz,
  message_count         integer not null default 0,
  last_message_at       timestamptz,
  created_at            timestamptz not null default now(),
  unique (user_id, session_number)
);

create table if not exists public.wiz_message_meta (
  message_id uuid primary key references public.messages (id) on delete cascade,
  session_id uuid not null references public.conversations (id) on delete cascade,
  user_id    uuid not null references public.users (id) on delete cascade,
  seq        bigint generated always as identity unique,
  model      text check (model is null or char_length(model) <= 100),
  provenance jsonb not null default '{}'::jsonb check (pg_column_size(provenance) <= 6144),
  created_at timestamptz not null default now()
);
create index if not exists wiz_message_meta_session_idx on public.wiz_message_meta (session_id, seq);

create table if not exists public.wiz_goals (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users (id) on delete cascade,
  session_id   uuid references public.conversations (id) on delete set null,
  title        text not null check (char_length(title) between 1 and 300),
  why          text check (why is null or char_length(why) <= 2000),
  measure      text check (measure is null or char_length(measure) <= 1000),
  target_date  date,
  status       text not null default 'active' check (status in ('active', 'achieved', 'paused', 'dropped')),
  source       text not null default 'user_stated' check (source in ('user_stated', 'assistant_suggested_user_confirmed')),
  confirmed_at timestamptz not null default now(),
  version      integer not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists wiz_goals_user_idx on public.wiz_goals (user_id, created_at desc, id desc);

create table if not exists public.wiz_journal_entries (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users (id) on delete cascade,
  session_id uuid references public.conversations (id) on delete set null,
  entry_date date not null default current_date,
  body       text not null check (char_length(body) between 1 and 20000),
  version    integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists wiz_journal_user_idx on public.wiz_journal_entries (user_id, created_at desc, id desc);

create table if not exists public.wiz_reports (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users (id) on delete cascade,
  session_id uuid references public.conversations (id) on delete set null,
  kind       text not null check (kind ~ '^[a-z0-9_]{1,40}$'),
  title      text not null check (char_length(title) between 1 and 200),
  body       text not null check (char_length(body) between 1 and 60000),
  source     text not null check (source in ('client_submitted', 'assistant_generated')),
  model      text check (model is null or char_length(model) <= 100),
  provenance jsonb not null default '{}'::jsonb check (pg_column_size(provenance) <= 2048),
  version    integer not null default 1,
  created_at timestamptz not null default now()
);
create index if not exists wiz_reports_user_idx on public.wiz_reports (user_id, created_at desc, id desc);

create table if not exists public.wiz_profile_evidence (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.users (id) on delete cascade,
  session_id     uuid references public.conversations (id) on delete set null,
  statement      text not null check (char_length(statement) between 1 and 2000),
  source         text not null check (source in ('user_stated', 'onboarding', 'assistant_inferred')),
  confirmed_at   timestamptz,
  ai_use_enabled boolean not null default false,
  revoked_at     timestamptz,
  version        integer not null default 1,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (not ai_use_enabled or confirmed_at is not null),
  unique (id, user_id)
);
create index if not exists wiz_evidence_user_idx on public.wiz_profile_evidence (user_id, created_at desc, id desc);

create table if not exists public.wiz_profile_evidence_revisions (
  id          uuid primary key default gen_random_uuid(),
  evidence_id uuid not null,
  user_id     uuid not null references public.users (id) on delete cascade,
  version     integer not null,
  statement   text not null,
  changed_at  timestamptz not null default now(),
  foreign key (evidence_id, user_id) references public.wiz_profile_evidence (id, user_id) on delete cascade
);

create table if not exists public.wiz_training_progress (
  user_id      uuid not null references public.users (id) on delete cascade,
  module_key   text not null check (module_key ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  status       text not null check (status in ('not_started', 'in_progress', 'completed')),
  percent      smallint not null default 0 check (percent between 0 and 100),
  started_at   timestamptz,
  completed_at timestamptz,
  updated_at   timestamptz not null default now(),
  primary key (user_id, module_key)
);

-- Pairing STATUS only: no counterpart identity, no shared data.
create table if not exists public.wiz_pairing_status (
  user_id    uuid primary key references public.users (id) on delete cascade,
  status     text not null default 'not_paired' check (status in ('not_paired', 'pending', 'paired', 'revoked')),
  updated_at timestamptz not null default now()
);

-- triggers (re-created so they re-attach after a rollback dropped the functions)
do $$
declare t text;
begin
  foreach t in array array['wiz_user_profiles', 'wiz_goals', 'wiz_journal_entries', 'wiz_profile_evidence', 'wiz_training_progress', 'wiz_pairing_status'] loop
    execute format('drop trigger if exists wiz_touch_updated_at on public.%I', t);
    execute format('create trigger wiz_touch_updated_at before update on public.%I for each row execute function public.wiz_touch_updated_at()', t);
  end loop;
  foreach t in array array['wiz_session_meta', 'wiz_message_meta', 'wiz_goals', 'wiz_journal_entries', 'wiz_reports', 'wiz_profile_evidence'] loop
    execute format('drop trigger if exists wiz_assert_session_owner on public.%I', t);
    execute format('create trigger wiz_assert_session_owner before insert or update on public.%I for each row execute function public.wiz_assert_session_owner()', t);
  end loop;
end $$;

create trigger wiz_assert_message_session before insert or update on public.wiz_message_meta
  for each row execute function public.wiz_assert_message_session();
create trigger wiz_notice_lock before insert or update or delete on public.wiz_consent_versions
  for each row execute function public.wiz_notice_lock();
-- additive guards on existing tables (the baseline triggers are untouched; the rollback drops these)
create trigger wiz_guard_reparent before update of user_id on public.conversations
  for each row execute function public.wiz_guard_reparent();
create trigger wiz_guard_reparent before update of conversation_id on public.messages
  for each row execute function public.wiz_guard_reparent();

-- additive index on an existing table (dropped again by the rollback)
create index if not exists wiz_conversations_user_updated_idx on public.conversations (user_id, updated_at desc, id desc);

-- consent purposes: versions are data. legal_approved stays false until the owner approves notice text.
insert into public.wiz_consent_versions (purpose, version, status, summary, legal_approved) values
  ('save_chats', '1', 'current', 'Keep my coaching conversations on my account so I can return to them.', false),
  ('personalisation', '1', 'current', 'Use my saved conversations, onboarding answers and confirmed profile evidence to personalise future sessions.', false)
on conflict do nothing;

-- 5. backfill sibling metadata for pre-existing records (numbering only; nothing is invented) --------
insert into public.wiz_session_meta (session_id, user_id, session_number, title_source, created_at)
select c.id, c.user_id,
  coalesce((select max(m.session_number) from public.wiz_session_meta m where m.user_id = c.user_id), 0)
    + row_number() over (partition by c.user_id order by c.created_at, c.id),
  case when c.title = 'New Conversation' then 'auto' else 'user' end,
  c.created_at
from public.conversations c
where not exists (select 1 from public.wiz_session_meta m where m.session_id = c.id)
order by c.user_id, c.created_at, c.id;

insert into public.wiz_message_meta (message_id, session_id, user_id, provenance, created_at)
select m.id, m.conversation_id, c.user_id, '{"origin":"legacy_import"}'::jsonb, m.created_at
from public.messages m join public.conversations c on c.id = m.conversation_id
where not exists (select 1 from public.wiz_message_meta x where x.message_id = m.id)
order by m.created_at, m.id;

update public.wiz_session_meta s set
  message_count = (select count(*) from public.wiz_message_meta x where x.session_id = s.session_id),
  last_message_at = (select max(x.created_at) from public.wiz_message_meta x where x.session_id = s.session_id)
where s.message_count = 0 and exists (select 1 from public.wiz_message_meta x where x.session_id = s.session_id);

-- 6. functions (service role only; every one filters by the caller-supplied owner in SQL) -------------
create function public.wiz_idem_claim(p_user_id uuid, p_scope text, p_key text, p_payload jsonb) returns uuid
language plpgsql set search_path = public, pg_temp as $$
declare
  v_hash text;
  v_row public.wiz_idempotency;
begin
  if p_key is null then return null; end if;
  v_hash := encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex');
  insert into public.wiz_idempotency (user_id, scope, key, request_hash) values (p_user_id, p_scope, p_key, v_hash)
    on conflict do nothing;
  if found then return null; end if;
  select * into v_row from public.wiz_idempotency where user_id = p_user_id and scope = p_scope and key = p_key;
  if v_row.request_hash <> v_hash then perform public.wiz_fail('idempotency_conflict'); end if;
  if v_row.result_id is null then perform public.wiz_fail('idempotency_conflict'); end if;
  return v_row.result_id;
end $$;

create function public.wiz_idem_set(p_user_id uuid, p_scope text, p_key text, p_id uuid) returns void
language sql set search_path = public, pg_temp as $$
  update public.wiz_idempotency set result_id = p_id where user_id = p_user_id and scope = p_scope and key = p_key;
$$;

-- A grant counts only while its notice version is the current one AND approved (legal_approved). Read-only: context
-- assembly must call this (or the locking wiz_consent_gate) at assembly time; ai_use_enabled alone is not enough.
create function public.wiz_consent_active(p_user_id uuid, p_purpose text) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select coalesce((
    select e.action = 'grant' and e.version = v.version
    from public.wiz_consent_versions v
    join lateral (
      select * from public.wiz_consent_events x where x.user_id = p_user_id and x.purpose = v.purpose order by x.seq desc limit 1
    ) e on true
    where v.purpose = p_purpose and v.status = 'current' and v.legal_approved
  ), false);
$$;

-- Locking variant for consent-dependent writes. Ordering rule: notice (shared) -> user consent (exclusive) -> row locks.
-- Consent decisions and notice changes take the same locks, so a revoke cannot commit between a check and its write.
create function public.wiz_consent_gate(p_user_id uuid, p_purpose text) returns boolean
language plpgsql set search_path = public, pg_temp as $$
begin
  perform pg_advisory_xact_lock_shared(hashtextextended('wiz_notice:' || p_purpose, 0));
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':consent', 0));
  return public.wiz_consent_active(p_user_id, p_purpose);
end $$;

create function public.wiz_ensure_user(p_user_id uuid, p_email text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
begin
  if p_user_id is null or coalesce(p_email, '') = '' then perform public.wiz_fail('invalid_input'); end if;
  insert into public.users (id, email) values (p_user_id, p_email)
    on conflict (id) do update set email = excluded.email where public.users.email is distinct from excluded.email;
  insert into public.wiz_user_profiles (user_id) values (p_user_id) on conflict do nothing;
  return public.wiz_get_me(p_user_id);
end $$;

-- billing / subscription columns are deliberately never returned or written here.
create function public.wiz_get_me(p_user_id uuid) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare v jsonb;
begin
  select jsonb_build_object(
    'user', jsonb_build_object('id', u.id, 'email', u.email, 'full_name', u.full_name, 'created_at', u.created_at),
    'profile', jsonb_build_object(
      'preferences', coalesce(p.preferences, '{}'::jsonb),
      'onboarding_version', coalesce(p.onboarding_version, 0),
      'onboarding_completed_at', p.onboarding_completed_at
    )
  ) into v
  from public.users u left join public.wiz_user_profiles p on p.user_id = u.id
  where u.id = p_user_id;
  if v is null then perform public.wiz_fail('not_found'); end if;
  return v;
end $$;

create function public.wiz_update_profile(p_user_id uuid, p_patch jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
begin
  perform 1 from public.users where id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  insert into public.wiz_user_profiles (user_id) values (p_user_id) on conflict do nothing;
  if p_patch ? 'full_name' then
    update public.users set full_name = nullif(p_patch ->> 'full_name', '') where id = p_user_id;
  end if;
  if p_patch ? 'preferences' then
    update public.wiz_user_profiles set preferences = jsonb_strip_nulls(preferences || (p_patch -> 'preferences'))
      where user_id = p_user_id;
  end if;
  return public.wiz_get_me(p_user_id);
end $$;

create function public.wiz_onboarding_get(p_user_id uuid) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('answers', coalesce(p.onboarding, '{}'::jsonb), 'version', coalesce(p.onboarding_version, 0),
    'completed_at', p.onboarding_completed_at)
  from public.users u left join public.wiz_user_profiles p on p.user_id = u.id where u.id = p_user_id;
$$;

create function public.wiz_onboarding_put(p_user_id uuid, p_answers jsonb, p_complete boolean) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
begin
  perform 1 from public.users where id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  insert into public.wiz_user_profiles (user_id) values (p_user_id) on conflict do nothing;
  update public.wiz_user_profiles set
    onboarding = jsonb_strip_nulls(onboarding || p_answers),
    onboarding_version = onboarding_version + 1,
    onboarding_completed_at = case when p_complete and onboarding_completed_at is null then now() else onboarding_completed_at end
  where user_id = p_user_id;
  return public.wiz_onboarding_get(p_user_id);
end $$;

create function public.wiz_consent_state(p_user_id uuid) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'purpose', v.purpose, 'version', v.version, 'summary', v.summary, 'legal_approved', v.legal_approved,
    'granted', coalesce(e.action = 'grant' and e.version = v.version, false),
    'last_decision', e.action, 'last_decision_version', e.version, 'last_decision_at', e.created_at
  ) order by v.purpose), '[]'::jsonb)
  from public.wiz_consent_versions v
  left join lateral (
    select * from public.wiz_consent_events x where x.user_id = p_user_id and x.purpose = v.purpose order by x.seq desc limit 1
  ) e on true
  where v.status = 'current';
$$;

create function public.wiz_consent_record(p_user_id uuid, p_purpose text, p_version text, p_action text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_current public.wiz_consent_versions;
  v_last public.wiz_consent_events;
begin
  if p_action not in ('grant', 'revoke') then perform public.wiz_fail('invalid_input'); end if;
  perform 1 from public.users where id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('wiz_notice:' || p_purpose, 0));
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':consent', 0));
  select * into v_current from public.wiz_consent_versions where purpose = p_purpose and status = 'current';
  if v_current.version is null then perform public.wiz_fail('unknown_purpose'); end if;
  if p_version is distinct from v_current.version then perform public.wiz_fail('stale_consent_version'); end if;
  -- an unapproved notice can never be accepted; withdrawing is always possible
  if p_action = 'grant' and not v_current.legal_approved then perform public.wiz_fail('notice_not_approved'); end if;
  select * into v_last from public.wiz_consent_events where user_id = p_user_id and purpose = p_purpose order by seq desc limit 1;
  if v_last.seq is null or v_last.action <> p_action or v_last.version <> p_version then
    insert into public.wiz_consent_events (user_id, purpose, version, action) values (p_user_id, p_purpose, p_version, p_action);
  end if;
  return public.wiz_consent_state(p_user_id);
end $$;

create function public.wiz_session_json(p_user_id uuid, p_id uuid) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', c.id, 'title', c.title, 'title_source', m.title_source, 'is_archived', coalesce(c.is_archived, false),
    'session_number', m.session_number, 'track', m.track, 'lens', m.lens, 'topic', m.topic,
    'message_count', m.message_count, 'last_message_at', m.last_message_at,
    'checkpoint_version', m.checkpoint_version, 'created_at', c.created_at, 'updated_at', c.updated_at)
  from public.conversations c
  join public.wiz_session_meta m on m.session_id = c.id and m.user_id = c.user_id
  where c.id = p_id and c.user_id = p_user_id;
$$;

create function public.wiz_session_create(p_user_id uuid, p_data jsonb, p_key text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_existing uuid;
  v_id uuid;
begin
  perform 1 from public.users where id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':session', 0));
  v_existing := public.wiz_idem_claim(p_user_id, 'session', p_key, p_data);
  if v_existing is not null then
    return jsonb_build_object('item', public.wiz_session_json(p_user_id, v_existing), 'replayed', true);
  end if;
  insert into public.conversations (user_id) values (p_user_id) returning id into v_id;
  insert into public.wiz_session_meta (session_id, user_id, session_number, track, lens, topic)
  values (v_id, p_user_id,
    coalesce((select max(session_number) from public.wiz_session_meta where user_id = p_user_id), 0) + 1,
    p_data ->> 'track', p_data ->> 'lens', p_data -> 'topic');
  perform public.wiz_idem_set(p_user_id, 'session', p_key, v_id);
  return jsonb_build_object('item', public.wiz_session_json(p_user_id, v_id), 'replayed', false);
end $$;

create function public.wiz_session_get(p_user_id uuid, p_id uuid) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare v jsonb := public.wiz_session_json(p_user_id, p_id);
begin
  if v is null then perform public.wiz_fail('not_found'); end if;
  return v;
end $$;

create function public.wiz_session_list(p_user_id uuid, p_limit integer, p_before_ts timestamptz, p_before_id uuid, p_archived boolean) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare v_items jsonb; v_next jsonb;
begin
  with page as (
    select c.id, c.updated_at from public.conversations c
    join public.wiz_session_meta m on m.session_id = c.id and m.user_id = c.user_id
    where c.user_id = p_user_id
      and (p_archived is null or coalesce(c.is_archived, false) = p_archived)
      and (p_before_ts is null or (c.updated_at, c.id) < (p_before_ts, p_before_id))
    order by c.updated_at desc, c.id desc limit p_limit + 1
  ), shaped as (
    select id, updated_at, row_number() over (order by updated_at desc, id desc) rn from page
  )
  select coalesce(jsonb_agg(public.wiz_session_json(p_user_id, id) order by rn) filter (where rn <= p_limit), '[]'::jsonb),
    (select jsonb_build_object('ts', s.updated_at, 'id', s.id) from shaped s
      where s.rn = p_limit and exists (select 1 from shaped y where y.rn = p_limit + 1))
  into v_items, v_next from shaped;
  return jsonb_build_object('items', v_items, 'next', v_next);
end $$;

create function public.wiz_session_update(p_user_id uuid, p_id uuid, p_patch jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
begin
  perform 1 from public.conversations where id = p_id and user_id = p_user_id for update;
  if not found then perform public.wiz_fail('not_found'); end if;
  if p_patch ? 'title' then
    update public.conversations set title = p_patch ->> 'title', updated_at = now() where id = p_id and user_id = p_user_id;
    update public.wiz_session_meta set title_source = 'user' where session_id = p_id and user_id = p_user_id;
  end if;
  if p_patch ? 'is_archived' then
    update public.conversations set is_archived = (p_patch ->> 'is_archived')::boolean, updated_at = now() where id = p_id and user_id = p_user_id;
  end if;
  return public.wiz_session_json(p_user_id, p_id);
end $$;

create function public.wiz_checkpoint_get(p_user_id uuid, p_id uuid) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare v jsonb;
begin
  select jsonb_build_object('checkpoint', m.checkpoint, 'version', m.checkpoint_version, 'updated_at', m.checkpoint_updated_at)
    into v from public.wiz_session_meta m where m.session_id = p_id and m.user_id = p_user_id;
  if v is null then perform public.wiz_fail('not_found'); end if;
  return v;
end $$;

create function public.wiz_checkpoint_put(p_user_id uuid, p_id uuid, p_checkpoint jsonb, p_expected_version integer) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_cur integer;
begin
  select checkpoint_version into v_cur from public.wiz_session_meta where session_id = p_id and user_id = p_user_id for update;
  if not found then perform public.wiz_fail('not_found'); end if;
  if p_expected_version is not null and p_expected_version <> v_cur then perform public.wiz_fail('version_conflict'); end if;
  update public.wiz_session_meta set checkpoint = p_checkpoint, checkpoint_version = v_cur + 1, checkpoint_updated_at = now()
    where session_id = p_id and user_id = p_user_id;
  return public.wiz_checkpoint_get(p_user_id, p_id);
end $$;

create function public.wiz_message_append(
  p_user_id uuid, p_session_id uuid, p_sender text, p_content text, p_tokens integer,
  p_key text, p_model text, p_provenance jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_conv public.conversations;
  v_existing uuid;
  v_id uuid;
  v_title text;
  v_row jsonb;
  v_prov jsonb := coalesce(p_provenance, '{}'::jsonb);
begin
  perform 1 from public.conversations where id = p_session_id and user_id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  if p_sender not in ('user', 'assistant', 'system') or coalesce(p_content, '') = '' then perform public.wiz_fail('invalid_input'); end if;
  -- lock order: notice -> user consent (inside the gate) -> conversation row
  if not public.wiz_consent_gate(p_user_id, 'save_chats') then perform public.wiz_fail('consent_required'); end if;
  select * into v_conv from public.conversations where id = p_session_id and user_id = p_user_id for update;
  if not found then perform public.wiz_fail('not_found'); end if;

  v_existing := public.wiz_idem_claim(p_user_id, 'message:' || p_session_id::text, p_key,
    jsonb_build_object('sender', p_sender, 'content', p_content, 'tokens', coalesce(p_tokens, 0), 'model', p_model, 'provenance', v_prov));
  if v_existing is not null then
    select jsonb_build_object('id', m.id, 'seq', x.seq, 'sender', m.sender, 'content', m.content, 'tokens_used', m.tokens_used,
      'model', x.model, 'created_at', m.created_at, 'sources', x.provenance -> 'sources') into v_row
    from public.messages m join public.wiz_message_meta x on x.message_id = m.id
    where m.id = v_existing and x.user_id = p_user_id;
    return jsonb_build_object('item', v_row, 'replayed', true);
  end if;

  insert into public.messages (conversation_id, sender, content, tokens_used)
  values (p_session_id, p_sender, p_content, coalesce(p_tokens, 0)) returning id into v_id;
  insert into public.wiz_message_meta (message_id, session_id, user_id, model, provenance)
  values (v_id, p_session_id, p_user_id, p_model, v_prov);

  -- automatic title from the first user message of an untitled session
  if p_sender = 'user' and v_conv.title = 'New Conversation'
     and (select title_source from public.wiz_session_meta where session_id = p_session_id) = 'auto' then
    v_title := regexp_replace(btrim(p_content), '\s+', ' ', 'g');
    if char_length(v_title) > 60 then
      v_title := coalesce(nullif(regexp_replace(left(v_title, 60), '\s+\S*$', ''), ''), left(v_title, 60)) || '…';
    end if;
    if v_title <> '' then
      update public.conversations set title = v_title where id = p_session_id and user_id = p_user_id;
    end if;
  end if;
  update public.conversations set updated_at = now() where id = p_session_id and user_id = p_user_id;
  update public.wiz_session_meta set message_count = message_count + 1, last_message_at = now()
    where session_id = p_session_id and user_id = p_user_id;
  perform public.wiz_idem_set(p_user_id, 'message:' || p_session_id::text, p_key, v_id);

  select jsonb_build_object('id', m.id, 'seq', x.seq, 'sender', m.sender, 'content', m.content, 'tokens_used', m.tokens_used,
    'model', x.model, 'created_at', m.created_at, 'sources', x.provenance -> 'sources') into v_row
  from public.messages m join public.wiz_message_meta x on x.message_id = m.id where m.id = v_id;
  return jsonb_build_object('item', v_row, 'replayed', false);
end $$;

create function public.wiz_message_list(p_user_id uuid, p_session_id uuid, p_limit integer, p_after bigint) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare v_items jsonb; v_more boolean;
begin
  perform 1 from public.conversations where id = p_session_id and user_id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  with page as (
    select m.id, x.seq, m.sender, m.content, m.tokens_used, x.model, m.created_at, x.provenance -> 'sources' as sources
    from public.wiz_message_meta x join public.messages m on m.id = x.message_id and m.conversation_id = x.session_id
    where x.session_id = p_session_id and x.user_id = p_user_id and (p_after is null or x.seq > p_after)
    order by x.seq limit p_limit + 1
  ), shaped as (select *, row_number() over (order by seq) rn from page)
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'seq', seq, 'sender', sender, 'content', content,
      'tokens_used', tokens_used, 'model', model, 'created_at', created_at, 'sources', sources) order by seq) filter (where rn <= p_limit), '[]'::jsonb),
    coalesce(bool_or(rn > p_limit), false)
  into v_items, v_more from shaped;
  return jsonb_build_object('items', v_items,
    'next_after', case when v_more then (v_items -> (jsonb_array_length(v_items) - 1) ->> 'seq')::bigint else null end);
end $$;

-- coaching reads ---------------------------------------------------------------------------------------------
-- The genuinely most recent messages of a session (the keyset list above only walks forward from the start).
create function public.wiz_message_recent(p_user_id uuid, p_session_id uuid, p_limit integer) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
begin
  perform 1 from public.conversations where id = p_session_id and user_id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(t.j order by t.seq) from (
      select x.seq, jsonb_build_object('id', m.id, 'seq', x.seq, 'sender', m.sender, 'content', m.content,
        'tokens_used', m.tokens_used, 'model', x.model, 'created_at', m.created_at, 'sources', x.provenance -> 'sources') as j
      from public.wiz_message_meta x join public.messages m on m.id = x.message_id and m.conversation_id = x.session_id
      where x.session_id = p_session_id and x.user_id = p_user_id
      order by x.seq desc limit least(greatest(coalesce(p_limit, 30), 1), 100)
    ) t), '[]'::jsonb));
end $$;

-- The message a given Idempotency-Key produced in this session (exact request/response correlation), or null.
create function public.wiz_message_by_key(p_user_id uuid, p_session_id uuid, p_key text) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare v jsonb;
begin
  select jsonb_build_object('id', m.id, 'seq', x.seq, 'sender', m.sender, 'content', m.content, 'tokens_used', m.tokens_used,
    'model', x.model, 'created_at', m.created_at, 'sources', x.provenance -> 'sources', 'provenance', x.provenance) into v
  from public.wiz_idempotency i
  join public.messages m on m.id = i.result_id
  join public.wiz_message_meta x on x.message_id = m.id and x.session_id = p_session_id and x.user_id = p_user_id
  where i.user_id = p_user_id and i.scope = 'message:' || p_session_id::text and i.key = p_key;
  return v;
end $$;

-- Bounded, account-owned personalisation context for a session: the onboarding answers and the last messages /
-- checkpoint of a few OTHER sessions of the same account (same pathway first, then most recent). The personalisation
-- consent (approved, current, granted) is rechecked here under the consent locks; without it only {allowed:false}.
create function public.wiz_personalisation_context(p_user_id uuid, p_session_id uuid, p_max_sessions integer, p_per_session integer) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_cur public.wiz_session_meta;
  v_onb jsonb;
  v_sessions jsonb;
  v_max integer := least(greatest(coalesce(p_max_sessions, 3), 1), 5);
  v_per integer := least(greatest(coalesce(p_per_session, 4), 1), 8);
begin
  select * into v_cur from public.wiz_session_meta where session_id = p_session_id and user_id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  if not public.wiz_consent_gate(p_user_id, 'personalisation') then
    return jsonb_build_object('allowed', false);
  end if;
  select jsonb_build_object('answers', p.onboarding, 'version', p.onboarding_version) into v_onb
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
      order by 9 desc, cv.updated_at desc, m.session_id limit v_max
    ) o
  ) c;
  return jsonb_build_object('allowed', true, 'onboarding', coalesce(v_onb, '{}'::jsonb), 'sessions', v_sessions);
end $$;

-- goals ----------------------------------------------------------------------------------------------
create function public.wiz_goal_create(p_user_id uuid, p_data jsonb, p_key text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_existing uuid;
  v_row public.wiz_goals;
  v_source text := coalesce(p_data ->> 'source', 'user_stated');
  v_confirmed timestamptz := coalesce(nullif(p_data ->> 'confirmed_at', '')::timestamptz, now());
begin
  perform 1 from public.users where id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  -- a goal exists only once the owner confirmed it; source/confirmed_at are set by server code, never by the browser
  if v_source not in ('user_stated', 'assistant_suggested_user_confirmed') or v_confirmed > now() + interval '1 minute' then
    perform public.wiz_fail('invalid_input');
  end if;
  v_existing := public.wiz_idem_claim(p_user_id, 'goal', p_key, p_data);
  if v_existing is not null then
    select * into v_row from public.wiz_goals where id = v_existing and user_id = p_user_id;
    if not found then perform public.wiz_fail('idempotent_target_gone'); end if;
    return jsonb_build_object('item', to_jsonb(v_row) - 'user_id', 'replayed', true);
  end if;
  insert into public.wiz_goals (user_id, session_id, title, why, measure, target_date, source, confirmed_at)
  values (p_user_id, nullif(p_data ->> 'session_id', '')::uuid, p_data ->> 'title', p_data ->> 'why', p_data ->> 'measure',
    nullif(p_data ->> 'target_date', '')::date, v_source, v_confirmed)
  returning * into v_row;
  perform public.wiz_idem_set(p_user_id, 'goal', p_key, v_row.id);
  return jsonb_build_object('item', to_jsonb(v_row) - 'user_id', 'replayed', false);
end $$;

create function public.wiz_goal_get(p_user_id uuid, p_id uuid) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare v_row public.wiz_goals;
begin
  select * into v_row from public.wiz_goals where id = p_id and user_id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  return to_jsonb(v_row) - 'user_id';
end $$;

create function public.wiz_goal_list(p_user_id uuid, p_limit integer, p_before_ts timestamptz, p_before_id uuid) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare v_items jsonb; v_next jsonb;
begin
  with page as (
    select g.* from public.wiz_goals g where g.user_id = p_user_id
      and (p_before_ts is null or (g.created_at, g.id) < (p_before_ts, p_before_id))
    order by g.created_at desc, g.id desc limit p_limit + 1
  ), shaped as (select *, row_number() over (order by created_at desc, id desc) rn from page)
  select coalesce(jsonb_agg(to_jsonb(s) - 'user_id' - 'rn' order by rn) filter (where rn <= p_limit), '[]'::jsonb),
    (select jsonb_build_object('ts', y.created_at, 'id', y.id) from shaped y where y.rn = p_limit and exists (select 1 from shaped z where z.rn = p_limit + 1))
  into v_items, v_next from shaped s;
  return jsonb_build_object('items', v_items, 'next', v_next);
end $$;

create function public.wiz_goal_update(p_user_id uuid, p_id uuid, p_patch jsonb, p_expected_version integer) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_row public.wiz_goals;
begin
  select * into v_row from public.wiz_goals where id = p_id and user_id = p_user_id for update;
  if not found then perform public.wiz_fail('not_found'); end if;
  if p_expected_version is not null and p_expected_version <> v_row.version then perform public.wiz_fail('version_conflict'); end if;
  update public.wiz_goals set
    title = case when p_patch ? 'title' then p_patch ->> 'title' else title end,
    why = case when p_patch ? 'why' then p_patch ->> 'why' else why end,
    measure = case when p_patch ? 'measure' then p_patch ->> 'measure' else measure end,
    target_date = case when p_patch ? 'target_date' then nullif(p_patch ->> 'target_date', '')::date else target_date end,
    status = case when p_patch ? 'status' then p_patch ->> 'status' else status end,
    version = version + 1
  where id = p_id and user_id = p_user_id returning * into v_row;
  return to_jsonb(v_row) - 'user_id';
end $$;

create function public.wiz_goal_delete(p_user_id uuid, p_id uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
begin
  delete from public.wiz_goals where id = p_id and user_id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  return jsonb_build_object('deleted', true);
end $$;

-- journal ---------------------------------------------------------------------------------------------
create function public.wiz_journal_create(p_user_id uuid, p_data jsonb, p_key text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_existing uuid; v_row public.wiz_journal_entries;
begin
  perform 1 from public.users where id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  v_existing := public.wiz_idem_claim(p_user_id, 'journal', p_key, p_data);
  if v_existing is not null then
    select * into v_row from public.wiz_journal_entries where id = v_existing and user_id = p_user_id;
    if not found then perform public.wiz_fail('idempotent_target_gone'); end if;
    return jsonb_build_object('item', to_jsonb(v_row) - 'user_id', 'replayed', true);
  end if;
  insert into public.wiz_journal_entries (user_id, session_id, entry_date, body)
  values (p_user_id, nullif(p_data ->> 'session_id', '')::uuid, coalesce(nullif(p_data ->> 'entry_date', '')::date, current_date), p_data ->> 'body')
  returning * into v_row;
  perform public.wiz_idem_set(p_user_id, 'journal', p_key, v_row.id);
  return jsonb_build_object('item', to_jsonb(v_row) - 'user_id', 'replayed', false);
end $$;

create function public.wiz_journal_get(p_user_id uuid, p_id uuid) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare v_row public.wiz_journal_entries;
begin
  select * into v_row from public.wiz_journal_entries where id = p_id and user_id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  return to_jsonb(v_row) - 'user_id';
end $$;

create function public.wiz_journal_list(p_user_id uuid, p_limit integer, p_before_ts timestamptz, p_before_id uuid) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare v_items jsonb; v_next jsonb;
begin
  with page as (
    select g.* from public.wiz_journal_entries g where g.user_id = p_user_id
      and (p_before_ts is null or (g.created_at, g.id) < (p_before_ts, p_before_id))
    order by g.created_at desc, g.id desc limit p_limit + 1
  ), shaped as (select *, row_number() over (order by created_at desc, id desc) rn from page)
  select coalesce(jsonb_agg(to_jsonb(s) - 'user_id' - 'rn' order by rn) filter (where rn <= p_limit), '[]'::jsonb),
    (select jsonb_build_object('ts', y.created_at, 'id', y.id) from shaped y where y.rn = p_limit and exists (select 1 from shaped z where z.rn = p_limit + 1))
  into v_items, v_next from shaped s;
  return jsonb_build_object('items', v_items, 'next', v_next);
end $$;

create function public.wiz_journal_update(p_user_id uuid, p_id uuid, p_patch jsonb, p_expected_version integer) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_row public.wiz_journal_entries;
begin
  select * into v_row from public.wiz_journal_entries where id = p_id and user_id = p_user_id for update;
  if not found then perform public.wiz_fail('not_found'); end if;
  if p_expected_version is not null and p_expected_version <> v_row.version then perform public.wiz_fail('version_conflict'); end if;
  update public.wiz_journal_entries set
    body = case when p_patch ? 'body' then p_patch ->> 'body' else body end,
    entry_date = case when p_patch ? 'entry_date' then (p_patch ->> 'entry_date')::date else entry_date end,
    version = version + 1
  where id = p_id and user_id = p_user_id returning * into v_row;
  return to_jsonb(v_row) - 'user_id';
end $$;

create function public.wiz_journal_delete(p_user_id uuid, p_id uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
begin
  delete from public.wiz_journal_entries where id = p_id and user_id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  return jsonb_build_object('deleted', true);
end $$;

-- reports ---------------------------------------------------------------------------------------------
create function public.wiz_report_create(p_user_id uuid, p_data jsonb, p_key text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_existing uuid; v_row public.wiz_reports;
begin
  perform 1 from public.users where id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  v_existing := public.wiz_idem_claim(p_user_id, 'report', p_key, p_data);
  if v_existing is not null then
    select * into v_row from public.wiz_reports where id = v_existing and user_id = p_user_id;
    if not found then perform public.wiz_fail('idempotent_target_gone'); end if;
    return jsonb_build_object('item', to_jsonb(v_row) - 'user_id', 'replayed', true);
  end if;
  insert into public.wiz_reports (user_id, session_id, kind, title, body, source, model, provenance)
  values (p_user_id, nullif(p_data ->> 'session_id', '')::uuid, p_data ->> 'kind', p_data ->> 'title', p_data ->> 'body',
    coalesce(p_data ->> 'source', 'client_submitted'), p_data ->> 'model', coalesce(p_data -> 'provenance', '{}'::jsonb))
  returning * into v_row;
  perform public.wiz_idem_set(p_user_id, 'report', p_key, v_row.id);
  return jsonb_build_object('item', to_jsonb(v_row) - 'user_id', 'replayed', false);
end $$;

create function public.wiz_report_get(p_user_id uuid, p_id uuid) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare v_row public.wiz_reports;
begin
  select * into v_row from public.wiz_reports where id = p_id and user_id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  return to_jsonb(v_row) - 'user_id';
end $$;

create function public.wiz_report_list(p_user_id uuid, p_limit integer, p_before_ts timestamptz, p_before_id uuid) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare v_items jsonb; v_next jsonb;
begin
  with page as (
    select g.id, g.session_id, g.kind, g.title, g.source, g.model, g.version, g.created_at from public.wiz_reports g where g.user_id = p_user_id
      and (p_before_ts is null or (g.created_at, g.id) < (p_before_ts, p_before_id))
    order by g.created_at desc, g.id desc limit p_limit + 1
  ), shaped as (select *, row_number() over (order by created_at desc, id desc) rn from page)
  select coalesce(jsonb_agg(to_jsonb(s) - 'rn' order by rn) filter (where rn <= p_limit), '[]'::jsonb),
    (select jsonb_build_object('ts', y.created_at, 'id', y.id) from shaped y where y.rn = p_limit and exists (select 1 from shaped z where z.rn = p_limit + 1))
  into v_items, v_next from shaped s;
  return jsonb_build_object('items', v_items, 'next', v_next);
end $$;

create function public.wiz_report_delete(p_user_id uuid, p_id uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
begin
  delete from public.wiz_reports where id = p_id and user_id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  return jsonb_build_object('deleted', true);
end $$;

-- profile evidence (owner can review, correct, confirm, enable/revoke AI use, delete) ----------------
create function public.wiz_evidence_create(p_user_id uuid, p_data jsonb, p_key text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_existing uuid; v_row public.wiz_profile_evidence; v_source text := coalesce(p_data ->> 'source', 'user_stated');
begin
  perform 1 from public.users where id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  if v_source not in ('user_stated', 'onboarding', 'assistant_inferred') then perform public.wiz_fail('invalid_input'); end if;
  v_existing := public.wiz_idem_claim(p_user_id, 'evidence', p_key, p_data);
  if v_existing is not null then
    select * into v_row from public.wiz_profile_evidence where id = v_existing and user_id = p_user_id;
    if not found then perform public.wiz_fail('idempotent_target_gone'); end if;
    return jsonb_build_object('item', to_jsonb(v_row) - 'user_id', 'replayed', true);
  end if;
  insert into public.wiz_profile_evidence (user_id, session_id, statement, source, confirmed_at)
  values (p_user_id, nullif(p_data ->> 'session_id', '')::uuid, p_data ->> 'statement', v_source,
    case when v_source = 'assistant_inferred' then null else now() end)
  returning * into v_row;
  perform public.wiz_idem_set(p_user_id, 'evidence', p_key, v_row.id);
  return jsonb_build_object('item', to_jsonb(v_row) - 'user_id', 'replayed', false);
end $$;

create function public.wiz_evidence_list(p_user_id uuid, p_limit integer, p_before_ts timestamptz, p_before_id uuid) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare v_items jsonb; v_next jsonb;
begin
  with page as (
    select g.* from public.wiz_profile_evidence g where g.user_id = p_user_id
      and (p_before_ts is null or (g.created_at, g.id) < (p_before_ts, p_before_id))
    order by g.created_at desc, g.id desc limit p_limit + 1
  ), shaped as (select *, row_number() over (order by created_at desc, id desc) rn from page)
  select coalesce(jsonb_agg(to_jsonb(s) - 'user_id' - 'rn' order by rn) filter (where rn <= p_limit), '[]'::jsonb),
    (select jsonb_build_object('ts', y.created_at, 'id', y.id) from shaped y where y.rn = p_limit and exists (select 1 from shaped z where z.rn = p_limit + 1))
  into v_items, v_next from shaped s;
  return jsonb_build_object('items', v_items, 'next', v_next);
end $$;

create function public.wiz_evidence_correct(p_user_id uuid, p_id uuid, p_statement text, p_expected_version integer) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_row public.wiz_profile_evidence;
begin
  select * into v_row from public.wiz_profile_evidence where id = p_id and user_id = p_user_id for update;
  if not found then perform public.wiz_fail('not_found'); end if;
  if p_expected_version is not null and p_expected_version <> v_row.version then perform public.wiz_fail('version_conflict'); end if;
  insert into public.wiz_profile_evidence_revisions (evidence_id, user_id, version, statement)
    values (v_row.id, p_user_id, v_row.version, v_row.statement);
  -- the owner's corrected wording is their own statement, so it counts as confirmed
  update public.wiz_profile_evidence set statement = p_statement, version = version + 1,
    confirmed_at = coalesce(confirmed_at, now())
  where id = p_id and user_id = p_user_id returning * into v_row;
  return to_jsonb(v_row) - 'user_id';
end $$;

create function public.wiz_evidence_confirm(p_user_id uuid, p_id uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_row public.wiz_profile_evidence;
begin
  update public.wiz_profile_evidence set confirmed_at = coalesce(confirmed_at, now())
  where id = p_id and user_id = p_user_id returning * into v_row;
  if not found then perform public.wiz_fail('not_found'); end if;
  return to_jsonb(v_row) - 'user_id';
end $$;

create function public.wiz_evidence_set_ai_use(p_user_id uuid, p_id uuid, p_enabled boolean) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_row public.wiz_profile_evidence;
begin
  perform 1 from public.wiz_profile_evidence where id = p_id and user_id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  -- lock order: notice -> user consent (inside the gate) -> evidence row. Revoking needs no consent.
  if p_enabled and not public.wiz_consent_gate(p_user_id, 'personalisation') then perform public.wiz_fail('consent_required'); end if;
  select * into v_row from public.wiz_profile_evidence where id = p_id and user_id = p_user_id for update;
  if not found then perform public.wiz_fail('not_found'); end if;
  if p_enabled then
    if v_row.confirmed_at is null then perform public.wiz_fail('not_confirmed'); end if;
    update public.wiz_profile_evidence set ai_use_enabled = true, revoked_at = null
      where id = p_id and user_id = p_user_id returning * into v_row;
  else
    update public.wiz_profile_evidence set ai_use_enabled = false, revoked_at = now()
      where id = p_id and user_id = p_user_id returning * into v_row;
  end if;
  return to_jsonb(v_row) - 'user_id';
end $$;

create function public.wiz_evidence_delete(p_user_id uuid, p_id uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
begin
  delete from public.wiz_profile_evidence where id = p_id and user_id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  return jsonb_build_object('deleted', true);
end $$;

-- training progress + pairing status ---------------------------------------------------------------------
create function public.wiz_training_upsert(p_user_id uuid, p_module_key text, p_status text, p_percent integer) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_row public.wiz_training_progress; v_pct integer := case when p_status = 'completed' then 100 else coalesce(p_percent, 0) end;
begin
  perform 1 from public.users where id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  insert into public.wiz_training_progress (user_id, module_key, status, percent, started_at, completed_at)
  values (p_user_id, p_module_key, p_status, v_pct,
    case when p_status <> 'not_started' then now() end, case when p_status = 'completed' then now() end)
  on conflict (user_id, module_key) do update set
    status = excluded.status, percent = excluded.percent,
    started_at = case when excluded.status = 'not_started' then null else coalesce(public.wiz_training_progress.started_at, now()) end,
    completed_at = case when excluded.status = 'completed' then coalesce(public.wiz_training_progress.completed_at, now()) else null end
  returning * into v_row;
  return to_jsonb(v_row) - 'user_id';
end $$;

create function public.wiz_training_list(p_user_id uuid) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(to_jsonb(t) - 'user_id' order by t.module_key), '[]'::jsonb)
  from public.wiz_training_progress t where t.user_id = p_user_id;
$$;

create function public.wiz_pairing_get(p_user_id uuid) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('status', coalesce(p.status, 'not_paired'), 'updated_at', p.updated_at)
  from (select 1) o left join public.wiz_pairing_status p on p.user_id = p_user_id;
$$;

-- server-internal (not exposed by any browser route): later pairing flows set status through this.
create function public.wiz_pairing_set(p_user_id uuid, p_status text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
begin
  perform 1 from public.users where id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  insert into public.wiz_pairing_status (user_id, status) values (p_user_id, p_status)
    on conflict (user_id) do update set status = excluded.status;
  return public.wiz_pairing_get(p_user_id);
end $$;

-- The only supported way for later stages to read evidence for model use: re-checks the global personalisation
-- consent (approved, current, granted) under the consent locks; ai_use_enabled alone is never sufficient.
create function public.wiz_evidence_ai_usable(p_user_id uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
begin
  if not public.wiz_consent_gate(p_user_id, 'personalisation') then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', e.id, 'statement', e.statement, 'source', e.source,
      'confirmed_at', e.confirmed_at, 'version', e.version) order by e.created_at, e.id)
    from public.wiz_profile_evidence e
    where e.user_id = p_user_id and e.ai_use_enabled and e.confirmed_at is not null and e.revoked_at is null
  ), '[]'::jsonb);
end $$;


-- 7. access hardening -------------------------------------------------------------------------------------------
-- RLS stays ON everywhere. The new tables get no policies (deny by default for non-bypass roles); the existing tables
-- keep their policies untouched but lose ALL browser privileges (table, column, PUBLIC), because their broad grants
-- would otherwise let a browser forge assistant messages or change billing fields through PostgREST.
-- service_role is a TRUSTED server credential: it is reduced to exactly what the wiz_* functions do (no TRUNCATE,
-- no billing-column writes, no access to wiz_migration_state), but the functions are SECURITY INVOKER, so their owner
-- predicates protect correctly-made calls only. The API must pass a server-derived verified id as p_user_id; nothing
-- here protects against someone who holds the service key and runs arbitrary SQL through it.
alter table public.users enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
do $$
begin
  if to_regclass('public.user_documents') is not null then
    execute 'alter table public.user_documents enable row level security';
  end if;
end $$;

do $$
declare
  r record;
  g record;
begin
  -- browser roles and PUBLIC: nothing, on every touched table (table and column level) and owned sequence
  for r in
    select c.oid, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and (c.oid in (select to_regclass(i.name)::oid from wiz_inventory i where i.kind = 'table')
           or c.relname in ('users', 'conversations', 'messages', 'user_documents'))
  loop
    execute format('alter table public.%I enable row level security', r.relname);
    execute format('revoke all on table public.%I from public, anon, authenticated', r.relname);
    for g in select a.attname from pg_attribute a where a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped and a.attacl is not null loop
      execute format('revoke all (%I) on table public.%I from public, anon, authenticated', g.attname, r.relname);
    end loop;
  end loop;
  for r in
    select s.relname from pg_class s
    join pg_depend d on d.objid = s.oid and d.classid = 'pg_class'::regclass and d.deptype in ('a', 'i')
    where s.relkind = 'S' and d.refobjid in (select to_regclass(i.name)::oid from wiz_inventory i where i.kind = 'table')
  loop
    execute format('revoke all on sequence public.%I from public, anon, authenticated', r.relname);
  end loop;

  -- service_role on the existing tables: only what the functions use (user_documents is deliberately left as found)
  execute 'revoke all on table public.users, public.conversations, public.messages from service_role';
  for g in
    select c.relname, a.attname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and a.attacl is not null
    where n.nspname = 'public' and c.relname in ('users', 'conversations', 'messages')
  loop
    execute format('revoke all (%I) on table public.%I from service_role', g.attname, g.relname);
  end loop;
  grant select on public.users, public.conversations, public.messages to service_role;
  grant insert (id, email) on public.users to service_role;
  grant update (email, full_name) on public.users to service_role;
  grant insert (user_id) on public.conversations to service_role;
  grant update (title, is_archived, updated_at) on public.conversations to service_role;
  grant insert (conversation_id, sender, content, tokens_used) on public.messages to service_role;

  -- service_role on the new tables: per-table minimum
  for r in
    select * from (values
      ('wiz_user_profiles', 'select, insert, update'), ('wiz_consent_versions', 'select'), ('wiz_consent_events', 'select, insert'),
      ('wiz_idempotency', 'select, insert, update'), ('wiz_session_meta', 'select, insert, update'), ('wiz_message_meta', 'select, insert'),
      ('wiz_goals', 'select, insert, update, delete'), ('wiz_journal_entries', 'select, insert, update, delete'),
      ('wiz_reports', 'select, insert, delete'), ('wiz_profile_evidence', 'select, insert, update, delete'),
      ('wiz_profile_evidence_revisions', 'select, insert'), ('wiz_training_progress', 'select, insert, update'),
      ('wiz_pairing_status', 'select, insert, update')
    ) as v(t, privs)
  loop
    execute format('revoke all on table public.%I from service_role', r.t);
    execute format('grant %s on table public.%I to service_role', r.privs, r.t);
  end loop;
  alter table public.wiz_migration_state enable row level security;
  revoke all on table public.wiz_migration_state from public, anon, authenticated, service_role;

  -- functions: callable by the service role only
  for r in select name from wiz_inventory where kind = 'function' loop
    execute format('revoke all on function %s from public, anon, authenticated', r.name);
    execute format('grant execute on function %s to service_role', r.name);
  end loop;
end $$;

update public.wiz_migration_state set status = 'applied', applied_at = now(), rolled_back_at = null
where name = 'wiz_account_foundation_20261003';

  $wiz_body$;
end $wiz_migration$;

commit;
