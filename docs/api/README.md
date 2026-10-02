# BedLink API contract and implementation

The API contract is implemented through Steps 1–5. See [local availability setup](availability.md), [matching behavior](matching.md), [request lifecycle](lifecycle.md), [frontend run guide](../frontend.md), and [Step 5 validation](validation-step5.md).

The OpenAPI document covers 14 operations under `/api/v1`, including public health. The existing 50 fictional exchanges and 82 JSON payload fixtures remain available in [examples](examples/README.md). The workflow adds runtime behavior without changing those response schemas.

The operational flow is **match → create request → dispatcher confirms hospital → hospital accepts/rejects within 120 seconds → accepted hold → arrival**. Rejection, timeout or hold expiry returns the request to searching with an explicit fallback offer. A dispatcher confirms any next attempt; the backend never sends one automatically.

Keep patient request, hospital attempt and hold statuses separate. Each bed belongs to one pool that must satisfy every requested resource and specialty. Nurses report physical free beds including held beds; BedLink subtracts active holds to determine offerable capacity.
