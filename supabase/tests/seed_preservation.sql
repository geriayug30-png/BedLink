-- psql-only check for an explicitly disposable local database, after seed.sql.
-- seed.sql manages its own transaction; do not wrap this file in --single-transaction.
-- Temporary changes to the six fictional pool rows are restored after a successful check.
do $$
begin
  if current_setting('bedlink.test_disposable', true) is distinct from 'yes' then
    raise exception 'Requires an explicitly marked disposable local database';
  end if;
  if (select count(*) from public.bed_pools where id::text like '20000000-0000-4000-8000-%') <> 6 then
    raise exception 'Run seed.sql in a disposable database first';
  end if;
end;
$$;

create temporary table seed_original as
select id, reported_free_beds, verified_at, inventory_updated_at, version, updated_at
from public.bed_pools where id::text like '20000000-0000-4000-8000-%';

update public.bed_pools set reported_free_beds=0, verified_at=now()-interval '90 minutes',
  inventory_updated_at=now(), updated_at=now(), version=version+7
where id='20000000-0000-4000-8000-000000000001';

create temporary table seed_expected as
select 'pool' as kind, id, to_jsonb(p) as body from public.bed_pools p
  where id::text like '20000000-0000-4000-8000-%'
union all
select 'hospital', id, to_jsonb(h) from public.hospitals h
  where id::text like '10000000-0000-4000-8000-%';
create temporary table seed_identity_counts as
select (select count(*) from auth.users) as auth_count,
  (select count(*) from public.staff_memberships) as membership_count;

\ir ../seed.sql
\ir ../seed.sql

do $$
begin
  if exists (
    select 1 from seed_expected expected full join (
      select 'pool' as kind, id, to_jsonb(p) as body from public.bed_pools p
        where id::text like '20000000-0000-4000-8000-%'
      union all
      select 'hospital', id, to_jsonb(h) from public.hospitals h
        where id::text like '10000000-0000-4000-8000-%'
    ) actual using(kind,id)
    where expected.body is distinct from actual.body
  ) then
    raise exception 'FAIL: repeated seeding changed or duplicated an existing demo row';
  end if;
  raise notice 'PASS: repeated seeds preserve every existing demo field, including changed counts, versions and verification times';
  if (select auth_count<>(select count(*) from auth.users)
    or membership_count<>(select count(*) from public.staff_memberships) from seed_identity_counts) then
    raise exception 'FAIL: seed created an Auth identity or membership';
  end if;
  raise notice 'PASS: seed creates no Auth users or memberships';
end;
$$;

update public.bed_pools p set reported_free_beds=b.reported_free_beds,
  verified_at=b.verified_at, inventory_updated_at=b.inventory_updated_at,
  version=b.version, updated_at=b.updated_at
from seed_original b where b.id=p.id;
drop table seed_original, seed_expected, seed_identity_counts;
