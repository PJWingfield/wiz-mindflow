-- Data-PRESERVING rollback for 20261021180000_wiz_billing_tiers.
--
-- Restores the previous wiz_billing_state body (no price_id; same signature, so privileges are untouched) and RETIRES the openai_training consent
-- version, so Shared Info can no longer be granted or used. It deletes nothing: consent events (append-only) and billing rows stay. While this
-- rollback is in force a three-plan configuration cannot resolve a paid price and fails closed (no coaching), so roll the application back (or
-- return it to the legacy single-price configuration) first. Re-running the up migration re-attaches everything.
begin;
select pg_advisory_xact_lock(hashtextextended('wiz_billing_tiers_20261021', 0));

do $wiz_rollback$
declare
  v_status text;
begin
  if to_regclass('public.wiz_migration_state') is null then
    raise notice 'wiz billing tiers rollback: migration was never applied; nothing to do';
    return;
  end if;
  select status into v_status from public.wiz_migration_state where name = 'wiz_billing_tiers_20261021';
  if v_status is distinct from 'applied' then
    raise notice 'wiz billing tiers rollback: migration is not in applied state (%); nothing to do', coalesce(v_status, 'absent');
    return;
  end if;

  execute $wiz_body$
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

update public.wiz_consent_versions set status = 'retired' where purpose = 'openai_training' and version = '1' and status = 'current';

update public.wiz_migration_state set status = 'rolled_back', rolled_back_at = now() where name = 'wiz_billing_tiers_20261021';
  $wiz_body$;
end $wiz_rollback$;

commit;
