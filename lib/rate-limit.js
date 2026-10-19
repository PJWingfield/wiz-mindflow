'use strict';
// Fixed-window limiter with a hard cap on tracked keys (memory-bounded). Keys are chosen by the caller:
// verified user ids for authenticated routes, the socket-derived client address for public ones. The
// client-supplied X-Forwarded-For header is never read here (Express applies it only for configured proxy hops).

function createLimiter({ max, windowMs = 60000, maxKeys = 10000, now = Date.now }) {
  const hits = new Map();
  return function hit(key) {
    const t = now();
    let rec = hits.get(key);
    if (!rec || t - rec.start >= windowMs) {
      if (!rec && hits.size >= maxKeys) {
        for (const [k, r] of hits) if (t - r.start >= windowMs) hits.delete(k);
        while (hits.size >= maxKeys) hits.delete(hits.keys().next().value); // evict oldest; never grows unbounded
      }
      rec = { count: 0, start: t };
      hits.set(key, rec);
    }
    rec.count += 1;
    if (rec.count > max) return { ok: false, retryAfter: Math.max(1, Math.ceil((rec.start + windowMs - t) / 1000)) };
    return { ok: true };
  };
}

module.exports = { createLimiter };
