-- Fail-closed database access. Business mutations are deferred to later atomic functions.
begin;

create function bedlink_private.is_dispatcher()
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.staff_memberships m
    where m.user_id = (select auth.uid()) and m.role = 'dispatcher' and m.is_active
  );
$$;

create function bedlink_private.is_nurse_for(target_hospital_id uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.staff_memberships m
    where m.user_id = (select auth.uid()) and m.role = 'nurse'
      and m.is_active and m.hospital_id = target_hospital_id
  );
$$;

create function bedlink_private.owns_request(target_request_id uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select bedlink_private.is_dispatcher() and exists (
    select 1 from public.patient_requests r
    where r.id = target_request_id and r.owner_id = (select auth.uid())
  );
$$;

-- These helpers intentionally read trusted membership/request tables as the owner,
-- avoiding recursive policies. They expose only a boolean about the current caller.
alter function bedlink_private.is_dispatcher() owner to postgres;
alter function bedlink_private.is_nurse_for(uuid) owner to postgres;
alter function bedlink_private.owns_request(uuid) owner to postgres;
revoke all on function bedlink_private.is_dispatcher(),
  bedlink_private.is_nurse_for(uuid), bedlink_private.owns_request(uuid)
  from public, anon, authenticated, service_role;
grant usage on schema public to authenticated, service_role;
grant usage on schema bedlink_private to authenticated, service_role;
grant execute on function bedlink_private.is_dispatcher(),
  bedlink_private.is_nurse_for(uuid), bedlink_private.owns_request(uuid)
  to authenticated, service_role;
grant execute on function bedlink_private.array_is_set(anyarray) to service_role;

create policy memberships_read_self on public.staff_memberships
  for select to authenticated using (user_id = (select auth.uid()));

create policy hospitals_read_authorized on public.hospitals
  for select to authenticated using
    ((select bedlink_private.is_dispatcher()) or bedlink_private.is_nurse_for(id));

create policy bed_pools_read_authorized on public.bed_pools
  for select to authenticated using
    ((select bedlink_private.is_dispatcher()) or bedlink_private.is_nurse_for(hospital_id));

create policy requests_read_owner on public.patient_requests
  for select to authenticated using
    ((select bedlink_private.is_dispatcher()) and owner_id = (select auth.uid()));

create policy attempts_read_participant on public.hospital_attempts
  for select to authenticated using
    (bedlink_private.owns_request(request_id) or bedlink_private.is_nurse_for(hospital_id));

create policy holds_read_participant on public.holds
  for select to authenticated using
    (bedlink_private.owns_request(request_id) or bedlink_private.is_nurse_for(hospital_id));

grant select on table public.hospitals, public.staff_memberships, public.bed_pools,
  public.patient_requests, public.hospital_attempts, public.holds to authenticated;

-- No client INSERT/UPDATE/DELETE grants or policies, even for a nurse's own pool.
-- A direct PATCH cannot provide version checks, idempotency and inventory locking.
-- Idempotency has no client table privileges and no client RLS policy at all.
grant select, insert, update, delete on table public.hospitals, public.staff_memberships,
  public.bed_pools, public.patient_requests, public.hospital_attempts, public.holds,
  bedlink_private.idempotency_records to service_role;

-- Narrow, deliberately owner-executed read projections. Nurses cannot SELECT the
-- patient_requests base rows, since RLS cannot hide owner_id/history columns.
-- Every projected row independently checks the session caller's current assignment.
create view public.hospital_incoming_attempts
with (security_barrier = true, security_invoker = false)
as
select a.id as attempt_id, a.request_id, a.hospital_id, a.bed_pool_id,
  a.status as attempt_status, a.created_at as attempt_created_at,
  a.response_deadline_at, a.resolved_at, a.reason_code,
  r.patient_reference, r.latitude, r.longitude, r.resources, r.specialty
from public.hospital_attempts a
join public.patient_requests r on r.id = a.request_id
where bedlink_private.is_nurse_for(a.hospital_id)
  and a.status = 'pending' and a.response_deadline_at > statement_timestamp();

create view public.hospital_active_holds
with (security_barrier = true, security_invoker = false)
as
select h.id as hold_id, h.request_id, h.attempt_id, h.hospital_id, h.bed_pool_id,
  h.status as hold_status, h.created_at as hold_created_at, h.expires_at,
  h.ended_at, h.end_reason,
  r.patient_reference, r.latitude, r.longitude, r.resources, r.specialty
from public.holds h
join public.patient_requests r on r.id = h.request_id
where bedlink_private.is_nurse_for(h.hospital_id)
  and h.status = 'active' and h.expires_at > statement_timestamp();

alter view public.hospital_incoming_attempts owner to postgres;
alter view public.hospital_active_holds owner to postgres;
revoke all on table public.hospital_incoming_attempts, public.hospital_active_holds
  from public, anon, authenticated, service_role;
grant select on table public.hospital_incoming_attempts, public.hospital_active_holds
  to authenticated, service_role;
comment on view public.hospital_incoming_attempts is
  'Minimal currently pending patient information for the caller-assigned hospital. Not a complete REST inbox or a timeout settlement function.';
comment on view public.hospital_active_holds is
  'Minimal patient information for live holds at the caller-assigned hospital. Owner-executed projection with explicit auth.uid()-based authorization; no owner_id.';

commit;
