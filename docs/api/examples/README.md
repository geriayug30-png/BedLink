# Mock exchanges

All hospitals are fictional and all patient references are anonymous. Coordinates are illustrative points near Bengaluru, not verified hospital addresses. Times are fixed UTC on 2026-10-02. No file contains a usable bearer token. [The manifest](_manifest.json) provides method, path, identity label, request headers, response status/headers, and payload filenames for each exchange; it is not an endpoint body.

Each numbered scenario starts from a clean fixture world unless noted below. Repeated hospital/pool IDs refer to the same fictional capabilities; free counts and freshness differ only in the stated scenario setup. The initial catalog is shown in `01-success/01-catalog.response.json`. Counts are not accumulated across independent scenarios. Each patient request belongs to `dispatch_demo_a` except `req_race_b`, which belongs to `dispatch_demo_b`. `nurse_demo_cedar` and `nurse_demo_cedar_b` are assigned to `h_demo_cedar`.

| Scenario | Steps / expected behavior |
| --- | --- |
| `01-success` | Read catalog; find ranked matches; create `req_success`; explicitly send `att_success` at 10:00:10 (deadline 10:02:10); poll inbox; accept at 10:00:40; hold `hold_success` expires 10:15:40; retrieve held state; arrive at 10:10:00; retrieve arrived state. Cedar starts with F=2, H=0, A=2; acceptance yields 2/1/1; arrival yields 1/0/1. Verification stays 09:59:00 throughout. |
| `02-rejection` | Independent case `req_reject`; Cedar rejects at 10:00:35. Fallback offer contains Lotus and excludes Cedar. At 10:00:40 the dispatcher explicitly sends the Lotus attempt. Reading the offer alone has no side effect. |
| `03-timeout` | Independent case `req_timeout`; deadline 10:02:10. Acceptance at exactly that time fails. Poll returns `timedOut` and a Lotus offer. Dispatcher confirms a new attempt at 10:02:15. |
| `04-no-eligible` | This scenario's configured catalog contains Cedar and Ember only; Lotus is not configured. Burns plus ICU/ventilator/oxygen cannot be satisfied by either pool. Return 200 `noEligibleHospitals`. |
| `05-stale` | Same capabilities as the base catalog, but every pool was last verified at 09:25:00. At 10:00:00 compatible counts are 35 minutes old. Return 200 `availabilityOutdated`, not “zero beds.” |
| `06-capacity-unavailable` | Same catalog and fresh verification, but every reported free count is zero. Return 200 `capacityUnavailable`, distinguished from missing capability and stale data. |
| `07-nurse-conflict` | Two nurses read Cedar version 1. First saves F=3, obtaining version 2. The second submits old version 1 and receives 409. A refetch still has the original verification time from the successful edit; explicit verification at 10:00:20 then produces version 3 and a new verification timestamp. |
| `08-last-bed` | Cedar starts with exactly one free bed. Two authorized dispatchers create separate cases and pending attempts; neither consumes capacity. First acceptance at 10:00:40 gets F=1/H=1/A=0. Second at 10:00:41 gets 409 `CAPACITY_UNAVAILABLE`; status still pending at 10:00:42. Nurse rejects it at 10:00:45 and returns Lotus as fallback. |
| `09-retries` | Replays the successful create and accept from scenario 01, delivered at 10:00:50. Bodies, status and Location are identical to the originals; `Date` is current and `Idempotency-Replayed` is true. A changed payload with the same create key returns 409. |
| `10-hold-expiry` | Alternative continuation from scenario 01's acceptance, with **no arrival**. At 10:15:40 the hold expires, request resumes searching and offers Lotus. Arrival at that instant fails with `HOLD_EXPIRED`. Cedar F remains 2 and its hold is released. |
| `11-cancel-hold` | Alternative continuation from scenario 01's acceptance, with no arrival/expiry. At 10:01:40 dispatcher releases the hold. Request resumes searching, Cedar is excluded, Lotus is offered. |
| `12-cancel-request` | Alternative continuation from scenario 01's acceptance, with no arrival/expiry. At 10:01:40 dispatcher cancels the entire request. Active hold is cancelled; request is terminal with no fallback. |

OpenAPI points to the request and successful response fixtures using `externalValue`. The manifest also covers error bodies. A validation run checks each raw payload against the schema of its exact operation and HTTP status, plus semantic relationships (IDs, clocks, counts, scores, history and retries). See [validation.md](../validation.md) for the performed checks and their limits.

For a UI mock, use the manifest's status and response headers alongside the referenced response JSON. Keep a simulated clock or advance the fixture times consistently. Do not concatenate independent scenarios into one database state.
