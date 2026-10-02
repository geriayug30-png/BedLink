# BedLink frontend handoff

This is the Step 1 contract, version 1.0.0. It is framework independent and describes a future REST API; it does not imply a running service. Start with [openapi.yaml](openapi.yaml), use [examples/README.md](examples/README.md) for mock flows, and read [decisions.md](decisions.md) for the business rules. Validation evidence is in [validation.md](validation.md).

## Connect and authenticate

Configure an API origin per environment and append `/api/v1`. No hostname is fixed in this contract. Send `Authorization: Bearer <Supabase Auth access token>` on **every** endpoint. Send `Content-Type: application/json` for bodies, including the empty `{}` used to accept an attempt. JSON uses camelCase. IDs are opaque strings; URL-encode them. All response timestamps are server-assigned UTC ISO 8601 strings ending in `Z`. Display them in the user's local timezone if useful.

Supabase Auth handles sign-in and token refresh outside this REST surface. The backend verifies the access token and looks up trusted business roles and hospital assignments. A Supabase token's generic `authenticated` role is not the BedLink `nurse` or `dispatcher` role. Clients never send an owner ID or assigned hospital ID as proof of permission, and never hold a service-role key. Demo identity labels in examples are not credentials.

Dispatchers own the requests they create. In this demo, only that owner can read request history, send attempts, cancel requests, or release holds. Nurses can update counts, view the inbox and respond only for their server-assigned hospital. Both roles can read the catalog. Arrival can be recorded by the owning dispatcher or a nurse assigned to the active hold's hospital. Wrong role returns 403; unknown or out-of-scope objects return indistinguishable 404 responses. Authentication and current authorization are checked even on idempotent replays.

The backend must allow the UI's configured origin and required headers through CORS. Expose `Date`, `Location`, `Idempotency-Replayed`, `Idempotency-Expires-At`, and `Retry-After`. All responses use `Cache-Control: no-store`. No cookies or direct frontend inventory writes to Supabase are part of this contract.

## Screen-to-endpoint mapping

Every path below is relative to `/api/v1`. Required and optional fields, all status codes, and error shapes are in the OpenAPI document. No endpoint currently accepts query parameters. Catalog and inbox results include all configured demo records; there is no hidden pagination or truncation.

| Screen / action | Method and path | Inputs | Display / use |
| --- | --- | --- | --- |
| Hospital directory | `GET /hospitals` | Bearer token | `hospitals[].id`, `name`, `location`, `bedPools[]`, `serverTime` |
| Nurse availability board / refresh after conflict | `GET /hospitals/{hospitalId}/bed-pools` | Hospital ID | Pool `label`, `resources`, `specialties`, `capacity`, `reportedFreeBeds`, `activeHoldCount`, `availableBeds`, `verifiedAt`, `dataAgeMinutes`, `freshness`, `version` |
| Save count / “Still correct” | `PATCH /hospitals/{hospitalId}/bed-pools/{bedPoolId}` | `operation`, `reportedFreeBeds`, `version`; idempotency key | Replace the whole local pool with `bedPool`; anchor freshness to `serverTime` |
| Patient requirements and results | `POST /matches` | `{needs: {location, resources, specialty?}}` | `result.outcome`, `candidates`, `diagnostics`, `policy`, `serverTime` |
| Create dispatch case | `POST /patient-requests` | `patientReference`, `needs`; key | Store `request.id`, status, `nextBest`; 201 `Location` points to request progress |
| “Request this hospital” / “Send next request” | `POST /patient-requests/{requestId}/attempts` | `hospitalId`, `bedPoolId`; key | Pending attempt ID, `responseDeadlineAt`, request status; 201 |
| Request progress / attempt history | `GET /patient-requests/{requestId}` | Request ID | `request.status`, `attempts[]`, `holds[]`, `activeHold`, `nextBest`, `serverTime` |
| Hospital incoming requests | `GET /hospitals/{hospitalId}/incoming-requests` | Assigned hospital ID | `pendingAttempts[].patient`, `.attempt`; `activeHolds[].patient`, `.hold`; deadlines and requirement badges |
| Accept | `POST /hospitals/{hospitalId}/attempts/{attemptId}/accept` | `{}`; key | `attempt`, `requestStatus`, `hold.expiresAt`, updated `bedPool`; 200 |
| Reject | `POST /hospitals/{hospitalId}/attempts/{attemptId}/reject` | `reasonCode`; key | Rejected attempt and current fallback offer in `nextBest`; 200 |
| Ambulance arrived | `POST /patient-requests/{requestId}/arrivals` | Exact `holdId`; key | `requestStatus: arrived`, terminal `hold`, updated pool; 200 |
| Cancel entire request | `POST /patient-requests/{requestId}/cancellations` | `reasonCode`; key | Cancelled request and updated histories; `nextBest: null`; 200 |
| Release reservation, continue searching | `POST /patient-requests/{requestId}/holds/{holdId}/cancellations` | `reasonCode`; key | Cancelled hold, request searching, next-best options; 200 |

`needs.resources` is a nonempty, duplicate-free array containing any combination of `icu`, `ventilator`, and `oxygen`. `needs.specialty` is independently `cardiac`, `burns`, or `null`; omission means `null`. Latitude is -90 through 90 and longitude -180 through 180. Do not turn specialty into a resource. Use anonymous references such as `ANON_SUCCESS`, never names or other patient identifiers. Requirements are immutable after creation in Step 1.

Every body field is required unless the schema explicitly says otherwise. Only `Needs.specialty` and `Error.details` are optional in the API models. Nullable fields such as `activeHold` remain present with a JSON `null`. The server normalizes an omitted specialty to `null` in stored requests. Unknown input fields and query parameters are 400 errors. Do not add client timestamps, scores, roles, or inventory deltas to commands.

## Matching and empty states

Each result contains at most one candidate per hospital: its best eligible pool. A single pool must satisfy **all** requested resources and the specialty together. Never combine an ICU count from one pool with a ventilator count from another. `bedPool.availableBeds` is the available count for that exact combination. `rank` starts at 1.

Show the hospital, pool label, available count, requirement badges, freshness, and travel estimate. Display the travel label as **“Simulated travel estimate · traffic not considered”** because `travel.source` is `simulatedDistance` and `trafficConsidered` is `false`. `distanceKm` is straight-line distance. This is not a live road ETA. See the exact scoring formula in [decisions.md](decisions.md#ranking-and-load).

| `result.outcome` | Meaning | Suggested screen text |
| --- | --- | --- |
| `matchesFound` | One or more compatible, fresh-enough pools have capacity | “Available options” |
| `noEligibleHospitals` | No configured, unattempted pool has the full capability combination | “No hospitals meet all requirements” |
| `capacityUnavailable` | Compatible pools exist, all are fresh enough, but all are full or held | “No capacity currently available” |
| `availabilityOutdated` | No eligible candidate; at least one compatible pool is stale or unverified | “Availability needs verification” |

All four are HTTP 200. An empty array is never a transport error. If fresh pools are full and another compatible pool is stale, `availabilityOutdated` takes precedence; diagnostics retain both facts. `freshPoolCount` includes `fresh` and `aging`. `compatiblePoolCount` is counted after excluding attempted hospitals. A candidate is only an offer: another ambulance can consume capacity before acceptance.

## Counts and nurse updates

Show three separate numbers: **reported free**, **held**, and **available for new requests**. Instruct nurses: **“Count every physically unoccupied, staffed, usable bed, including beds currently held by BedLink.”** Example: two physically free beds and one active reservation means enter 2, show held 1, available 1. A pending hospital request consumes no capacity.

For Save, send `{"operation":"update","reportedFreeBeds":2,"version":7}`. For an explicit check without changing the count, send `{"operation":"verify","reportedFreeBeds":2,"version":7}`. Both require a deliberate nurse action and refresh `verifiedAt`. Never call verify when opening a screen, polling, rerendering, or replaying a mutation. Verification fails if its count differs from the current value.

Hold creation, release, expiry, and arrival also increment the pool version. On `VERSION_CONFLICT`, refetch and show the latest counts/holds; let the nurse review before submitting with the new version and a **new** key. Never silently replace the version and overwrite the nurse's newer work. A count below the active holds returns `FREE_COUNT_BELOW_HOLDS`; do not clamp it or drop reservations. Resolve the affected reservations through the dispatcher before retrying.

## State, fallback, and countdowns

Keep these three enums separate:

| Resource | States |
| --- | --- |
| Patient request | `searching`, `pending`, `held`, `arrived`, `cancelled` |
| Hospital attempt | `pending`, `accepted`, `rejected`, `timedOut`, `cancelled` |
| Hold | `active`, `arrived`, `cancelled`, `expired` |

Create a request first; this does not notify a hospital. The dispatcher then confirms a hospital/pool and creates an attempt. While pending, use the attempt's `responseDeadlineAt` for the two-minute countdown. The backend rejects an acceptance at or after that instant. An accepted attempt creates an active hold and changes the request to `held`; switch to the hold's separate `expiresAt` countdown. The accepted attempt stays accepted after arrival, cancellation, or hold expiry.

On rejection or timeout the request returns to `searching`. `nextBest.candidates[0]` is the next-best offer, and the array contains alternatives. Every hospital already in `attempts` is excluded, even if it has another pool. The backend computes offers automatically; **sending** the next request requires an explicit dispatcher action through `POST .../attempts`. The nurse reject response contains an offer, and the dispatcher obtains it from the next progress poll. Timeout is surfaced by the progress response without a separate timeout endpoint. Do not auto-submit when a timer reaches zero or when a poll returns a candidate.

`nextBest` is null while pending, held, arrived, or cancelled. While searching, it is a `MatchResult` even when no candidates exist. `activeHold` is null except while held. Histories include terminal entries and are sorted by `createdAt`, then ID. Arrival and full cancellation are terminal for the patient request. Releasing or expiring a hold resumes searching. Never reuse an old active hold ID for a replacement hold.

## Freshness, polling, and refetch

Use each response's `serverTime` as the time anchor. Store when the response arrived using a monotonic client clock. Until the next response, approximate current server time as `serverTime + elapsedMonotonicTime`. Then display age from `verifiedAt`, or advance `dataAgeMinutes` by elapsed minutes. Avoid relying on the device wall clock. This estimate can lag by network latency; deadline decisions remain server-authoritative.

Display fresh for age under 10 minutes, aging for 10 through less than 30, stale at 30 or more, and unverified when `verifiedAt` and `dataAgeMinutes` are null. These are **demo defaults**; use `bedPool.freshnessPolicy` for the effective thresholds on every screen and treat the server's freshness values as authoritative for actions. Matching also returns the same thresholds in `result.policy`. Do not silently invent a last-updated time for unverified data. Inventory activity updates `inventoryUpdatedAt`, which is not a clinical verification time.

Poll request progress every 2 seconds while searching, pending, or held. Poll the nurse inbox every 2 seconds while visible. Refresh visible pool boards every 15 seconds, after nurse mutations, and when an inbox action changes inventory. Stop request polling at arrived/cancelled; pause hidden tabs and refetch immediately on visibility, reconnection, or token refresh. Timer labels may tick locally every second. Reaching zero disables the expired action locally and triggers a refetch; it never performs a state transition itself.

Allow only one in-flight poll per resource. Use a request sequence number or cancellation to discard older responses that arrive late. After a mutation or replay, cancel/disregard older polls and refetch the authoritative resource. On transient errors, back off 2, 4, 8, 16, then up to 30 seconds with jitter; honor `Retry-After`. Show an offline/reconnecting state instead of frozen “live” labels. Refresh authentication once on 401; if unsuccessful return to sign-in. Treat 403/404 as access loss and stop polling that object.

Future real-time notifications must be **refetch signals** containing minimal identifiers. They may be duplicated, delayed, or missed; they must not become authoritative inventory or silently create an attempt. Keep refetch on reconnect and a periodic reconciliation strategy even after notifications are introduced.

## Safe retries and errors

Every mutation requires `Idempotency-Key`, 8–128 characters from letters, digits, `.`, `_`, `:`, `-`. Generate a new UUID-like key for a new user intent and keep it with the exact submitted body until the result is known. `POST /matches` is read-only and does not require a key.

Keys are scoped to the authenticated token issuer and subject across all mutation paths. The server fingerprints the HTTP method, normalized resource path, and canonical JSON body (object key ordering/whitespace ignored; documented defaults applied and resource arrays sorted). Identical retries return the original HTTP status, body, and `Location`; `Idempotency-Replayed: true` identifies a replay. The original `serverTime`, hold ID, expiry, and pool version are preserved: replay must not refresh verification, extend a timer, decrement beds twice, or create a second attempt. `Date` reflects the current delivery time, so immediately refetch before rendering replayed progress as current.

The replay guarantee lasts 24 hours from the first completed result; the server returns `Idempotency-Expires-At` for stored results. Same key with a different method, path, or normalized payload returns 409 `IDEMPOTENCY_KEY_REUSED`. An identical in-flight request returns 409 `IDEMPOTENCY_IN_PROGRESS` and `Retry-After: 1`, then can be retried unchanged. Concurrent different keys still obey the request and inventory invariants.

Successful mutations and completed business 409 results are stored atomically with the decision. Missing/invalid authentication, wrong authorization, schema/JSON errors, key-reuse/in-progress errors, rate limits, and transient server failures are not stored as completed business results. A 503 or lost response may leave the commit outcome unknown: retry with the same key. After key retention expires, reconcile by known resource ID before another mutation; if a create response and its ID were lost, require operator reconciliation rather than guessing or reusing an expired key. No list-my-requests recovery API is defined in Step 1.

All errors use:

```json
{
  "serverTime": "2026-10-02T10:00:11Z",
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "The pool changed. Refetch and review the current count and holds.",
    "details": [{"field": "/version", "code": "MISMATCH", "message": "Expected current version 2; received 1."}]
  }
}
```

Use `code` for behavior; `message` is safe display text, not a stable identifier. `details` is optional and uses JSON Pointers for body fields. Render error text as text, never HTML. Common HTTP statuses are 400 invalid input/missing key, 401 authentication, 403 forbidden role, 404 missing or unauthorized object, 409 state/concurrency conflict, 415 unsupported content type, 429 rate limit, and 500/503 server failure. Endpoint-specific conflict codes are listed in `x-conflict-codes` in OpenAPI.

On `CAPACITY_UNAVAILABLE`, `AVAILABILITY_OUTDATED`, or `POOL_REQUIREMENTS_NOT_MET`, refetch current state and explain the failed check. A failed accept leaves that attempt pending unless its deadline has elapsed. The nurse can verify availability, reject, or wait for timeout; no fallback is sent by an error handler. On `ATTEMPT_DEADLINE_PASSED`, `HOLD_EXPIRED`, or other terminal state errors, discard local actionable state and refetch. A corrected payload or deliberate new attempt after a reviewed conflict uses a new idempotency key.

## Integrating the fixtures

`examples/_manifest.json` maps every mock request and response file to its HTTP method, exact path, operation ID, headers, actor, and response status. It is test metadata, not an API response. Serve the raw `*.response.json` file as the body and the listed headers/status as HTTP metadata. Tokens are placeholders. Scenario fixtures reset independently except for the documented retries and hold alternatives. A deterministic mock clock can anchor itself to `serverTime`; do not treat the sample dates as current time.

The contract can support any HTTP client, mock server, or generated client that understands [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0.html). UI implementation and backend implementation are intentionally deferred to Step 2.
