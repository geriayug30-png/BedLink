# Step 4: hospital matching and ranking

`POST /api/v1/matches` is implemented for **active dispatchers**. The API verifies the bearer token using the existing Supabase Auth adapter. A new database function checks trusted membership before returning a catalog snapshot. Nurses, inactive members and unassigned users receive 403 with no catalog or diagnostic counts. Anonymous callers receive 401. No client-supplied role is trusted.

Search is read-only: it creates no request, reservation, attempt, notification or idempotency record, and never changes verification timestamps or versions. A result is an offer based on a snapshot; it does not promise capacity at a later send/accept step.

## Run and integrate

Follow the [Step 3 local setup guide](availability.md) for Node.js 24, dependency installation, local Supabase, test users and `.env`. Apply **only** the new `supabase/migrations/20261002000400_matching_catalog.sql` if your local database already has Steps 2–3. On a new local database, apply all four migrations in filename order, then `supabase/seed.sql`. Never rerun the old migrations on an existing database. Reload the local PostgREST schema cache if needed with `NOTIFY pgrst, 'reload schema';`.

Run `pnpm start` from the repository root after configuring `.env`. This change was not deployed and no remote database was modified.

```sh
curl -X POST http://127.0.0.1:3000/api/v1/matches \
  -H "Authorization: Bearer $DISPATCHER_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"needs":{"location":{"latitude":12.9716,"longitude":77.5946},"resources":["icu","ventilator","oxygen"],"specialty":"cardiac"}}'
```

No idempotency key or query parameter is needed. The body must contain only `needs`; that object accepts only `location`, `resources`, and optional `specialty`. Coordinates must be finite JSON numbers with latitude in [-90,90] and longitude in [-180,180]. Resources must be a nonempty set drawn from `icu`, `ventilator`, `oxygen`. Specialty is `cardiac`, `burns`, or null; omission means null. Unknown fields, duplicates, string coordinates and malformed values return 400 `INVALID_INPUT`. Oversized JSON returns 413; unsupported media types return 415. Authentication runs before body parsing. There is no patient identifier in a search.

The framework-independent client now exposes:

```js
import { createBedLinkApi } from './client/bedlink-api.mjs';

const api = createBedLinkApi({
  baseUrl: 'http://127.0.0.1:3000/api/v1',
  getAccessToken: async () => currentSupabaseSession.access_token,
});
const controller = new AbortController();
const { data, meta } = await api.findMatches({
  location: { latitude: 12.9716, longitude: 77.5946 },
  resources: ['icu', 'ventilator', 'oxygen'],
  specialty: 'cardiac',
}, { signal: controller.signal });
// data.serverTime and data.result are the existing MatchesResponse contract.
// meta.requestId can be used to correlate a failed operation with safe server logs.
// controller.abort() cancels an obsolete search. The client never automatically retries.
```

The token provider runs for each request. Structured HTTP errors use `BedLinkApiError`; cancellation remains an AbortError. Search sends `Content-Type: application/json` and bearer auth, without an `Idempotency-Key`. The shared CORS configuration now allows POST. Logs continue to omit bodies, coordinates, needs, tokens and raw upstream errors.

## Eligibility and diagnostics

For each unexcluded hospital, a **single pool** must contain every requested resource and the requested specialty, if any. Resources are never combined across separate pools. Hospital service labels, distance and score cannot compensate for a missing requirement.

The database snapshot reuses Step 3's census projection. Let `C = capacity`, `F = reportedFreeBeds`, `H = activeHoldCount`, `A = F - H`. H counts only holds whose status is active and whose expiry is strictly later than the snapshot timestamp. F includes held physically unoccupied beds. Pending attempts do not reduce capacity. Matching requires A >= 1 and verified age strictly below 30 minutes. Null verification is unverified; exactly 30 minutes is stale. The 10-minute aging boundary does not exclude a pool. Inconsistent inventory fails closed with 503.

The response uses the database snapshot timestamp as `serverTime`. Freshness and held capacity therefore use the same instant, independently of API host clock skew. Travel runs after that transaction commits. Provider delay does not re-label the snapshot as newly observed. No search refreshes `verifiedAt`, `inventoryUpdatedAt`, or the version; due holds are filtered, not transitioned.

Diagnostics count pools after capability filtering and trusted hospital exclusions:

- `compatiblePoolCount` = `freshPoolCount` + `stalePoolCount` + `unverifiedPoolCount`.
- `freshPoolCount` includes both fresh and aging compatible pools.
- `freshAvailablePoolCount` counts compatible, fresh-enough pools with A >= 1, before choosing one pool per hospital.

Successful searches use the existing four HTTP 200 outcomes:

| Outcome | Meaning |
|---|---|
| `matchesFound` | At least one eligible pool remains |
| `availabilityOutdated` | No candidate; at least one compatible pool is stale or unverified |
| `capacityUnavailable` | Compatible pools exist and are fresh enough, but all have zero offerable capacity |
| `noEligibleHospitals` | No unexcluded pool has all mandatory capabilities |

Outdated data takes precedence over full capacity in mixed empty results. If any eligible candidate exists, the outcome is `matchesFound` even if other pools are full or stale. Empty searches never invoke the travel provider. Diagnostics and candidates are returned only after database authorization succeeds.

## Simulated travel and replacement interface

`src/travel/simulated.mjs` implements the provider interface:

```js
await provider.estimate({ origin, destination, policy, signal });
// -> { distanceKm, estimatedTravelMinutes, source, trafficConsidered }
```

Haversine distance uses Earth radius **6371 km**. ETA is `max(1, ceil(unroundedDistanceKm * simulatedRoadFactor / simulatedSpeedKph * 60))`. Default speed is 30 km/h; the illustrative distance multiplier is 1.3. Distance is returned rounded to one decimal, but ETA uses the unrounded distance. Identical coordinates yield 0 km and 1 minute. No routing, roads or traffic data are consulted.

The required display label remains **“Simulated travel estimate · traffic not considered.”** `source` is `simulatedDistance` and `trafficConsidered` is false. The multiplier's historical configuration name is “road factor”; it is only an arithmetic assumption and does not make this a road-route estimate. These estimates may differ greatly from actual ambulance travel.

The provider is called once per hospital with eligible pools, outside any database transaction. Calls share a bounded timeout (default 5000 ms) and cancellation signal. A thrown error, timeout, missing/invalid result or zero/nonfinite ETA causes the **entire search** to return 503 `SERVICE_UNAVAILABLE`, with `Retry-After: 1` and a safe message. No partial rankings or diagnostics are returned, and no zero-minute fallback is fabricated. Even a provider that ignores cancellation cannot keep the API response waiting indefinitely; replacement providers should honor AbortSignal to stop their own work.

The current wire contract only permits simulated travel. A real routing/traffic provider can implement the interface, but its source labels and response semantics require an explicit contract revision before use.

## Scoring, bounds and ordering

For eligible pools, with t = simulated whole-minute ETA and age = fractional minutes since verification:

```text
travelScore    = max(0, 100 * (1 - t / travelScoreHorizonMinutes))
freshnessScore = max(0, 100 * (1 - age / staleAfterMinutes))
headroomScore  = 100 * A / C
score          = roundHalfUp(travelScore * travelWeight
                          + freshnessScore * freshnessWeight
                          + headroomScore * headroomWeight, 2)
```

Components and total are bounded by 0–100. The default weights are **50% travel, 30% freshness, 20% headroom**; the travel horizon is 60 minutes. Returned components are rounded half up to four decimals; the total uses unrounded components. The top pool per hospital is selected by the rounded total, then ascending pool ID. Hospitals sort by descending rounded total, ascending ETA, then ascending hospital ID. ID comparisons use code-point order, not locale collation. Ranks start at 1.

`loadRatio = 1 - A/C` means the selected pool's fraction unavailable for new requests, including occupied/unusable reported capacity and live holds. It is **not** a staffing measure, ED congestion, waiting time or whole-hospital occupancy. The ranking is the agreed prototype prioritization, not a clinical triage assessment.

The existing response already explains eligibility through `matchesAllRequirements: true` plus the selected pool's resources, specialties, freshness and available capacity. Score components and travel labels explain ordering. No new free-text eligibility field was added to the strict schema. [The original complete matching example](examples/01-success/02-matches.response.json) is reproduced exactly by the implementation with its fixture clock. Existing empty-state examples are also unchanged.

## Policy configuration and Step 5 reuse

| Environment variable | Default |
|---|---|
| `MATCH_POLICY_VERSION` | `demo-1` |
| `MATCH_TRAVEL_WEIGHT` | 0.5 |
| `MATCH_FRESHNESS_WEIGHT` | 0.3 |
| `MATCH_HEADROOM_WEIGHT` | 0.2 |
| `MATCH_TRAVEL_HORIZON_MINUTES` | 60 |
| `MATCH_SIMULATED_SPEED_KPH` | 30 |
| `MATCH_SIMULATED_ROAD_FACTOR` | 1.3 |
| `MATCH_TRAVEL_TIMEOUT_MS` | 5000 |

Weights must be finite, individually in [0,1], and sum to 1. Horizon and speed must be finite and positive; the distance factor must be at least 1. Changing numeric ranking settings requires a distinct nonempty `MATCH_POLICY_VERSION`. Timeout accepts integers 1–60000 ms. The effective policy is returned in every successful result, including empty ones.

Freshness thresholds remain the Step 3 database policy (10/30 minutes). They are not independently configurable in matching: a mismatched snapshot policy fails closed. Changing those thresholds requires a coordinated migration and policy change so catalog and matching remain consistent. Ranking customization can have its own version while the unchanged pool freshness policy stays `demo-1`. The response still includes the contract's 120-second response deadline and 900-second prototype hold duration as policy metadata; this step implements neither workflow.

`createMatchingService(...)(needs, identity, signal, { excludedHospitalIds })` accepts trusted internal exclusions. `rankHospitals(...)` is the pure-data ranking boundary with an injectable clock and provider. The public endpoint never accepts exclusion IDs in the body or query. Step 5 should load **all** attempted hospital IDs from authorized request history, regardless of attempt status, and pass them internally. Exclusion applies to the whole hospital, before compatibility counts or travel calls. It does not create or send a fallback request. The service defaults to the database snapshot clock; tests can inject a fixed clock for synthetic snapshots.

## Contract and validation

OpenAPI is now contract version **1.3.0**. The existing `/matches` request, result, candidate and diagnostic schemas are unchanged. Only its implementation description, travel-failure behavior and 413 response were added. There are still 14 documented operations and 43 schemas; the original request and response workflow operations are implemented in [Step 5](lifecycle.md).

Run:

```sh
pnpm test
pnpm test:contract
python scripts/check_contract.py
# After all four migrations and the seed are applied to a disposable LOCAL database:
pnpm test:db
```

The Python check requires `pip install -r requirements-checks.txt`. For a plain PostgreSQL test cluster, use the guarded test-only auth adapter and database naming described in [availability.md](availability.md#tests); add the fourth migration to that command. The adapter must never be used in Supabase itself. Existing Step 2 SQL checks run before the runtime suites. See [Step 4 validation results](validation-step4.md) for the distinction between mocks and real database tests.
