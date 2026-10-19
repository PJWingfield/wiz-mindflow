-- Data-PRESERVING rollback for 20261008120000_wiz_career_backend.
--
-- Drops only the triggers and functions recorded in wiz_migration_state.captured.owned (explicit inventory, no CASCADE:
-- if anything outside the migration depends on one, the rollback fails and nothing changes). It does NOT drop any career
-- table, the added wiz_user_profiles columns or the career_records consent rows: every record saved after the up
-- migration stays in place, inert (no function can reach it; browser roles never could). service_role keeps its table
-- grants. It does not touch the account foundation (tables, functions, grants, RLS, consent notices) in any way.
-- Re-running the up migration afterwards re-attaches everything without loss.
-- Storage objects are not touched either; bucket teardown is a separate manual staging operation.
begin;
select pg_advisory_xact_lock(hashtextextended('wiz_career_backend_20261008', 0));

do $wiz_rollback$
declare
  v_status text;
  v_captured jsonb;
  r record;
begin
  if to_regclass('public.wiz_migration_state') is null then
    raise notice 'wiz career rollback: migration was never applied; nothing to do';
    return;
  end if;
  select status, captured into v_status, v_captured from public.wiz_migration_state where name = 'wiz_career_backend_20261008';
  if v_status is distinct from 'applied' then
    raise notice 'wiz career rollback: migration is not in applied state (%); nothing to do', coalesce(v_status, 'absent');
    return;
  end if;
  if v_captured -> 'owned' is null then
    raise exception 'wiz career rollback refused: no recorded object inventory';
  end if;

  for r in select value from jsonb_array_elements_text(v_captured -> 'owned' -> 'triggers') loop
    execute format('drop trigger if exists %I on %s', split_part(r.value, '.', 3), split_part(r.value, '.', 1) || '.' || split_part(r.value, '.', 2));
  end loop;
  for r in select value from jsonb_array_elements_text(v_captured -> 'owned' -> 'functions') loop
    execute format('drop function if exists %s', r.value);
  end loop;

  update public.wiz_migration_state set status = 'rolled_back', rolled_back_at = now()
  where name = 'wiz_career_backend_20261008';
end $wiz_rollback$;

commit;
