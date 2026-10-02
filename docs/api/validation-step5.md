# Step 5 and frontend validation

Validated locally on 2026-10-02 with Node.js 24.19.0 and PostgreSQL 17.11. The lifecycle integration suite used a newly created, disposable `bedlink_step2_step5_final` database with the five versioned migrations, guarded plain-PostgreSQL Auth test adapter and demo seed. It did not connect to a hosted Supabase project. SQL integration tests use real PostgreSQL, transactions, roles and independent pool connections; Supabase token verification and travel estimates are explicitly stubbed in these tests.

## Checks run

- `pnpm test`: **23 passed**. Includes existing Step 3/4 suites, workflow input/role projection tests, retry-key and client-path checks, worker behavior and an HTTP static frontend/API-client smoke test.
- `pnpm test:db`: **27 passed** across the prior availability/matching integration and new lifecycle suite on real local PostgreSQL. Covers create/send/inbox/accept/arrival, rejection and fallback exhaustion, authorization and grants, last-bed races, simultaneous idempotency retries, exact deadline/expiry equality, request/hold cancellation, timeout recovery and concurrent worker ticks, nurse update races, restricted database login, provider failure and transaction rollback on idempotency persistence failure.
- `pnpm test:contract`: **82 existing JSON payloads across 50 exchanges** validated, plus health response schema. The fixture set remains unchanged.
- `python scripts/check_contract.py`: OpenAPI 3.1 valid; **14 operations, 43 schemas, 50 exchanges, 82 payloads, 21 negative cases and 4,099 semantic/structural assertions**.
- Migration/seed SQL on the same fresh disposable database: **79 SQL PASS assertions**; seed-preservation checks pass.
- `node --check web/app.js`: frontend module syntax passes.

## Boundaries of the evidence

The HTTP/Auth tests use injected authentication; no actual Supabase Auth server was exercised. Lifecycle races and database permissions ran against real local PostgreSQL, not Supabase's managed PostgREST pooler or production load. UI smoke tests verify unauthenticated static delivery and served assets. The home screen was visually reviewed at a narrow viewport; authenticated dispatcher/nurse screens were not browser-tested end to end. There is no live map, address geocoder, push notification delivery or hosted deployment. A production environment still needs local/hosted configuration and the restricted backend login roles described in [frontend setup](../frontend.md) and the [lifecycle guide](lifecycle.md).
