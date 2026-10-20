'use strict';
// LOCAL STAND-IN for the existing knowledge-base objects. The real project's kb table and its pgvector-based
// match_kb_chunks(query_embedding vector, match_count int, filter_source_type text) are NOT reproduced exactly:
// PGlite here has no pgvector, so the vector is accepted as its text form ('[0.1,0.2,...]') and scored by dot product.
// What is faithful: the function name, argument names, tier filter semantics, and row-shaped (set-returning) output.
async function installKbFixture(db, chunks) {
  await db.exec(`
    create table if not exists public.kb_ingested_files (
      file_path text primary key, source_type text, active boolean, embedding_model text, source_path text, file_hash text
    );
    create table if not exists public.kb_chunks (
      id uuid primary key default gen_random_uuid(), content text not null, source_type text not null,
      source_file text, title text, section_number text, embedding float8[] not null, ingestion_key text, chunk_index integer);
    create function public.wiz_match_kb_chunks_attested(query_embedding text, p_embedding_model text, filter_source_type text, match_count integer)
    returns table (id uuid, source_type text, source_file text, title text, section_number text, content text, similarity float8, ingestion_key text, source_path text, file_hash text, embedding_model text, chunk_index integer)
    language sql stable as $$
      select c.id, c.source_type, c.source_file, c.title, c.section_number, c.content,
        (select sum(a * b) from unnest(c.embedding, string_to_array(trim(both '[]' from query_embedding), ',')::float8[]) as t(a, b)) as similarity,
        c.ingestion_key, f.source_path, f.file_hash, f.embedding_model, c.chunk_index
      from public.kb_chunks c
      join public.kb_ingested_files f on c.ingestion_key = f.file_path
      where f.active = true and f.embedding_model = p_embedding_model and f.source_type = filter_source_type
      order by similarity desc limit match_count $$;
    grant select on public.kb_chunks to service_role;
    grant select on public.kb_ingested_files to service_role;
    grant execute on function public.wiz_match_kb_chunks_attested(text, text, text, integer) to service_role;`);
  
  await db.query(`insert into public.kb_ingested_files (file_path, source_type, active, embedding_model, source_path, file_hash)
                  values ('wizkb-v1:fixture', 'guide', true, 'voyage-3', 'fixture.md', 'testhash')`);
                  
  for (const c of chunks) {
    await db.query('insert into public.kb_chunks (content, source_type, source_file, title, section_number, embedding, ingestion_key, chunk_index) values ($1,$2,$3,$4,$5,$6,$7,$8)',
      [c.content, c.source_type, c.source_file || null, c.title || null, c.section_number || null, c.embedding, 'wizkb-v1:fixture', 0]);
  }
}

module.exports = { installKbFixture };
