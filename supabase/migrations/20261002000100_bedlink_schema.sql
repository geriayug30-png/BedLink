-- Step 2: structural storage only. Apply to a Supabase PostgreSQL 15+ database.
-- auth.users and Supabase roles must already exist. No application workflow is implemented.
begin;

create schema bedlink_private;
revoke all on schema bedlink_private from public, anon, authenticated, service_role;

create type public.bed_resource as enum ('icu', 'ventilator', 'oxygen');
create type public.bed_specialty as enum ('cardiac', 'burns');
create type public.hospital_service as enum
  ('emergency', 'critical_care', 'cardiac', 'burns', 'oxygen_support');
create type public.staff_role as enum ('dispatcher', 'nurse');
create type public.patient_request_status as enum
  ('searching', 'pending', 'held', 'arrived', 'cancelled');
create type public.hospital_attempt_status as enum
  ('pending', 'accepted', 'rejected', 'timed_out', 'cancelled');
create type public.bed_hold_status as enum ('active', 'arrived', 'cancelled', 'expired');
create type bedlink_private.idempotency_status as enum ('in_progress', 'completed');

-- A reusable, immutable CHECK helper, not an API operation or an authorization helper.
create function bedlink_private.array_is_set(values_in anyarray)
returns boolean language sql immutable parallel safe
set search_path = ''
as $$
  select values_in is not null
    and (cardinality(values_in) = 0
      or (array_ndims(values_in) = 1 and array_lower(values_in, 1) = 1))
    and not exists (select 1 from pg_catalog.unnest(values_in) as v(element) where element is null)
    and cardinality(values_in) =
      (select count(distinct element) from pg_catalog.unnest(values_in) as v(element));
$$;
revoke all on function bedlink_private.array_is_set(anyarray) from public, anon, authenticated, service_role;

create table public.hospitals (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120 and btrim(name) <> ''),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  supported_services public.hospital_service[] not null default '{}'::public.hospital_service[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hospitals_services_set check (bedlink_private.array_is_set(supported_services)),
  constraint hospitals_times check (isfinite(created_at) and isfinite(updated_at) and updated_at >= created_at)
);

create table public.staff_memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on update restrict on delete cascade,
  role public.staff_role not null,
  hospital_id uuid references public.hospitals(id) on update restrict on delete restrict,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint staff_hospital_assignment check (
    (role = 'nurse' and hospital_id is not null)
    or (role = 'dispatcher' and hospital_id is null)
  ),
  constraint staff_membership_times check (isfinite(created_at) and isfinite(updated_at) and updated_at >= created_at)
);
create index staff_memberships_hospital_idx on public.staff_memberships(hospital_id, user_id)
  where is_active and role = 'nurse';

create table public.bed_pools (
  id uuid primary key default gen_random_uuid(),
  hospital_id uuid not null references public.hospitals(id) on update restrict on delete restrict,
  label text not null check (char_length(label) between 1 and 120 and btrim(label) <> ''),
  resources public.bed_resource[] not null,
  specialties public.bed_specialty[] not null default '{}'::public.bed_specialty[],
  capacity integer not null check (capacity > 0),
  reported_free_beds integer not null,
  verified_at timestamptz,
  inventory_updated_at timestamptz not null default now(),
  version bigint not null default 1 check (version between 1 and 9007199254740991),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bed_pools_count_bounds check (reported_free_beds between 0 and capacity),
  constraint bed_pools_resources_set check
    (cardinality(resources) between 1 and 3 and bedlink_private.array_is_set(resources)),
  constraint bed_pools_specialties_set check
    (cardinality(specialties) <= 2 and bedlink_private.array_is_set(specialties)),
  constraint bed_pools_times check (
    isfinite(created_at) and isfinite(updated_at) and isfinite(inventory_updated_at)
    and (verified_at is null or isfinite(verified_at)) and updated_at >= created_at
  ),
  -- Supports an attempt FK that also verifies the selected hospital.
  constraint bed_pools_id_hospital_key unique (id, hospital_id)
);
create index bed_pools_hospital_idx on public.bed_pools(hospital_id, id);
comment on column public.bed_pools.reported_free_beds is
  'Physically unoccupied staffed usable beds INCLUDING BedLink-held beds. Subtract active unexpired holds for offerable capacity.';
comment on column public.bed_pools.verified_at is
  'Only an explicit successful nurse update/verification may refresh this. Never refresh on reads or unrelated writes.';
comment on column public.bed_pools.version is
  'Later transactional operations compare the expected version and increment once per census or inventory transition. No automatic write trigger.';

create table public.patient_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on update restrict on delete restrict,
  patient_reference text not null check (patient_reference ~ '^[A-Za-z0-9_-]{1,64}$'),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  resources public.bed_resource[] not null,
  specialty public.bed_specialty,
  status public.patient_request_status not null default 'searching',
  cancellation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint patient_requests_resources_set check
    (cardinality(resources) between 1 and 3 and bedlink_private.array_is_set(resources)),
  constraint patient_requests_cancellation check (
    (status = 'cancelled' and cancellation_reason is not null
      and cancellation_reason in ('no_longer_needed', 'duplicate', 'other'))
    or (status <> 'cancelled' and cancellation_reason is null)
  ),
  constraint patient_requests_times check
    (isfinite(created_at) and isfinite(updated_at) and updated_at >= created_at)
);
create index patient_requests_owner_idx on public.patient_requests(owner_id, created_at desc, id);

create table public.hospital_attempts (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.patient_requests(id) on update restrict on delete restrict,
  hospital_id uuid not null,
  bed_pool_id uuid not null,
  status public.hospital_attempt_status not null default 'pending',
  created_at timestamptz not null default now(),
  response_deadline_at timestamptz not null,
  resolved_at timestamptz,
  reason_code text,
  updated_at timestamptz not null default now(),
  constraint hospital_attempts_pool_hospital_fk foreign key (bed_pool_id, hospital_id)
    references public.bed_pools(id, hospital_id) on update restrict on delete restrict,
  constraint hospital_attempts_deadline check (
    isfinite(created_at) and isfinite(response_deadline_at)
    and response_deadline_at = created_at + interval '120 seconds'
  ),
  constraint hospital_attempts_resolution check (
    (status = 'pending' and resolved_at is null and reason_code is null)
    or (status = 'accepted' and resolved_at is not null and isfinite(resolved_at)
      and resolved_at >= created_at and resolved_at < response_deadline_at and reason_code is null)
    or (status = 'rejected' and resolved_at is not null and isfinite(resolved_at)
      and resolved_at >= created_at and resolved_at < response_deadline_at
      and reason_code is not null and reason_code in ('cannot_receive', 'capacity_changed', 'other'))
    or (status = 'timed_out' and resolved_at is not null
      and resolved_at = response_deadline_at and reason_code is not null and reason_code = 'response_timeout')
    or (status = 'cancelled' and resolved_at is not null and isfinite(resolved_at)
      and resolved_at >= created_at and resolved_at < response_deadline_at
      and reason_code is not null and reason_code = 'request_cancelled')
  ),
  constraint hospital_attempts_updated_time check (isfinite(updated_at) and updated_at >= created_at),
  -- A hospital cannot be attempted twice for one request, even with another pool.
  constraint hospital_attempts_request_hospital_key unique (request_id, hospital_id),
  constraint hospital_attempts_hold_target_key unique (id, request_id, bed_pool_id, hospital_id, status)
);
create unique index hospital_attempts_one_pending_per_request
  on public.hospital_attempts(request_id) where status = 'pending';
create index hospital_attempts_incoming_idx
  on public.hospital_attempts(hospital_id, response_deadline_at, id) where status = 'pending';
create index hospital_attempts_deadlines_idx
  on public.hospital_attempts(response_deadline_at, id) where status = 'pending';
create index hospital_attempts_pool_idx on public.hospital_attempts(bed_pool_id);
create index hospital_attempts_history_idx on public.hospital_attempts(request_id, created_at, id);

create table public.holds (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.patient_requests(id) on update restrict on delete restrict,
  attempt_id uuid not null unique,
  bed_pool_id uuid not null,
  hospital_id uuid not null,
  -- Internal discriminator makes the composite FK require an accepted attempt.
  accepted_attempt_status public.hospital_attempt_status
    generated always as ('accepted'::public.hospital_attempt_status) stored,
  status public.bed_hold_status not null default 'active',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  end_reason text,
  updated_at timestamptz not null default now(),
  constraint holds_accepted_attempt_fk
    foreign key (attempt_id, request_id, bed_pool_id, hospital_id, accepted_attempt_status)
    references public.hospital_attempts(id, request_id, bed_pool_id, hospital_id, status)
    on update restrict on delete restrict,
  constraint holds_expiry check
    (isfinite(created_at) and isfinite(expires_at) and expires_at > created_at),
  constraint holds_resolution check (
    (status = 'active' and ended_at is null and end_reason is null)
    or (status = 'arrived' and ended_at is not null and isfinite(ended_at)
      and ended_at >= created_at and ended_at < expires_at
      and end_reason is not null and end_reason = 'ambulance_arrived')
    or (status = 'cancelled' and ended_at is not null and isfinite(ended_at)
      and ended_at >= created_at and ended_at < expires_at
      and end_reason is not null and end_reason in ('request_cancelled', 'transport_plan_changed', 'other'))
    or (status = 'expired' and ended_at is not null and ended_at = expires_at
      and end_reason is not null and end_reason = 'hold_expired')
  ),
  constraint holds_updated_time check (isfinite(updated_at) and updated_at >= created_at)
);
create unique index holds_one_active_per_request on public.holds(request_id) where status = 'active';
create index holds_active_pool_idx on public.holds(bed_pool_id, expires_at, id) where status = 'active';
create index holds_expiries_idx on public.holds(expires_at, id) where status = 'active';
create index holds_hospital_active_idx on public.holds(hospital_id, expires_at, id) where status = 'active';
create index holds_history_idx on public.holds(request_id, created_at, id);
comment on index public.holds_one_active_per_request is
  'One active row per request, not a pool-capacity guarantee. Due active rows must be settled before replacement; now() must not be used in an index predicate.';

create table bedlink_private.idempotency_records (
  id uuid primary key default gen_random_uuid(),
  issuer text not null check (char_length(btrim(issuer)) between 1 and 2048),
  actor_id uuid not null references auth.users(id) on update restrict on delete restrict,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  http_method text not null check (http_method in ('POST', 'PATCH')),
  request_path text not null check (request_path like '/api/v1/%' and char_length(request_path) <= 1024),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  status bedlink_private.idempotency_status not null default 'in_progress',
  response_status smallint,
  response_body jsonb,
  response_headers jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint idempotency_actor_key unique (issuer, actor_id, idempotency_key),
  constraint idempotency_result_shape check (
    (status = 'in_progress' and response_status is null and response_body is null
      and response_headers is null and completed_at is null and expires_at is null)
    or (status = 'completed' and response_status is not null and response_status in (200, 201, 409)
      and response_body is not null and jsonb_typeof(response_body) = 'object'
      and response_headers is not null and jsonb_typeof(response_headers) = 'object'
      and completed_at is not null and isfinite(completed_at) and completed_at >= created_at
      and expires_at is not null and isfinite(expires_at)
      and expires_at = completed_at + interval '24 hours')
  ),
  constraint idempotency_times check (isfinite(created_at) and isfinite(updated_at) and updated_at >= created_at)
);
create index idempotency_records_expiry_idx on bedlink_private.idempotency_records(expires_at)
  where status = 'completed';
create index idempotency_records_actor_idx on bedlink_private.idempotency_records(actor_id);

-- Secure immediately, including when only this first migration has been applied.
alter table public.hospitals enable row level security;
alter table public.staff_memberships enable row level security;
alter table public.bed_pools enable row level security;
alter table public.patient_requests enable row level security;
alter table public.hospital_attempts enable row level security;
alter table public.holds enable row level security;
alter table bedlink_private.idempotency_records enable row level security;

revoke all on table public.hospitals, public.staff_memberships, public.bed_pools,
  public.patient_requests, public.hospital_attempts, public.holds,
  bedlink_private.idempotency_records from public, anon, authenticated, service_role;

commit;
