# Step 5: request lifecycle

All nine lifecycle operations in [OpenAPI](openapi.yaml) are implemented. The public wire schemas and the existing [50 example exchanges](examples/README.md) are unchanged. No UI, hosted API, remote migration or notification delivery service is included.

## Run locally

Use Node 24, `pnpm install --frozen-lockfile`, and the existing [Supabase Auth/API configuration](availability.md). Apply migrations 001–005 in order to a local database; migration 005 adds the workflow functions and expiry-aware availability wrappers. Earlier migrations are unchanged. Keep `bedlink_private` outside the exposed PostgREST schemas. Apply migrations using the same trusted migration administrator as Steps 2–4.

The workflow uses a backend PostgreSQL connection so state changes and the exact ranked response can commit together. Availability and standalone matching retain the authenticated PostgREST path. Provision **separate restricted login users**, using an administrator and interactive password prompts; do not use `postgres`, `service_role`, or a browser token as a database password:

```sql
CREATE ROLE bedlink_api_login LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE bedlink_worker_login LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT bedlink_api TO bedlink_api_login;
GRANT bedlink_worker TO bedlink_worker_login;
```

In `psql`, use `\password bedlink_api_login` and `\password bedlink_worker_login`. Configure the two backend-only connection URLs in `.env`, using a direct or session-pooler connection and TLS appropriate to the environment. Do not commit credentials. Migration 005 creates the corresponding NOLOGIN roles. They have entry-function execution privileges, not table write privileges. The API login must not also be a worker or administrative role.

```text
WORKFLOW_DATABASE_URL=postgresql://bedlink_api_login:LOCAL_PASSWORD@127.0.0.1:54322/postgres
WORKER_DATABASE_URL=postgresql://bedlink_worker_login:LOCAL_PASSWORD@127.0.0.1:54322/postgres
WORKER_POLL_MS=2000
WORKER_BATCH_SIZE=100
```

Start `pnpm start` and `pnpm worker` as separate processes. Both read `.env`. The worker runs independently of browsers. Runtime connections refuse superuser/BYPASSRLS login roles; the test bypass exists only as an explicit adapter constructor option. Missing workflow configuration returns safe 503 errors while the existing availability endpoints can still run. Health remains process liveness, not readiness.

Supabase `/auth/v1/user` verification runs before any workflow call. Only then does the backend project the verified token subject/issuer into transaction-local claims, using a fixed database role. SQL rechecks active membership, request ownership and hospital assignment, including before replaying a saved response. Browser `anon`/`authenticated` and `service_role` cannot execute the new backend workflow/worker entry points. The worker cannot call request operations. Returned inbox items contain only the contracted anonymous reference and needs, never another hospital's attempts or dispatcher ownership details.

## States, deadlines and inventory

| Action | Request | Attempt | Hold | Physical free count F / active unexpired holds H |
| --- | --- | --- | --- | --- |
| Create | searching | none | none | unchanged |
| Confirm hospital/pool | pending | pending | none | unchanged |
| Accept before deadline | held | accepted | active | F unchanged; H + 1 |
| Reject / response timeout | searching | rejected / timedOut | none | unchanged |
| Arrival before expiry | arrived | accepted | arrived | F − 1; H − 1 |
| Release hold | searching | accepted | cancelled | F unchanged; H − 1 |
| Hold expires | searching | accepted | expired | F unchanged; H − 1 |
| Cancel request | cancelled | pending attempt cancelled, history retained | active hold cancelled | F unchanged; release H once |

Offerable capacity is `A = F − H`. Physically free held beds remain in nurse-reported F. Pool version advances exactly once per hold creation/end; lifecycle operations change `inventoryUpdatedAt`, never `verifiedAt`. Arrival reduces F once; cancellation and expiry do not increase it. Completed arrival/cancelled requests are terminal.

Database time creates the **120-second** attempt deadline and **900-second** hold expiry. The latter implements the demo's 15-minute policy separately from the response timer. These durations and the 10/30-minute freshness thresholds currently live in the database migration and matching policy metadata; changing them requires a coordinated migration and metadata/version change, not an undocumented environment override. Acceptance rechecks all requirements in one pool, freshness below 30 minutes, and A ≥ 1. Sending an offer also revalidates pool ownership, requirements, freshness and capacity.

At `serverNow >= responseDeadlineAt`, timeout wins; `resolvedAt` equals the deadline even when processed later. At `serverNow >= expiresAt`, expiry wins and `endedAt` equals expiry. Mutations enforce deadlines themselves. Request/inbox/catalog reads reconcile already-due transitions, including after worker downtime, and never verify nurse census data.

## Atomicity and retries

Migration 005 coordinates availability edits, lifecycle decisions and worker batches through one transaction-scoped advisory lock for this small-catalog prototype, then locks request/pool rows in consistent order. Actor/key locks are nonblocking and acquired before that lock. Existing uniqueness constraints prohibit multiple pending attempts or active holds per request. Acceptance, last-bed checks, hold creation, versions, state transitions and the completed replay record commit in one transaction. Nurse count updates participate in the same ordering and retain optimistic version checks.

The API first reads authorized context, closes that transaction, and obtains bounded travel estimates. Its final transaction rechecks authorization/state and uses Step 4's ranker with only cached estimates. There is no external provider call while database locks are held. Newly eligible/changed coordinates without a cached estimate fail with 503 and roll back the mutation. An unavailable estimate for an eligible fallback similarly rolls back; an unavailable estimate for an excluded/ineligible hospital is not needed. A prior context read may already have materialized genuinely overdue transitions.

Every lifecycle POST requires a stable `Idempotency-Key`. The namespace is verified issuer + actor + key, shared with nurse availability mutations. Fingerprints include method, canonical route and normalized JSON. Exact replays return original status/body/Location and original timestamps, with `Idempotency-Replayed: true`. Retention is 24 hours after completion. Reuse for another operation/body returns `IDEMPOTENCY_KEY_REUSED`; a simultaneous unfinished operation returns `IDEMPOTENCY_IN_PROGRESS` and `Retry-After: 1`. State conflicts (409) are also saved. Validation/auth failures are not saved. Database/provider failures roll back; a deferred constraint rejects a transaction that leaves an incomplete replay record.

After an uncertain network outcome, retry the same intent and key; do not generate a new key. Refetch after replay because it describes the original result, not current inventory. After an actionable 409, refetch and use a new key only for a newly chosen intent. Keys older than the retention window may be treated as new requests. Do not log patient fields, access tokens, connection URLs or raw database/provider errors.

## Fallback and client integration

Searching request responses contain `nextBest`, using the existing `matchesFound`, `noEligibleHospitals`, `capacityUnavailable` and `availabilityOutdated` outcomes. Rejection returns fallback immediately; after timeout or expiry it appears when dispatch fetches request status. Every previously attempted hospital is excluded, regardless of attempt status. Offers do not create attempts or holds. Dispatch explicitly confirms the selected hospital/pool through `createAttempt`; a stale offer can fail revalidation. Ranking remains Step 4's deterministic 50/30/20 prototype with simulated, non-traffic-aware, non-road-routing ETA. See [ranking assumptions](matching.md).

The framework-independent [client](../../client/bedlink-api.mjs) exposes:

| Method | Purpose |
| --- | --- |
| `createPatientRequest(body, options)` | Anonymous reference and needs; initial options |
| `getPatientRequest(requestId, options)` | Owner status/history/current fallback |
| `createAttempt(requestId, {hospitalId, bedPoolId}, options)` | Explicit dispatch confirmation |
| `getHospitalInbox(hospitalId, options)` | Assigned hospital pending attempts and active holds |
| `acceptAttempt(hospitalId, attemptId, options)` | Atomic acceptance and hold |
| `rejectAttempt(hospitalId, attemptId, reasonCode, options)` | Rejection and next options |
| `recordArrival(requestId, holdId, options)` | Owner or assigned nurse records arrival |
| `cancelPatientRequest(requestId, reasonCode, options)` | Owner cancels request and pending/held work |
| `cancelActiveHold(requestId, holdId, reasonCode, options)` | Owner releases hold and resumes searching |

POST options require `{idempotencyKey, signal?}`; reads accept `{signal?}`. Helpers return `{data, meta}` and never auto-retry or auto-send fallback. See [lifecycle example](lifecycle-example.md).

Display countdowns from absolute `responseDeadlineAt` / `expiresAt` against the response's `serverTime`, allowing for network delay. UI countdowns do not authorize decisions. Handle `ATTEMPT_DEADLINE_PASSED`, `ATTEMPT_NOT_PENDING`, `HOLD_EXPIRED`, `HOLD_NOT_ACTIVE`, `REQUEST_NOT_SEARCHING`, `REQUEST_TERMINAL`, `HOSPITAL_ALREADY_ATTEMPTED`, capability/capacity/freshness conflicts by refetching. Preserve unknown-outcome keys on network failure. Error responses do not include unauthorized diagnostics.

## Worker polling and limits

The worker scans persisted due deadlines, processes up to `WORKER_BATCH_SIZE` requests in one transaction, and sleeps `WORKER_POLL_MS` after each iteration. Concurrent workers try the same advisory lock; a busy worker skips that batch. Completed transitions are idempotent, so crashes before commit roll back and restart catches up. SIGINT/SIGTERM stops new batches, interrupts polling sleep and waits for the current transaction to finish; database statements have a 10-second timeout. Failures log only a fixed event; successful work logs a count.

With no backlog or lock contention, polling adds **at most one worker interval (default 2 seconds), plus batch/query execution time** before durable settlement. A visible UI polling every 2 seconds can add another 2 seconds, plus request/network time. There is no hard overall maximum during an outage, lock contention or backlog; batches each add execution plus polling delay. Request/inbox reads themselves catch up overdue records. No push, email, SMS or automatic hospital notification transport is implemented; hospital receipt is its inbox. Use backoff on failed UI reads and refetch on resume.

The global advisory lock and full-catalog fallback are deliberate prototype scalability limits. Administrative table writes can bypass these rules; production tools must preserve the same invariants and locking. Dedicated-role provisioning, full Supabase Auth/PostgREST integration, hosted operations, monitoring, retention cleanup and load testing remain environment-level work. [Validation](validation-step5.md) distinguishes real PostgreSQL races from mocked Auth/travel tests.
