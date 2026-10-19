-- Additive only. Legacy data and match_kb_chunks are preserved.
begin;
-- Resolve vector types/operators during migration compilation as well as RPC execution.
set local search_path = pg_catalog, public, extensions, pg_temp;
do $preflight$
begin
 if not exists (
   select 1 from pg_catalog.pg_extension e
   join pg_catalog.pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'vector' and n.nspname in ('public','extensions')
 ) then
   raise exception 'KB migration requires vector extension in public or extensions';
 end if;
end;
$preflight$;
alter table public.kb_ingested_files
 add column source_path text, add column embedding_model text,
 add column active boolean not null default false;
alter table public.kb_chunks add column ingestion_key text
 references public.kb_ingested_files(file_path) on delete restrict;
alter table public.kb_ingested_files add constraint kb_ingested_files_tagged_check check (
 (source_path is null and embedding_model is null) or
 (source_path is not null and embedding_model is not null and
 length(source_path) between 1 and 1024 and source_path = btrim(source_path) and
 source_path !~ '(^/|/$|//|(^|/)\.{1,2}(/|$)|[\\:[:cntrl:]])' and
 source_type is not null and source_type in ('master_kb','guide','reference_book') and
 file_hash is not null and file_hash ~ '^[0-9a-f]{64}$' and embedding_model = 'voyage-3' and
 file_path ~ '^wizkb-v1:[0-9a-f]{64}$' and chunk_count is not null and chunk_count > 0));
alter table public.kb_ingested_files add constraint kb_ingested_files_active_check
 check (not active or (source_path is not null and embedding_model is not null));
alter table public.kb_chunks add constraint kb_chunks_linked_check check (
 ingestion_key is null or (chunk_index is not null and chunk_index >= 0 and
 source_file is not null and length(btrim(source_file)) > 0 and
 content is not null and length(btrim(content)) > 0 and
 source_type is not null and source_type in ('master_kb','guide','reference_book') and
 embedding is not null and vector_dims(embedding) = 1024 and embedding <> array_fill(0::real, ARRAY[1024])::vector));
create unique index kb_ingested_files_active_idx on public.kb_ingested_files
 (source_path,source_type,embedding_model) where active;
create unique index kb_chunks_linked_chunk_idx on public.kb_chunks
 (ingestion_key,chunk_index) where ingestion_key is not null;

create function public.wiz_kb_publish_document(
 p_source_path text,p_source_type text,p_file_hash text,p_embedding_model text,
 p_recipe_version text,p_chunks jsonb
) returns text language plpgsql security definer
set search_path = pg_catalog, public, extensions, pg_temp as $body$
declare
 v_key text; v_chunk jsonb; v_vector vector; v_index integer := 0;
 v_payload jsonb := '[]'::jsonb; v_existing jsonb;
begin
 if p_source_path is null or length(p_source_path) not between 1 and 1024 or
 p_source_path <> btrim(p_source_path) or
 p_source_path ~ '(^/|/$|//|(^|/)\.{1,2}(/|$)|[\\:[:cntrl:]])' then
 raise exception 'Invalid root-relative source path'; end if;
 if p_source_type is null or p_source_type not in ('master_kb','guide','reference_book') or
 p_embedding_model is distinct from 'voyage-3' or
 p_file_hash is null or p_file_hash !~ '^[0-9a-f]{64}$' or
 p_recipe_version is null or p_recipe_version !~ '^[A-Za-z0-9._:-]{1,100}$' then
 raise exception 'Invalid publication provenance'; end if;
 if p_chunks is null or jsonb_typeof(p_chunks) <> 'array' then
 raise exception 'Nonempty chunk array required'; end if;
 if jsonb_array_length(p_chunks) = 0 then raise exception 'Nonempty chunk array required'; end if;
 -- Canonical PostgreSQL JSONB array text, UTF8; never delimiter concatenation.
 v_key := 'wizkb-v1:' || encode(sha256(convert_to(jsonb_build_array(
 'mindflow',p_source_path,p_source_type,p_file_hash,p_embedding_model,p_recipe_version
 )::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(
 'mindflow',p_source_path,p_source_type,p_embedding_model)::text,0));
 -- Validation precedes rerun handling. Normalise float32 embeddings as stored.
 for v_chunk in select value from jsonb_array_elements(p_chunks) loop
 if jsonb_typeof(v_chunk) <> 'object' then raise exception 'Invalid chunk object'; end if;
 if exists (select 1 from jsonb_object_keys(v_chunk) k where k not in
 ('content','source_file','source_type','title','section_number','chunk_index','token_count','embedding')) then
 raise exception 'Unknown chunk fields'; end if;
 if jsonb_typeof(v_chunk->'chunk_index') is distinct from 'number' or
 v_chunk->>'chunk_index' !~ '^(0|[1-9][0-9]*)$' or
 (v_chunk->>'chunk_index')::integer <> v_index then
 raise exception 'Contiguous nonnegative chunk indexes required'; end if;
 if jsonb_typeof(v_chunk->'content') is distinct from 'string' or
 length(btrim(v_chunk->>'content')) = 0 or
 jsonb_typeof(v_chunk->'source_file') is distinct from 'string' or
 length(btrim(v_chunk->>'source_file')) = 0 or length(v_chunk->>'source_file') > 1024 or
 ((v_chunk ? 'source_type') and v_chunk->>'source_type' is distinct from p_source_type) then
 raise exception 'Nonempty content, source_file and matching tier required'; end if;
 if (v_chunk ? 'title' and jsonb_typeof(v_chunk->'title') not in ('string','null')) or
 (v_chunk ? 'section_number' and jsonb_typeof(v_chunk->'section_number') not in ('string','null')) or
 jsonb_typeof(v_chunk->'token_count') is distinct from 'number' or
 v_chunk->>'token_count' !~ '^(0|[1-9][0-9]*)$' then
 raise exception 'Invalid chunk metadata'; end if;
 perform (v_chunk->>'token_count')::integer;
 if jsonb_typeof(v_chunk->'embedding') is distinct from 'array' then
 raise exception 'Embedding must be numeric array'; end if;
 if jsonb_array_length(v_chunk->'embedding') <> 1024 or exists (
 select 1 from jsonb_array_elements(v_chunk->'embedding') x where jsonb_typeof(x) <> 'number') then
 raise exception 'Invalid embedding dimension or values'; end if;
 -- pgvector rejects nonfinite or out-of-float32-range elements during cast.
 v_vector := (v_chunk->>'embedding')::vector;
 if v_vector is null or vector_dims(v_vector) <> 1024 or v_vector = array_fill(0::real, ARRAY[1024])::vector then
 raise exception 'Finite nonzero 1024-dimensional embedding required'; end if;
 v_payload := v_payload || jsonb_build_array(jsonb_build_object(
 'content',v_chunk->>'content','source_file',v_chunk->>'source_file',
 'title',v_chunk->>'title','section_number',v_chunk->>'section_number',
 'chunk_index',v_index,'token_count',(v_chunk->>'token_count')::integer,
 'embedding',v_vector::text::jsonb));
 v_index := v_index + 1;
 end loop;
 if exists (select 1 from public.kb_ingested_files where file_path = v_key) then
 if not exists (select 1 from public.kb_ingested_files where file_path = v_key and
 source_path = p_source_path and source_type = p_source_type and file_hash = p_file_hash and
 embedding_model = p_embedding_model and chunk_count = v_index) or exists (
 select 1 from public.kb_chunks where ingestion_key = v_key and source_type is distinct from p_source_type
 ) then raise exception 'Ingestion key provenance conflict'; end if;
 select jsonb_agg(jsonb_build_object('content',c.content,'source_file',c.source_file,
 'title',c.title,'section_number',c.section_number,'chunk_index',c.chunk_index,
 'token_count',c.token_count,'embedding',c.embedding::text::jsonb) order by c.chunk_index)
 into v_existing from public.kb_chunks c where c.ingestion_key = v_key;
 if v_existing is distinct from v_payload then raise exception 'Ingestion key payload conflict'; end if;
 -- Identical publication is a strict no-op, including for an inactive old revision.
 return v_key;
 else
 insert into public.kb_ingested_files
 (file_path,file_hash,source_type,chunk_count,source_path,embedding_model,active)
 values (v_key,p_file_hash,p_source_type,v_index,p_source_path,p_embedding_model,false);
 insert into public.kb_chunks
 (ingestion_key,content,source_type,source_file,title,section_number,chunk_index,token_count,embedding)
 select v_key,x->>'content',p_source_type,x->>'source_file',x->>'title',x->>'section_number',
 (x->>'chunk_index')::integer,(x->>'token_count')::integer,(x->>'embedding')::vector
 from jsonb_array_elements(v_payload) x;
 end if;
 -- Deactivate first, avoiding the partial unique active index violation.
 update public.kb_ingested_files set active = false where source_path = p_source_path and
 source_type = p_source_type and embedding_model = p_embedding_model and active and file_path <> v_key;
 update public.kb_ingested_files set active = true where file_path = v_key and not active;
 return v_key;
end;
$body$;

-- Composite return type permits the exact input name embedding_model and same returned field.
create type public.wiz_kb_attested_match as (
 id uuid,source_type text,source_file text,title text,section_number text,
 content text,similarity double precision,ingestion_key text,source_path text,file_hash text,
 embedding_model text,chunk_index integer);
create function public.wiz_match_kb_chunks_attested(
 query_embedding vector,embedding_model text,filter_source_type text,match_count integer
) returns setof public.wiz_kb_attested_match language plpgsql stable security definer
set search_path = pg_catalog, public, extensions, pg_temp as $body$
begin
 if $2 is distinct from 'voyage-3' or $3 is null or $3 not in ('master_kb','guide','reference_book') or
 $1 is null or vector_dims($1) <> 1024 or $1 = array_fill(0::real, ARRAY[1024])::vector or
 $4 is null or $4 not between 1 and 8 then raise exception 'Invalid retrieval arguments'; end if;
 return query
 with eligible as materialized (
 select c.*,f.source_path,f.file_hash,f.embedding_model as attested_model
 from public.kb_chunks c join public.kb_ingested_files f on f.file_path = c.ingestion_key
 where f.active and f.embedding_model = $2 and f.source_type = $3 and c.source_type = $3
 and f.source_path is not null
 ) select c.id,c.source_type,c.source_file,c.title,c.section_number,c.content,
 1 - (c.embedding <=> $1),c.ingestion_key,c.source_path,c.file_hash,c.attested_model,c.chunk_index
 from eligible c order by c.embedding <=> $1,c.id limit $4;
end;
$body$;
revoke all on function public.wiz_kb_publish_document(text,text,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.wiz_match_kb_chunks_attested(vector,text,text,integer) from public,anon,authenticated;
grant execute on function public.wiz_kb_publish_document(text,text,text,text,text,jsonb) to service_role;
grant execute on function public.wiz_match_kb_chunks_attested(vector,text,text,integer) to service_role;
commit;
