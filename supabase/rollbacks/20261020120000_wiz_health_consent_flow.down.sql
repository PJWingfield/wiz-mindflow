-- Data-PRESERVING rollback for 20261020120000_wiz_health_consent_flow.
--
-- Withdraws the publication and removes the read-only enforcement functions, but loses no record:
--   * the versions this migration published (save_chats 2, personalisation 2, career_records 2, health_processing 1) are RETIRED, not deleted
--     (events recorded against them keep their foreign key), and the placeholder v1 rows it retired are made current again
--     (the pre-migration state: unapproved, so nothing can be granted). Decisions people already made are untouched.
--   * wiz_coaching_state() and wiz_terms_current() are dropped (no data).
-- It KEEPS wiz_user_profiles.context_fence_at and learning_fence_hashes, the wiz_health_fence trigger and the fence-aware wiz_personalisation_context /
-- wiz_career_context / wiz_evidence_ai_usable / wiz_message_recent (the last only adds a field): with no fence recorded they behave exactly as before, and with one they keep withdrawn
-- context out of model use. Restoring the unfenced versions would silently re-expose withdrawn context, so it is deliberately not done.
-- Re-running the up migration re-publishes (the retired rows are made current again where no other version of the purpose is current).
begin;
select pg_advisory_xact_lock(hashtextextended('wiz_health_consent_flow_20261020', 0));

do $wiz_rollback$
declare
  v_status text;
  v_captured jsonb;
  r record;
begin
  if to_regclass('public.wiz_migration_state') is null then
    raise notice 'wiz health consent rollback: migration was never applied; nothing to do';
    return;
  end if;
  select status, captured into v_status, v_captured from public.wiz_migration_state where name = 'wiz_health_consent_flow_20261020';
  if v_status is distinct from 'applied' then
    raise notice 'wiz health consent rollback: migration is not in applied state (%); nothing to do', coalesce(v_status, 'absent');
    return;
  end if;
  if v_captured -> 'owned' is null or v_captured -> 'published' is null then
    raise exception 'wiz health consent rollback refused: no recorded object inventory';
  end if;

  for r in select value ->> 'purpose' as purpose, value ->> 'version' as version from jsonb_array_elements(v_captured -> 'published') loop
    update public.wiz_consent_versions set status = 'retired' where purpose = r.purpose and version = r.version and status = 'current';
  end loop;
  for r in select value ->> 'purpose' as purpose, value ->> 'version' as version from jsonb_array_elements(coalesce(v_captured -> 'retired_placeholders', '[]'::jsonb)) loop
    update public.wiz_consent_versions v set status = 'current'
    where v.purpose = r.purpose and v.version = r.version and v.status = 'retired'
      and not exists (select 1 from public.wiz_consent_versions c where c.purpose = v.purpose and c.status = 'current');
  end loop;
  for r in select value from jsonb_array_elements_text(v_captured -> 'owned' -> 'functions') loop
    execute format('drop function if exists %s', r.value);
  end loop;

  update public.wiz_migration_state set status = 'rolled_back', rolled_back_at = now()
  where name = 'wiz_health_consent_flow_20261020';
end $wiz_rollback$;

commit;
