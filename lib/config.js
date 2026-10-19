'use strict';
// Environment -> config. Missing or malformed pieces leave that capability OFF (the API then fails closed
// with 503); there are no insecure defaults and no anonymous fallback.

const DEFAULT_ORIGINS = ['https://app.mindflowpro.com', 'https://mindflowpro.com', 'https://www.mindflowpro.com'];

function httpsOrLocal(raw) {
  try {
    const u = new URL(raw);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) return u.origin;
  } catch (_) { /* invalid */ }
  return null;
}
// Password-recovery return URL: ONE server-configured link target (never client supplied). HTTPS or loopback HTTP, no
// credentials or fragment, and its origin must be in the CORS allowlist. Anything else leaves recovery OFF (503).
function recoveryRedirect(raw, origins) {
  if (!raw || raw.includes('#')) return null;
  try {
    const u = new URL(raw);
    if (u.username || u.password || u.hash || !httpsOrLocal(raw) || !origins.includes(u.origin)) return null;
    return u.href;
  } catch (_) { return null; }
}
const posInt = (raw, def) => (/^\d{1,6}$/.test(raw || '') && +raw > 0 ? +raw : def);

function loadConfig(env = process.env) {
  const supabaseUrl = httpsOrLocal(env.SUPABASE_URL || '');
  const anonKey = env.SUPABASE_ANON_KEY || '';
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || '';
  const corsOrigins = env.CORS_ORIGINS ? env.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_ORIGINS;
  return {
    supabase: {
      url: supabaseUrl,
      anonKey: supabaseUrl && anonKey ? anonKey : null,
      serviceKey: supabaseUrl && serviceKey ? serviceKey : null
    },
    // Private attachment bucket (career portfolio). The bucket must already exist and be PRIVATE; provisioning is a separate
    // staging operation. Reuses the same project URL and service key as above; unset bucket = attachments off (503).
    storage: {
      url: supabaseUrl,
      serviceKey: supabaseUrl && serviceKey ? serviceKey : null,
      bucket: /^[a-z0-9][a-z0-9_-]{2,62}$/.test(env.WIZ_ATTACHMENT_BUCKET || '') ? env.WIZ_ATTACHMENT_BUCKET : null
    },
    // Privacy controls (export / session deletion / erasure) need 20261008180000_wiz_privacy_controls applied; off until then.
    privacy: { enabled: env.WIZ_PRIVACY_CONTROLS === 'on' },
    anthropicKey: env.ANTHROPIC_API_KEY || null,
    providerTimeoutMs: posInt(env.PROVIDER_TIMEOUT_MS, 90000),
    // Additive active-provenance RPC only. Apply KB migration before enabling.
    voyageKey: env.VOYAGE_API_KEY || null,
    kbProvenanceEnabled: env.WIZ_KB_PROVENANCE === 'on',
    kbDimension: posInt(env.WIZ_KB_EMBEDDING_DIM, 1024),
    kbTopK: Math.min(posInt(env.WIZ_KB_TOP_K, 2), 2),
    ragTimeoutMs: posInt(env.RAG_TIMEOUT_MS, 5000),
    corsOrigins,
    // Must also be listed in the Supabase Auth redirect allowlist (see docs/PASSWORD-RECOVERY.md).
    passwordResetRedirectUrl: recoveryRedirect((env.WIZ_PASSWORD_RESET_REDIRECT_URL || '').trim(), corsOrigins),
    // Number of trusted reverse-proxy hops in front of the app. 0 = ignore X-Forwarded-For entirely.
    trustProxyHops: /^[0-9]$/.test(env.TRUST_PROXY_HOPS || '') ? +env.TRUST_PROXY_HOPS : 0,
    limits: {
      publicPerMinute: posInt(env.RATE_PUBLIC_PER_MIN, 300),
      authPerMinute: posInt(env.RATE_AUTH_PER_MIN, 10),
      apiPerMinute: posInt(env.RATE_API_PER_MIN, 120),
      chatPerMinute: posInt(env.RATE_CHAT_PER_MIN, 20)
    }
  };
}

module.exports = { loadConfig, DEFAULT_ORIGINS };
