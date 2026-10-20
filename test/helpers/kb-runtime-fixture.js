'use strict';
// Mock runtime rows only. This fixture makes no claim about pgvector or SQL publication.
const { randomUUID } = require('node:crypto');
function kbRow(overrides = {}) {
  return {
    id: randomUUID(), source_type: 'guide', source_file: 'guide.md', title: null,
    section_number: null, content: 'Attested material', similarity: 0.75,
    ingestion_key: 'wizkb-v1:' + 'a'.repeat(64), source_path: 'guides/guide.md',
    file_hash: 'b'.repeat(64), embedding_model: 'voyage-3', chunk_index: 0, ...overrides
  };
}
function mockMatch(rows, args, failingTier) {
  if (args.embedding_model !== 'voyage-3' || 'p_embedding_model' in args) throw new Error('RPC argument mismatch');
  if (args.filter_source_type === failingTier) throw new Error('mock tier unavailable');
  const query = JSON.parse(args.query_embedding);
  return rows.filter(r => r.source_type === args.filter_source_type).map(r => ({ ...r,
    score: (r.embedding || []).reduce((n, x, i) => n + x * query[i], 0)
  })).sort((a, b) => b.score - a.score).slice(0, args.match_count);
}
module.exports = { kbRow, mockMatch };
