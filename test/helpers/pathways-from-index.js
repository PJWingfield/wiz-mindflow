'use strict';
// Reads Jon's 14 opening tiles from the ORIGINAL index.html (read-only) so lib/pathways.json can be generated and
// checked for drift. Run `node test/helpers/pathways-from-index.js --write` to regenerate lib/pathways.json.
const fs = require('node:fs');
const path = require('node:path');

const ENTITIES = { '&amp;': '&', '&mdash;': '—', '&ldquo;': '“', '&rdquo;': '”', '&hellip;': '…', '&rarr;': '→', '&lt;': '<', '&gt;': '>' };
const decode = s => s.replace(/&[a-z]+;/g, m => (m in ENTITIES ? ENTITIES[m] : m));

function extract(html) {
  const out = [];
  const re = /<div class="os-explore-item os-explore-link"[^>]*onclick="(startLens|startTrack)\('([a-z_]+)'[^"]*"[^>]*>\s*<span class="os-num">(\d+)<\/span><div class="os-explore-body"><strong>([^<]+)<\/strong>([\s\S]*?)<span class="os-explore-go">/g;
  let m;
  while ((m = re.exec(html))) {
    out.push({ number: +m[3], id: m[2], kind: m[1] === 'startTrack' ? 'track' : 'lens', title: decode(m[4]), description: decode(m[5]) });
  }
  return out;
}

const INDEX = path.join(__dirname, '..', '..', 'index.html');
const OUT = path.join(__dirname, '..', '..', 'lib', 'pathways.json');
const fromIndex = () => extract(fs.readFileSync(INDEX, 'utf8'));

if (require.main === module && process.argv.includes('--write')) {
  const items = fromIndex();
  fs.writeFileSync(OUT, JSON.stringify(items, null, 2) + '\n');
  console.log('wrote', items.length, 'pathways');
}

module.exports = { extract, fromIndex };
