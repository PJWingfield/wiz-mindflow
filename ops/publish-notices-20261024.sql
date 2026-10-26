-- WIZ 24 October 2026 Notice & Terms Publication (DATA-ONLY, NOT APPLIED).
--
-- Scope:
--   * Publishes Terms of Service version '2.0' linked to artifact 'terms-2026-10-24-v2'.
--   * Publishes Privacy Notice consent version '3' (uniform NEW version for all four purposes) linked to artifact
--     'privacy-2026-10-24-v2' for the exact four purposes: save_chats, personalisation, career_records, health_processing.
--   * Retires the actual prior current rows by status transition ONLY ('current' -> 'retired'). Actual staging prior
--     versions differ per purpose: career_records '2', personalisation '2', save_chats '2', health_processing '1'.
--   * Preserves all historical version rows, hashes, provenance, terms acceptances, and consent events.
--   * Requires fresh explicit Terms '2.0' acceptance and version '3' consent grants (no silent grant carry-over).
--   * Never publishes or approves openai_training (Sol / Shared Info plan remains disabled).
--   * No DDL, no schema/table/trigger/function changes, no DELETE or TRUNCATE.
--
-- Parent pre-application pin requirements:
--   1. Replace 013ed24f60ec551f30350cda7fd48f34b54eaffcd06142838f2e29e1d923f2d1 and 9ed6fe95d4eca65b56f30c1cfd00e62e9a5d79e5111a1ba379b6f694392e573a
--      with the verified 64-character lowercase hex SHA-256 digests of notices/privacy-2026-10-24-v2.txt
--      and notices/terms-2026-10-24-v2.txt (matching lib/notices.js).
--   2. Confirm the expected current version IDs on the target database from staging readback before running.
--      The script fails closed if hashes are unpinned, if expected current versions do not match, or if
--      version '2.0' / '3' already exists with different artifact identity.
--
-- Provenance note:
--   legal_approved = true is the existing database gate for owner publication authorisation.
--   The 24 October 2026 wording is an owner-delegated technical revision (independent_legal_approval: false),
--   not an independent solicitor sign-off or PJW-signed approval.

begin;

select pg_advisory_xact_lock(hashtextextended('wiz_publish_notices_20261024', 0));

do $wiz_publish_20261024$
declare
  v_privacy_id constant text := 'privacy-2026-10-24-v2';
  v_terms_id constant text := 'terms-2026-10-24-v2';
  v_privacy_sha constant text := '013ed24f60ec551f30350cda7fd48f34b54eaffcd06142838f2e29e1d923f2d1';
  v_terms_sha constant text := '9ed6fe95d4eca65b56f30c1cfd00e62e9a5d79e5111a1ba379b6f694392e573a';
  v_provenance constant text := 'Owner-delegated technical wording revision of 2026-10-24 (independent_legal_approval: false; no PJW signature or independent solicitor approval).';
  v_expected_terms_current constant text := '1.0';
  v_new_consent constant text := '3';
  v_expected_consent_current constant jsonb := '{"save_chats":"2","personalisation":"2","career_records":"2","health_processing":"1"}'::jsonb;
  v_purposes constant text[] := array['career_records', 'health_processing', 'personalisation', 'save_chats'];
  v_purpose text;
  v_exp_ver text;
  v_cur_ver text;
  v_summary text;
  v_existing record;
  v_already_terms boolean := false;
  v_already_consents integer := 0;
begin
  if to_regclass('public.wiz_terms_versions') is null
     or to_regclass('public.wiz_terms_acceptances') is null
     or to_regclass('public.wiz_consent_versions') is null
     or to_regclass('public.wiz_consent_events') is null then
    raise exception 'wiz notice publication refused: required notice/consent tables are absent';
  end if;

  if v_privacy_sha !~ '^[0-9a-f]{64}$' or v_terms_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'wiz notice publication refused: parent must pin exact 64-char hex SHA-256 hashes before applying (privacy=%, terms=%)', v_privacy_sha, v_terms_sha;
  end if;

  -- Acquire per-purpose notice locks in deterministic order.
  foreach v_purpose in array v_purposes loop
    perform pg_advisory_xact_lock(hashtextextended('wiz_notice:' || v_purpose, 0));
  end loop;

  -- Check whether this exact publication is already active (idempotent verified no-op).
  select exists (
    select 1 from public.wiz_terms_versions
    where version = '2.0'
      and status = 'current'
      and artifact_id = v_terms_id
      and artifact_sha256 = v_terms_sha
      and approval_provenance = v_provenance
  ) and exists (
    select 1 from public.wiz_terms_versions
    where version = v_expected_terms_current
      and status = 'retired'
  ) into v_already_terms;

  select count(*)::int into v_already_consents
  from unnest(v_purposes) as p(purpose)
  where exists (
    select 1 from public.wiz_consent_versions c
    where c.purpose = p.purpose
      and c.version = v_new_consent
      and c.status = 'current'
      and c.legal_approved = true
      and c.artifact_id = v_privacy_id
      and c.artifact_sha256 = v_privacy_sha
      and c.approval_provenance = v_provenance
  ) and exists (
    select 1 from public.wiz_consent_versions old_c
    where old_c.purpose = p.purpose
      and old_c.version = (v_expected_consent_current ->> p.purpose)
      and old_c.status = 'retired'
  );

  if v_already_terms and v_already_consents = array_length(v_purposes, 1) then
    raise notice 'wiz notice publication 2026-10-24 already applied and verified; nothing changed';
    return;
  end if;

  -- Refuse on Terms version '2.0' collision if any row exists with different artifact/hash/provenance.
  select version, status, artifact_id, artifact_sha256, approval_provenance
    into v_existing
    from public.wiz_terms_versions
   where version = '2.0';
  if found then
    if v_existing.artifact_id is distinct from v_terms_id
       or v_existing.artifact_sha256 is distinct from v_terms_sha
       or v_existing.approval_provenance is distinct from v_provenance then
      raise exception 'wiz notice publication refused: terms version 2.0 collision with existing row (artifact_id=%, status=%)', v_existing.artifact_id, v_existing.status;
    end if;
  end if;

  -- Refuse on Consent version '3' collision for any target purpose.
  foreach v_purpose in array v_purposes loop
    select purpose, version, status, legal_approved, artifact_id, artifact_sha256, approval_provenance
      into v_existing
      from public.wiz_consent_versions
     where purpose = v_purpose and version = v_new_consent;
    if found then
      if v_existing.artifact_id is distinct from v_privacy_id
         or v_existing.artifact_sha256 is distinct from v_privacy_sha
         or v_existing.approval_provenance is distinct from v_provenance
         or v_existing.legal_approved is distinct from true then
        raise exception 'wiz notice publication refused: consent version 3 collision on purpose % (existing artifact_id=%, status=%)', v_purpose, coalesce(v_existing.artifact_id, 'null'), v_existing.status;
      end if;
    end if;
  end loop;

  -- Verify expected current Terms version before retiring.
  select version into v_cur_ver
    from public.wiz_terms_versions
   where status = 'current';
  if v_cur_ver is distinct from v_expected_terms_current then
    raise exception 'wiz notice publication refused: expected current terms version %, found %', v_expected_terms_current, coalesce(v_cur_ver, 'none');
  end if;

  -- Verify expected current Consent versions before retiring.
  foreach v_purpose in array v_purposes loop
    v_exp_ver := v_expected_consent_current ->> v_purpose;
    if v_exp_ver is null or v_exp_ver !~ '^[A-Za-z0-9._-]{1,20}$' or v_exp_ver = v_new_consent then
      raise exception 'wiz notice publication refused: invalid or unpinned expected current version for purpose %', v_purpose;
    end if;
    select version into v_cur_ver
      from public.wiz_consent_versions
     where purpose = v_purpose and status = 'current';
    if v_cur_ver is distinct from v_exp_ver then
      raise exception 'wiz notice publication refused: purpose % expected current version %, found %', v_purpose, v_exp_ver, coalesce(v_cur_ver, 'none');
    end if;
  end loop;

  -- Ensure openai_training is never approved or published.
  if exists (select 1 from public.wiz_consent_versions where purpose = 'openai_training' and legal_approved = true) then
    raise exception 'wiz notice publication refused: openai_training must remain unapproved';
  end if;

  -- Retire old current Terms version by status only and publish Terms '2.0'.
  update public.wiz_terms_versions
     set status = 'retired'
   where version = v_expected_terms_current
     and status = 'current';

  if exists (select 1 from public.wiz_terms_versions where version = '2.0') then
    update public.wiz_terms_versions
       set status = 'current'
     where version = '2.0'
       and status = 'retired';
  else
    insert into public.wiz_terms_versions (version, status, artifact_id, artifact_sha256, approval_provenance)
    values ('2.0', 'current', v_terms_id, v_terms_sha, v_provenance);
  end if;

  -- Retire old current Consent version by status only and publish version '3' for each of the 4 purposes.
  foreach v_purpose in array v_purposes loop
    v_exp_ver := v_expected_consent_current ->> v_purpose;
    select summary into v_summary
      from public.wiz_consent_versions
     where purpose = v_purpose and version = v_exp_ver;

    update public.wiz_consent_versions
       set status = 'retired'
     where purpose = v_purpose
       and version = v_exp_ver
       and status = 'current';

    if exists (select 1 from public.wiz_consent_versions where purpose = v_purpose and version = v_new_consent) then
      update public.wiz_consent_versions
         set status = 'current'
       where purpose = v_purpose
         and version = v_new_consent
         and status = 'retired';
    else
      insert into public.wiz_consent_versions (
        purpose, version, status, summary, legal_approved, artifact_id, artifact_sha256, approval_provenance
      ) values (
        v_purpose, v_new_consent, 'current', v_summary, true, v_privacy_id, v_privacy_sha, v_provenance
      );
    end if;
  end loop;
end
$wiz_publish_20261024$;

commit;
