# BedLink database setup and checks

Use a **new, disposable local database** for this step. The supplied files do not deploy anything or contact a remote database. Do not reset, drop, or overwrite an existing database to follow these instructions. The migration files depend on Supabase's Auth schema and roles; a plain PostgreSQL test adapter is provided separately.

## Files and requirements

- PostgreSQL 15 or later; PostgreSQL 17.11 was used for the recorded validation.
- For a full local Supabase stack: the [Supabase CLI and Docker](https://supabase.com/docs/guides/local-development), installed using the official instructions.
- `psql` for the fail-fast SQL checks. These are plain SQL assertion scripts, not pgTAP output; run the commands below instead of `supabase test db`.
- Run migrations as trusted `postgres`, since the authorization helpers and protected projection views are deliberately owned by that role. Application identities do not receive migration privileges.

Versioned migrations are under `supabase/migrations/`. Fictional data is in `supabase/seed.sql`; it is deliberately absent from production migrations. No repository credentials, `.env`, remote project reference, service key, Docker volume or database binary is required or committed.

## Option A: a fresh local Supabase stack

From a fresh local checkout with no existing Supabase stack for this project:

```text
supabase init
supabase start
supabase migration up --local
supabase status
```

`supabase init` creates the local CLI configuration; do not overwrite a pre-existing configuration. Retain `public` as an exposed application schema and keep `bedlink_private` out of the exposed API schemas. Review the generated local configuration and ports. `supabase start` may already apply migrations/seeds for a newly initialized stack; migration tracking prevents reapplying migrations, and the seed is safe to repeat. Follow the CLI's [local migration workflow](https://supabase.com/docs/guides/local-development/database-migrations). No `link`, remote `db push`, or database reset is needed here.

The examples below use the usual local database address `127.0.0.1:54322`; substitute the **verified local** port from your configuration. `-W` prompts for the local database password rather than including a credential in the command. Do not paste a production database URL.

```text
psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 54322 -U postgres -d postgres -W -f supabase/seed.sql
psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 54322 -U postgres -d postgres -W -c "SET bedlink.test_disposable='yes'" -f supabase/tests/step2_checks.sql
psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 54322 -U postgres -d postgres -W -c "SET bedlink.test_disposable='yes'" -f supabase/tests/seed_preservation.sql
```

The explicit marker is a guard against an accidental command, not proof that a connection is safe; independently confirm the local host and disposable project. Do not run `tests/support/plain_postgres_auth.sql` in Supabase: Supabase already provides the real Auth objects and roles.

For future local development, use migration tracking and new migration files; do not edit an already-applied migration. These initial migrations were edited only before their first repository publication.

## Option B: a new disposable plain PostgreSQL cluster

This is the route used to validate Step 2. Use a newly initialized local PostgreSQL cluster, bound only to loopback on an unused port, with its data directory outside source control. Choose a private local password through your normal PostgreSQL setup; none is prescribed or hardcoded here. Do not reuse an existing production/shared cluster merely for convenience.

After that fresh cluster is running, create a new database (an existing name causes an error, not replacement):

```text
createdb -h 127.0.0.1 -p 55439 -U postgres -W bedlink_step2_check
psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 55439 -U postgres -d bedlink_step2_check -W -c "SET bedlink.test_disposable='yes'" -f supabase/tests/support/plain_postgres_auth.sql
psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 55439 -U postgres -d bedlink_step2_check -W -f supabase/migrations/20261002000100_bedlink_schema.sql -f supabase/migrations/20261002000200_bedlink_access.sql
psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 55439 -U postgres -d bedlink_step2_check -W -f supabase/seed.sql
psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 55439 -U postgres -d bedlink_step2_check -W -c "SET bedlink.test_disposable='yes'" -f supabase/tests/step2_checks.sql -f supabase/tests/seed_preservation.sql
```

The test adapter requires a `bedlink_step2_*` database name and the explicit disposable marker. It refuses to replace an existing `auth` schema. It creates minimal `auth.users`, `auth.uid()` and no-login roles only for testing and reuses compatible existing emulation roles without changing their privileges. It does not run Supabase Auth, verify JWT signatures or reproduce all Supabase extensions/default grants. It is never a production migration.

The production migrations themselves include transactions and intentionally fail on conflicting existing objects rather than silently redefining an unknown schema. Apply once to a fresh database or through Supabase migration tracking; do not manually replay them against a database where they already succeeded.

## Expected checks

`step2_checks.sql` emits `NOTICE: PASS:` for 77 assertions. It wraps all synthetic Auth users, hospitals, patient references, attempts and holds in a transaction that ends with `ROLLBACK`; a failure with `ON_ERROR_STOP=1` exits nonzero and the connection rollback removes those fixtures. No real users or credentials are created. It checks structure and access rules by `SET LOCAL ROLE` plus synthetic JWT-subject settings, not by logging in to a real Auth service.

`seed_preservation.sql` emits two more PASS notices. In the disposable database only, it changes a fictional pool's count/version/verification time, snapshots all demo rows, runs the seed twice, and verifies exact preservation plus unchanged Auth/membership counts. It restores original pool values after success. It manages separate seed transactions; do **not** pass `--single-transaction` around this script. If interrupted or failed, its deliberate sentinel change can remain in that disposable database; no production data should be present there.

After checks, inspect a UTC snapshot:

```sql
set timezone = 'UTC';
select h.name, p.label, p.capacity, p.reported_free_beds, p.verified_at,
       p.inventory_updated_at, p.version
from public.hospitals h join public.bed_pools p on p.hospital_id=h.id
order by h.id, p.id;

select n.nspname as schema_name, c.relname as table_name, c.relrowsecurity
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where c.relkind='r' and (
  (n.nspname='public' and c.relname in ('hospitals','staff_memberships','bed_pools',
    'patient_requests','hospital_attempts','holds'))
  or (n.nspname='bedlink_private' and c.relname='idempotency_records')
)
order by n.nspname,c.relname;
```

A fresh seeded database has five hospitals, six pools, seven application tables with RLS enabled, and no staff/request/attempt/hold/idempotency records after test rollback. Reads must not change `verified_at`. Repeating `seed.sql` must not refresh it either; demo rows will become stale naturally. To get a new initial freshness scenario, use another fresh disposable database rather than overwriting existing operational data.

## Staff provisioning and future API access

The seed creates no accounts. In later integration, an administrator first creates/identifies legitimate Supabase Auth users, then provisions membership using a trusted database/admin channel. Example with operator-supplied `psql` variables and already-existing UUIDs:

```sql
insert into public.staff_memberships(user_id, role, hospital_id)
values (:'existing_user_id'::uuid, 'nurse', :'assigned_hospital_id'::uuid);
```

Dispatchers have `hospital_id = null`. No client signup trigger trusts user-editable metadata to assign roles. Clients can read only their own membership; they cannot insert, update or delete it. Deactivate a membership for offboarding; do not delete linked operational history.

For reads with an end-user Supabase JWT, RLS uses its verified `auth.uid()` and current membership. For server connections with `service_role`, RLS is bypassed: the API must validate the caller and enforce ownership/assignment explicitly. Keep privileged keys out of browser clients and public repository files. The nurse-wide catalog exception in Step 1 requires a deliberately authorized server projection, explained in [schema.md](schema.md#contract-compatibility-notes).

Do not make direct client writes work by adding blanket grants. Later narrowly scoped transactional functions must authorize, reconcile deadlines, lock request/pool state, compare versions, check requirements/capacity, apply one consistent transition and persist idempotency before returning. No such mutation is available in this step. Reads of the two nurse views are projections only, not timeout/expiry processing.

See [validation.md](validation.md) for what was executed and what remains unverified on a full Supabase stack. Stop the disposable local PostgreSQL process or local Supabase stack when finished; the delivered files do not install a background service.
