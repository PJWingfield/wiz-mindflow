-- Data-PRESERVING rollback for 20261003120000_wiz_account_foundation.
--
-- Removes only the objects recorded in wiz_migration_state.captured.owned (explicit inventory, never a name pattern):
-- its triggers, functions (no CASCADE: if anything outside the migration depends on one, the rollback fails and
-- nothing changes) and the additive index. Restores the exact grants and RLS flags captured by the up migration on
-- public.users / conversations / messages / user_documents. It does NOT drop any wiz_* table: every record collected
-- after the up migration stays in place. Policies on existing tables were never changed.
--
-- CONSEQUENCE THAT NEEDS EXPLICIT ACCEPTANCE: restoring the captured legacy grants re-opens whatever direct browser
-- access the baseline had to public.conversations / messages, which by then also hold newly retained chats. The
-- rollback therefore refuses to run until the operator sets, in the same session:
--     select set_config('wiz.accept_legacy_grant_restore', 'yes', false);
-- If the migration was never applied (or is already rolled back) this is a no-op and needs no setting.
-- Destructive alternative (deletes the new data): rollbacks/destructive/*.DROP-NEW-DATA.sql
-- Re-running the up migration afterwards re-attaches everything without loss.
begin;
select pg_advisory_xact_lock(hashtextextended('wiz_account_foundation_20261003', 0));

do $wiz_rollback$
declare
  v_status text;
  v_captured jsonb;
  r record;
  e jsonb;
begin
  if to_regclass('public.wiz_migration_state') is null then
    raise notice 'wiz rollback: migration was never applied; nothing to do';
    return;
  end if;
  select status, captured into v_status, v_captured from public.wiz_migration_state where name = 'wiz_account_foundation_20261003';
  if v_status is distinct from 'applied' then
    raise notice 'wiz rollback: migration is not in applied state (%); nothing to do', coalesce(v_status, 'absent');
    return;
  end if;
  if coalesce(current_setting('wiz.accept_legacy_grant_restore', true), '') <> 'yes' then
    raise exception 'wiz rollback refused: it restores the legacy browser grants on conversations/messages; set wiz.accept_legacy_grant_restore = yes to accept';
  end if;
  if v_captured -> 'owned' is null then
    raise exception 'wiz rollback refused: no recorded object inventory';
  end if;

  for r in select value from jsonb_array_elements_text(v_captured -> 'owned' -> 'triggers') loop
    execute format('drop trigger if exists %I on %s', split_part(r.value, '.', 3), split_part(r.value, '.', 1) || '.' || split_part(r.value, '.', 2));
  end loop;
  for r in select value from jsonb_array_elements_text(v_captured -> 'owned' -> 'functions') loop
    execute format('drop function if exists %s', r.value);
  end loop;
  for r in select value from jsonb_array_elements_text(v_captured -> 'owned' -> 'indexes') where value = 'public.wiz_conversations_user_updated_idx' loop
    execute format('drop index if exists %s', r.value);
  end loop;

  -- exact grant restoration: clear what the up migration and default privileges produced, replay the capture
  for e in select * from jsonb_array_elements(v_captured -> 'rls') loop
    if to_regclass(format('public.%I', e ->> 'rel')) is null then continue; end if;
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', e ->> 'rel');
    for r in
      select a.attname from pg_attribute a
      where a.attrelid = format('public.%I', e ->> 'rel')::regclass and a.attnum > 0 and not a.attisdropped and a.attacl is not null
    loop
      execute format('revoke all (%I) on table public.%I from public, anon, authenticated, service_role', r.attname, e ->> 'rel');
    end loop;
    execute format('alter table public.%I %s row level security', e ->> 'rel', case when (e ->> 'enabled')::boolean then 'enable' else 'disable' end);
    execute format('alter table public.%I %s row level security', e ->> 'rel', case when (e ->> 'forced')::boolean then 'force' else 'no force' end);
  end loop;
  for e in select * from jsonb_array_elements(v_captured -> 'grants') loop
    execute format('grant %s on table public.%I to %s%s', e ->> 'privilege', e ->> 'rel', e ->> 'grantee',
      case when (e ->> 'grantable')::boolean then ' with grant option' else '' end);
  end loop;
  for e in select * from jsonb_array_elements(v_captured -> 'column_grants') loop
    execute format('grant %s (%I) on table public.%I to %s%s', e ->> 'privilege', e ->> 'column', e ->> 'rel', e ->> 'grantee',
      case when (e ->> 'grantable')::boolean then ' with grant option' else '' end);
  end loop;

  update public.wiz_migration_state set status = 'rolled_back', rolled_back_at = now()
  where name = 'wiz_account_foundation_20261003';
end $wiz_rollback$;

commit;
