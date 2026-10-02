# Step 3 validation record

Validated on 2026-10-02 with Node.js 24.19.0, pnpm 11.19.0 and a disposable, loopback-only PostgreSQL 17.11 cluster. The final database was newly created; no hosted database was accessed or altered.

| Check | Result |
|---|---|
| All three migrations and seed applied to a fresh database | Passed |
| Existing Step 2 constraints, RLS, projections and seed preservation | 79 assertions passed |
| Node HTTP/client/database suites | 15 tests passed (including the database suite container), no skips |
| Database transaction/authorization subtests | 9 passed using actual PostgreSQL connections and roles |
| Existing OpenAPI fixtures | 82 payloads across 50 exchanges passed |
| OpenAPI 3.1 validation and semantic checker | 14 operations, 43 schemas, 21 negative cases, 4098 structural/semantic assertions passed |
| Dependency audit after updating dependencies | No known vulnerabilities reported |

Database tests cover broad authorized catalog reads with scoped direct-table RLS, zero-availability pools, own-hospital writes, other-hospital/dispatcher/inactive denials, authorization rechecks before replay, actor/issuer key scope, malformed/over-capacity input, explicit verification, stale versions, two competing writers, simultaneous retries, exact cached responses, retention expiry, freshness boundaries, active-versus-expired holds, and rollback when writing the idempotency record fails **after** the inventory UPDATE. HTTP integration checks the actual persisted response against OpenAPI and confirms a database exception becomes a non-sensitive 503.

HTTP/client tests cover missing/invalid/expired Auth responses, bearer forwarding to the database, Supabase outages and malformed responses, JSON/body limits, unknown inputs, CORS, safe logs/request IDs, privileged-key configuration rejection, explicit retry key preservation, structured conflicts, cancellation and uncertain network outcomes. The API, migration and client are separated into `src/`, `supabase/migrations/`, and `client/`; tests are in `test/`. Run commands and test-database setup are in [availability.md](availability.md).

The original Step 1 checker was first run unchanged: all 4096 assertions passed. Its repository version adds the intentional public health exception and validates the updated 1.1.0 contract. Original scenario payloads and the first two database migrations remain unchanged.

## Limits of the evidence

The local PostgreSQL tests use the existing **test-only** Supabase Auth schema/claim adapter. HTTP authentication tests stub Supabase Auth responses, including expired-token rejection. No real Supabase Auth/PostgREST instance or actual JWT signature/expiration flow was available in this environment. Those end-to-end checks remain necessary against local Supabase before deployment; mocked auth tests do not establish that integration.

No UI, matching/ranking, patient-request workflow, reservation transition, expiry worker, timeout worker or deployment was implemented. Availability reads filter unexpired holds but do not settle lifecycle rows. Future inventory writers must use the same pool lock and version discipline. Old replay results intentionally retain their original timestamps. No remote database migration was applied.
