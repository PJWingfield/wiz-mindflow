'use strict';
// Executes the actual migration/RPCs in local PostgreSQL with pgvector. No Supabase calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { PGlite } = require('@electric-sql/pglite');
const { createStore } = require('../lib/store');
const { createRetriever } = require('../lib/retrieval');
const { loadConfig } = require('../lib/config');
const { createPgliteRpc } = require('./helpers/pglite-rpc');
const root = path.join(__dirname, '..');
const sql = file => fs.readFileSync(path.join(root, file), 'utf8');
const vector = i => Array.from({ length: 1024 }, (_, j) => j === i ? 1 : 0);
const chunk = (i = 0, content = 'revision one') => ({ content, source_file: 'same.md',
  title: 'Real title', section_number: '1', chunk_index: i, token_count: 3, embedding: vector(1) });

test('actual pgvector publication, retrieval, grants and operational rollback', { timeout: 60000 }, async t => {
  let options = {};
  // A separately provisioned local extension can be supplied without package/cloud changes.
  if (process.env.WIZ_TEST_VECTOR_BUNDLE) {
    options.extensions = { vector: pathToFileURL(path.resolve(process.env.WIZ_TEST_VECTOR_BUNDLE)) };
  } else {
    try { options.extensions = { vector: require('@electric-sql/pglite/vector').vector }; }
    catch (err) { if (err.code !== 'MODULE_NOT_FOUND' && err.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw err; }
  }
  const db = new PGlite(options);
  try {
    await db.waitReady;
    try { await db.exec('create extension vector'); }
    catch (err) {
      if (err.code === '0A000' && /extension "vector" is not available/.test(err.message)) {
        t.skip(`LOCAL DB NOT VERIFIED: ${err.code}: ${err.message}; no installed PGlite vector bundle`);
        return;
      }
      throw err;
    }
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      grant usage on schema public to anon,authenticated,service_role;
      alter default privileges grant execute on functions to anon,authenticated;
      create table public.kb_ingested_files (file_path text primary key,file_hash text,
        source_type text,chunk_count integer,ingested_at timestamptz default now());
      create table public.kb_chunks (id uuid primary key default gen_random_uuid(),
        source_type text check (source_type in ('master_kb','guide','reference_book')),
        source_file text,title text,section_number text,chunk_index integer,content text,
        token_count integer,topic_tags text[],embedding vector(1024),created_at timestamptz default now());
      create index kb_chunks_embedding_idx on public.kb_chunks using hnsw (embedding vector_cosine_ops);
      alter table public.kb_chunks enable row level security;
      alter table public.kb_ingested_files enable row level security;
      create function public.match_kb_chunks(query_embedding vector,match_count integer,filter_source_type text)
      returns table(id uuid,source_type text,source_file text,title text,section_number text,content text,similarity float8)
      language sql stable as $$ select id,source_type,source_file,title,section_number,content,
        1-(embedding <=> query_embedding) from public.kb_chunks where source_type=filter_source_type
        order by embedding <=> query_embedding limit match_count $$;
      insert into public.kb_ingested_files(file_path,file_hash,source_type,chunk_count)
        values ('legacy/same.md','unknown','guide',1);`);
    await db.query('insert into public.kb_chunks(source_type,source_file,chunk_index,content,embedding) values ($1,$2,0,$3,$4::vector)',
      ['guide', 'same.md', 'UNKNOWN LEGACY NEAREST', JSON.stringify(vector(0))]);
    const legacySnapshot = async () => (await db.query(`select pg_get_functiondef(oid) as definition,proacl::text as acl
      from pg_proc where oid='public.match_kb_chunks(vector,integer,text)'::regprocedure`)).rows;
    const legacy = await legacySnapshot();
    // The migration must resolve vector types even when the caller's path excludes them.
    await db.exec('set search_path = pg_catalog');
    try { await db.exec(sql('supabase/migrations/20261010220000_wiz_kb_provenance.sql')); }
    catch (err) { await db.exec('rollback'); throw err; }
    finally { await db.exec('reset search_path'); }
    const rpc = createPgliteRpc(db);
    const store = createStore(rpc);
    const args = (patch = {}) => ({ p_source_path: 'folder/same.md',p_source_type: 'guide',
      p_file_hash: 'a'.repeat(64),p_embedding_model: 'voyage-3',p_recipe_version: 'recipe-v1',
      p_chunks: [chunk()],...patch });
    const publish = patch => rpc('wiz_kb_publish_document', args(patch));
    const match = tier => store.matchKbChunksAttested(JSON.stringify(vector(0)), 'voyage-3', tier, 2);
    const active = async () => (await db.query('select file_path from public.kb_ingested_files where active order by file_path')).rows;
    let key1, key2;

    await t.test('rerun is a no-op and conflicting same-key payload is rejected', async () => {
      key1 = await publish();
      assert.match(key1, /^wizkb-v1:[0-9a-f]{64}$/);
      assert.equal(await publish(), key1);
      assert.equal((await db.query('select count(*)::int n from public.kb_chunks where ingestion_key=$1',[key1])).rows[0].n, 1);
      for (const field of ['content','source_file','title','section_number','token_count','embedding']) {
        const changed = { ...chunk(), [field]: field === 'embedding' ? vector(2) : field === 'token_count' ? 8 : 'conflict' };
        await assert.rejects(publish({ p_chunks: [changed] }), /payload conflict/);
      }
      assert.deepEqual(await active(), [{ file_path: key1 }]);
    });
    await t.test('replacement retains history; failed replacement rolls back', async () => {
      key2 = await publish({ p_file_hash: 'b'.repeat(64), p_chunks: [chunk(0,'revision two')] });
      assert.notEqual(key1,key2);
      assert.deepEqual(await active(), [{ file_path: key2 }]);
      const before = (await db.query('select count(*)::int n from public.kb_ingested_files')).rows[0].n;
      // Force an error during chunk insertion after the inactive ledger insert.
      await db.exec(`create function public.reject_kb_fixture() returns trigger language plpgsql as $$
        begin if new.content='REJECT INSERT' then raise exception 'fixture insert failure'; end if; return new; end $$;
        create trigger reject_kb_fixture before insert on public.kb_chunks for each row execute function public.reject_kb_fixture()`);
      await assert.rejects(publish({ p_file_hash: 'c'.repeat(64), p_chunks: [chunk(0,'REJECT INSERT')] }), /fixture insert failure/);
      assert.equal((await db.query('select count(*)::int n from public.kb_ingested_files')).rows[0].n,before);
      assert.deepEqual(await active(), [{ file_path: key2 }]);
    });
    await t.test('old A rerun is a no-op after B becomes active: B stays active and A inactive', async () => {
      assert.deepEqual(await active(), [{ file_path: key2 }]);
      const before = (await db.query('select file_path,active from public.kb_ingested_files order by file_path')).rows;
      assert.equal(await publish(),key1);
      assert.deepEqual(await active(), [{ file_path: key2 }]);
      assert.equal((await db.query('select active from public.kb_ingested_files where file_path=$1',[key1])).rows[0].active,false);
      assert.equal((await db.query('select active from public.kb_ingested_files where file_path=$1',[key2])).rows[0].active,true);
      assert.deepEqual((await db.query('select file_path,active from public.kb_ingested_files order by file_path')).rows,before);
    });
    await t.test('paths and all three tiers stay independent, exact provenance, unknown legacy excluded', async () => {
      const other = await publish({ p_source_path: 'other/same.md' });
      for (const tier of ['master_kb','reference_book']) await publish({ p_source_type: tier });
      assert.notEqual(other,key1);
      assert.equal((await active()).length,4);
      const guide = await match('guide');
      assert.equal(guide.length,2);
      assert.deepEqual(new Set(guide.map(r => r.source_path)),new Set(['folder/same.md','other/same.md']));
      assert.ok(guide.every(r => r.ingestion_key && r.file_hash === (r.source_path === 'folder/same.md' ? 'b' : 'a').repeat(64) && r.chunk_index === 0 && r.source_file === 'same.md'));
      assert.equal(guide.find(r => r.source_path === 'folder/same.md').ingestion_key,key2);
      assert.ok(guide.every(r => !r.content.includes('UNKNOWN')));
      const retriever = createRetriever({ config: loadConfig({ VOYAGE_API_KEY: 'mock', WIZ_KB_PROVENANCE: 'on' }),store,embed: async () => vector(0) });
      const result = await retriever.search('q');
      assert.equal(result.status,'ok'); assert.equal(result.chunks.length,4);
      assert.deepEqual(Object.values(result.tiers).map(r => r.status),['ok','ok','ok']);
      assert.deepEqual(await legacySnapshot(),legacy);
      assert.equal((await db.query('select content from public.match_kb_chunks($1::vector,1,$2)',[JSON.stringify(vector(0)),'guide'])).rows[0].content,'UNKNOWN LEGACY NEAREST');
    });
    await t.test('reject null/path/index/tier/vector/metadata errors without switching active revision', async () => {
      const before = await active();
      const invalid = [
        {p_source_path:null},{p_source_path:''},{p_source_path:'/a'},{p_source_path:'a/../b'},
        {p_source_path:'a/./b'},{p_source_path:'a//b'},{p_source_path:'a\\b'},{p_source_path:'C:/b'},
        {p_source_type:null},{p_source_type:'internal'},{p_embedding_model:null},{p_embedding_model:'voyage-2'},
        {p_file_hash:null},{p_file_hash:'bad'},{p_recipe_version:null},{p_recipe_version:''},
        {p_chunks:null},{p_chunks:[]},{p_chunks:{}},
        ...[{chunk_index:null},{chunk_index:1},{chunk_index:-1},{chunk_index:0.5},{chunk_index:'0'},
          {source_file:null},{source_file:''},{content:' '},{source_type:'master_kb'},{token_count:null},
          {token_count:-1},{embedding:null},{embedding:[1]},{embedding:Array(1024).fill(0)},
          {embedding:Array(1024).fill('NaN')},{embedding:Array(1024).fill(1e100)}]
          .map(c => ({p_chunks:[{...chunk(),...c}]}))
      ];
      for (const patch of invalid) await assert.rejects(publish(patch));
      assert.deepEqual(await active(),before);
      for (const [v,m,tier,n] of [[null,'voyage-3','guide',2],[JSON.stringify(vector(0)),null,'guide',2],
        [JSON.stringify(vector(0)),'voyage-3',null,2],[JSON.stringify(vector(0)),'voyage-3','guide',null],
        ['[1]','voyage-3','guide',2],[JSON.stringify(Array(1024).fill(0)),'voyage-3','guide',2],
        [JSON.stringify(vector(0)),'voyage-3','guide',9]]) await assert.rejects(store.matchKbChunksAttested(v,m,tier,n));
      await assert.rejects(db.query(`insert into public.kb_ingested_files(file_path,source_path,embedding_model,source_type,file_hash,chunk_count)
        values ($1,'a.md','voyage-3',null,$2,1)`,['wizkb-v1:'+'d'.repeat(64),'a'.repeat(64)]));
    });
    await t.test('service-only execution despite default anon grants; fixed definer search paths', async () => {
      for (const signature of ['wiz_kb_publish_document(text,text,text,text,text,jsonb)','wiz_match_kb_chunks_attested(vector,text,text,integer)']) {
        for (const role of ['anon','authenticated','service_role']) {
          const row = (await db.query('select has_function_privilege($1,$2,$3) ok',[role,'public.'+signature,'EXECUTE'])).rows[0];
          assert.equal(row.ok,role==='service_role');
        }
        const row = (await db.query('select prosecdef,proconfig from pg_proc where oid=$1::regprocedure',['public.'+signature])).rows[0];
        assert.equal(row.prosecdef,true);
        assert.ok(row.proconfig.includes('search_path=pg_catalog, public, extensions, pg_temp'));
      }
      for (const role of ['anon','authenticated']) await assert.rejects(db.transaction(async tx => {
        await tx.exec(`set local role ${role}`);
        await tx.query('select * from public.wiz_match_kb_chunks_attested($1::vector,$2,$3,$4)',[JSON.stringify(vector(0)),'voyage-3','guide',2]);
      }),/permission denied/);
    });
    await t.test('operational rollback disables RPCs and preserves rows, provenance and old RPC', async () => {
      const count = (await db.query('select count(*)::int n from public.kb_chunks')).rows[0].n;
      await db.exec(sql('supabase/rollbacks/20261010220000_wiz_kb_provenance.down.sql'));
      assert.deepEqual(await active(),[]);
      assert.equal((await db.query('select count(*)::int n from public.kb_chunks')).rows[0].n,count);
      assert.deepEqual(await legacySnapshot(),legacy);
      await assert.rejects(match('guide'),/permission denied/);
      await assert.rejects(publish(),/permission denied/);
    });
  } finally { await db.close(); }
});
