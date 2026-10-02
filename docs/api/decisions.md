# BedLink Step 1 decisions

Contract version: **1.0.0**. Prepared 2026-10-02. This records proposed demo behavior for implementation and review; it is not evidence of clinical approval or a running system. [openapi.yaml](openapi.yaml) defines the wire shape; this document supplies cross-resource rules that schemas alone cannot enforce.

## Repository and scope

The target is `geriayug30-png/BedLink`. At inspection, `main` pointed to commit `665952a991874b0b13ebe713a8fbe7d270788f9f` and contained only `README.md`; no `AGENTS.md` existed in that tree or in applicable local ancestors. The README is preserved. A separate local prototype was inspected for context: it contains SQLite persistence, a seed catalog, input validation, and simulated ranking. It is not part of this GitHub repository and is not copied or altered in this Step 1 change.

This change adds documentation and mock JSON only. There is no new Express server, UI, SQL migration, deployment, generated client, or production credential. The planned stack remains Node.js/Express, Supabase PostgreSQL, and Supabase Auth. The user's latest instruction to save the rebuilt Step 1 in GitHub supersedes the pasted restriction against committing/pushing.

## Bed pools and inventory

A pool is a set of physically distinct, staffed, usable beds with an identical guaranteed capability combination. Each bed belongs to exactly one pool. A bed's resources cannot be counted in several pools at once. Pool resources and specialties apply to **every** bed in that pool and must be simultaneously available. If equipment is shared and cannot support every bed concurrently, it cannot be advertised on all those beds; use conservative disjoint pools until a resource-allocation model is designed.

ICU, ventilator, and oxygen are resources. Cardiac and burns are specialties. A candidate requires `requestedResources ⊆ pool.resources` and either no specialty or `requestedSpecialty ∈ pool.specialties`. This is an operational matching model, not a clinical triage score. One request requires one bed. Pool capacities/capabilities, hospital locations, and assignments are provisioned outside this contract and cannot be edited through these endpoints.

Let C = `capacity`, F = `reportedFreeBeds`, H = `activeHoldCount`, A = `availableBeds`.

**Invariant: `0 ≤ H ≤ F ≤ C`; `A = F − H`; `loadRatio = 1 − A/C`.**

F means physically unoccupied, staffed, usable beds, including beds reserved by an active BedLink hold. Nurses must include those held beds in their count. H counts only unexpired active holds; pending attempts do not count. Capacity is positive. Do not show F alone as “available.” Pools never report negative availability or silently clamp an inconsistent census.

| Event | F | H | A | Pool version / timestamps |
| --- | --- | --- | --- | --- |
| Read / search / poll | No change | No change except due expiry settlement | Derived | No verification refresh; ordinary reads do not bump version |
| Nurse update or explicit verify | Set to confirmed count | Unchanged | Recompute | Increment version; set `verifiedAt` and `inventoryUpdatedAt` to server time |
| Create pending attempt | Unchanged | Unchanged | Unchanged | No pool change |
| Reject or time out pending attempt | Unchanged | Unchanged | Unchanged | No pool change |
| Accept attempt | Unchanged | +1 | -1 | Increment version and `inventoryUpdatedAt`; preserve `verifiedAt` |
| Cancel active hold / cancel held request | Unchanged | -1 | +1 | Increment version and `inventoryUpdatedAt`; preserve `verifiedAt` |
| Hold expires | Unchanged | -1 | +1 | Increment version and `inventoryUpdatedAt` at effective expiry; preserve `verifiedAt` |
| Arrival before hold expiry | -1 | -1 | Unchanged | Increment version and `inventoryUpdatedAt`; preserve `verifiedAt` |

Nurse census edits atomically compare the submitted version to the current version. A mismatch returns 409 `VERSION_CONFLICT`. A count greater than capacity returns 400 `INVALID_INPUT`; a count below H returns 409 `FREE_COUNT_BELOW_HOLDS`. Rejecting the edit preserves holds. The dispatcher must reconcile affected holds before a lower count can be recorded. Escalation for an unexpectedly unusable held bed remains a product decision; the API does not invent an unsafe count override.

`operation: verify` requires the same count as current F or returns 409 `VERIFICATION_COUNT_CHANGED`. Both successful update and verify refresh `verifiedAt` even when F is unchanged. Replay is an exception: it returns the original result without refreshing anything. Pool versions also change with inventory/hold transitions to prevent a stale screen overwriting a change it has not seen.

## Freshness and configurable demo policy

`verifiedAt` is only the last explicit nurse confirmation. A read, ranking calculation, acceptance, arrival, or cancellation must never refresh it. `inventoryUpdatedAt` is a separate operational timestamp. `dataAgeMinutes = (serverTime − verifiedAt) / 60000` without whole-minute rounding. Never-verified pools have null age and null verification timestamp, with freshness `unverified`, and cannot match or be accepted.

| Setting | Demo value | Rule |
| --- | --- | --- |
| Hospital response deadline | **120 seconds** | Fixed requirement in this contract; not a UI countdown assumption |
| Hold duration | 900 seconds / 15 minutes | Configurable demo assumption, starts at acceptance |
| Aging threshold | 10 minutes | Age < 10 is fresh; 10 ≤ age < 30 is aging |
| Stale threshold | 30 minutes | Age ≥ 30 is stale and excluded |
| Ranking weights | Travel 0.50; freshness 0.30; headroom 0.20 | Configurable, must sum to 1 |
| Travel score horizon | 60 minutes | At or above this, travel component is 0 |
| Simulated speed / road factor | 30 km/h / 1.3 | Configurable illustrative assumptions, no traffic |
| Replay retention | 24 hours | From first completed idempotent result |
| Request / inbox polling | 2 seconds | Visible active screens; backoff on failure |
| Inventory board polling | 15 seconds | Also refetch after relevant mutations |

The effective matching policy is returned in each `MatchResult.policy` with a `policyVersion`. Each bed pool also includes `freshnessPolicy`, so catalog and nurse screens receive the thresholds without performing a dispatch search. A deployment must use a consistent policy across endpoints. Existing deadlines and hold expiries are immutable absolute timestamps if configuration later changes. Clients use the timestamps, not their hardcoded defaults.

Freshness eligibility and capacity are rechecked at both send and acceptance. An already active hold is not revoked solely because data later becomes stale. Arrival against that valid hold is allowed, and it does not imply a new census verification.

## Ranking and load

Search all hospitals in the configured demo catalog; there is no implicit radius or real routing provider. For fallback, exclude **all** hospitals with any attempt for this patient request, including rejected, timed-out, accepted, or cancelled attempts. Filter pools for simultaneous capabilities, age below the stale threshold, and A ≥ 1.

For each remaining pool:

1. Compute Haversine straight-line distance d using latitude/longitude in radians and Earth radius 6371 km.
2. Compute simulated minutes t = `max(1, ceil(d × roadFactor / speedKph × 60))` using the unrounded distance. Return `distanceKm` rounded to one decimal. Set `source: simulatedDistance`, `trafficConsidered: false`.
3. `travelScore = max(0, 100 × (1 − t / travelScoreHorizonMinutes))`.
4. `freshnessScore = max(0, 100 × (1 − dataAgeMinutes / staleAfterMinutes))`.
5. `headroomScore = 100 × A / C = 100 × (1 − loadRatio)`.
6. Weighted score = `travelScore × travelWeight + freshnessScore × freshnessWeight + headroomScore × headroomWeight`. Round the total to two decimals, half up. Return components to four decimals; calculate the total from unrounded components.

Choose the highest total score per hospital; ties within a hospital use ascending pool ID in Unicode code-point order. Sort hospitals by descending rounded total score, then ascending simulated travel minutes, then ascending hospital ID in Unicode code-point order. Assign sequential ranks starting at 1. This deterministic rule is independent of client locale and frontend framework.

“Load” means **the fraction of this selected pool's capacity unavailable for new requests**, including occupied/unusable reported capacity plus active holds. It is not the hospital's whole-campus occupancy, ED waiting queue, ambulance queue, or staff workload. Scores do not reflect clinical urgency, treatment quality, or whether another hospital should be medically preferred.

`MatchResult.diagnostics` counts compatible pools after exclusions: fresh/aging, stale, unverified, and fresh with capacity. If any eligible candidate exists, outcome is `matchesFound`. Otherwise choose `availabilityOutdated` if stale/unverified compatible pools exist, `capacityUnavailable` if only fresh but full pools exist, or `noEligibleHospitals` if no compatible unattempted pool exists. Thus no-match, unavailable capacity, and untrustworthy data are not conflated. All return 200; none is a missing-resource 404.

## Request lifecycle and transaction rules

The API maintains three independent state machines:

| Trigger | Patient request | Hospital attempt | Hold |
| --- | --- | --- | --- |
| Create case | `searching` | None | None |
| Dispatcher confirms hospital | `pending` | New `pending` | None |
| Nurse accepts before deadline | `held` | `accepted` | New `active` |
| Nurse rejects before deadline | `searching` | `rejected` | None |
| Deadline reached | `searching` | `timedOut` | None |
| Arrival before expiry | `arrived` | Stays `accepted` | `arrived` |
| Release active hold | `searching` | Stays `accepted` | `cancelled` |
| Hold expires | `searching` | Stays `accepted` | `expired` |
| Cancel searching case | `cancelled` | Existing history unchanged | None |
| Cancel pending case | `cancelled` | Current pending becomes `cancelled` | None |
| Cancel held case | `cancelled` | Stays `accepted` | Active becomes `cancelled` |

At most **one live commitment** exists for a patient request: either one pending attempt or one active hold, never both. `activeAttemptId` is non-null only for pending; `activeHoldId` and `activeHold` are non-null only for held. Arrived and cancelled requests are terminal. Rejected and timed-out attempts are terminal; accepted attempts remain historical facts after the hold ends. All history is retained. There is no hold renewal, resurrection, resend to an already attempted hospital, or editing of needs in this version.

The backend derives `responseDeadlineAt = attempt.createdAt + 120 seconds`. A pending attempt is actionable only while `serverNow < responseDeadlineAt`. At equality it has timed out; `resolvedAt` is the deadline even if a worker observes it later. The backend must reconcile deadline/expiry state before returning reads or performing writes, with background settlement for timely operation. Reads may materialize an already-due lifecycle transition; they never verify census data. Clients cannot supply a decision timestamp or extend a timer.

Acceptance serializes the patient request and pool, checks the deadline at the effective transition instant, confirms the attempt is pending and sole live commitment, revalidates capabilities/freshness/capacity, and atomically transitions the attempt/request, inserts the hold, and updates pool inventory/version. The state change and idempotency record form one durable decision. Two ambulances may both have pending attempts for the last bed; only the first successful acceptance can create a hold. The second returns 409 `CAPACITY_UNAVAILABLE`, without an extra hold or negative inventory, and remains pending until rejection or timeout.

If the deadline has passed, acceptance/rejection returns 409 `ATTEMPT_DEADLINE_PASSED` after settling the timeout; no late hold can be created. Other terminal attempts return `ATTEMPT_NOT_PENDING`. Repeated requests with the original successful key replay that result rather than re-running deadline checks. After replay, the client refetches current state.

Rejection/timeout restores searching and computes eligible fallback options, excluding all attempted hospitals. Returning or refreshing an offer does not notify the hospital, create an attempt, or reserve a bed. The dispatcher must explicitly send an option. Offers have no separate persistent status or reservation token; their freshness/capacity may change and send is revalidated. A nurse rejection response exposes catalog-level fallback candidates and this attempt, not unrelated request history.

Holds expire at `acceptedAt + holdDurationSeconds`. At equality, expiry wins over arrival; `endedAt` is `expiresAt`, inventory is released once, and the request resumes searching. Arrival after expiry returns `HOLD_EXPIRED`; it never consumes an unreserved bed retroactively. Arrival, expiry, cancellation, count edits, and acceptance must serialize so each hold ends once and inventory is adjusted once. A new key against an already-arrived/cancelled hold returns `HOLD_NOT_ACTIVE`; an original successful key replays. Race tests must cover arrival versus expiry and arrival versus cancellation in Step 2.

Cancelling a whole request ends it; cancelling only an active hold releases the reservation and resumes searching. Full request cancellation after an expiry may cancel the now-searching request, without releasing the old hold twice. Dispatchers cannot cancel an arrived request through this surface. Nurses do not cancel a hold through this API; operational escalation goes to the dispatcher until the team designs a hospital withdrawal flow.

## Reliability and access decisions

Use bearer access tokens validated by the API. Authorization comes from trusted server-managed assignment records; user-editable profile metadata is not authority. Request ownership is the authenticated subject at creation. No admin role, organization delegation, or public patient lookup exists in this demo. Out-of-scope object access returns 404, wrong endpoint role returns 403. Mutations accept only whitelisted fields.

Idempotency keys are scoped to issuer + subject across all API mutations. Fingerprints include method, resolved/normalized path, and canonical JSON with documented defaults and set-valued resources normalized. Reuse with changed payload/path/method is a conflict. Successful and business-conflict results are retained 24 hours; replay preserves original status/body/resource IDs/verification time/deadlines and returns an explicit replay header. Key lookup precedes version/deadline reevaluation only after authentication and object authorization. In-flight identical keys return retryable `IDEMPOTENCY_IN_PROGRESS`. Complete processing order and UI handling appear in [frontend-handoff.md](frontend-handoff.md#safe-retries-and-errors).

In PostgreSQL implementation, protect both request-level exclusivity and pool capacity under concurrency, not only with preflight reads. Constraints plus transactional locking/serialization and durable idempotency should be designed in Step 2. This contract specifies outcomes rather than prescribing SQL or claiming a particular Supabase transaction API.

## Decisions to resolve before Step 2

| Decision | Current demo assumption | Resolve with the team |
| --- | --- | --- |
| Census and held-bed workflow | F includes held beds; reject F < H | Nurse training and escalation when a reserved bed becomes unusable |
| Hold duration and travel overrun | 15 minutes; no renewal; strict expiry | Appropriate duration, renewal/withdrawal, late-arrival operational handling |
| Clinical requirements | Three resource flags; one optional cardiac/burns specialty | Clinician-approved eligibility, pediatric/isolation/acuity, staffing and shared equipment |
| Ranking and freshness | 50/30/20 weights, 10/30-minute thresholds, simulated travel | Agree thresholds/weights, routing provider, traffic and search region |
| Authorization and organization scope | One dispatcher owner; one assigned hospital per nurse | Teams, shifts, transfers, administrators, audit retention and access revocation |
| Anonymous reference uniqueness | Informational reference; no global deduplication | Duplicate cases across dispatchers; recovery when a create response is lost after 24 hours |
| Inventory reconciliation | External admissions/discharges reported by nurses | Hospital-system integration, offline updates, audit trail, census conflicts |
| Terminal behavior | Arrived/cancelled terminal; attempted hospitals excluded | Reopening, deliberate retries at the same hospital, exhausted fallback escalation |
| Operational scale | Full small demo catalog/inbox; basic polling | Pagination, rate limits, monitoring, background deadline settlement and notification delivery |
| Privacy and launch readiness | Anonymous fixture data only | Applicable privacy controls, retention, consent, operational validation, and deployment requirements |

Step 2 must implement and test these contract outcomes before treating the system as operational. No backend, UI, database, or deployment work belongs to this Step 1 change.
