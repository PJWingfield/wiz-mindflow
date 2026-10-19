-- Data-PRESERVING rollback for 20261008180000_wiz_privacy_controls.
--
-- Drops only the recorded triggers and functions (explicit inventory in wiz_migration_state.captured.owned, no CASCADE) and revokes
-- exactly the three privileges that migration added (DELETE on public.conversations, public.users and public.wiz_idempotency for service_role).
-- It keeps wiz_erasure_receipts and every record: an unfinished erasure receipt must not be lost. Foundation and career stages are untouched.
-- Re-running the up migration re-attaches everything.
begin;
select pg_advisory_xact_lock(hashtextextended('wiz_privacy_controls_20261008', 0));

do $wiz_rollback$
declare
  v_status text;
  v_captured jsonb;
  r record;
begin
  if to_regclass('public.wiz_migration_state') is null then
    raise notice 'wiz privacy rollback: migration was never applied; nothing to do';
    return;
  end if;
  select status, captured into v_status, v_captured from public.wiz_migration_state where name = 'wiz_privacy_controls_20261008';
  if v_status is distinct from 'applied' then
    raise notice 'wiz privacy rollback: migration is not in applied state (%); nothing to do', coalesce(v_status, 'absent');
    return;
  end if;
  if v_captured -> 'owned' is null then
    raise exception 'wiz privacy rollback refused: no recorded object inventory';
  end if;

  for r in select value from jsonb_array_elements_text(v_captured -> 'owned' -> 'triggers') loop
    execute format('drop trigger if exists %I on %s', split_part(r.value, '.', 3), split_part(r.value, '.', 1) || '.' || split_part(r.value, '.', 2));
  end loop;
  for r in select value from jsonb_array_elements_text(v_captured -> 'owned' -> 'functions') loop
    execute format('drop function if exists %s', r.value);
  end loop;
  revoke delete on table public.conversations from service_role;
  revoke delete on table public.users from service_role;
  revoke delete on table public.wiz_idempotency from service_role;

  update public.wiz_migration_state set status = 'rolled_back', rolled_back_at = now()
  where name = 'wiz_privacy_controls_20261008';
end $wiz_rollback$;

commit;
