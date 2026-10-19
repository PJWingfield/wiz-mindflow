-- Operational rollback retains schema, imported data and reference provenance.
-- Also unset WIZ_KB_PROVENANCE in the application; never fall back to unknown vectors.
begin;
update public.kb_ingested_files set active = false where active;
revoke all on function public.wiz_match_kb_chunks_attested(vector,text,text,integer) from public,anon,authenticated,service_role;
revoke all on function public.wiz_kb_publish_document(text,text,text,text,text,jsonb) from public,anon,authenticated,service_role;
commit;
