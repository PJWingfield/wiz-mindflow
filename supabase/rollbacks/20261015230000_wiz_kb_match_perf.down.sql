-- Restores the original (materialized CTE) function body. Slower on large tiers; grants are unchanged.
begin;
set local search_path = pg_catalog, public, extensions, pg_temp;
create or replace function public.wiz_match_kb_chunks_attested(
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
commit;
