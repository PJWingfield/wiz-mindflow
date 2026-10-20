# Terms + health-consent flow (contract)

Migration: `supabase/migrations/20261020120000_wiz_health_consent_flow.sql` (rollback: `supabase/rollbacks/20261020120000_wiz_health_consent_flow.down.sql`).
Needs the foundation, career, privacy and `20261019120000_wiz_consent_notices_terms` migrations first.
**Enforcement is ON by default.** Only an explicit `WIZ_CONSENT_FLOW=off` disables it (legacy test fixtures opt out in `test/helpers/api.js` and
`career-api.js`; nothing else should). If the two migrations are not applied the enforced routes fail closed (500), never open — apply both before starting the app.
Billing/entitlement is a separate later gate; accepting the Terms here does not claim a paid contract has formed.

## What the server enforces (flow on)

Before a message is appended, retrieved for or sent: `POST /sessions/:id/chat`, `POST /sessions/:id/start` and legacy `POST /api/chat` all require, after the adult check,
the **current Terms accepted** and an **answered health choice for the current notice version**. Otherwise nothing is stored or sent:

| Code | Status | Meaning |
|---|---|---|
| `terms_required` | 403 | current Terms not accepted (`POST /terms/acceptance`) |
| `health_choice_required` | 403 | no decision for the current `health_processing` version (a changed notice does not inherit an older grant) |
| `terms_unavailable`, `health_choice_unavailable` | 503 | no current Terms / no approved current health notice (fails closed) |
| `consent_changed` | 409 | choices changed while the request was being prepared; **nothing was sent**, send it again |

`save_chats` (message retention) and `personalisation` / `career_records` remain separate gates exactly as before; none is granted automatically.

- **Allowed** (`health_processing` grant): normal coaching, with the existing personalisation gates.
- **Declined or withdrawn** (a current-version `revoke`): general coaching only. No onboarding answers, profile evidence, career data or other-session
  history is loaded, history from before the fence is not sent, and the model brief says WIZ cannot coach on health-related matters. Nothing classifies the text a
  person types, so this does not stop sensitive input; the UI says so.
- Last check immediately before the provider call: a withdrawal / version change / fence move during retrieval refuses the unsent request. A call already submitted
  cannot be recalled.

## Decisions and the fence

Decisions use the existing `POST /api/v1/consents` with `purpose: "health_processing"` and the current `version` (`grant` or `revoke`; an initial decline is a `revoke`).
Published under the 2026-10-19 owner instruction, linked to the Privacy Notice artifact: `save_chats` 2, `personalisation` 2, `career_records` 2, `health_processing` 1.
The old unapproved v1 placeholders are retired, not rewritten.

Every recorded `health_processing` revoke sets `wiz_user_profiles.context_fence_at` (only ever forward; a later grant does not clear it). Excluded from future model use:
whole sessions begun at or before the fence (messages, checkpoint, summaries), messages at or before it in any session, onboarding answers (one merged document),
evidence, career plan, portfolio entries and pulses created before it, and each learning-profile field as it stood at the fence (`learning_fence_hashes`: an md5 per
top-level field, no profile text). Re-saving, or editing one field, offers only the fields whose value now differs; unchanged ones stay out, a missing fingerprint offers
nothing, `self_recognition` is never offered, and a second withdrawal re-fences everything then present. The owner can still view and export the whole profile. Newer material is ordinary context again; to reuse a fenced career plan,
delete and recreate it (editing one in place keeps it fenced). Chats stay readable, exportable and deletable.

**Replies to requests that were already in flight.** Each reply stores `provenance.request_fence` (the fence its request was assembled under, `none` if there was none).
A reply that arrives after a withdrawal gets a new `created_at`, so time alone cannot catch it: history assembly also drops any assistant reply whose `request_fence` is earlier
than the current fence. The reply and its exchange stay stored, readable and exportable, and an identical retry still returns the completed reply (no new provider call).

## First use and chat retention

`GET /readiness` also returns `retention: { version, summary, granted }` (`save_chats`, the approved current version). It is reported, never decided: the append gate still
returns `consent_required` without a grant, and nothing is granted automatically. The sign-in-time dialog shows, each with its own unticked box and button: Terms (if not yet
accepted), the health choice ("Allow" or "Continue without sharing"), and "Saving your conversations" with the approved summary and the plain statement that WIZ cannot chat
without saving (all chats are retained; read, export, delete stay available). It closes only when nothing is left to decide; a `consent_required` reply to a send re-opens it
and the same request is repeated. Personalisation and career records stay optional and are only offered in Account settings.

## Endpoints added

- `GET /api/v1/terms/current` (public): `{ enabled, terms?: { version, artifact_id, artifact_sha256, notice_path } }` for the sign-up form.
- `GET /api/v1/readiness` (auth): `{ enabled, ready, blocker, mode: "health" | "general" | null, terms: { version, accepted }, health: { version, decision, decided_at }, fenced }`.
  `decision` = `unanswered | granted | declined | unavailable`. Flow off: `{ enabled: false, ready: true }`.
- `POST /api/v1/auth/signup` additionally takes `accept_terms: true`, `terms_version`, `terms_sha256` (flow on: required, validated against the current hash-verified Terms
  **before** the Auth account is created). With a session, acceptance is recorded against the Auth user id with the server time, else `503 terms_not_recorded`
  (account exists, no session returned; sign in and accept). With email confirmation there is no verified session, so nothing is recorded: the response has
  `terms_recorded: false` and the person accepts after signing in. Coaching stays blocked until acceptance either way.

## Migration / rollback

Up: adds `context_fence_at`, the `wiz_health_fence` trigger, `wiz_coaching_state`, `wiz_terms_current`, the approved versions, and fence-aware
`wiz_personalisation_context` / `wiz_career_context` / `wiz_evidence_ai_usable`. Down: retires the published versions and makes the retired placeholders current again
(nothing grantable), drops the two read-only functions, and KEEPS every record, the column, the trigger and the fence-aware readers (restoring the old readers would
re-expose withdrawn context). Re-running up re-publishes; earlier decisions apply again.
