# Step 4 validation

Validated locally on 2026-10-02 using Node.js 24.19.0 and PostgreSQL 17.11. The source is saved in the BedLink GitHub repository. No deployment or remote database migration was performed.

## Automated checks

The combined Node run completed **29 tests with zero failures or skips**, including the database suite container.

- **17 HTTP/client/ranking tests:** existing Step 3 HTTP/client checks plus 12 Step 4 tests. These use synthetic catalogs, fixed clocks and injected providers/Auth responses where appropriate.
- **11 real PostgreSQL integration subtests**, plus their suite container: the nine existing transaction/authorization checks and two matching checks. A fresh loopback-only test database received all four migrations and the seed.
- **79 existing SQL assertions:** schema constraints, RLS, projections and repeated-seed preservation passed with the new migration applied.
- **82 contract payloads across 50 exchanges**, 21 negative schema cases and 4099 structural/semantic assertions pass. The specification remains valid OpenAPI 3.1, with 14 operations and 43 schemas.

Matching tests cover combined resources in one pool, specialty mismatch, a nearer incompatible hospital, held capacity, exact aging/stale boundaries, null verification, each ranking component changing order, selecting the best pool, deterministic ties, exclusion of attempted hospitals before counts/provider calls, invalid coordinates/body fields, all four empty states, distance calculation, half-up score rounding, failure/invalid ETA/timeout/cancellation, private diagnostics and client requests without idempotency keys. All four original standalone matching response fixtures are reproduced without changing their payloads.

Real database checks validate that only active dispatchers can fetch the matching snapshot, nurse direct-table access stays scoped, RLS remains enabled, and direct client inventory updates remain forbidden. HTTP searches use actual active/unexpired hold counts, omit fully held pools, and leave census timestamps, versions, request/attempt/hold counts and idempotency records unchanged. A separate connection acquires the checked membership row lock during the injected provider call, proving the catalog transaction has ended before travel is invoked.

## Limits

The real database tests use the guarded, test-only Supabase Auth schema/claim adapter. The HTTP auth tests stub Auth responses. They do not prove real Supabase Auth/PostgREST JWT verification or a deployed end-to-end connection. A local Supabase smoke test with signed, tampered, expired and revoked tokens remains necessary before deployment.

Travel is deterministic simulated distance arithmetic, with no road-routing or traffic service. Snapshot results do not reserve capacity. Reservations, hospital response workflows, timeout processing, patient request flows and UI remain outside this step.
