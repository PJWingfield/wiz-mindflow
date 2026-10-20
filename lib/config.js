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

// Paid subscription (Stripe). Every piece is server configuration; nothing here is a default price. A missing or malformed piece leaves
// that capability OFF (purchase unavailable, webhook 503) while account, privacy and verification routes keep working.
//   STRIPE_SECRET_KEY        sk_test_... / sk_live_...  (the mode is read from the prefix)
//   STRIPE_WEBHOOK_SECRET    whsec_...
//   WIZ_STRIPE_PRICE_ID, WIZ_STRIPE_PRODUCT_ID, WIZ_STRIPE_PRICE_AMOUNT (minor units), WIZ_STRIPE_PRICE_CURRENCY, WIZ_STRIPE_PRICE_INTERVAL (month|year)
//                            the owner-approved price; verified against Stripe before purchase is offered
//   WIZ_BILLING_RETURN_URL   one https/loopback URL on a CORS-allowlisted origin: checkout success/cancel and portal return
//   WIZ_BILLING_GATE         paid gate on coaching + paid feature writes: ON unless exactly 'off' (legacy test fixtures only)
//   WIZ_BILLING_ERASURE_POLICY  'block' (default: erasure waits while a subscription can still charge) | 'cancel' (cancel it first)
function billingConfig(env, origins) {
  const key = /^sk_(test|live)_[A-Za-z0-9]{8,}$/.exec(env.STRIPE_SECRET_KEY || '');
  const price = /^price_[A-Za-z0-9]{3,64}$/.test(env.WIZ_STRIPE_PRICE_ID || '') && /^prod_[A-Za-z0-9]{3,64}$/.test(env.WIZ_STRIPE_PRODUCT_ID || '')
    && /^[1-9]\d{0,8}$/.test(env.WIZ_STRIPE_PRICE_AMOUNT || '') && /^[a-z]{3}$/.test(env.WIZ_STRIPE_PRICE_CURRENCY || '') && ['month', 'year'].includes(env.WIZ_STRIPE_PRICE_INTERVAL)
    ? { id: env.WIZ_STRIPE_PRICE_ID, productId: env.WIZ_STRIPE_PRODUCT_ID, amount: +env.WIZ_STRIPE_PRICE_AMOUNT, currency: env.WIZ_STRIPE_PRICE_CURRENCY, interval: env.WIZ_STRIPE_PRICE_INTERVAL } : null;
  return {
    gate: env.WIZ_BILLING_GATE !== 'off',
    secretKey: key ? key[0] : null,
    mode: key ? key[1] : null,
    webhookSecret: /^whsec_[A-Za-z0-9]{8,}$/.test(env.STRIPE_WEBHOOK_SECRET || '') ? env.STRIPE_WEBHOOK_SECRET : null,
    price,
    returnUrl: recoveryRedirect((env.WIZ_BILLING_RETURN_URL || '').trim(), origins),
    erasurePolicy: env.WIZ_BILLING_ERASURE_POLICY === 'cancel' ? 'cancel' : 'block'
  };
}

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
    // Terms + health-choice enforcement (signup, session start/chat, legacy /api/chat) is ON unless explicitly set to 'off' (legacy test fixtures
    // only). It needs 20261019120000 and 20261020120000 applied; without them the enforced routes fail closed (500), never open.
    consent: { flow: env.WIZ_CONSENT_FLOW !== 'off' },
    billing: billingConfig(env, corsOrigins),
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
