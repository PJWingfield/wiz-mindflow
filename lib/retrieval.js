'use strict';
// Only active voyage-3 revisions linked through the provenance RPC are eligible.
// No legacy RPC fallback or corpus-wide operator attestation.

const MAX_CONTENT = 1500;
const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined);

class RetrievalError extends Error {
  constructor(reason) { super(reason); this.name = 'RetrievalError'; this.reason = reason; }
}

// Default embedding transport (Voyage AI HTTP API). Tests inject their own function instead; they never reach this.
function createVoyageEmbed({ apiKey, model, timeoutMs, fetchImpl }) {
  const doFetch = fetchImpl || require('node-fetch');
  return async function embed(text) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    let body = null;
    try {
      res = await doFetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ input: [text], model, input_type: 'query' }),
        signal: ctrl.signal
      });
      if (!res.ok) throw new RetrievalError('embedding_rejected');
      try { 
        body = await res.json(); 
      } catch (err) { 
        if (err.name === 'AbortError') throw err; 
        /* malformed */ 
      }
    } catch (err) {
      if (err.name === 'RetrievalError') throw err;
      throw new RetrievalError('embedding_unreachable');
    } finally {
      clearTimeout(timer);
    }
    if (!body || !Array.isArray(body.data) || body.data.length !== 1 || !body.data[0] || body.data[0].index !== 0 ||
        (body.model !== undefined && body.model !== model)) throw new RetrievalError('embedding_malformed');
    return body.data[0].embedding;
  };
}

function validEmbedding(v, dimension) {
  return Array.isArray(v) && v.length === dimension && Array.from(v).every(x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 3.4028234663852886e38) && v.some(x => Math.abs(x) >= 1.401298464324817e-45);
}

const nonempty = v => typeof v === 'string' && v.trim().length > 0;
const validPath = p => nonempty(p) && p.length <= 1024 && p === p.trim() &&
  !/(^\/|\/$|\/\/|(^|\/)\.{1,2}(\/|$)|[\\:\x00-\x1f\x7f])/.test(p);
function validRow(r, tier, model) {
  return r && typeof r === 'object' &&
    typeof r.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.id) &&
    r.source_type === tier && r.embedding_model === model &&
    /^wizkb-v1:[0-9a-f]{64}$/.test(r.ingestion_key || '') &&
    /^[0-9a-f]{64}$/.test(r.file_hash || '') && validPath(r.source_path) &&
    nonempty(r.source_file) && r.source_file.length <= 1024 && nonempty(r.content) &&
    (r.title === null || typeof r.title === 'string') &&
    (r.section_number === null || typeof r.section_number === 'string') &&
    Number.isSafeInteger(r.chunk_index) && r.chunk_index >= 0 &&
    typeof r.similarity === 'number' && Number.isFinite(r.similarity) && Math.abs(r.similarity) <= 1.00001;
}

function createRetriever({ config, store, embed }) {
  const enabled = !!(config.voyageKey && config.kbProvenanceEnabled && config.kbDimension === 1024 && store && typeof store.matchKbChunksAttested === 'function');
  const dimension = config.kbDimension;
  const tiers = ['master_kb', 'guide', 'reference_book'];
  const model = 'voyage-3';
  const topKPerTier = Number.isInteger(config.kbTopK) && config.kbTopK > 0 ? Math.min(config.kbTopK, 2) : 2;
  const doEmbed = embed || (enabled ? createVoyageEmbed({ apiKey: config.voyageKey, model, timeoutMs: config.ragTimeoutMs }) : null);

  const unavailable = reason => ({ status: 'unavailable', reason, chunks: [],
    tiers: Object.fromEntries(tiers.map(tier => [tier, { status: 'unavailable', reason, chunks: [] }])) });

  return {
    enabled,
    async search(text) {
      if (!enabled) return unavailable('not_configured');
      
      let vector;
      try {
        vector = await doEmbed(text);
        if (!validEmbedding(vector, dimension)) throw new RetrievalError('embedding_malformed');
      } catch (err) {
        return unavailable(err && err.name === 'RetrievalError' ? err.reason : 'retrieval_failed');
      }

      const vectorStr = '[' + vector.join(',') + ']';
      const results = {};
      let totalFailed = 0;
      let totalChunks = 0;
      let allChunks = [];

      for (const tier of tiers) {
        try {
          const rows = await store.matchKbChunksAttested(vectorStr, model, tier, topKPerTier);
          if (!Array.isArray(rows) || rows.length > topKPerTier) throw new RetrievalError('results_malformed');
          const seen = new Set();
          const chunks = rows.map(r => {
            if (!validRow(r, tier, model) || seen.has(r.id) || seen.has(`${r.ingestion_key}:${r.chunk_index}`)) {
              throw new RetrievalError('results_malformed');
            }
            seen.add(r.id);
            seen.add(`${r.ingestion_key}:${r.chunk_index}`);
            return {
              content: clip(r.content, MAX_CONTENT), id: r.id, source_type: r.source_type,
              source_file: r.source_file, title: r.title, section: r.section_number,
              ingestion_key: r.ingestion_key, source_path: r.source_path,
              file_hash: r.file_hash, embedding_model: r.embedding_model, chunk_index: r.chunk_index
            };
          });

          results[tier] = { status: chunks.length ? 'ok' : 'no_match', chunks };
          totalChunks += chunks.length;
          allChunks.push(...chunks);
        } catch (err) {
          results[tier] = { status: 'unavailable', reason: err && err.name === 'RetrievalError' ? err.reason : 'retrieval_failed', chunks: [] };
          totalFailed++;
        }
      }

      let overallStatus = 'no_match';
      if (totalChunks > 0) {
        overallStatus = totalFailed > 0 ? 'partial' : 'ok';
      } else if (totalFailed > 0) {
        overallStatus = totalFailed === tiers.length ? 'unavailable' : 'partial';
      }

      return { status: overallStatus, tiers: results, chunks: allChunks };
    }
  };
}

// The source references that are persisted and returned (content is never part of them).
const sourceRefs = chunks => chunks.map(({ content, ...ref }) => ref);

module.exports = { createRetriever, createVoyageEmbed, RetrievalError, sourceRefs };
