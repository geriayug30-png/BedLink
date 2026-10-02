# BedLink
About Emergency aid services . Ambulance service, Nurse service and providing info about availability of beds and hospitals nearby

## Implementation status

- Step 1: frontend/backend [API contract](docs/api/README.md) and fixtures.
- Step 2: Supabase [database schema, RLS and local setup](docs/database/setup.md).
- Step 3: authenticated hospital availability API, atomic nurse updates, idempotency, frontend client and integration tests.
- Step 4: dispatcher [hospital matching and ranking](docs/api/matching.md), simulated travel, useful empty results and client `findMatches()`.

Start with the [Step 3 run and frontend guide](docs/api/availability.md) and [validation results](docs/api/validation-step3.md).

Node.js 24 and pnpm are required. Install with `pnpm install --frozen-lockfile`, copy `.env.example` to `.env`, set your **local** Supabase configuration, then run `pnpm start`.

Patient request workflows, reservation transitions and timeout workers are still planned. No deployment or hosted database is included.
