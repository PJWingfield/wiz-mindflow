'use strict';
// Transport boundary between the API store and the database functions (wiz_* RPCs).
// Production: Supabase PostgREST with the service-role key. Local verification: test/helpers/pglite-rpc.js
// runs the SAME functions in a local PostgreSQL-compatible database.

class RpcError extends Error {
  // kind: 'db' (the function raised; message is wiz:<code> or a database error) | 'unavailable' (transport/timeout/5xx)
  constructor(kind, message, extra) {
    super(message);
    this.name = 'RpcError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

function createPostgrestRpc({ url, serviceKey, fetchImpl, timeoutMs = 8000 }) {
  const base = new URL(url);
  const doFetch = fetchImpl || require('node-fetch');
  return async function rpc(name, args) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await doFetch(new URL(`/rest/v1/rpc/${encodeURIComponent(name)}`, base).toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        body: JSON.stringify(args || {}),
        signal: ctrl.signal
      });
      let body = null;
      let parsed = false; // a valid JSON null (e.g. wiz_privacy_erasure_state with no receipt) is a real result, unlike an unparseable body
      try { body = await res.json(); parsed = true; } catch (_) { /* empty or non-JSON body */ }
      if (res.ok) {
        if (!parsed) throw new RpcError('unavailable', 'database unreachable');
        return body;
      }
      if (res.status >= 400 && res.status < 500 && body && typeof body.message === 'string' && /^wiz:[a-z_]+$/.test(body.message)) {
        throw new RpcError('db', body.message);
      }
      throw new RpcError(res.status >= 500 || res.status === 401 || res.status === 403 ? 'unavailable' : 'db', 'database error', { status: res.status });
    } catch (err) {
      if (err instanceof RpcError) throw err;
      throw new RpcError('unavailable', 'database unreachable');
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = { RpcError, createPostgrestRpc };
