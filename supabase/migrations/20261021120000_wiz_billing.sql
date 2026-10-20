-- WIZ paid subscription: private entitlement + billing-event records and the narrow service-role functions around them.
--
-- PREPARED ONLY: not applied to any database. Requires the account foundation, career and privacy migrations.
-- Additive: two new private tables and wiz_billing_* functions. The legacy public.users billing columns (subscription_status, subscription_tier,
-- stripe_customer_id) are NOT read, written or altered: wiz_billing_entitlements is the only paid-access authority.
--   * wiz_billing_entitlements: one row per (WIZ user, Stripe mode): customer / subscription / allowlisted price ids, provider status, the
--     verified paid-through time, cancel-at-period-end, last paid invoice id, and a persistent per-owner LEASE (token, expiry, fence counter).
--     The lease serialises "fetch provider state -> commit" across workers (PostgREST RPCs are separate transactions, so a database lock cannot
--     span the provider call). A stale holder's commit is refused (billing_lease_lost); a second reconciler waits (billing_busy, retryable).
--   * wiz_billing_events: unique (mode, event_id), type, owner, identifiers, time. No raw payloads. Inserted in the SAME transaction as the
--     entitlement update, so a failure rolls back both and the provider's retry is safe; a committed duplicate is a no-op.
--   * access = active status AND a verified paid period that has not ended (database clock). Trials, incomplete, past_due, unpaid, paused,
--     conflicting or unknown states never grant. Applications decide the state from CURRENT provider data; nothing here trusts a redirect.
-- Browser roles (anon, authenticated, PUBLIC) get nothing. Functions are SECURITY INVOKER and filter by the caller-supplied owner; the API passes the
-- VERIFIED bearer user id only (or the owner bound to a verified webhook customer).
-- Deleting the user cascades both tables. The API refuses/handles erasure while a subscription can still charge (see docs/billing.md).
-- Rollback (data-preserving; keeps the tables): supabase/rollbacks/20261021120000_wiz_billing.down.sql

begin;
select pg_advisory_xact_lock(hashtextextended('wiz_billing_20261021', 0));

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
    execute $q$ select status from public.wiz_migration_state where name = 'wiz_billing_20261021' $q$ into v_status;
  end if;
  if v_found is distinct from 'applied' or v_career is distinct from 'applied' or v_privacy is distinct from 'applied' then
    raise exception 'wiz billing migration refused: foundation, career and privacy migrations must be applied first (%, %, %)',
      coalesce(v_found, 'absent'), coalesce(v_career, 'absent'), coalesce(v_privacy, 'absent');
  end if;
  if v_status = 'applied' then
    raise notice 'wiz billing migration already applied; nothing changed';
    return;
  end if;
  if v_status = 'applying' then
    raise exception 'wiz billing migration refused: a previous run left state applying';
  end if;
  if v_status is null then
    select string_agg(x, ', ') into v_collision from (
      select relname::text as x from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname in ('wiz_billing_entitlements', 'wiz_billing_events')
      union all
      select p.proname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname ~ '^wiz_billing_'
    ) q;
    if v_collision is not null then
      raise exception 'wiz billing migration refused: objects already exist but are not recorded as this migration: %', v_collision;
    end if;
  end if;

  execute $wiz_body$
insert into public.wiz_migration_state (name, status, captured) values ('wiz_billing_20261021', 'applying', '{}'::jsonb)
on conflict (name) do update set status = 'applying';

-- 1. tables ------------------------------------------------------------------------------------------------------------------
create table if not exists public.wiz_billing_entitlements (
  user_id              uuid not null references public.users (id) on delete cascade,
  mode                 text not null check (mode in ('test', 'live')),
  customer_id          text check (customer_id ~ '^cus_[A-Za-z0-9]{3,64}$'),
  subscription_id      text check (subscription_id ~ '^sub_[A-Za-z0-9]{3,64}$'),
  price_id             text check (price_id ~ '^price_[A-Za-z0-9]{3,64}$'),
  status               text not null default 'none'
    check (status in ('none', 'active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'incomplete_expired', 'paused', 'canceled', 'conflict')),
  paid_through         timestamptz,
  cancel_at_period_end boolean not null default false,
  last_invoice_id      text check (last_invoice_id ~ '^in_[A-Za-z0-9_]{3,64}$'),
  reconciled_at        timestamptz,
  lease_token          uuid,
  lease_until          timestamptz,
  fence                bigint not null default 0,
  created_at           timestamptz not null default now(),
  primary key (user_id, mode)
);
create unique index if not exists wiz_billing_customer_idx on public.wiz_billing_entitlements (mode, customer_id) where customer_id is not null;
create unique index if not exists wiz_billing_subscription_idx on public.wiz_billing_entitlements (mode, subscription_id) where subscription_id is not null;

create table if not exists public.wiz_billing_events (
  mode            text not null check (mode in ('test', 'live')),
  event_id        text not null check (event_id ~ '^evt_[A-Za-z0-9_]{3,100}$'),
  event_type      text not null check (char_length(event_type) between 3 and 80),
  user_id         uuid not null references public.users (id) on delete cascade,
  customer_id     text,
  subscription_id text,
  processed_at    timestamptz not null default now(),
  primary key (mode, event_id)
);
create index if not exists wiz_billing_events_user_idx on public.wiz_billing_events (user_id, processed_at);

-- 2. functions ---------------------------------------------------------------------------------------------------------------
-- webhook customer -> owner (null when the customer is not bound to anyone: such events are ignored by the API)
create or replace function public.wiz_billing_owner(p_mode text, p_customer_id text) returns uuid
language sql stable set search_path = public, pg_temp as $$
  select e.user_id from public.wiz_billing_entitlements e where e.mode = p_mode and e.customer_id = p_customer_id;
$$;

-- server-only view of the binding (never returned to the browser)
create or replace function public.wiz_billing_binding(p_user_id uuid, p_mode text) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select coalesce((select jsonb_build_object('customer_id', e.customer_id, 'subscription_id', e.subscription_id, 'status', e.status)
    from public.wiz_billing_entitlements e where e.user_id = p_user_id and e.mode = p_mode), '{}'::jsonb);
$$;

-- owner-facing state. entitled = active AND a verified paid period that has not ended (database clock). Nothing else grants access.
create or replace function public.wiz_billing_state(p_user_id uuid, p_mode text) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'mode', p_mode,
    'bound', coalesce(e.customer_id is not null, false),
    'status', coalesce(e.status, 'none'),
    'paid_through', e.paid_through,
    'cancel_at_period_end', coalesce(e.cancel_at_period_end, false),
    'reconciled_at', e.reconciled_at,
    'entitled', coalesce(e.status = 'active' and e.paid_through is not null and e.paid_through > now(), false))
  from (select 1) one left join public.wiz_billing_entitlements e on e.user_id = p_user_id and e.mode = p_mode;
$$;

-- Takes the per-owner lease. A duplicate event (already committed) returns {duplicate:true} without taking it. Busy -> wiz:billing_busy.
create or replace function public.wiz_billing_lease(p_user_id uuid, p_mode text, p_event_id text, p_ttl integer) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_row public.wiz_billing_entitlements;
begin
  if p_mode not in ('test', 'live') then perform public.wiz_fail('invalid_input'); end if;
  perform 1 from public.users where id = p_user_id;
  if not found then perform public.wiz_fail('not_found'); end if;
  if p_event_id is not null and exists (select 1 from public.wiz_billing_events x where x.mode = p_mode and x.event_id = p_event_id) then
    return jsonb_build_object('duplicate', true);
  end if;
  insert into public.wiz_billing_entitlements (user_id, mode) values (p_user_id, p_mode) on conflict do nothing;
  update public.wiz_billing_entitlements set lease_token = gen_random_uuid(),
    lease_until = clock_timestamp() + make_interval(secs => least(greatest(coalesce(p_ttl, 30), 5), 120)), fence = fence + 1
  where user_id = p_user_id and mode = p_mode and (lease_until is null or lease_until <= clock_timestamp())
  returning * into v_row;
  if not found then perform public.wiz_fail('billing_busy'); end if;
  return jsonb_build_object('duplicate', false, 'token', v_row.lease_token, 'fence', v_row.fence,
    'customer_id', v_row.customer_id, 'subscription_id', v_row.subscription_id, 'status', v_row.status);
end $$;

-- Persist the server-created customer for the lease holder. A different customer already bound, or one bound to another owner -> billing_conflict.
create or replace function public.wiz_billing_bind_customer(p_user_id uuid, p_mode text, p_token uuid, p_customer_id text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_row public.wiz_billing_entitlements;
begin
  select * into v_row from public.wiz_billing_entitlements where user_id = p_user_id and mode = p_mode for update;
  if not found or v_row.lease_token is distinct from p_token or v_row.lease_until <= clock_timestamp() then perform public.wiz_fail('billing_lease_lost'); end if;
  if v_row.customer_id is not null and v_row.customer_id <> p_customer_id then perform public.wiz_fail('billing_conflict'); end if;
  begin
    update public.wiz_billing_entitlements set customer_id = p_customer_id where user_id = p_user_id and mode = p_mode;
  exception when unique_violation then
    perform public.wiz_fail('billing_conflict');
  end;
  return jsonb_build_object('customer_id', p_customer_id);
end $$;

create or replace function public.wiz_billing_release(p_user_id uuid, p_mode text, p_token uuid) returns void
language sql set search_path = public, pg_temp as $$
  update public.wiz_billing_entitlements set lease_token = null, lease_until = null
  where user_id = p_user_id and mode = p_mode and lease_token = p_token;
$$;

-- Atomic: verify the lease, insert the event (duplicate -> no-op), write the entitlement from the state the API fetched WHILE holding the lease,
-- release. Any failure raises and rolls back the event and the entitlement together.
create or replace function public.wiz_billing_commit(p_user_id uuid, p_mode text, p_token uuid, p_event_id text, p_event_type text, p_state jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_row public.wiz_billing_entitlements;
  v_n integer;
begin
  select * into v_row from public.wiz_billing_entitlements where user_id = p_user_id and mode = p_mode for update;
  if not found or v_row.lease_token is distinct from p_token or v_row.lease_until <= clock_timestamp() then perform public.wiz_fail('billing_lease_lost'); end if;
  if p_event_id is not null then
    insert into public.wiz_billing_events (mode, event_id, event_type, user_id, customer_id, subscription_id)
    values (p_mode, p_event_id, p_event_type, p_user_id, v_row.customer_id, nullif(p_state ->> 'subscription_id', ''))
    on conflict (mode, event_id) do nothing;
    get diagnostics v_n = row_count;
    if v_n = 0 then
      update public.wiz_billing_entitlements set lease_token = null, lease_until = null where user_id = p_user_id and mode = p_mode;
      return public.wiz_billing_state(p_user_id, p_mode) || jsonb_build_object('duplicate', true);
    end if;
  end if;
  begin
    update public.wiz_billing_entitlements set
      subscription_id = nullif(p_state ->> 'subscription_id', ''),
      price_id = nullif(p_state ->> 'price_id', ''),
      status = coalesce(p_state ->> 'status', 'none'),
      paid_through = nullif(p_state ->> 'paid_through', '')::timestamptz,
      cancel_at_period_end = coalesce((p_state ->> 'cancel_at_period_end')::boolean, false),
      last_invoice_id = nullif(p_state ->> 'last_invoice_id', ''),
      reconciled_at = now(), lease_token = null, lease_until = null
    where user_id = p_user_id and mode = p_mode;
  exception when unique_violation then
    perform public.wiz_fail('billing_conflict');
  end;
  return public.wiz_billing_state(p_user_id, p_mode) || jsonb_build_object('duplicate', false);
end $$;

-- the owner's own local billing records for the account export (no lease fields, no payloads)
create or replace function public.wiz_billing_export(p_user_id uuid) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'entitlements', coalesce((select jsonb_agg(jsonb_build_object('mode', e.mode, 'customer_id', e.customer_id, 'subscription_id', e.subscription_id,
        'price_id', e.price_id, 'status', e.status, 'paid_through', e.paid_through, 'cancel_at_period_end', e.cancel_at_period_end,
        'last_invoice_id', e.last_invoice_id, 'reconciled_at', e.reconciled_at) order by e.mode)
      from public.wiz_billing_entitlements e where e.user_id = p_user_id), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('mode', x.mode, 'event_id', x.event_id, 'event_type', x.event_type,
        'processed_at', x.processed_at) order by x.processed_at, x.event_id)
      from public.wiz_billing_events x where x.user_id = p_user_id), '[]'::jsonb));
$$;

-- 3. access --------------------------------------------------------------------------------------------------------------------
alter table public.wiz_billing_entitlements enable row level security;
alter table public.wiz_billing_events enable row level security;
revoke all on table public.wiz_billing_entitlements, public.wiz_billing_events from public, anon, authenticated, service_role;
grant select, insert, update on table public.wiz_billing_entitlements to service_role;
grant select, insert on table public.wiz_billing_events to service_role;
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname ~ '^wiz_billing_'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;

update public.wiz_migration_state set status = 'applied', applied_at = now(), rolled_back_at = null,
  captured = jsonb_build_object(
    'owned', jsonb_build_object(
      'functions', (select coalesce(jsonb_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text), '[]'::jsonb) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname ~ '^wiz_billing_')),
    'retained', jsonb_build_object('tables', jsonb_build_array('public.wiz_billing_entitlements', 'public.wiz_billing_events')))
where name = 'wiz_billing_20261021';
  $wiz_body$;
end $wiz_migration$;

commit;
