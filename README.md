# BedLink

BedLink coordinates hospital availability, emergency dispatch and hospital responses.

## Implementation status

- Step 1: documented API contract, OpenAPI schemas and fictional examples.
- Step 2: Supabase PostgreSQL schema, RLS and migrations.
- Step 3: authenticated availability API, atomic nurse updates and idempotency.
- Step 4: hospital matching and ranking with simulated travel estimates.
- Step 5: transactional patient requests, hospital responses, bed holds, fallback offers and timeout worker.
- Frontend: responsive dispatcher/hospital-team experience served by the same Node API process.

See [frontend and local run guide](docs/frontend.md), [lifecycle integration guide](docs/api/lifecycle.md), and [validation record](docs/api/validation-step5.md).

Node.js 24 and pnpm are required. Install with `pnpm install --frozen-lockfile`, configure `.env` and `web/config.js` using the [local setup instructions](docs/frontend.md), apply migrations to a local Supabase database, then run `pnpm start` and `pnpm worker` separately. The worker needs its own restricted connection.

This repository does not include a hosted deployment or a remote database configuration.
