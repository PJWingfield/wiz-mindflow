-- Data-PRESERVING rollback for 20261019120000_wiz_consent_notices_terms.
--
-- Takes the feature out of service without losing anything recorded: it drops only the two service-role functions listed in
-- wiz_migration_state.captured.owned (no CASCADE) and revokes the two privileges that migration added (INSERT on
-- wiz_terms_acceptances, SELECT on wiz_terms_versions), so no new acceptance can be recorded.
-- It KEEPS wiz_terms_versions, wiz_terms_acceptances (every acceptance), the three added wiz_consent_versions columns, and the
-- wiz_publication_lock function + triggers (recorded content stays write-once). It also keeps the re-created
-- wiz_privacy_export / wiz_privacy_erasure_finish, which still read/verify the retained acceptances: export keeps including them and
-- erasure still removes them (users FK cascade), so a rolled-back database remains exportable and erasable.
-- Re-running the up migration re-attaches everything. If 20261008180000_wiz_privacy_controls is ever re-run, re-run the up migration
-- afterwards (the privacy migration's create-or-replace would otherwise restore the versions without the acceptance data).
-- A destructive removal of acceptance data is deliberately not provided here.
begin;
select pg_advisory_xact_lock(hashtextextended('wiz_consent_notices_20261019', 0));

do $wiz_rollback$
declare
  v_status text;
  v_captured jsonb;
  r record;
begin
  if to_regclass('public.wiz_migration_state') is null then
    raise notice 'wiz consent notices rollback: migration was never applied; nothing to do';
    return;
  end if;
  select status, captured into v_status, v_captured from public.wiz_migration_state where name = 'wiz_consent_notices_20261019';
  if v_status is distinct from 'applied' then
    raise notice 'wiz consent notices rollback: migration is not in applied state (%); nothing to do', coalesce(v_status, 'absent');
    return;
  end if;
  if v_captured -> 'owned' is null then
    raise exception 'wiz consent notices rollback refused: no recorded object inventory';
  end if;

  for r in select value from jsonb_array_elements_text(v_captured -> 'owned' -> 'functions') loop
    execute format('drop function if exists %s', r.value);
  end loop;
  revoke insert on table public.wiz_terms_acceptances from service_role;
  revoke select on table public.wiz_terms_versions from service_role;

  update public.wiz_migration_state set status = 'rolled_back', rolled_back_at = now()
  where name = 'wiz_consent_notices_20261019';
end $wiz_rollback$;

commit;
