'use strict';
// Supabase Auth ADMIN adapter: server-only, isolated from lib/auth.js (which only ever holds the anon key). It holds the service
// credential, is used for nothing except identity removal during account erasure, and never returns provider bodies or keys.
// Contract (GoTrue admin API): DELETE /auth/v1/admin/users/{id} -> 200 when removed, 404 when the user does not exist;
// GET /auth/v1/admin/users/{id} -> 404 once it is gone. Not verified against a live project.
const { ApiError } = require('./errors');

function createSupabaseAuthAdmin({ url, serviceKey, fetchImpl, timeoutMs = 8000 }) {
  const base = new URL(url);
  const doFetch = fetchImpl || require('node-fetch');
  const fail = () => new ApiError(503, 'auth_admin_unavailable', 'Authentication service unavailable.');
  const target = id => new URL(`/auth/v1/admin/users/${encodeURIComponent(id)}`, base).toString();

  // timeout covers the response body as well as the headers
  async function call(method, id) {
    const ctrl = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { ctrl.abort(); reject(new Error('timeout')); }, timeoutMs); });
    const work = (async () => {
      const res = await doFetch(target(id), { method, headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }, signal: ctrl.signal });
      if (typeof res.text === 'function') await res.text();
      return res.status;
    })();
    work.catch(() => {});
    try { return await Promise.race([work, deadline]); } catch (_) { throw fail(); } finally { clearTimeout(timer); }
  }

  return {
    // -> { removed: true } for a real removal, { removed: false } when the identity was already absent
    async deleteUser(id) {
      const status = await call('DELETE', id);
      if (status >= 200 && status < 300) return { removed: true };
      if (status === 404) return { removed: false };
      throw fail();
    },
    // -> boolean; anything other than a clear 200/404 is an error, never a guess
    async exists(id) {
      const status = await call('GET', id);
      if (status >= 200 && status < 300) return true;
      if (status === 404) return false;
      throw fail();
    }
  };
}

module.exports = { createSupabaseAuthAdmin };
