-- TEST ADAPTER ONLY: for a newly created, disposable plain PostgreSQL database.
-- Never run this in Supabase (which already supplies auth.users, auth.uid and roles).
-- No Auth service, token verification, credentials or real users are provisioned.
begin;
do $$
begin
  if current_setting('bedlink.test_disposable', true) is distinct from 'yes'
    or current_database() not like 'bedlink_step2_%' then
    raise exception 'Requires an explicitly marked disposable bedlink_step2_* database';
  end if;
  if exists (select 1 from pg_namespace where nspname = 'auth') then
    raise exception 'auth already exists; refusing to replace it';
  end if;
end;
$$;
do $$
begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
  if exists (select 1 from pg_roles where rolname in ('anon','authenticated','service_role')
    and (rolsuper or rolcanlogin or (rolname in ('anon','authenticated') and rolbypassrls)
      or (rolname='service_role' and not rolbypassrls))) then
    raise exception 'Existing emulation roles have unexpected privileges; refusing to modify them';
  end if;
end;
$$;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable
set search_path = ''
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
commit;
