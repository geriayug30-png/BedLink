# Step 2 validation record

Validated 2026-10-02 using a new disposable **native PostgreSQL 17.11** cluster on Windows, listening only on `127.0.0.1:55439`. The runtime came from the [EDB PostgreSQL binary distribution](https://www.enterprisedb.com/download-postgresql-binaries) and remained in task scratch space. No existing database was reset and no remote database was contacted or modified.

| Check | Result |
| --- | --- |
| First schema migration on a fresh database | Passed |
| Second access-control migration | Passed |
| Fictional seed | Passed: five hospitals and six pools |
| Constraint/access suite | **77 assertions passed**, transaction rolled back |
| Seed preservation suite | **2 assertions passed**, including changed operational values and unchanged Auth identities |
| Total database assertions | **79 passed** |

The suite exercised invalid counts, capacity and version bounds, coordinate ranges/NaN, resource/specialty/role/status validation, array uniqueness, role/hospital assignment, exact response duration, acceptance at the deadline, required rejection reasons, hold time bounds, duplicate pending attempts, repeated hospitals, duplicate active holds, one hold per attempt, composite request/pool/hospital relationships, accepted-attempt linkage, restrictive deletion, actor-scoped idempotency keys, complete idempotency result requirements, inventory subtraction, and unchanged verification/version on reads.

Authorization checks used actual PostgreSQL grants, RLS policies and view execution semantics: one dispatcher cannot read another's requests; nurses cannot read other hospitals' inventory or full patient base rows; projections expose only assigned pending/active entries; forged editable metadata does not grant authority; unassigned and revoked users lose access; client writes and role self-assignment are denied; anonymous access and client idempotency access are denied. Privileged service-role access was also tested. The suite checks all application relations for missing client mutation/trigger/truncate privileges and checks fixed search paths on authorization helpers.

The seed test deliberately changed an existing demo pool before re-seeding twice. All existing demo fields, including count, version and verification timestamp, remained identical. No Auth users or memberships were added. Original pool values were then restored.

## Limits

This was real PostgreSQL validation, **not SQLite**. The disposable cluster used the explicitly separate test adapter for minimal `auth.users`, `auth.uid()` and Supabase-like roles. A full local Supabase stack, GoTrue JWT verification, PostgREST, production default grants, hosted migrations and network API behavior were not exercised. The adapter and synthetic identities are test scaffolding, not a replacement for Supabase Auth.

No reservation workflow or API exists in this change. No concurrency/overselling guarantee, transactional version comparison, multi-table live-commitment consistency, clock-driven settlement, arrival/cancellation effects, ranking, or end-to-end idempotency replay is claimed as implemented or tested. The schema constrains stored row shapes and relationships; privileged writers can still produce cross-table business inconsistencies until the later transaction functions are built. Client writes remain closed for that reason.

The source of truth is the unchanged [Step 1 contract](../api/README.md). UUID serialization, direct nurse database scope versus the broader REST catalog, and deferred transactional guarantees are documented in [schema.md](schema.md#contract-compatibility-notes). Reproduction commands and safe local-only prerequisites are in [setup.md](setup.md).
