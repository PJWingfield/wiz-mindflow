'use strict';
// The three owner-approved plans and the ONE server-side resolver from a verified paid entitlement to a coaching provider. Not a catalogue:
// the identifiers, GBP monthly amounts and provider kinds are fixed here; only Stripe price/product ids and provider settings come from config.
//   main    GBP 20/month  existing Claude configuration (unchanged)
//   sol     GBP 30/month  OpenAI gpt-6.1-sol, reasoning low, NON-sharing project
//   shared  GBP 10/month  same model/effort, a DIFFERENT sharing-enabled project, needs the user's explicit current openai_training grant
// Routing is chosen from the entitlement's verified price_id, never from the browser. Unknown, conflicting or incomplete state is unavailable;
// there is no fallback to another plan, provider, key, project or model. See docs/billing.md.
const { ApiError, e } = require('./errors');

const PLAN_IDS = Object.freeze(['main', 'sol', 'shared']);
const PLANS = Object.freeze({
  main: Object.freeze({ id: 'main', label: 'Main', amount: 2000, currency: 'gbp', interval: 'month', sharing: false }),
  sol: Object.freeze({ id: 'sol', label: 'Sol', amount: 3000, currency: 'gbp', interval: 'month', sharing: false }),
  shared: Object.freeze({ id: 'shared', label: 'Shared Info', amount: 1000, currency: 'gbp', interval: 'month', sharing: true })
});
const SHARING_PURPOSE = 'openai_training';
// Every category the outbound bundle of a Shared Info turn can contain. The operator must attest each as eligible (config.openai.shared);
// prior-session messages are never part of a Shared Info bundle (see lib/coaching.js), so they are not a category.
const SHARING_CATEGORIES = Object.freeze(['message', 'session_history', 'profile', 'knowledge', 'health']);

function createPlans({ config, providers = {}, store }) {
  const cfg = (config && config.billing) || {};
  const openai = (config && config.openai) || {};
  const tiers = !!cfg.plans; // absent = the legacy single-price contract
  const malformed = tiers && cfg.plans.malformed === true;
  const items = tiers && !malformed ? cfg.plans.items : {};
  const byPrice = new Map();
  for (const id of PLAN_IDS) if (items[id]) byPrice.set(items[id].id, id);

  const planUnavailable = () => e.unavailable('plan_unavailable', 'Your plan is not available right now. Please try again shortly.');
  // null when the plan can be sold / routed, else a short internal reason (never shown with detail)
  function staticReason(plan) {
    if (!tiers || malformed || !items[plan]) return 'not_configured';
    if (plan === 'main') return providers.main ? null : 'provider_missing';
    if (plan === 'sol') return providers.sol && openai.sol ? null : 'provider_missing';
    return providers.shared && openai.shared && openai.shared.eligible === true ? null : 'provider_missing';
  }

  async function sharingGrant(userId) {
    const purposes = await store.consentState(userId);
    const p = Array.isArray(purposes) ? purposes.find(x => x && x.purpose === SHARING_PURPOSE) : null;
    if (!p) return { ok: false, reason: 'sharing_unavailable' };
    if (p.legal_approved !== true) return { ok: false, reason: 'sharing_notice_unapproved' };
    if (p.granted !== true) return { ok: false, reason: 'sharing_consent_required' };
    return { ok: true, version: p.version, since: p.last_decision_at };
  }
  const sharingError = reason => (reason === 'sharing_consent_required'
    ? new ApiError(403, 'sharing_consent_required', 'Shared Info needs your explicit permission. Turn on the sharing choice in your account settings first.')
    : e.unavailable('shared_unavailable', 'Shared Info is not available yet.'));
  // One readiness check for both boundaries (purchase/start of work, and immediately before the external send).
  async function requireSharing(userId) {
    const g = await sharingGrant(userId);
    if (!g.ok) throw sharingError(g.reason);
    return g;
  }

  return {
    tiers, malformed, planIds: PLAN_IDS, plans: PLANS,

    // Verified entitlement -> { plan, provider, sharing, legacy }. Legacy single-price configuration always means the existing provider.
    resolve(state) {
      if (!tiers) return { plan: 'main', legacy: true, sharing: false, provider: providers.main || null };
      if (malformed || !state || state.entitled !== true) throw planUnavailable();
      const plan = byPrice.get(state.price_id);
      if (!plan || staticReason(plan)) throw planUnavailable();
      return { plan, legacy: false, sharing: PLANS[plan].sharing, provider: providers[plan] };
    },

    staticReason,
    requireSharing,

    // Before Checkout for `plan`: configured, provider-ready and (Shared Info) approved notice + the user's persisted grant.
    async requirePurchasable(plan, userId) {
      if (!PLAN_IDS.includes(plan)) throw new ApiError(400, 'invalid_plan', 'Choose one of the available plans.', { fields: ['plan'] });
      if (staticReason(plan)) throw e.unavailable('plan_unavailable', `${PLANS[plan].label} is not available yet.`);
      if (PLANS[plan].sharing) await requireSharing(userId);
    },

    // Safe, server-owned view for the account selector. Never contains ids, keys or projects.
    async describe(userId) {
      if (!tiers || malformed) return [];
      const out = [];
      for (const id of PLAN_IDS) {
        const p = PLANS[id];
        let reason = staticReason(id) ? 'not_available' : null;
        let granted = null;
        if (!reason && p.sharing) {
          try {
            const g = await sharingGrant(userId);
            granted = g.ok;
            if (!g.ok && g.reason !== 'sharing_consent_required') reason = 'not_available'; // notice not approved / purpose absent: cannot be offered
          } catch (_) { reason = 'not_available'; }
        }
        out.push({ id, label: p.label, amount: p.amount, currency: p.currency, interval: p.interval, requires_sharing_consent: p.sharing, ...(granted === null ? {} : { sharing_granted: granted }), ready: !reason, reason });
      }
      return out;
    },
    priceFor: plan => (items[plan] ? items[plan].id : null)
  };
}

module.exports = { createPlans, PLANS, PLAN_IDS, SHARING_PURPOSE, SHARING_CATEGORIES };
