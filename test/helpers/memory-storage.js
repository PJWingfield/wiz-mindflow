'use strict';
// In-memory PRIVATE object transport for tests: no network, no bucket. Failure injection for cleanup/availability paths.
function createMemoryStorage() {
  const objects = new Map();
  const state = { failPut: false, failGet: false, failDelete: false, calls: [] };
  const boom = () => Object.assign(new Error('injected storage failure'), { status: 503 });
  return {
    objects, state,
    async put(key, buffer, contentType) { state.calls.push(['put', key]); if (state.failPut) throw boom(); objects.set(key, { buffer: Buffer.from(buffer), contentType }); },
    async get(key) { state.calls.push(['get', key]); if (state.failGet) throw boom(); const o = objects.get(key); return o ? Buffer.from(o.buffer) : null; },
    async delete(key) { state.calls.push(['delete', key]); if (state.failDelete) throw boom(); objects.delete(key); }
  };
}
module.exports = { createMemoryStorage };
