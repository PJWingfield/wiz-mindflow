'use strict';
// Runs wiz_* functions in PGlite as role service_role (BYPASSRLS), like the PostgREST service-role path.
const { RpcError } = require('../../lib/rpc');

function createPgliteRpc(db) {
  const meta = new Map();
  async function params(name) {
    if (!meta.has(name)) {
      const r = await db.query(
        `select a.n as name, format_type(a.t, null) as type, p.proretset as setof
         from pg_proc p join pg_namespace s on s.oid = p.pronamespace
         cross join lateral unnest(p.proargnames, p.proargtypes::oid[]) as a(n, t)
         where s.nspname = 'public' and p.proname = $1`, [name]);
      let setof;
      if (r.rows.length) setof = r.rows[0].setof;
      else { // a function with no arguments has no unnest rows: confirm it exists
        const f = await db.query("select p.proretset as setof from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = $1 and p.pronargs = 0", [name]);
        if (!f.rows.length) throw new RpcError('db', `unknown function ${name}`);
        setof = f.rows[0].setof;
      }
      const m = new Map(r.rows.map(x => [x.name, x.type]));
      m.setof = setof;
      meta.set(name, m);
    }
    return meta.get(name);
  }
  return async function rpc(name, args = {}) {
    const types = await params(name);
    const keys = Object.keys(args).filter(k => args[k] !== undefined);
    for (const k of keys) if (!types.has(k)) throw new RpcError('db', `unknown argument ${k}`);
    const values = keys.map(k => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]));
    const call = `public.${name}(${keys.map((k, i) => `${k} => $${i + 1}::${types.get(k)}`).join(', ')})`;
    // set-returning functions come back as a JSON array of rows, like PostgREST
    const sql = types.setof ? `select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) as r from ${call} t` : `select ${call} as r`;
    try {
      return await db.transaction(async tx => {
        await tx.query('set local role service_role');
        const r = await tx.query(sql, values);
        return r.rows[0].r;
      });
    } catch (err) {
      throw new RpcError('db', err.message, { pgCode: err.code });
    }
  };
}

module.exports = { createPgliteRpc };
