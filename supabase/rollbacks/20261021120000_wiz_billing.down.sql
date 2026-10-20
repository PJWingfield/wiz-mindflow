-- Data-PRESERVING rollback for 20261021120000_wiz_billing.
--
-- Drops only the recorded wiz_billing_* functions (explicit inventory in wiz_migration_state.captured.owned, no CASCADE) and revokes the
-- service-role privileges on the two tables. It KEEPS wiz_billing_entitlements and wiz_billing_events: they record which Stripe customers and
-- subscriptions belong to which account, and deleting them could orphan a subscription that still charges. They stay private (RLS on, no
-- browser grants) and are still removed with the account (foreign-key cascade). Re-running the up migration re-attaches everything.
begin;
select pg_advisory_xact_lock(hashtextextended('wiz_billing_20261021', 0));

do $wiz_rollback$
declare
  v_status text;
  v_captured jsonb;
  r record;
begin
  if to_regclass('public.wiz_migration_state') is null then
    raise notice 'wiz billing rollback: migration was never applied; nothing to do';
    return;
  end if;
  select status, captured into v_status, v_captured from public.wiz_migration_state where name = 'wiz_billing_20261021';
  if v_status is distinct from 'applied' then
    raise notice 'wiz billing rollback: migration is not in applied state (%); nothing to do', coalesce(v_status, 'absent');
    return;
  end if;
  if v_captured -> 'owned' is null then
    raise exception 'wiz billing rollback refused: no recorded object inventory';
  end if;

  for r in select value from jsonb_array_elements_text(v_captured -> 'owned' -> 'functions') loop
    execute format('drop function if exists %s', r.value);
  end loop;
  revoke all on table public.wiz_billing_entitlements, public.wiz_billing_events from service_role;

  update public.wiz_migration_state set status = 'rolled_back', rolled_back_at = now()
  where name = 'wiz_billing_20261021';
end $wiz_rollback$;

commit;
