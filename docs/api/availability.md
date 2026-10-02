# Step 3: availability API and frontend integration

Implemented routes (base URL includes `/api/v1`):

| Method/path | Access | Result |
|---|---|---|
| `GET /health` | Public | Process liveness only |
| `GET /hospitals` | Active nurse or dispatcher | Entire hospital/pool catalog |
| `GET /hospitals/{hospitalId}/bed-pools` | Active nurse or dispatcher | Hospital summary and every pool |
| `PATCH /hospitals/{hospitalId}/bed-pools/{bedPoolId}` | Active nurse assigned to that hospital | Saved pool, or structured error |

PATCH uses the existing `operation: "update"` or `"verify"` field. Both require `reportedFreeBeds`, the current `version`, and an `Idempotency-Key`. No separate verification endpoint exists. Other Step 1 workflow routes are not implemented.

## Run locally

Use Node.js 24 and pnpm. From the repository root:

```sh
pnpm install --frozen-lockfile
cp .env.example .env
# Edit .env using your LOCAL Supabase project settings.
pnpm start
```

On PowerShell, use `Copy-Item .env.example .env`. The API defaults to `http://127.0.0.1:3000/api/v1`. `.env`, `.env.test`, tokens and passwords are ignored by Git.

Apply the three ordered files under `supabase/migrations/` to a **new local Supabase database** using the [database setup guide](../database/setup.md), then apply `supabase/seed.sql`. For an existing local Step 2 database, apply only `20261002000300_availability_api.sql`; do not rerun the first two migrations. Use local Studio's SQL editor or psql. If using the Supabase CLI, configure a local project before starting it; this repository does not include a CLI `config.toml`. Do not point these commands at a hosted database. Reload local PostgREST's schema cache if RPCs are not yet visible (`NOTIFY pgrst, 'reload schema';` in local SQL).

| Variable | Purpose/default |
|---|---|
| `SUPABASE_URL` | Required Supabase origin; HTTPS, or HTTP on loopback for local development |
| `SUPABASE_PUBLISHABLE_KEY` | Required publishable or legacy **anon** key; secret/service-role keys are rejected |
| `CORS_ORIGINS` | Comma-separated exact frontend origins; empty permits requests without an Origin header only |
| `HOST`, `PORT` | `127.0.0.1`, `3000` |
| `JSON_LIMIT_BYTES` | 16384; accepted configuration range 1024–1048576 |
| `UPSTREAM_TIMEOUT_MS` | 10000; accepted range 100–60000 |

CORS supports bearer headers, JSON, `Idempotency-Key` and OPTIONS. It exposes request IDs and idempotency headers. It does not use browser cookies. All responses have `Cache-Control: no-store`. Health reports no database status or configuration; it is not a readiness check.

## Local users and trusted memberships

Create fictional test users through **local Supabase Auth**, for example through the local Studio Authentication page or your existing local sign-up flow. Obtain their UUIDs there. Do not insert real users or medical information into test fixtures. In local Studio SQL, as the database administrator, replace the placeholders below:

```sql
insert into public.staff_memberships(user_id, role, hospital_id)
values ('<NURSE_AUTH_USER_UUID>', 'nurse', '10000000-0000-4000-8000-000000000001');
insert into public.staff_memberships(user_id, role, hospital_id)
values ('<DISPATCHER_AUTH_USER_UUID>', 'dispatcher', null);
```

Create a second nurse assigned to another seeded hospital to exercise authorization. Disabling `is_active` revokes access, including access to a previously cached mutation response. Membership writes are administrative operations; neither browser metadata nor request bodies can assign roles.

Sign in with the local Auth password endpoint to obtain an access token (examples use shell variables to avoid committing credentials):

```sh
curl "$SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'Content-Type: application/json' \
  --data '{"email":"nurse@example.test","password":"YOUR_LOCAL_TEST_PASSWORD"}'
```

Set `ACCESS_TOKEN` to that response's `access_token` in your local shell. Never paste it into repository files or logs.

```sh
curl http://127.0.0.1:3000/api/v1/health
curl http://127.0.0.1:3000/api/v1/hospitals -H "Authorization: Bearer $ACCESS_TOKEN"
curl http://127.0.0.1:3000/api/v1/hospitals/10000000-0000-4000-8000-000000000001/bed-pools \
  -H "Authorization: Bearer $ACCESS_TOKEN"
# Use the version returned by the preceding read, not a hardcoded production version.
curl -X PATCH http://127.0.0.1:3000/api/v1/hospitals/10000000-0000-4000-8000-000000000001/bed-pools/20000000-0000-4000-8000-000000000001 \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: local-count-change-001' \
  --data '{"operation":"update","reportedFreeBeds":2,"version":1}'
```

A successful mutation returns the existing `BedPoolResponse` schema, for example (illustrative timestamps):

```json
{
  "serverTime": "2026-10-02T10:00:00.000Z",
  "bedPool": {
    "id": "20000000-0000-4000-8000-000000000001",
    "hospitalId": "10000000-0000-4000-8000-000000000001",
    "label": "ICU with ventilator",
    "resources": ["icu", "ventilator"],
    "specialties": [],
    "capacity": 10,
    "reportedFreeBeds": 2,
    "activeHoldCount": 0,
    "availableBeds": 2,
    "loadRatio": 0.8,
    "verifiedAt": "2026-10-02T10:00:00.000Z",
    "dataAgeMinutes": 0,
    "freshness": "fresh",
    "freshnessPolicy": {"policyVersion":"demo-1","agingAfterMinutes":10,"staleAfterMinutes":30},
    "inventoryUpdatedAt": "2026-10-02T10:00:00.000Z",
    "version": 2
  }
}
```

The database's actual labels, capabilities and capacities are authoritative. The response includes `Idempotency-Replayed: false`, `Idempotency-Expires-At` and `X-Request-Id`. A stale version returns HTTP 409:

```json
{"serverTime":"2026-10-02T10:00:01.000Z","error":{"code":"VERSION_CONFLICT","message":"Pool changed; refetch before retrying."}}
```

## Authorization and transactions

The backend calls Supabase Auth `GET /auth/v1/user` with the bearer token. It then forwards **that same token**, with the publishable key, to PostgREST RPC. Supabase validates identity; SQL derives the subject from `auth.uid()` and issuer from verified request claims. No caller-supplied role, actor ID, hospital claim or decoded unverified JWT authorizes access. The one decode in configuration only rejects a legacy service-role key.

Step 2 intentionally restricted direct nurse table reads to their hospital, whereas Step 1 REST allows staff to read the complete catalog. `bedlink_read_availability` resolves that documented difference with an owner-executed, authenticated-only catalog projection. It checks active membership and exposes only hospital/pool information. Direct table RLS remains unchanged. Patient data is not joined into the catalog.

`bedlink_update_availability` checks and locks the trusted membership, takes a nonblocking advisory transaction lock for issuer/actor/key, then locks the pool row. It validates the current version and count, writes the count/version/database verification time, and stores the exact completed response in **one transaction**. The API only acknowledges after PostgREST completes that transaction. Direct client INSERT/UPDATE/DELETE grants remain absent; the private serialization helpers and idempotency table are inaccessible to authenticated callers. Every privileged function has an empty search path and schema-qualified table references.

Counts use `F = reportedFreeBeds` (includes physically unoccupied held beds), `H = active unexpired holds`, `A = F - H`. Pending attempts consume zero. `F > capacity` is 400; `F < H` is 409 `FREE_COUNT_BELOW_HOLDS`. Unknown/out-of-scope pools return 404; an active dispatcher attempting a mutation returns 403. Malformed JSON, unknown fields, negative/fractional counts and unsafe numeric versions are 400. IDs remain opaque to clients; UUID storage IDs are an internal detail.

Every future hold/inventory writer must acquire the **same pool row lock** before changing holds or counts, and advance the pool version as defined in Step 1. Administrative SQL must preserve those invariants. This step does not implement hold creation, arrival, release, expiry settlement or timeout workers. Reads filter expired holds without rewriting their lifecycle status. Inconsistent stored inventory fails closed with 503 rather than returning a negative availability.

## Retries, freshness and the frontend helper

Import `createBedLinkApi` from `client/bedlink-api.mjs` with `{ baseUrl: 'http://127.0.0.1:3000/api/v1', getAccessToken: async () => accessToken }`. Methods are `listHospitals`, `listBedPools`, `updateCount`, and `verifyCount`. Each accepts an AbortSignal; saves require an explicit `idempotencyKey`. Success returns `{data, meta}`; `BedLinkApiError` provides `status`, `code`, `message`, `details` and `requestId`. Client transport errors use `NETWORK_ERROR`; malformed responses use `INVALID_RESPONSE`. There are **no automatic retries**. See [the executable usage example](../../examples/availability-client.mjs).

- Build an immutable intent containing operation, count, displayed version and a new key. Keep it pending until a successful server response. A failed, offline or cancelled save must never be presented as synchronized. Cancellation may occur after the server commits, so its outcome can be unknown.
- Retry an uncertain save with exactly the same actor, path, operation, body and key within its retention window. Do not generate a new key for a network retry. Matching completed results (including business 409s) replay for 24 hours without another write or freshness refresh. A different payload/path with that key returns 409 `IDEMPOTENCY_KEY_REUSED`.
- While the first transaction is uncommitted, a competing key receives 409 `IDEMPOTENCY_IN_PROGRESS` and `Retry-After: 1`. Its fingerprint is not yet visible; even a different competing payload may provisionally receive this code. After completion, different payloads receive `IDEMPOTENCY_KEY_REUSED`. Wait before an explicit identical retry.
- A replay's body, `serverTime`, version and verification time are the **original result**. `Date` is current; `Idempotency-Replayed` is true. Refetch current availability after replay. Never label old replayed availability as newly verified.
- On `VERSION_CONFLICT`, refetch and let the nurse review the current count/holds. A newly chosen intent uses the new version and a **new key**. The old conflicting result will continue to replay. `verify` must send the saved count unchanged; differing counts return `VERIFICATION_COUNT_CHANGED`.
- Retention expiry permits key reuse, but do not replay an old uncertain action after 24 hours: refetch and reconcile first. Invalid input, auth failures, not-found, transient failures and key/in-progress conflicts are not cached. Saved successes and business conflicts are cached.
- `verifiedAt` changes only after an explicit successful update/verify. Both advance the version even if the count stays the same. Reads never do either. Freshness uses database time and returned thresholds: fresh below 10 minutes, aging from 10 to below 30, stale at 30+, unverified when null. This implementation uses the documented `demo-1` policy; a policy change requires a reviewed migration, not a frontend constant.

The logs contain only request ID, method, route template, status and duration. They omit query strings, IDs from URLs, tokens, bodies and upstream error details. Correlate a failed save with `X-Request-Id`. Upstream failures return a generic 503; unexpected application failures return a generic 500. Aborting a request cannot undo a committed database transaction.

## Contract adjustments

`openapi.yaml` is now contract version **1.1.0**, still OpenAPI 3.1. The three availability paths and their existing request/response schemas are unchanged. The requested public liveness route adds `/health` and `HealthResponse`; PATCH now documents 413 with the existing `INVALID_INPUT` code. Implemented responses also include `X-Request-Id` (no payload field added). The in-flight fingerprint visibility rule above clarifies concurrent retries. Original fixtures and planned workflow schemas are preserved.

Implementation references: [Supabase user verification](https://supabase.com/docs/reference/javascript/auth-getuser), [database function security](https://supabase.com/docs/guides/database/functions), [PostgreSQL advisory locks](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS), and [Express API](https://expressjs.com/en/5x/api.html).

## Tests

```sh
pnpm test
pnpm test:contract
python -m pip install -r requirements-checks.txt
python scripts/check_contract.py
```

The Python checker includes OpenAPI validation plus the original 82 fixtures, 21 negative schema cases and cross-resource fixture invariants. Runtime tests additionally validate actual availability/error responses against those schemas.

For real transaction/RLS tests, use a disposable **local** PostgreSQL cluster as an administrator, with a new database name beginning `bedlink_step2_` (the prefix is required by the existing Step 2 test adapter). Example commands below assume standard local `PGHOST`, `PGPORT`, `PGUSER` and `PGPASSWORD` configuration; do not place passwords in command history:

```sh
createdb bedlink_step2_step3_checks
psql -X -v ON_ERROR_STOP=1 -d bedlink_step2_step3_checks \
  -c "SET bedlink.test_disposable='yes';" \
  -f supabase/tests/support/plain_postgres_auth.sql \
  -f supabase/migrations/20261002000100_bedlink_schema.sql \
  -f supabase/migrations/20261002000200_bedlink_access.sql \
  -f supabase/migrations/20261002000300_availability_api.sql \
  -f supabase/seed.sql \
  -f supabase/tests/step2_checks.sql \
  -f supabase/tests/seed_preservation.sql
cp .env.test.example .env.test
# Set BEDLINK_TEST_DATABASE_URL to that new local test database in .env.test.
pnpm test:db
```

Use only a **fresh** database for the adapter; it refuses to replace an existing auth schema. Never run it in a Supabase database. Database tests create random fictional fixtures and remove only their own rows. They temporarily install a narrowly targeted failure trigger to prove rollback. They do not reset an existing database or silently skip when configuration is missing. The original Step 2 SQL checks require their seeded fixture baseline; run them before adding unrelated data.

These tests prove PostgreSQL locking, transactional replay, constraints and RLS using a test-only auth schema and role switching. They do **not** prove a live Supabase Auth/PostgREST deployment, real signed/expired JWT behavior, or remote connectivity. Before deployment, smoke-test local Supabase with valid, tampered and expired tokens, an inactive user and nurses from two hospitals. No remote database was changed for Step 3.
