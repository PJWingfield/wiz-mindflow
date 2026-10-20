# Exact notices and terms acceptance (API contract)

Migration: `supabase/migrations/20261019120000_wiz_consent_notices_terms.sql` (rollback: `supabase/rollbacks/20261019120000_wiz_consent_notices_terms.down.sql`).
Scope: exact wording retrieval and separate terms acceptance only. It adds no signup requirement, payment/subscription logic, coaching or
health-consent behaviour, and records no paid-contract formation. Existing consent purposes stay unapproved; nothing is granted or approved.

## Notices (public, read-only; same per-IP limit as the other public routes)

| Route | Result |
|---|---|
| `GET /api/v1/notices` | `{ items: [{ id, kind, sha256, approval }] }` (no wording) |
| `GET /api/v1/notices/:id` | `{ notice: { id, kind, content_type, sha256, bytes, text, approval } }` |

- Ids are the catalogue keys in `lib/notices.js`: `privacy-2026-10-16-v1`, `terms-2026-10-16-v1`. Files live in `notices/` and are preserved byte-for-byte;
  `sha256` is over those bytes (`text` is their UTF-8 decoding, so `sha256(utf8(text))` equals it). Wording changes mean a new id and a new version.
- `approval` = `{ basis: "owner_instruction", instructed_on: "2026-10-19", source_control, independent_legal_approval: false }`. It is not solicitor approval.
- Every read re-verifies the file against the catalogue hash. Missing/mismatched file: `503 notice_unavailable` (no path, no substitute). Unknown id: `404 not_found`. Malformed id: `400 invalid_request`.

## Terms (authenticated existing account; owner = verified bearer token only)

| Route | Result |
|---|---|
| `GET /api/v1/terms` | `{ terms: { current: { version, artifact_id, artifact_sha256, approval_provenance, published_at, notice_path } \| null, accepted, acceptances: [{ version, artifact_id, artifact_sha256, accepted_at }] } }` |
| `POST /api/v1/terms/acceptance` | body `{ "version": "1.0", "artifact_sha256": "<64 hex>", "accepted": true }`; `201` first acceptance, `200` repeat; same body shape as `GET /terms` |

- Show the wording from `notice_path`, then post the `version` and `artifact_sha256` that were shown. `accepted` must be literally `true`.
- Unknown body fields (e.g. `user_id`, `accepted_at`) are `400 invalid_request`. The user is the token's; the time is the database clock.
- `400 unknown_terms_version`; `409 stale_terms_version` (not the current version, or a different hash); `503 terms_unavailable` (no current version);
  `503 notice_unavailable` (runtime artifact does not match the version's recorded hash; nothing is recorded).
- A repeat acceptance of the current version is harmless: no new row, the original `accepted_at` is returned. A newer current version makes `accepted` false again; earlier acceptances stay as history.
- Acceptance is a separate append-only record. There is no revoke/delete route (`405`), and `POST /api/v1/consents` with purpose `terms` is `400 unknown_purpose`.

## Data and lifecycle

- `wiz_terms_versions` (global catalogue; Terms `1.0` -> `terms-2026-10-16-v1` / `8570e1f5...ed60d`) and `wiz_terms_acceptances` (`user_id` FK `on delete cascade`, unique `(user_id, version)`).
  RLS on, no browser-role privileges; `service_role` has select on versions, select+insert on acceptances.
- `wiz_consent_versions` gains nullable `artifact_id`, `artifact_sha256`, `approval_provenance` (existing rows unlinked and untouched). A trigger makes published artifact/hash/provenance write-once; terms
  versions can only be retired; acceptances cannot be updated.
- `GET /api/v1/account/export` adds `terms_acceptances` (the caller's rows). Account erasure removes them through the users cascade and counts them in the existing leftover check; the catalogue is retained.
- Rollback keeps all tables, columns, acceptances and write-once triggers; it drops `wiz_terms_state`/`wiz_terms_accept` and revokes the added service-role privileges. Export/erasure keep working on the retained data.
  If `20261008180000_wiz_privacy_controls` is ever re-run, re-run this migration afterwards (it re-creates the two privacy functions with the acceptance data).
