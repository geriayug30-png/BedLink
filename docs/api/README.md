# Implementation through Step 4

The hospital availability API, dispatcher matching and frontend client are implemented. See [local setup](availability.md), [matching integration](matching.md), and [Step 4 validation](validation-step4.md). The original Step 1 design material below describes the full planned workflow; the three availability operations, matching and public health endpoint are currently implemented.

# BedLink API contract — Step 1

This folder is the framework-independent agreement between the frontend and the planned Node.js/Express + Supabase backend. It contains documentation and fictional mock data only.

- [Frontend integration guide](frontend-handoff.md): screen-to-endpoint mapping, counts, lifecycle, polling, retries and errors.
- [OpenAPI 3.1 specification](openapi.yaml): 14 operations (including the public health endpoint) under `/api/v1`, authentication, schemas and response codes.
- [Mock scenarios](examples/README.md): 12 scenarios, 50 exchanges, and 82 request/response JSON payloads. [The manifest](examples/_manifest.json) maps payload files to HTTP metadata.
- [Decisions and assumptions](decisions.md): inventory rules, ranking formula, configurable demo defaults, state transitions and Step 2 decisions.
- [Validation record](validation.md): tools, checks, reproduction instructions and limits.

The flow is **match → create patient request → dispatcher confirms hospital → hospital accepts/rejects within 120 seconds → accepted hold → arrival**. Rejection or timeout produces a fallback offer; a dispatcher explicitly confirms sending it. A hold has its own expiry, separate from the hospital response deadline.

Keep patient request, hospital attempt and hold statuses separate. Each bed belongs to one pool that must satisfy all requirements together. Nurses count physically free held beds in their reported free total; the server subtracts active holds to determine capacity for new requests.
