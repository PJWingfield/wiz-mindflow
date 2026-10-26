'use strict';
// Server-owned, read-only catalogue of the exact notice artifacts in notices/*.txt. The wording is preserved byte-for-byte; every
// read re-verifies the runtime bytes against the SHA-256 recorded here, so a missing or altered file fails closed (503) and is never
// replaced by another notice. Only catalogue ids are accepted: there is no client-supplied path and no directory serving.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { e } = require('./errors');

const NOTICE_DIR = path.join(__dirname, '..', 'notices');

// Approval provenance of the supplied wording. The owner instruction and the source document's own control field are recorded;
// this is NOT independently verified solicitor approval and must not be presented as such.
const APPROVAL = Object.freeze({
  basis: 'owner_instruction',
  instructed_on: '2026-10-19',
  source_control: 'Approved by and date: PJW 16/10/2026',
  independent_legal_approval: false
});

// Provenance of the 24 October 2026 revision: a technical wording revision delegated by the owner. It carries no PJW signature or
// approval and is NOT independent legal approval.
const APPROVAL_20261024 = Object.freeze({
  basis: 'owner_delegated_technical_revision',
  revised_on: '2026-10-24',
  independent_legal_approval: false
});

// The v2 hashes are not computed by the author (no hashing available there). Until the parent pins the real SHA-256 of the exact
// bytes of each v2 file in place of EXPLICIT_PARENT_SHA_*, every read of that entry fails the hash check and is refused (503).
const CATALOGUE = Object.freeze({
  'privacy-2026-10-16-v1': Object.freeze({ kind: 'privacy', file: 'privacy-2026-10-16-v1.txt', sha256: 'ba1a8f905d6b3af9ede6d5bfa7ac18fc520629847f49448530044fc4339e6f70', approval: APPROVAL }),
  'terms-2026-10-16-v1': Object.freeze({ kind: 'terms', file: 'terms-2026-10-16-v1.txt', sha256: '8570e1f5fac7f9a67597a672024fcdbe48bc85e90de9e6df907352ea987ed60d', approval: APPROVAL }),
  'privacy-2026-10-24-v2': Object.freeze({ kind: 'privacy', file: 'privacy-2026-10-24-v2.txt', sha256: '013ed24f60ec551f30350cda7fd48f34b54eaffcd06142838f2e29e1d923f2d1', approval: APPROVAL_20261024 }),
  'terms-2026-10-24-v2': Object.freeze({ kind: 'terms', file: 'terms-2026-10-24-v2.txt', sha256: '9ed6fe95d4eca65b56f30c1cfd00e62e9a5d79e5111a1ba379b6f694392e573a', approval: APPROVAL_20261024 })
});

function createNotices({ dir = NOTICE_DIR, catalogue = CATALOGUE, logger = () => {} } = {}) {
  const unavailable = () => e.unavailable('notice_unavailable', 'This notice is temporarily unavailable.');
  const fail = (id, reason) => { logger('notice_integrity_failure', { notice: id, reason }); return unavailable(); }; // metadata only: no paths

  // The full exact notice for a catalogue id. expectedSha256 (optional) is the hash another record (e.g. a terms version) links to.
  async function load(id, expectedSha256) {
    if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(catalogue, id)) throw e.notFound();
    const entry = catalogue[id];
    let buf;
    try { buf = await fs.promises.readFile(path.join(dir, entry.file)); } catch (_) { throw fail(id, 'missing'); }
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    if (sha256 !== entry.sha256) throw fail(id, 'hash_mismatch');
    if (expectedSha256 !== undefined && expectedSha256 !== sha256) throw fail(id, 'link_mismatch');
    return { id, kind: entry.kind, content_type: 'text/plain; charset=utf-8', sha256, bytes: buf.length, text: buf.toString('utf8'), approval: entry.approval || APPROVAL };
  }

  const list = () => Object.entries(catalogue).map(([id, x]) => ({ id, kind: x.kind, sha256: x.sha256, approval: x.approval || APPROVAL }));
  return { load, list };
}

module.exports = { createNotices, CATALOGUE, APPROVAL, APPROVAL_20261024, NOTICE_DIR };
