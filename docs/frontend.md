# BedLink frontend

The application lives in `web/` and is served at `/` by the same Express process as the API. It adapts the supplied reference screens with BedLink colors, an original care-team illustration, an approximate schematic location panel and responsive dispatcher/hospital-team workspaces. No external stock photo, map tile or geocoding service is required.

## Configure local access

1. Set up the local database and server as described in [availability setup](api/availability.md) and [the Step 5 lifecycle guide](api/lifecycle.md). `pnpm start` serves both frontend and API on the configured `PORT` (3000 by default). The worker is a separate `pnpm worker` process.
2. Edit `web/config.js` for your local Supabase Auth URL and its browser-safe publishable/anon key. Never put a service-role secret, database password or backend URL in this file. `apiBaseUrl` defaults to the current page origin plus `/api/v1`.
3. Add the page origin (for example `http://localhost:3000`) to the server's `ALLOWED_ORIGINS`, restart the API, and open `http://localhost:3000`.
4. Sign in with a Supabase Auth account whose trusted `staff_memberships` row is active. The role cards only select which workspace is shown; the backend remains responsible for role and hospital checks. Nurses enter their assigned hospital's opaque ID, available to the team provisioning the account.

Sign-in uses the Supabase Auth password grant and keeps the session in tab-scoped `sessionStorage`, refreshing a near-expiry token with its refresh token. The UI never saves a password. Mutation idempotency keys are kept for retries in the same tab. Sign out clears the active request and retained keys. Use TLS in hosted environments; this code describes a local frontend/API arrangement and does not publish a live BedLink service.

## Dispatcher flow

Choose one or more resources, optionally a specialty, and provide coordinates or share device location. The schematic map is illustrative and does not geocode addresses or provide directions. BedLink calls the existing `findMatches()` client method and displays hospitals ranked by the API, their best matching pool, offerable beds, freshness and simulated travel time. An explicit hospital selection creates an anonymous request and sends a pending attempt. The backend revalidates the offer.

The request panel polls active requests and shows attempt history, absolute response countdown, hold expiry and any next-best option. A rejection/timeout/expiry displays a fallback offer for the dispatcher to review. The interface never sends a fallback automatically. Countdown display is informational; server time controls state transitions. No patient name, phone number or clinical notes are collected.

## Hospital team flow

Paste the assigned hospital ID, then review the incoming inbox. The inbox refreshes every eight seconds while the tab is visible. Accept creates the database hold; decline asks for one of the API's enumerated reason codes. Active holds show expiry and can record an actual arrival. API errors are shown without database diagnostics. Refresh after conflicts and follow the server's current status.

## Scope and limitations

This is a responsive workflow UI, not the separately specified production dispatch/clinical system. It has no street map or address search, push/SMS/email notification, role provisioning, real patient registration, emergency-call button, analytics or staff-count editor. Travel estimates are explicitly simulated. UI polling interval is configurable in `web/app.js`; durable deadline settlement is done by `pnpm worker` and by API reads/mutations. Review API behavior and timeouts in [Step 5 lifecycle notes](api/lifecycle.md).
