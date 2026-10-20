'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRetriever, createVoyageEmbed, sourceRefs } = require('../lib/retrieval');
const { loadConfig } = require('../lib/config');
const { createStore } = require('../lib/store');
const { kbRow } = require('./helpers/kb-runtime-fixture');
const config = () => loadConfig({ VOYAGE_API_KEY: 'local-mock', WIZ_KB_PROVENANCE: 'on', WIZ_KB_TOP_K: '8' });
const vector = () => Array(1024).fill(0.01);
const tiers = ['master_kb','guide','reference_book'];

test('embed once; all three tiers; max two each/six total; exact persisted references', async () => {
  let embeds = 0;
  const calls = [];
  const sourcePath = 'long/'.repeat(100) + 'same.md';
  const sourceFile = 'real source '.repeat(40) + 'same.md';
  const rows = {};
  const store = createStore(async (name,args) => {
    calls.push({name,args});
    rows[args.filter_source_type] = [0,1].map(i => kbRow({ source_type: args.filter_source_type,
      source_path: sourcePath,source_file: sourceFile,chunk_index:i,content:'x'.repeat(5000) }));
    return rows[args.filter_source_type];
  });
  const r = await createRetriever({config:config(),store,embed:async () => { embeds++; return vector(); }}).search('hello');
  assert.equal(embeds,1); assert.equal(r.status,'ok'); assert.equal(r.chunks.length,6);
  assert.deepEqual(calls.map(c => [c.name,c.args.embedding_model,c.args.filter_source_type,c.args.match_count]),
    tiers.map(t => ['wiz_match_kb_chunks_attested','voyage-3',t,2]));
  assert.ok(calls.every(c => Object.keys(c.args).sort().join(',') === 'embedding_model,filter_source_type,match_count,query_embedding'));
  assert.equal(r.chunks[0].content.length,1500);
  const refs = sourceRefs(r.chunks);
  assert.equal(refs[0].source_path,sourcePath); assert.equal(refs[0].source_file,sourceFile);
  assert.equal(refs[0].id,rows.master_kb[0].id); assert.equal(refs[0].ingestion_key,rows.master_kb[0].ingestion_key);
  assert.ok(refs.every(r => !('content' in r)));
});

test('malformed/unknown provenance fails the affected tier instead of silently returning no_match', async () => {
  const bad = [null,{}, {id:null},{id:7},{ingestion_key:null},{ingestion_key:'wizkb-v1:fixture'},
    {source_path:''},{source_path:'../x'},{source_path:'x\\y'},{source_path:'x//y'},{source_path:'C:/x'},
    {file_hash:'testhash'},{embedding_model:'unknown'},{source_type:'internal'},
    {chunk_index:null},{chunk_index:-1},{chunk_index:0.5},{source_file:null},{source_file:' '},
    {content:' '},{title:4},{section_number:{}},{similarity:NaN}];
  for (const patch of bad) {
    const store = { matchKbChunksAttested: async (_v,_m,tier) => tier === 'guide'
      ? [patch === null || !Object.keys(patch).length ? patch : kbRow(patch)] : [kbRow({source_type:tier})] };
    const r = await createRetriever({config:config(),store,embed:async () => vector()}).search('q');
    assert.equal(r.status,'partial',JSON.stringify(patch));
    assert.equal(r.tiers.guide.status,'unavailable'); assert.equal(r.tiers.guide.reason,'results_malformed');
    assert.equal(r.chunks.length,2);
  }
});

test('partial, empty, all-unavailable and over-limit/duplicate rows are honest', async () => {
  const run = fn => createRetriever({config:config(),store:{matchKbChunksAttested:fn},embed:async () => vector()}).search('q');
  assert.equal((await run(async () => [])).status,'no_match');
  assert.equal((await run(async () => {throw new Error('down');})).status,'unavailable');
  const partial = await run(async (_v,_m,t) => {if(t==='guide') throw new Error('down'); return [];});
  assert.equal(partial.status,'partial'); assert.equal(partial.tiers.master_kb.status,'no_match');
  assert.equal((await run(async (_v,_m,t) => [0,1,2].map(i => kbRow({source_type:t,chunk_index:i})))).status,'unavailable');
  assert.equal((await run(async (_v,_m,t) => {const r=kbRow({source_type:t});return [r,r];})).status,'unavailable');
});

test('no legacy attestation/fallback; malformed vectors never reach an RPC', async () => {
  let calls=0;
  const store = {matchKbChunks:async () => {throw new Error('legacy fallback forbidden');},
    matchKbChunksAttested:async () => {calls++;return [];} };
  const legacy = loadConfig({VOYAGE_API_KEY:'mock',WIZ_KB_EMBEDDING_MODEL_ATTESTATION:'voyage-3'});
  assert.equal((await createRetriever({config:legacy,store,embed:async () => vector()}).search('q')).reason,'not_configured');
  for (const v of [null,[1],Array(1024).fill(0),Array(1024).fill(NaN),Array(1024).fill(Infinity),Array(1024).fill(1e100),Array(1024).fill(1e-100)]) {
    const r = await createRetriever({config:config(),store,embed:async () => v}).search('q');
    assert.equal(r.reason,'embedding_malformed');
    assert.deepEqual(Object.values(r.tiers).map(t => t.status), ['unavailable','unavailable','unavailable']);
  }
  assert.equal(calls,0);
  assert.equal(createRetriever({config:{...config(),kbDimension:512},store}).enabled,false);
});

test('mock Voyage response count/index/model validation and abort cleanup', async () => {
  for (const body of [{data:[]},{data:[null]},{data:[{index:1,embedding:vector()}]},
    {data:[{index:0,embedding:vector()},{index:1,embedding:vector()}]},
    {model:'wrong',data:[{index:0,embedding:vector()}]}]) {
    const embed = createVoyageEmbed({apiKey:'mock',model:'voyage-3',timeoutMs:20,
      fetchImpl:async () => ({ok:true,json:async () => body})});
    await assert.rejects(embed('q'),e => e.reason === 'embedding_malformed');
  }
  let seen;
  const embed = createVoyageEmbed({apiKey:'mock',model:'voyage-3',timeoutMs:20,
    fetchImpl:async (_url,opts) => {seen=JSON.parse(opts.body);return {ok:true,json:async () => ({data:[{index:0,embedding:vector()}]})};} });
  assert.deepEqual(await embed('q'),vector());
  assert.deepEqual(seen,{input:['q'],model:'voyage-3',input_type:'query'});
  const aborting = createVoyageEmbed({apiKey:'mock',model:'voyage-3',timeoutMs:20,
    fetchImpl:async (_url,opts) => ({ok:true,json:() => new Promise((_resolve,reject) => {
      opts.signal.addEventListener('abort',() => reject(Object.assign(new Error('abort'),{name:'AbortError'})),{once:true});
    })})});
  await assert.rejects(aborting('q'),e => e.reason === 'embedding_unreachable');
});
