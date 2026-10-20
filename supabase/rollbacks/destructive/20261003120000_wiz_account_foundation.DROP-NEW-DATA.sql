-- DESTRUCTIVE: permanently deletes every record collected in the wiz_* tables (profiles, consents, session
-- metadata, message metadata, goals, journal, reports, profile evidence, training, pairing status, idempotency).
-- Existing public.users / conversations / messages rows are NOT touched, but the sessions' message metadata,
-- checkpoints and consent history are lost. Run only after the data-preserving rollback, and only on explicit
-- owner instruction. Refuses to run unless the migration is in 'rolled_back' state.
begin;
select pg_advisory_xact_lock(hashtextextended('wiz_account_foundation_20261003', 0));

do $wiz_destroy$
declare
  r record;
  v_captured jsonb;
begin
  if to_regclass('public.wiz_migration_state') is null then
    raise exception 'wiz destructive rollback refused: run the data-preserving rollback first';
  end if;
  if not exists (select 1 from public.wiz_migration_state where name = 'wiz_account_foundation_20261003' and status = 'rolled_back') then
    raise exception 'wiz destructive rollback refused: run the data-preserving rollback first';
  end if;
  select captured into v_captured from public.wiz_migration_state where name = 'wiz_account_foundation_20261003';
  for r in select value from jsonb_array_elements_text(v_captured -> 'owned' -> 'tables') loop
    execute format('drop table if exists %s cascade', r.value);
  end loop;
  drop table public.wiz_migration_state;
end $wiz_destroy$;

commit;
