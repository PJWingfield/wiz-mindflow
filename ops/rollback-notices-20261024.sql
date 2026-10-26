-- WIZ 24 October 2026 Notice & Terms Rollback (DATA-ONLY, NOT APPLIED).
--
-- Scope:
--   * Retires Terms of Service version '2.0' ('terms-2026-10-24-v2') and restores version '1.0' to 'current'
--     by status transition ONLY.
--   * Retires Privacy Notice consent version '3' ('privacy-2026-10-24-v2') for save_chats, personalisation,
--     career_records, and health_processing, and restores their actual prior version to 'current' by status transition ONLY
--     (career_records '2', personalisation '2', save_chats '2', health_processing '1').
--   * Preserves all version rows (prior and v3), hashes, provenance, terms acceptances, and consent events.
--   * No DELETE, TRUNCATE, DROP, or trigger modifications.

begin;

select pg_advisory_xact_lock(hashtextextended('wiz_publish_notices_20261024', 0));

do $wiz_rollback_20261024$
declare
  v_privacy_id constant text := 'privacy-2026-10-24-v2';
  v_terms_id constant text := 'terms-2026-10-24-v2';
  v_restore_terms_version constant text := '1.0';
  v_new_consent constant text := '3';
  v_restore_consent_versions constant jsonb := '{"save_chats":"2","personalisation":"2","career_records":"2","health_processing":"1"}'::jsonb;
  v_purposes constant text[] := array['career_records', 'health_processing', 'personalisation', 'save_chats'];
  v_purpose text;
  v_prior_ver text;
  v_cur_ver text;
  v_cur_artifact text;
  v_already_terms boolean := false;
  v_already_consents integer := 0;
begin
  if to_regclass('public.wiz_terms_versions') is null
     or to_regclass('public.wiz_consent_versions') is null then
    raise exception 'wiz notice rollback refused: required notice/consent tables are absent';
  end if;

  foreach v_purpose in array v_purposes loop
    perform pg_advisory_xact_lock(hashtextextended('wiz_notice:' || v_purpose, 0));
  end loop;

  -- Check if already rolled back (idempotent verified no-op).
  select exists (
    select 1 from public.wiz_terms_versions
    where version = v_restore_terms_version and status = 'current'
  ) and exists (
    select 1 from public.wiz_terms_versions
    where version = '2.0' and status = 'retired' and artifact_id = v_terms_id
  ) into v_already_terms;

  select count(*)::int into v_already_consents
  from unnest(v_purposes) as p(purpose)
  where exists (
    select 1 from public.wiz_consent_versions c
    where c.purpose = p.purpose
      and c.version = (v_restore_consent_versions ->> p.purpose)
      and c.status = 'current'
  ) and exists (
    select 1 from public.wiz_consent_versions v2
    where v2.purpose = p.purpose
      and v2.version = v_new_consent
      and v2.status = 'retired'
      and v2.artifact_id = v_privacy_id
  );

  if v_already_terms and v_already_consents = array_length(v_purposes, 1) then
    raise notice 'wiz notice publication 2026-10-24 already rolled back; nothing changed';
    return;
  end if;

  -- Verify current Terms version is '2.0' for terms-2026-10-24-v2 and prior version exists as 'retired'.
  select version, artifact_id into v_cur_ver, v_cur_artifact
    from public.wiz_terms_versions
   where status = 'current';
  if v_cur_ver is distinct from '2.0' or v_cur_artifact is distinct from v_terms_id then
    raise exception 'wiz notice rollback refused: expected current terms 2.0 (%), found % (%)', v_terms_id, coalesce(v_cur_ver, 'none'), coalesce(v_cur_artifact, 'none');
  end if;
  if not exists (
    select 1 from public.wiz_terms_versions
    where version = v_restore_terms_version and status = 'retired'
  ) then
    raise exception 'wiz notice rollback refused: prior terms version % is not present as retired', v_restore_terms_version;
  end if;

  -- Verify current Consent versions are '3' for privacy-2026-10-24-v2 and prior versions exist as 'retired'.
  foreach v_purpose in array v_purposes loop
    v_prior_ver := v_restore_consent_versions ->> v_purpose;
    if v_prior_ver is null or v_prior_ver !~ '^[A-Za-z0-9._-]{1,20}$' or v_prior_ver = v_new_consent then
      raise exception 'wiz notice rollback refused: invalid prior version pin for purpose %', v_purpose;
    end if;
    select version, artifact_id into v_cur_ver, v_cur_artifact
      from public.wiz_consent_versions
     where purpose = v_purpose and status = 'current';
    if v_cur_ver is distinct from v_new_consent or v_cur_artifact is distinct from v_privacy_id then
      raise exception 'wiz notice rollback refused: purpose % expected current version 3 (%), found % (%)', v_purpose, v_privacy_id, coalesce(v_cur_ver, 'none'), coalesce(v_cur_artifact, 'none');
    end if;
    if not exists (
      select 1 from public.wiz_consent_versions
      where purpose = v_purpose and version = v_prior_ver and status = 'retired'
    ) then
      raise exception 'wiz notice rollback refused: purpose % prior version % is not present as retired', v_purpose, v_prior_ver;
    end if;
  end loop;

  -- Status-only rollback for Terms.
  update public.wiz_terms_versions
     set status = 'retired'
   where version = '2.0'
     and status = 'current';

  update public.wiz_terms_versions
     set status = 'current'
   where version = v_restore_terms_version
     and status = 'retired';

  -- Status-only rollback for Consent versions.
  foreach v_purpose in array v_purposes loop
    v_prior_ver := v_restore_consent_versions ->> v_purpose;

    update public.wiz_consent_versions
       set status = 'retired'
     where purpose = v_purpose
       and version = v_new_consent
       and status = 'current';

    update public.wiz_consent_versions
       set status = 'current'
     where purpose = v_purpose
       and version = v_prior_ver
       and status = 'retired';
  end loop;
end
$wiz_rollback_20261024$;

commit;
