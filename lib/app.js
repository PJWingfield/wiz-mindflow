'use strict';
// Express application factory. All collaborators are injected so the app can be verified locally with no live
// Supabase, database or model provider:
//   auth     { signUp, signIn, refresh, signOut, verify, requestPasswordReset, updatePassword }   (lib/auth.js)
//   store    owner-scoped durable store                      (lib/store.js over an RPC transport)
//   provider { complete({ system, messages, signal }), model? }  (model call: POST /api/chat and POST /sessions/:id/chat)
//   storage  private attachment transport { put, get, delete } (optional; default: Supabase Storage when WIZ_ATTACHMENT_BUCKET is set)
//   authAdmin  server-only identity removal { deleteUser, exists } (optional; default: Supabase Auth admin when the service key is set)
//   stripe   official Stripe client (optional; default: created from config.billing.secretKey when configured)
//   billing  billing service (optional; default: lib/billing.js over store + stripe)
//   notices  exact-notice reader { load(id, expectedSha256?), list() } (optional; default: lib/notices.js over ./notices)
//   embed    async text -> number[]                          (optional knowledge-query embedding transport; default: Voyage over HTTP)
// Any missing collaborator makes the routes that need it fail closed with 503. There is no anonymous fallback.
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { ApiError, e } = require('./errors');
const V = require('./validate');
const { createLimiter } = require('./rate-limit');
const { createRetriever } = require('./retrieval');
const career = require('./career');
const { createNotices } = require('./notices');
const { createPlans } = require('./plans');
const billingModule = require('./billing');
const privacyModule = require('./privacy');
const { createSupabaseAuthAdmin } = require('./auth-admin');
const { createAttachments, createSupabaseStorageTransport } = require('./attachments');
const { createCoaching, resolveSessionStart, resolvePathway, requireAdult, evaluateReadiness, requireCoachingReady, GENERAL_BRIEF, pathways } = require('./coaching');

const INDEX_FILE = path.join(__dirname, '..', 'index.html');
const NO_CACHE = 'no-cache, must-revalidate';
const ALLOWED_VERBS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const BEARER_RE = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/;

function defaultLogger(event, fields) {
  console.error(JSON.stringify({ event, ...fields })); // metadata only: never bodies, tokens or provider output
}

function createApp({ config, auth = null, store = null, provider = null, buildSystem = () => [], tracks = [], lenses = [], now = Date.now, logger = defaultLogger, providerTimeoutMs, embed = null, retrieval = null, storage = null, authAdmin = null, notices = null, stripe = null, billing = null, providers = {} }) {
  const app = express();
  const noticeCatalogue = notices || createNotices({ logger });
  if (providerTimeoutMs) config = { ...config, providerTimeoutMs };
  const consentFlow = !!(config.consent && config.consent.flow); // Terms + health choice enforced server-side (see lib/coaching.js)
  const TERMS_VERSION = V.pattern(/^[A-Za-z0-9._-]{1,20}$/, 20), TERMS_SHA = V.pattern(/^[0-9a-f]{64}$/, 64);
  const retriever = retrieval || createRetriever({ config, store, embed });
  app.locals.retrieval = retriever; // read-only visibility of the effective retrieval wiring (tests, diagnostics)
  // One plan resolver for every coaching entry point (saved sessions, session start, legacy /api/chat) and for purchase: the paid price picks the provider.
  const plans = createPlans({ config, providers: { ...providers, main: provider }, store });
  const coaching = createCoaching({ store, provider, retrieval: retriever, buildSystem, config, logger, plans });
  const stripeClient = stripe || (config.billing && config.billing.secretKey ? billingModule.createStripeClient(config.billing) : null);
  const billingSvc = billing || billingModule.createBilling({ config, store, stripe: stripeClient, logger, now, plans });
  const storageTransport = storage || (config.storage && config.storage.bucket && config.storage.serviceKey
    ? createSupabaseStorageTransport({ url: config.storage.url, serviceKey: config.storage.serviceKey, bucket: config.storage.bucket })
    : null);
  const attachments = createAttachments({ store, transport: storageTransport, logger });
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxyHops || false);

  const publicLimit = createLimiter({ max: config.limits.publicPerMinute, now });
  const authLimit = createLimiter({ max: config.limits.authPerMinute, now });
  const apiLimit = createLimiter({ max: config.limits.apiPerMinute, now });
  const chatLimit = createLimiter({ max: config.limits.chatPerMinute, now });
  const limiting = (limiter, keyOf) => (req, res, next) => {
    const r = limiter(keyOf(req));
    if (r.ok) return next();
    res.setHeader('Retry-After', String(r.retryAfter));
    next(new ApiError(429, 'rate_limited', 'Too many requests. Please wait and try again.'));
  };
  const byIp = req => req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';

  // request id + CORS (verbs/headers match what the routes below actually accept)
  app.use((req, res, next) => {
    req.id = crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    const origin = req.headers.origin;
    res.setHeader('Vary', 'Origin');
    if (origin && config.corsOrigins.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', ALLOWED_VERBS);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, Retry-After');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Source-exposure containment (P0): the app root is NOT served as a static directory. Only the explicit
  // routes below are public; everything else falls through to the canonical 404.
  function sendIndex(req, res) {
    res.setHeader('Cache-Control', NO_CACHE);
    res.sendFile(INDEX_FILE);
  }
  app.get(['/', '/index.html'], sendIndex);
  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  // ---- shared plumbing -------------------------------------------------------------------------------------
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const needJson = (req, res, next) => {
    const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'];
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && hasBody && !req.is('application/json')) {
      return next(new ApiError(415, 'unsupported_media_type', 'Content-Type must be application/json.'));
    }
    next();
  };
  const json = limit => [needJson, express.json({ limit })];
  const body = req => (req.body === undefined ? {} : req.body);

  const ensured = new Map(); // verified user id -> { email, until } so the profile row is upserted once per interval
  const privacyOn = () => !!(config.privacy && config.privacy.enabled && store && store.erasureState);
  // An account with an erasure receipt is denied BEFORE the profile row is ensured, so a request can never recreate or reopen it.
  // The check runs on every request (the ensure cache below only skips the profile upsert). allowPending: only the erasure/export routes.
  const makeRequireUser = allowPending => wrap(async (req, res, next) => {
    if (!auth || !store) throw e.unavailable();
    const m = BEARER_RE.exec(req.get('authorization') || '');
    if (!m || m[1].length > 4096) throw e.unauthorized();
    const user = await auth.verify(m[1]);
    if (!V.UUID_RE.test(user.id)) throw e.forbidden('unsupported_account', 'This account type is not supported.');
    if (privacyOn()) {
      const st = await store.erasureState(user.id);
      if (st && (st.state === 'completed' || !allowPending)) {
        throw e.forbidden(st.state === 'completed' ? 'account_erased' : 'account_erasure_pending', 'This account is closed or being erased.');
      }
      if (st) { ensured.delete(user.id); req.user = user; req.token = m[1]; return next(); }
    }
    const t = now();
    const seen = ensured.get(user.id);
    if (!seen || seen.email !== user.email || seen.until < t) {
      await store.ensureUser(user.id, user.email);
      if (ensured.size >= 5000) ensured.delete(ensured.keys().next().value);
      ensured.set(user.id, { email: user.email, until: t + 10 * 60 * 1000 });
    }
    req.user = user;
    req.token = m[1];
    next();
  });
  const requireUser = makeRequireUser(false);
  const userLimit = limiting(apiLimit, req => req.user.id);
  const secure = [requireUser, userLimit];
  const securePending = [makeRequireUser(true), userLimit];
  // Paid value-adding WRITES (goals, journal, reports, evidence, training, checkpoints, saved messages, career records, attachments): after
  // authentication, before the route. Reads, deletes and AI-use switches stay available unpaid, as do session creation/rename, profile,
  // onboarding, consent, Terms, billing, export and erasure. Coaching has its own check in lib/coaching.js and /api/chat.
  const PAID_WRITE = new Set(['POST', 'PUT', 'PATCH']);
  const paidWriteGate = wrap(async (req, res, next) => {
    if (PAID_WRITE.has(req.method) && !req.path.endsWith('/ai-use')) await billingModule.requirePaid(store, req.user.id, config);
    next();
  });
  const securePaid = [...secure, paidWriteGate];

  // route(router, path, { GET: [mw..., handler], ... }): unlisted verbs get 405 with Allow.
  function route(router, p, verbs) {
    const r = router.route(p);
    for (const [verb, chain] of Object.entries(verbs)) r[verb.toLowerCase()](...chain);
    const allow = Object.keys(verbs).flatMap(v => (v === 'GET' ? ['GET', 'HEAD'] : [v])).concat('OPTIONS').join(', ');
    r.all((req, res, next) => { res.setHeader('Allow', allow); next(new ApiError(405, 'method_not_allowed', 'Method not allowed.')); });
  }

  const v1 = express.Router();
  const id = (req, name = 'id') => V.uuid(req.params[name], name);
  const nextCursor = r => V.encodeCursor(r.next);
  const created = (res, r) => res.status(r.replayed ? 200 : 201).json({ item: r.item });

  // ---- auth (public, per-IP limited; credentials are forwarded to Supabase Auth and never kept) ------------
  const authLim = limiting(authLimit, byIp);
  const needAuth = (req, res, next) => (auth ? next() : next(e.unavailable()));
  route(v1, '/auth/signup', { POST: [authLim, needAuth, ...json('8kb'), wrap(async (req, res) => {
    const b = V.parse(body(req), { email: V.email, password: V.password, full_name: V.text(1, 100), over_18: V.bool, accept_terms: V.bool, terms_version: TERMS_VERSION, terms_sha256: TERMS_SHA }, ['email', 'password', 'over_18']);
    if (b.over_18 !== true) throw e.invalid('You must confirm you are 18 or older to create an account.', ['over_18']);
    // With the consent flow on, an affirmative decision on the CURRENT, hash-verified Terms is required BEFORE the Auth account exists.
    let terms = null;
    if (consentFlow) {
      if (!store) throw e.unavailable();
      if (b.accept_terms !== true) throw new ApiError(400, 'terms_not_accepted', 'You must accept the Terms to create an account.', { fields: ['accept_terms'] });
      terms = await store.termsCurrent();
      if (!terms) throw e.unavailable('terms_unavailable', 'The Terms are not available yet.');
      if (b.terms_version !== terms.version || b.terms_sha256 !== terms.artifact_sha256) throw e.conflict('stale_terms_version', 'These are not the current terms. Reload and review them before accepting.');
      await noticeCatalogue.load(terms.artifact_id, terms.artifact_sha256);
    }
    const r = await auth.signUp({ email: b.email, password: b.password, fullName: b.full_name, over18ConfirmedAt: new Date(now()).toISOString() });
    if (!terms) return res.status(201).json(r);
    if (!r.session) {
      // Email confirmation: no verified session yet (and Auth may return a placeholder id for an address already in use), so nothing is
      // recorded against it. The Terms are accepted from the signed-in account after confirmation; coaching stays blocked until then.
      return res.status(201).json({ ...r, terms_recorded: false });
    }
    try {
      await store.ensureUser(r.user.id, r.user.email);
      await store.acceptTerms(r.user.id, terms.version, terms.artifact_sha256);
    } catch (err) {
      logger('terms_record_failed', { request_id: req.id, kind: err && err.name, code: err && err.code });
      throw e.unavailable('terms_not_recorded', 'Your account was created, but we could not record your acceptance of the Terms. Sign in and accept the Terms to continue.');
    }
    res.status(201).json({ ...r, terms_recorded: true });
  })] });
  route(v1, '/auth/login', { POST: [authLim, needAuth, ...json('8kb'), wrap(async (req, res) => {
    const b = V.parse(body(req), { email: V.email, password: V.password }, ['email', 'password']);
    res.json(await auth.signIn(b));
  })] });
  route(v1, '/auth/refresh', { POST: [authLim, needAuth, ...json('8kb'), wrap(async (req, res) => {
    const b = V.parse(body(req), { refresh_token: V.text(10, 2048, { trim: false, blobCheck: false }) }, ['refresh_token']);
    res.json(await auth.refresh({ refreshToken: b.refresh_token }));
  })] });
  route(v1, '/auth/password-reset', { POST: [authLim, needAuth, ...json('8kb'), wrap(async (req, res) => {
    const b = V.parse(body(req), { email: V.email }, ['email']);
    if (!config.passwordResetRedirectUrl) throw e.unavailable('recovery_unavailable', 'Password recovery is not available.');
    await auth.requestPasswordReset({ email: b.email, redirectTo: config.passwordResetRedirectUrl });
    res.json({ ok: true, message: 'If an account exists for that email, a recovery link has been sent.' });
  })] });
  route(v1, '/auth/password', { POST: [...secure, ...json('8kb'), wrap(async (req, res) => {
    const b = V.parse(body(req), { password: V.password }, ['password']);
    await auth.updatePassword(req.token, b.password);
    res.json({ ok: true });
  })] });
  route(v1, '/auth/logout', { POST: [authLim, wrap(async (req, res) => {
    if (!auth) throw e.unavailable();
    const m = BEARER_RE.exec(req.get('authorization') || '');
    if (!m) throw e.unauthorized();
    await auth.signOut(m[1]);
    res.status(204).end();
  })] });

  // ---- profile / preferences / onboarding --------------------------------------------------------------------
  const prefSpec = {
    track: V.nullable(V.oneOf(tracks)), lens: V.nullable(V.oneOf(lenses)),
    language: V.nullable(V.pattern(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/, 10))
  };
  route(v1, '/me', {
    GET: [...secure, wrap(async (req, res) => res.json(await store.getMe(req.user.id)))],
    PATCH: [...secure, ...json('16kb'), wrap(async (req, res) => {
      const b = V.parse(body(req), { full_name: V.text(1, 100, { nullable: true }), preferences: (v, f) => V.parse(V.obj(v, f), prefSpec) });
      if (!Object.keys(b).length) throw e.invalid('Nothing to update.');
      res.json(await store.updateProfile(req.user.id, b));
    })]
  });
  const answerValue = (v, f) => {
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') { if (!Number.isFinite(v)) throw e.invalid(`${f} must be finite.`, [f]); return v; }
    if (typeof v === 'string') return V.text(0, 2000, { trim: false })(v, f);
    if (Array.isArray(v) && v.length <= 20) return v.map(x => V.text(0, 200, { trim: false })(x, f));
    throw e.invalid(`${f} has an unsupported value.`, [f]);
  };
  const answers = (v, f) => {
    V.obj(v, f);
    const keys = Object.keys(v);
    if (keys.length > 30) throw e.invalid('Too many onboarding answers.', [f]);
    const out = {};
    for (const k of keys) {
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(k)) throw e.invalid('Onboarding answer keys must be lower_snake_case.', [f]);
      out[k] = answerValue(v[k], k);
    }
    return out;
  };
  route(v1, '/me/onboarding', {
    GET: [...secure, wrap(async (req, res) => res.json(await store.getOnboarding(req.user.id)))],
    PUT: [...secure, ...json('32kb'), wrap(async (req, res) => {
      const b = V.parse(body(req), { answers, complete: V.bool }, ['answers']);
      res.json(await store.putOnboarding(req.user.id, b.answers, b.complete));
    })]
  });

  // ---- consent: versioned purposes; a decision is only ever recorded from an explicit owner request ----------
  route(v1, '/consents', {
    GET: [...secure, wrap(async (req, res) => res.json({ purposes: await store.consentState(req.user.id) }))],
    POST: [...secure, ...json('2kb'), wrap(async (req, res) => {
      const b = V.parse(body(req), { purpose: V.pattern(/^[a-z_]{3,40}$/, 40), version: V.pattern(/^[A-Za-z0-9._-]{1,20}$/, 20), action: V.oneOf(['grant', 'revoke']) }, ['purpose', 'version', 'action']);
      res.json({ purposes: await store.recordConsent(req.user.id, b.purpose, b.version, b.action) });
    })]
  });

  // ---- exact notices (public, read-only) and terms acceptance (authenticated, append-only) ----------------------------
  // Notices are served only by catalogue id from server-owned files whose bytes are re-verified against their SHA-256.
  route(v1, '/notices', { GET: [(req, res) => res.json({ items: noticeCatalogue.list() })] });
  route(v1, '/notices/:id', { GET: [wrap(async (req, res) => {
    const nid = V.pattern(/^[a-z0-9][a-z0-9._-]{2,79}$/, 80)(req.params.id, 'id');
    res.setHeader('Cache-Control', NO_CACHE);
    res.json({ notice: await noticeCatalogue.load(nid) });
  })] });
  // Current Terms for the pre-signup screen (public): which version/hash the sign-up must name. enabled = the server enforces the flow.
  route(v1, '/terms/current', { GET: [wrap(async (req, res) => {
    if (!consentFlow || !store) return res.json({ enabled: false });
    const t = await store.termsCurrent();
    if (!t) throw e.unavailable('terms_unavailable', 'The Terms are not available yet.');
    res.json({ enabled: true, terms: { ...t, notice_path: `/api/v1/notices/${t.artifact_id}` } });
  })] });
  // Whether this account may be coached now, and in which mode (health | general), so the UI can ask before the first message.
  route(v1, '/readiness', { GET: [...secure, wrap(async (req, res) => {
    // billing: whether a paid subscription is required and held (the server enforces it separately; this lets the UI ask first)
    const bill = config.billing && config.billing.gate ? { required: true, entitled: await billingSvc.entitlement(req.user.id) } : { required: false };
    if (!consentFlow) return res.json({ enabled: false, ready: true, billing: bill });
    const r = evaluateReadiness(await store.coachingState(req.user.id));
    // retention: save_chats is needed to hold any conversation. It is reported so the UI can ask explicitly; the append gate enforces it.
    res.json({ enabled: true, ready: r.ready, blocker: r.blocker, mode: r.mode, terms: r.terms, health: r.health, retention: r.retention, fenced: !!r.fence_at, billing: bill });
  })] });
  const termsView = st => ({ terms: { ...st, current: st.current && { ...st.current, notice_path: `/api/v1/notices/${st.current.artifact_id}` } } });
  route(v1, '/terms', { GET: [...secure, wrap(async (req, res) => res.json(termsView(await store.termsState(req.user.id))))] });
  // The owner comes from the verified token only; the time is the server's. Re-posting the same current version is harmless (200).
  route(v1, '/terms/acceptance', { POST: [...secure, ...json('2kb'), wrap(async (req, res) => {
    const b = V.parse(body(req), { version: V.pattern(/^[A-Za-z0-9._-]{1,20}$/, 20), artifact_sha256: V.pattern(/^[0-9a-f]{64}$/, 64), accepted: V.bool }, ['version', 'artifact_sha256', 'accepted']);
    if (b.accepted !== true) throw e.invalid('Acceptance must be confirmed explicitly.', ['accepted']);
    const st = await store.termsState(req.user.id);
    if (st.current) await noticeCatalogue.load(st.current.artifact_id, st.current.artifact_sha256); // never record against unverifiable wording
    const { replayed, ...state } = await store.acceptTerms(req.user.id, b.version, b.artifact_sha256);
    res.status(replayed ? 200 : 201).json(termsView(state));
  })] });

  // ---- paid subscription: status, hosted Checkout, Customer Portal, owner refresh, signed webhook (lib/billing.js) ----
  billingModule.mount({ v1, route, secure, securePending, json, wrap, billing: billingSvc, getStripe: () => stripeClient, getSecret: () => config.billing && config.billing.webhookSecret });

  // ---- privacy controls (export, session deletion, account erasure) ----
  const authAdminImpl = authAdmin || (config.supabase && config.supabase.serviceKey ? createSupabaseAuthAdmin({ url: config.supabase.url, serviceKey: config.supabase.serviceKey }) : null);
  const privacy = privacyModule.createPrivacy({ store: store || {}, transport: storageTransport, authAdmin: authAdminImpl, logger, forget: uid => ensured.delete(uid), billing: billingSvc });
  app.locals.privacy = privacy; // operator resume by receipt: app.locals.privacy.resume(receiptId)
  const privacyRoutes = privacyModule.mount({ v1, route, securePending, json, wrap, body, privacy, enabled: privacyOn });

  // ---- sessions (one journey per account, many sessions), messages, checkpoints -------------------------------
  const topic = (v, f) => {
    const t = V.parse(V.obj(v, f), { kind: V.oneOf(['custom', 'catalogue']), text: V.text(1, 300), area: V.text(1, 120), panel: V.text(1, 120) }, ['kind']);
    if (t.kind === 'custom' && (t.text === undefined || t.area !== undefined || t.panel !== undefined)) throw e.invalid('A custom topic needs text only.', [f]);
    if (t.kind === 'catalogue' && (t.area === undefined || t.text !== undefined)) throw e.invalid('A catalogue topic needs an area (and optionally a panel).', [f]);
    return t;
  };
  route(v1, '/sessions', {
    GET: [...secure, wrap(async (req, res) => {
      const arch = req.query.archived;
      if (arch !== undefined && !['true', 'false', 'all'].includes(arch)) throw e.invalid('archived must be true, false or all.', ['archived']);
      const r = await store.listSessions(req.user.id, V.decodeCursor(req), V.pageLimit(req), arch === 'all' ? null : arch === 'true');
      res.json({ items: r.items, next_cursor: nextCursor(r) });
    })],
    POST: [...secure, ...json('8kb'), wrap(async (req, res) => {
      const b = V.parse(body(req), { track: V.oneOf(tracks), lens: V.oneOf(lenses), topic }, []);
      created(res, await store.createSession(req.user.id, resolveSessionStart(b), V.idempotencyKey(req)));
    })]
  });
  route(v1, '/sessions/:id', {
    GET: [...secure, wrap(async (req, res) => res.json({ item: await store.getSession(req.user.id, id(req)) }))],
    PATCH: [...secure, ...json('4kb'), wrap(async (req, res) => {
      const b = V.parse(body(req), { title: V.text(1, 120), is_archived: V.bool });
      if (!Object.keys(b).length) throw e.invalid('Nothing to update.');
      res.json({ item: await store.updateSession(req.user.id, id(req), b) });
    })],
    DELETE: privacyRoutes.sessionDelete(secure)
  });
  route(v1, '/sessions/:id/checkpoint', {
    GET: [...secure, wrap(async (req, res) => res.json(await store.getCheckpoint(req.user.id, id(req))))],
    PUT: [...securePaid, ...json('64kb'), wrap(async (req, res) => {
      const b = V.parse(body(req), { checkpoint: V.jsonDoc(32768), expected_version: V.int(0, 1e9) }, ['checkpoint']);
      res.json(await store.putCheckpoint(req.user.id, id(req), b.checkpoint, b.expected_version === undefined ? null : b.expected_version));
    })]
  });

  // Jon's 14 opening pathways, exactly as the existing index.html presents them (lib/pathways.json). A session topic of
  // kind "catalogue" must name one of these (by id or title); custom goals are free text.
  route(v1, '/catalogue', {
    GET: [...secure, wrap(async (req, res) => res.json({ items: pathways }))]
  });

  route(v1, '/sessions/:id/start', {
    POST: [...secure, ...json('128kb'), wrap(async (req, res) => {
      const key = V.idempotencyKey(req, { required: true });
      const sessionId = id(req);
      await requireAdult(store, req.user.id);
      const session = await store.getSession(req.user.id, sessionId);
      if (session.message_count > 0) {
        const prior = await store.messageByKey(req.user.id, sessionId, key);
        if (!prior) throw new ApiError(400, 'session_already_started', 'Session has already started.');
      }
      const t = session.topic;
      if (!t) throw new ApiError(400, 'no_topic', 'Session has no topic.');
      let text = '';
      if (t.kind === 'custom') {
        text = `I want to focus on: ${t.text}`;
      } else {
        const p = resolvePathway(t.pathway || t.area);
        const name = p ? p.title : t.area;
        text = `I want to focus on: ${name}`;
        if (t.panel) text += ` (${t.panel})`;
      }
      const out = await coaching.chat({ userId: req.user.id, sessionId, key, userContent: text, requestId: req.id, origin: 'server_start' });
      res.json(out);
    })]
  });

  // One coaching turn: adult attestation -> retain the user turn -> recent history + consent-gated personal context +
  // knowledge retrieval -> model -> retain the reply with its provenance. The client's own history is not trusted;
  // only its last (user) message is used.
  route(v1, '/sessions/:id/chat', {
    POST: [...secure, ...json('10mb'), wrap(async (req, res) => {
      const key = V.idempotencyKey(req, { required: true });
      const b = V.parse(body(req), { messages: v => v }, ['messages']);
      const messages = chatMessages(b.messages);
      const userMsg = messages[messages.length - 1];
      if (userMsg.role !== 'user') throw e.invalid('Last message must be from user.', ['messages']);
      const sessionId = id(req);
      await requireAdult(store, req.user.id);
      const out = await coaching.chat({ userId: req.user.id, sessionId, key, userContent: userMsg.content, requestId: req.id });
      res.json(out);
    })]
  });

  route(v1, '/sessions/:id/messages', {
    GET: [...secure, wrap(async (req, res) => {
      let after = null;
      if (req.query.after !== undefined) {
        if (typeof req.query.after !== 'string' || !/^\d{1,15}$/.test(req.query.after)) throw e.invalid('after must be a non-negative integer.', ['after']);
        after = +req.query.after;
      }
      res.json(await store.listMessages(req.user.id, id(req), after, V.pageLimit(req, 50, 200)));
    })],
    // Browser-submitted messages are always sender "user"; assistant/system messages come from server code only.
    POST: [...securePaid, ...json('128kb'), wrap(async (req, res) => {
      const key = V.idempotencyKey(req, { required: true });
      const b = V.parse(body(req), { content: V.text(1, 20000, { trim: false }) }, ['content']);
      if (!b.content.trim()) throw e.invalid('content must not be blank.', ['content']);
      created(res, await store.appendMessage(req.user.id, id(req), { sender: 'user', content: b.content, key, provenance: { origin: 'user_input' } }));
    })]
  });

  // ---- durable records --------------------------------------------------------------------------------------------
  const maybe = f => (f === undefined ? null : f);
  const dateNull = V.nullable(V.date);
  const goalSpec = { title: V.text(1, 300), why: V.text(0, 2000, { nullable: true }), measure: V.text(0, 1000, { nullable: true }), target_date: dateNull };
  route(v1, '/goals', {
    GET: [...secure, wrap(async (req, res) => { const r = await store.listGoals(req.user.id, V.decodeCursor(req), V.pageLimit(req)); res.json({ items: r.items, next_cursor: nextCursor(r) }); })],
    POST: [...securePaid, ...json('16kb'), wrap(async (req, res) => {
      const b = V.parse(body(req), { ...goalSpec, session_id: V.uuid }, ['title']);
      created(res, await store.createGoal(req.user.id, b, V.idempotencyKey(req)));
    })]
  });
  route(v1, '/goals/:id', {
    GET: [...secure, wrap(async (req, res) => res.json({ item: await store.getGoal(req.user.id, id(req)) }))],
    PATCH: [...securePaid, ...json('16kb'), wrap(async (req, res) => {
      const b = V.parse(body(req), { ...goalSpec, status: V.oneOf(['active', 'achieved', 'paused', 'dropped']), expected_version: V.int(1, 1e9) });
      const { expected_version: ev, ...patch } = b;
      if (!Object.keys(patch).length) throw e.invalid('Nothing to update.');
      res.json({ item: await store.updateGoal(req.user.id, id(req), patch, maybe(ev)) });
    })],
    DELETE: [...secure, wrap(async (req, res) => res.json(await store.deleteGoal(req.user.id, id(req))))]
  });

  const journalSpec = { body: V.text(1, 20000), entry_date: V.date };
  route(v1, '/journal', {
    GET: [...secure, wrap(async (req, res) => { const r = await store.listJournal(req.user.id, V.decodeCursor(req), V.pageLimit(req)); res.json({ items: r.items, next_cursor: nextCursor(r) }); })],
    POST: [...securePaid, ...json('64kb'), wrap(async (req, res) => {
      const b = V.parse(body(req), { ...journalSpec, session_id: V.uuid }, ['body']);
      created(res, await store.createJournal(req.user.id, b, V.idempotencyKey(req)));
    })]
  });
  route(v1, '/journal/:id', {
    GET: [...secure, wrap(async (req, res) => res.json({ item: await store.getJournal(req.user.id, id(req)) }))],
    PATCH: [...securePaid, ...json('64kb'), wrap(async (req, res) => {
      const b = V.parse(body(req), { ...journalSpec, expected_version: V.int(1, 1e9) });
      const { expected_version: ev, ...patch } = b;
      if (!Object.keys(patch).length) throw e.invalid('Nothing to update.');
      res.json({ item: await store.updateJournal(req.user.id, id(req), patch, maybe(ev)) });
    })],
    DELETE: [...secure, wrap(async (req, res) => res.json(await store.deleteJournal(req.user.id, id(req))))]
  });

  route(v1, '/reports', {
    GET: [...secure, wrap(async (req, res) => { const r = await store.listReports(req.user.id, V.decodeCursor(req), V.pageLimit(req)); res.json({ items: r.items, next_cursor: nextCursor(r) }); })],
    POST: [...securePaid, ...json('128kb'), wrap(async (req, res) => {
      const b = V.parse(body(req), { kind: V.pattern(/^[a-z0-9_]{1,40}$/, 40), title: V.text(1, 200), body: V.text(1, 60000), session_id: V.uuid }, ['kind', 'title', 'body']);
      // provenance is fixed server-side: a browser cannot present its own text as an assistant-generated report
      created(res, await store.createReport(req.user.id, { ...b, source: 'client_submitted' }, V.idempotencyKey(req)));
    })]
  });
  route(v1, '/reports/:id', {
    GET: [...secure, wrap(async (req, res) => res.json({ item: await store.getReport(req.user.id, id(req)) }))],
    DELETE: [...secure, wrap(async (req, res) => res.json(await store.deleteReport(req.user.id, id(req))))]
  });

  route(v1, '/evidence', {
    GET: [...secure, wrap(async (req, res) => { const r = await store.listEvidence(req.user.id, V.decodeCursor(req), V.pageLimit(req)); res.json({ items: r.items, next_cursor: nextCursor(r) }); })],
    POST: [...securePaid, ...json('8kb'), wrap(async (req, res) => {
      const b = V.parse(body(req), { statement: V.text(1, 2000), session_id: V.uuid }, ['statement']);
      created(res, await store.createEvidence(req.user.id, { ...b, source: 'user_stated' }, V.idempotencyKey(req)));
    })]
  });
  route(v1, '/evidence/:id', {
    PATCH: [...securePaid, ...json('8kb'), wrap(async (req, res) => {
      const b = V.parse(body(req), { statement: V.text(1, 2000), expected_version: V.int(1, 1e9) }, ['statement']);
      res.json({ item: await store.correctEvidence(req.user.id, id(req), b.statement, maybe(b.expected_version)) });
    })],
    DELETE: [...secure, wrap(async (req, res) => res.json(await store.deleteEvidence(req.user.id, id(req))))]
  });
  route(v1, '/evidence/:id/confirm', { POST: [...securePaid, wrap(async (req, res) => res.json({ item: await store.confirmEvidence(req.user.id, id(req)) }))] });
  route(v1, '/evidence/:id/ai-use', {
    PUT: [...secure, ...json('1kb'), wrap(async (req, res) => {
      const b = V.parse(body(req), { enabled: V.bool }, ['enabled']);
      res.json({ item: await store.setEvidenceAiUse(req.user.id, id(req), b.enabled) });
    })]
  });

  route(v1, '/training', { GET: [...secure, wrap(async (req, res) => res.json({ items: await store.listTraining(req.user.id) }))] });
  route(v1, '/training/:moduleKey', {
    PUT: [...securePaid, ...json('1kb'), wrap(async (req, res) => {
      const moduleKey = V.pattern(/^[A-Za-z0-9_.:-]{1,80}$/, 80)(req.params.moduleKey, 'moduleKey');
      const b = V.parse(body(req), { status: V.oneOf(['not_started', 'in_progress', 'completed']), percent: V.int(0, 100) }, ['status']);
      res.json({ item: await store.upsertTraining(req.user.id, moduleKey, b.status, b.percent === undefined ? 0 : b.percent) });
    })]
  });
  // pairing is status only and read-only to the browser
  route(v1, '/pairing', { GET: [...secure, wrap(async (req, res) => res.json(await store.getPairing(req.user.id)))] });

  // ---- career development (plan, learning profile, portfolio, networking, pulses, prior learning, attachments) ----
  career.mount({ v1, route, secure: securePaid, json, wrap, body, store, attachments, now });

  app.use('/api/v1', limiting(publicLimit, byIp), v1);

  // ---- model proxy: verified identity required, no anonymous fallback. Not yet persisted or personalised. ----
  const blockTypes = { text: ['text'], image: ['source'], document: ['source'] };
  const MEDIA = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
  function chatMessages(list) {
    if (!Array.isArray(list) || list.length < 1 || list.length > 100) throw e.invalid('messages must be a list of 1-100 items.', ['messages']);
    return list.map(m => {
      const x = V.parse(V.obj(m, 'message'), { role: V.oneOf(['user', 'assistant']), content: (c, f) => {
        if (typeof c === 'string') return V.text(1, 50000, { trim: false, blobCheck: false })(c, f);
        if (!Array.isArray(c) || c.length < 1 || c.length > 10) throw e.invalid('content must be text or a short list of blocks.', [f]);
        return c.map(b => {
          if (!b || typeof b !== 'object' || !Object.prototype.hasOwnProperty.call(blockTypes, b.type)) throw e.invalid('Unsupported content block.', [f]);
          if (b.type === 'text') return V.parse(b, { type: V.oneOf(['text']), text: V.text(1, 50000, { trim: false, blobCheck: false }) }, ['type', 'text']);
          const src = V.parse(V.obj(b.source, 'source'), { type: V.oneOf(['base64']), media_type: V.oneOf(MEDIA), data: V.text(1, 40e6, { trim: false, blobCheck: false }) }, ['type', 'media_type', 'data']);
          return { type: b.type, source: src };
        });
      } }, ['role', 'content']);
      return x;
    });
  }
  const optionalName = (list) => V.nullable(V.oneOf(list));
  app.post('/api/chat', limiting(publicLimit, byIp), requireUser, limiting(chatLimit, req => req.user.id), ...json('10mb'), wrap(async (req, res) => {
    if (!provider && !(plans.tiers && !plans.malformed)) throw e.unavailable('assistant_unavailable', 'Assistant unavailable.');
    await requireAdult(store, req.user.id);
    const b = V.parse(body(req), { messages: v => v, track: optionalName(tracks), lens: optionalName(lenses), system: v => v }, ['messages']);
    // a client-supplied "system" is accepted for old-client compatibility and deliberately ignored
    let messages = chatMessages(b.messages);
    // Terms + answered health choice, checked immediately before the provider call. This route stores and personalises nothing, so a
    // declined choice only adds the general-coaching brief to the base system blocks.
    const entitlement = await billingModule.requirePaid(store, req.user.id, config); // paid gate before any provider work (unpaid accounts keep every non-coaching route)
    // The verified paid price chooses the provider here exactly as for saved sessions, so this route cannot bypass the plan or consent checks.
    const route = plans.resolve(entitlement);
    const chosen = route.provider;
    if (!chosen) throw e.unavailable('assistant_unavailable', 'Assistant unavailable.');
    const grant = route.sharing ? await plans.requireSharing(req.user.id) : null;
    // Shared Info never sends client-supplied history (it is unverified and may hold earlier sessions): only the final user message.
    if (grant) messages = messages.slice(-1);
    const gate = consentFlow ? await requireCoachingReady(store, req.user.id) : null;
    if (grant) await plans.requireSharing(req.user.id); // revocation between the checks above and the send: refused unsent
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.providerTimeoutMs || 90000);
    try {
      let system = buildSystem(b.track, b.lens);
      if (gate && gate.mode === 'general') system = [...(typeof system === 'string' ? [{ type: 'text', text: system }] : system), { type: 'text', text: GENERAL_BRIEF }];
      const content = await chosen.complete({ system, messages, signal: ctrl.signal });
      res.json({ content });
    } catch (err) {
      const upstream = err && err.name === 'ProviderError' ? err.status : 0;
      logger('provider_error', { request_id: req.id, kind: err && err.name, upstream_status: upstream || undefined });
      if (upstream === 429) throw new ApiError(429, 'assistant_busy', 'The assistant is busy. Please retry shortly.');
      throw new ApiError(502, 'assistant_unavailable', 'Assistant unavailable -- please retry.');
    } finally {
      clearTimeout(timer);
    }
  }));

  // ---- canonical 404 / errors ---------------------------------------------------------------------------------------
  app.use((req, res, next) => next(e.notFound()));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let out = err;
    if (!(err instanceof ApiError)) {
      if (err && err.type === 'entity.too.large') out = new ApiError(413, 'payload_too_large', 'Request body is too large.');
      else if (err && err.type === 'entity.parse.failed') out = new ApiError(400, 'invalid_json', 'Request body is not valid JSON.');
      else if (err && (err.type === 'encoding.unsupported' || err.type === 'charset.unsupported')) out = new ApiError(415, 'unsupported_media_type', 'Unsupported encoding.');
      else if (err && err.status >= 400 && err.status < 500) out = new ApiError(400, 'invalid_request', 'Bad request.');
      else out = new ApiError(500, 'internal_error', 'Something went wrong.');
    }
    if (out.status >= 500) logger('request_error', { request_id: req.id, status: out.status, code: out.code, method: req.method, error_name: err && err.name });
    if (res.headersSent) return res.destroy();
    res.status(out.status).json({ error: { code: out.code, message: out.message, request_id: req.id, ...(out.extra.fields ? { fields: out.extra.fields } : {}), ...(out.extra.attachment ? { attachment: out.extra.attachment } : {}), ...(out.extra.erasure ? { erasure: out.extra.erasure } : {}) } });
  });

  return app;
}

module.exports = { createApp, INDEX_FILE };
