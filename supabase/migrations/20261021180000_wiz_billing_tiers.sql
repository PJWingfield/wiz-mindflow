-- WIZ three-plan billing: expose the verified paid price to the trusted server, and register the Shared Info sharing consent purpose.
--
-- PREPARED ONLY: not applied to any database. Requires 20261021120000_wiz_billing and 20261020120000_wiz_health_consent_flow.
-- Additive / data-preserving. No new table, no caller-written tier column:
--   * wiz_billing_state(uuid, text) is REPLACED in place (same signature and jsonb return type, so no drop/recreate and its existing service-role-only
--     privileges are untouched) to also return the stored `price_id`. The entitlement calculation, owner filter and everything else are unchanged. The
--     API maps the verified paid price_id to a plan through a server-owned allowlist; the browser can never choose or influence it.
--   * consent purpose `openai_training` version 1 is registered as CURRENT but NOT legal-approved and with no notice artifact. wiz_consent_record
--     therefore refuses every grant (`notice_not_approved`) until a later, separate migration publishes an approved version for an approved notice
--     artifact. Withdrawing is always possible. Nothing is granted here; consent events stay append-only.
-- Rollback (data-preserving): supabase/rollbacks/20261021180000_wiz_billing_tiers.down.sql restores the previous wiz_billing_state body and
-- RETIRES the consent version (so Shared Info becomes unavailable); it never deletes consent events or billing rows.

begin;
select pg_advisory_xact_lock(hashtextextended('wiz_billing_tiers_20261021', 0));

do $wiz_migration$
declare
  v_billing text;
  v_flow text;
  v_status text;
begin
  if to_regclass('public.wiz_migration_state') is not null then
    execute $q$ select status from public.wiz_migration_state where name = 'wiz_billing_20261021' $q$ into v_billing;
    execute $q$ select status from public.wiz_migration_state where name = 'wiz_health_consent_flow_20261020' $q$ into v_flow;
    execute $q$ select status from public.wiz_migration_state where name = 'wiz_billing_tiers_20261021' $q$ into v_status;
  end if;
  if v_billing is distinct from 'applied' or v_flow is distinct from 'applied' then
    raise exception 'wiz billing tiers migration refused: billing and health-consent-flow migrations must be applied first (%, %)',
      coalesce(v_billing, 'absent'), coalesce(v_flow, 'absent');
  end if;
  if v_status = 'applied' then
    raise notice 'wiz billing tiers migration already applied; nothing changed';
    return;
  end if;
  if v_status = 'applying' then
    raise exception 'wiz billing tiers migration refused: a previous run left state applying';
  end if;

  execute $wiz_body$
insert into public.wiz_migration_state (name, status, captured) values ('wiz_billing_tiers_20261021', 'applying', '{}'::jsonb)
on conflict (name) do update set status = 'applying';

-- 1. the verified paid price, for server-side routing --------------------------------------------------------------------------
create or replace function public.wiz_billing_state(p_user_id uuid, p_mode text) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'mode', p_mode,
    'bound', coalesce(e.customer_id is not null, false),
    'status', coalesce(e.status, 'none'),
    'price_id', e.price_id,
    'paid_through', e.paid_through,
    'cancel_at_period_end', coalesce(e.cancel_at_period_end, false),
    'reconciled_at', e.reconciled_at,
    'entitled', coalesce(e.status = 'active' and e.paid_through is not null and e.paid_through > now(), false))
  from (select 1) one left join public.wiz_billing_entitlements e on e.user_id = p_user_id and e.mode = p_mode;
$$;

-- 2. Shared Info sharing consent: registered, unapproved (no grant can be recorded until an approved version is published) ----------
insert into public.wiz_consent_versions (purpose, version, status, summary, legal_approved)
values ('openai_training', '1', 'current',
  'Let WIZ share my Shared Info coaching with OpenAI so it can be used to improve OpenAI''s models. This sends my current message (with any attachment) and this session''s earlier messages since I agreed, any profile or career details I have separately allowed WIZ to use, Mind Flow guide extracts retrieved for the message, and WIZ''s replies. I can withdraw at any time; that stops future sharing but cannot recall what was already sent. Independent of my other privacy choices.',
  false)
on conflict do nothing;
-- re-attach after a rollback (the row exists but was retired): only where no other version of the purpose is current
update public.wiz_consent_versions v set status = 'current'
where v.purpose = 'openai_training' and v.version = '1' and v.status = 'retired'
  and not exists (select 1 from public.wiz_consent_versions c where c.purpose = v.purpose and c.status = 'current');

update public.wiz_migration_state set status = 'applied', applied_at = now(), rolled_back_at = null,
  captured = jsonb_build_object(
    'replaced_function', 'public.wiz_billing_state(uuid, text)',
    'consent_version', jsonb_build_object('purpose', 'openai_training', 'version', '1', 'legal_approved', false))
where name = 'wiz_billing_tiers_20261021';
  $wiz_body$;
end $wiz_migration$;

commit;
