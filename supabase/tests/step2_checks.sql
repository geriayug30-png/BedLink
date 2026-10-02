-- Execute with psql -X -v ON_ERROR_STOP=1 against a disposable local database.
-- Requires the two migrations. Every fixture and test helper is rolled back.
begin;
do $$
begin
  if current_setting('bedlink.test_disposable', true) is distinct from 'yes' then
    raise exception 'Set bedlink.test_disposable=yes only for a disposable local database';
  end if;
end;
$$;

create function pg_temp.assert_true(condition boolean, label text)
returns void language plpgsql as $$
begin
  if condition is distinct from true then raise exception 'FAIL: %', label; end if;
  raise notice 'PASS: %', label;
end;
$$;
create function pg_temp.expect_sqlstate(command text, expected text, label text)
returns void language plpgsql as $$
declare actual text;
begin
  begin
    execute command;
  exception when others then
    get stacked diagnostics actual = returned_sqlstate;
    if actual <> expected then
      raise exception 'FAIL: %, expected SQLSTATE %, got % (%)', label, expected, actual, sqlerrm;
    end if;
    raise notice 'PASS: %', label;
    return;
  end;
  raise exception 'FAIL: %, expected SQLSTATE %, command succeeded', label, expected;
end;
$$;
-- Let the emulated client roles call only these session-local assertion helpers.
do $$
begin
  execute format('grant usage on schema %I to anon, authenticated, service_role',
    (select nspname from pg_namespace where oid = pg_my_temp_schema()));
end;
$$;

-- Synthetic Auth identities exist only inside this rolled-back transaction.
insert into auth.users(id) values
  ('90000000-0000-4000-8000-000000000001'), -- dispatcher A
  ('90000000-0000-4000-8000-000000000002'), -- dispatcher B
  ('90000000-0000-4000-8000-000000000003'), -- nurse hospital A
  ('90000000-0000-4000-8000-000000000004'), -- nurse hospital B
  ('90000000-0000-4000-8000-000000000005'); -- authenticated but unassigned
insert into public.hospitals(id, name, latitude, longitude) values
  ('91000000-0000-4000-8000-000000000001', 'TEST ONLY Hospital A', 12.9, 77.6),
  ('91000000-0000-4000-8000-000000000002', 'TEST ONLY Hospital B', 13.0, 77.7);
insert into public.staff_memberships(user_id, role, hospital_id) values
  ('90000000-0000-4000-8000-000000000001', 'dispatcher', null),
  ('90000000-0000-4000-8000-000000000002', 'dispatcher', null),
  ('90000000-0000-4000-8000-000000000003', 'nurse', '91000000-0000-4000-8000-000000000001'),
  ('90000000-0000-4000-8000-000000000004', 'nurse', '91000000-0000-4000-8000-000000000002');
insert into public.bed_pools(id, hospital_id, label, resources, specialties, capacity, reported_free_beds, verified_at) values
  ('92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', 'TEST ICU A',
    '{icu,ventilator,oxygen}', '{cardiac}', 3, 2, now() - interval '1 minute'),
  ('92000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000002', 'TEST ICU B',
    '{icu,ventilator,oxygen}', '{cardiac,burns}', 3, 2, now() - interval '1 minute');
insert into public.patient_requests(id, owner_id, patient_reference, latitude, longitude, resources, specialty, status, created_at) values
  ('93000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', 'TEST_ANON_A', 12.9, 77.6, '{icu,oxygen}', 'cardiac', 'pending', now()-interval '60 seconds'),
  ('93000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000002', 'TEST_ANON_B', 12.9, 77.6, '{icu,oxygen}', 'burns', 'pending', now()-interval '60 seconds'),
  ('93000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000001', 'TEST_ANON_C', 12.9, 77.6, '{icu,oxygen}', 'cardiac', 'held', now()-interval '60 seconds'),
  ('93000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000002', 'TEST_ANON_D', 12.9, 77.6, '{oxygen}', null, 'searching', now()-interval '60 seconds');
insert into public.hospital_attempts(id, request_id, hospital_id, bed_pool_id, created_at, response_deadline_at, status, resolved_at) values
  ('94000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001',now()-interval '30 seconds',now()+interval '90 seconds','pending',null),
  ('94000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000002','91000000-0000-4000-8000-000000000002','92000000-0000-4000-8000-000000000002',now()-interval '30 seconds',now()+interval '90 seconds','pending',null),
  ('94000000-0000-4000-8000-000000000003','93000000-0000-4000-8000-000000000003','91000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001',now()-interval '30 seconds',now()+interval '90 seconds','accepted',now()-interval '20 seconds'),
  ('94000000-0000-4000-8000-000000000004','93000000-0000-4000-8000-000000000003','91000000-0000-4000-8000-000000000002','92000000-0000-4000-8000-000000000002',now()-interval '30 seconds',now()+interval '90 seconds','accepted',now()-interval '20 seconds');
-- The fourth accepted attempt is a structural test target, not a simulated workflow.
insert into public.holds(id, request_id, attempt_id, hospital_id, bed_pool_id, created_at, expires_at) values
  ('95000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000003','94000000-0000-4000-8000-000000000003','91000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001',now()-interval '20 seconds',now()+interval '880 seconds');

select pg_temp.assert_true((select count(*)=7 from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where (n.nspname='public' and c.relname in ('hospitals','staff_memberships','bed_pools','patient_requests','hospital_attempts','holds')
    or n.nspname='bedlink_private' and c.relname='idempotency_records') and c.relrowsecurity), 'RLS enabled on every application table');
select pg_temp.assert_true(not exists (
  select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
  cross join (values ('anon'),('authenticated')) as client(role_name)
  cross join (values ('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('TRIGGER'),('REFERENCES')) as operation(privilege_name)
  where (n.nspname='public' and c.relname in ('hospitals','staff_memberships','bed_pools','patient_requests','hospital_attempts','holds','hospital_incoming_attempts','hospital_active_holds')
    or n.nspname='bedlink_private' and c.relname='idempotency_records')
    and has_table_privilege(client.role_name, c.oid, operation.privilege_name)
), 'no client mutation, trigger or truncate privileges on any application relation');
select pg_temp.assert_true((select count(*)=3 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='bedlink_private' and p.proname in ('is_dispatcher','is_nurse_for','owns_request')
    and p.prosecdef and p.proconfig @> array['search_path=""']), 'authorization helpers have fixed empty search_path');
select pg_temp.expect_sqlstate($q$update public.hospitals set name='A'||repeat(' ',120) where id='91000000-0000-4000-8000-000000000001'$q$, '23514','hospital name obeys wire length including whitespace');
select pg_temp.expect_sqlstate($q$update public.bed_pools set reported_free_beds=-1 where id='92000000-0000-4000-8000-000000000001'$q$, '23514','negative free count rejected');
select pg_temp.expect_sqlstate($q$update public.bed_pools set reported_free_beds=4 where id='92000000-0000-4000-8000-000000000001'$q$, '23514','free count above capacity rejected');
select pg_temp.expect_sqlstate($q$update public.bed_pools set capacity=0 where id='92000000-0000-4000-8000-000000000001'$q$, '23514','zero capacity rejected');
select pg_temp.expect_sqlstate($q$update public.bed_pools set version=0 where id='92000000-0000-4000-8000-000000000001'$q$, '23514','zero version rejected');
select pg_temp.expect_sqlstate($q$update public.hospitals set latitude=91 where id='91000000-0000-4000-8000-000000000001'$q$, '23514','latitude range enforced');
select pg_temp.expect_sqlstate($q$update public.patient_requests set longitude=-181 where id='93000000-0000-4000-8000-000000000001'$q$, '23514','longitude range enforced');
select pg_temp.expect_sqlstate($q$update public.hospitals set latitude='NaN'::double precision where id='91000000-0000-4000-8000-000000000001'$q$, '23514','NaN latitude rejected');
select pg_temp.expect_sqlstate($q$update public.bed_pools set resources='{icu,icu}' where id='92000000-0000-4000-8000-000000000001'$q$, '23514','duplicate resources rejected');
select pg_temp.expect_sqlstate($q$update public.bed_pools set resources='{}' where id='92000000-0000-4000-8000-000000000001'$q$, '23514','empty resources rejected');
select pg_temp.expect_sqlstate($q$update public.bed_pools set resources='{icu,NULL}' where id='92000000-0000-4000-8000-000000000001'$q$, '23514','null resource rejected');
select pg_temp.expect_sqlstate($q$update public.bed_pools set resources='{cardiac}' where id='92000000-0000-4000-8000-000000000001'$q$, '22P02','specialty is not a resource');
select pg_temp.expect_sqlstate($q$update public.patient_requests set specialty='unknown' where id='93000000-0000-4000-8000-000000000001'$q$, '22P02','invalid specialty rejected');
select pg_temp.expect_sqlstate($q$update public.staff_memberships set role='admin' where user_id='90000000-0000-4000-8000-000000000003'$q$, '22P02','invalid role rejected');
select pg_temp.expect_sqlstate($q$update public.staff_memberships set hospital_id=null where user_id='90000000-0000-4000-8000-000000000003'$q$, '23514','nurse requires hospital');
select pg_temp.expect_sqlstate($q$update public.staff_memberships set hospital_id='91000000-0000-4000-8000-000000000001' where user_id='90000000-0000-4000-8000-000000000001'$q$, '23514','dispatcher cannot have nurse assignment');
select pg_temp.expect_sqlstate($q$update public.patient_requests set status='accepted' where id='93000000-0000-4000-8000-000000000001'$q$, '22P02','request status separate from attempt status');
select pg_temp.expect_sqlstate($q$update public.hospital_attempts set response_deadline_at=created_at+interval '119 seconds' where id='94000000-0000-4000-8000-000000000001'$q$, '23514','exact 120-second deadline enforced');
select pg_temp.expect_sqlstate($q$update public.hospital_attempts set status='accepted', resolved_at=response_deadline_at where id='94000000-0000-4000-8000-000000000001'$q$, '23514','acceptance timestamp at deadline rejected');
select pg_temp.expect_sqlstate($q$update public.hospital_attempts set status='rejected', resolved_at=now(), reason_code=null where id='94000000-0000-4000-8000-000000000001'$q$, '23514','rejection requires reason');
select pg_temp.expect_sqlstate($q$update public.holds set expires_at=created_at where id='95000000-0000-4000-8000-000000000001'$q$, '23514','hold expiry after creation');
select pg_temp.expect_sqlstate($q$update public.holds set status='arrived', ended_at=expires_at, end_reason='ambulance_arrived' where id='95000000-0000-4000-8000-000000000001'$q$, '23514','arrival timestamp at expiry rejected');

select pg_temp.expect_sqlstate($q$insert into public.hospital_attempts(request_id,hospital_id,bed_pool_id,response_deadline_at)
  values('93000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000002','92000000-0000-4000-8000-000000000002',now()+interval '120 seconds')$q$, '23505','second pending attempt rejected');
select pg_temp.expect_sqlstate($q$insert into public.hospital_attempts(request_id,hospital_id,bed_pool_id,status,response_deadline_at,resolved_at,reason_code)
  values('93000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001','rejected',now()+interval '120 seconds',now(),'other')$q$, '23505','hospital cannot be reattempted');
select pg_temp.expect_sqlstate($q$update public.hospital_attempts set bed_pool_id='92000000-0000-4000-8000-000000000002' where id='94000000-0000-4000-8000-000000000001'$q$, '23503','attempt hospital must own selected pool');
select pg_temp.expect_sqlstate($q$insert into public.holds(request_id,attempt_id,hospital_id,bed_pool_id,expires_at)
  values('93000000-0000-4000-8000-000000000003','94000000-0000-4000-8000-000000000004','91000000-0000-4000-8000-000000000002','92000000-0000-4000-8000-000000000002',now()+interval '15 minutes')$q$, '23505','second active hold for request rejected');
select pg_temp.expect_sqlstate($q$insert into public.holds(request_id,attempt_id,hospital_id,bed_pool_id,expires_at,status,ended_at,end_reason)
  values('93000000-0000-4000-8000-000000000003','94000000-0000-4000-8000-000000000003','91000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001',now()+interval '15 minutes','cancelled',now(),'other')$q$, '23505','one hold per attempt including terminal holds');
select pg_temp.expect_sqlstate($q$update public.holds set request_id='93000000-0000-4000-8000-000000000004' where id='95000000-0000-4000-8000-000000000001'$q$, '23503','hold must reference same request as attempt');
select pg_temp.expect_sqlstate($q$update public.holds set bed_pool_id='92000000-0000-4000-8000-000000000002' where id='95000000-0000-4000-8000-000000000001'$q$, '23503','hold must reference same pool as attempt');
select pg_temp.expect_sqlstate($q$update public.holds set hospital_id='91000000-0000-4000-8000-000000000002' where id='95000000-0000-4000-8000-000000000001'$q$, '23503','hold must reference same hospital as attempt');
select pg_temp.expect_sqlstate($q$insert into public.holds(request_id,attempt_id,hospital_id,bed_pool_id,expires_at)
  values('93000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001',now()+interval '15 minutes')$q$, '23503','hold requires accepted attempt');
select pg_temp.expect_sqlstate($q$delete from public.hospital_attempts where id='94000000-0000-4000-8000-000000000003'$q$, '23503','accepted attempt history cannot be cascade deleted');
select pg_temp.expect_sqlstate($q$delete from auth.users where id='90000000-0000-4000-8000-000000000001'$q$, '23503','request owner deletion is restricted');

insert into bedlink_private.idempotency_records(issuer,actor_id,idempotency_key,http_method,request_path,request_fingerprint)
values ('https://auth.example.test','90000000-0000-4000-8000-000000000001','test-key-001','POST','/api/v1/patient-requests',repeat('a',64));
select pg_temp.expect_sqlstate($q$insert into bedlink_private.idempotency_records(issuer,actor_id,idempotency_key,http_method,request_path,request_fingerprint)
  values('https://auth.example.test','90000000-0000-4000-8000-000000000001','test-key-001','PATCH','/api/v1/hospitals/pools',repeat('b',64))$q$, '23505','idempotency key is actor-scoped across paths');
insert into bedlink_private.idempotency_records(issuer,actor_id,idempotency_key,http_method,request_path,request_fingerprint)
values ('https://auth.example.test','90000000-0000-4000-8000-000000000002','test-key-001','POST','/api/v1/patient-requests',repeat('b',64));
select pg_temp.assert_true((select count(*)=2 from bedlink_private.idempotency_records where issuer='https://auth.example.test'), 'different actors may reuse a key');
select pg_temp.expect_sqlstate($q$update bedlink_private.idempotency_records set status='completed' where issuer='https://auth.example.test'$q$, '23514','completed idempotency record requires a durable response');

-- Observe inventory rather than mutating it: reads must not verify or bump version.
create temporary table pool_before as select id,verified_at,version from public.bed_pools;
select pg_temp.assert_true((select reported_free_beds - (select count(*) from public.holds h
  where h.bed_pool_id=p.id and h.status='active' and h.expires_at>statement_timestamp())=1
  from public.bed_pools p where p.id='92000000-0000-4000-8000-000000000001'), 'held beds are included in reported free and subtracted for availability');
select pg_temp.assert_true(not exists(select 1 from public.bed_pools p join pool_before b using(id)
  where p.verified_at is distinct from b.verified_at or p.version<>b.version), 'reads do not refresh verification or version');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"90000000-0000-4000-8000-000000000001"}',true);
select pg_temp.assert_true((select count(*)=2 from public.patient_requests), 'dispatcher sees only owned requests');
select pg_temp.assert_true(not exists(select 1 from public.patient_requests where id='93000000-0000-4000-8000-000000000002'), 'dispatcher cannot read another owner request');
select pg_temp.assert_true((select count(*)=3 from public.hospital_attempts), 'dispatcher sees own attempt history only');
select pg_temp.assert_true((select count(*)=1 from public.holds), 'dispatcher sees own holds only');
select pg_temp.assert_true((select count(*)=2 from public.hospitals where name like 'TEST ONLY%'), 'dispatcher can read configured catalog');
select pg_temp.assert_true((select count(*)=1 from public.staff_memberships), 'membership reads limited to self');
select pg_temp.expect_sqlstate($q$update public.patient_requests set owner_id='90000000-0000-4000-8000-000000000001'$q$, '42501','dispatcher cannot steal or directly mutate requests');
select pg_temp.expect_sqlstate($q$insert into public.patient_requests(owner_id,patient_reference,latitude,longitude,resources) values('90000000-0000-4000-8000-000000000001','TEST_NEW',0,0,'{oxygen}')$q$, '42501','request writes require future transactional functions');
select pg_temp.expect_sqlstate($q$select * from bedlink_private.idempotency_records$q$, '42501','idempotency records hidden even from their actor');
select pg_temp.assert_true((select count(*)=0 from public.hospital_incoming_attempts), 'dispatcher cannot use nurse projection');

-- Forged editable role/hospital metadata must not override trusted memberships.
select set_config('request.jwt.claims','{"sub":"90000000-0000-4000-8000-000000000003","user_metadata":{"role":"dispatcher","hospitalId":"91000000-0000-4000-8000-000000000002"}}',true);
select pg_temp.assert_true((select count(*)=1 from public.hospitals), 'nurse reads assigned hospital only');
select pg_temp.assert_true((select count(*)=1 from public.bed_pools), 'nurse reads assigned inventory only');
select pg_temp.assert_true((select count(*)=0 from public.patient_requests), 'nurse cannot read patient base rows or owner IDs');
select pg_temp.assert_true((select count(*)=2 from public.hospital_attempts), 'nurse cannot read other hospitals attempts');
select pg_temp.assert_true((select count(*)=1 from public.hospital_incoming_attempts where patient_reference='TEST_ANON_A'), 'assigned nurse receives minimal pending patient fields');
select pg_temp.assert_true((select count(*)=1 from public.hospital_active_holds where patient_reference='TEST_ANON_C'), 'assigned nurse receives minimal active hold patient fields');
select pg_temp.expect_sqlstate($q$select owner_id from public.hospital_incoming_attempts$q$, '42703','nurse projection omits dispatcher owner');
select pg_temp.expect_sqlstate($q$update public.bed_pools set reported_free_beds=0 where hospital_id='91000000-0000-4000-8000-000000000002'$q$, '42501','cross-hospital nurse write denied');
select pg_temp.expect_sqlstate($q$update public.bed_pools set reported_free_beds=0 where hospital_id='91000000-0000-4000-8000-000000000001'$q$, '42501','own-hospital direct writes also require atomic functions');
select pg_temp.expect_sqlstate($q$update public.staff_memberships set role='dispatcher',hospital_id=null$q$, '42501','self promotion denied');
select pg_temp.expect_sqlstate($q$insert into public.staff_memberships(user_id,role) values('90000000-0000-4000-8000-000000000005','dispatcher')$q$, '42501','client membership creation denied');
select pg_temp.expect_sqlstate($q$delete from public.holds$q$, '42501','client hold deletion denied');
select pg_temp.expect_sqlstate($q$update public.hospital_attempts set status='accepted',resolved_at=now()$q$, '42501','client acceptance must use future atomic functions');
select pg_temp.expect_sqlstate($q$insert into public.holds(request_id,attempt_id,bed_pool_id,hospital_id,expires_at) values(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),now()+interval '15 minutes')$q$, '42501','client hold creation denied');

select set_config('request.jwt.claims','{"sub":"90000000-0000-4000-8000-000000000004"}',true);
select pg_temp.assert_true((select count(*)=1 from public.hospital_incoming_attempts where patient_reference='TEST_ANON_B'), 'second hospital sees its own incoming request');
select pg_temp.assert_true((select count(*)=0 from public.hospital_active_holds), 'second hospital cannot see first hospital hold');
select set_config('request.jwt.claims','{"sub":"90000000-0000-4000-8000-000000000005","user_metadata":{"role":"dispatcher"}}',true);
select pg_temp.assert_true((select count(*)=0 from public.hospitals), 'unassigned authenticated user has no catalog access');
select pg_temp.assert_true((select count(*)=0 from public.patient_requests), 'unassigned user has no patient access');
select pg_temp.assert_true((select count(*)=0 from public.hospital_incoming_attempts), 'unassigned user cannot use owner-executed projection');
reset role;

update public.staff_memberships set is_active=false where user_id='90000000-0000-4000-8000-000000000003';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"90000000-0000-4000-8000-000000000003"}',true);
select pg_temp.assert_true((select count(*)=0 from public.bed_pools), 'revoked assignment loses inventory access');
select pg_temp.assert_true((select count(*)=0 from public.hospital_active_holds), 'revoked assignment loses projected patient access');
reset role;

set local role anon;
select set_config('request.jwt.claims','{}',true);
select pg_temp.expect_sqlstate($q$select * from public.hospitals$q$, '42501','anonymous catalog access denied');
select pg_temp.expect_sqlstate($q$select * from public.patient_requests$q$, '42501','anonymous patient access denied');
select pg_temp.expect_sqlstate($q$select * from public.hospital_incoming_attempts$q$, '42501','anonymous projection access denied');
select pg_temp.expect_sqlstate($q$select * from bedlink_private.idempotency_records$q$, '42501','anonymous idempotency access denied');
reset role;

set local role service_role;
select pg_temp.assert_true((select count(*)=2 from bedlink_private.idempotency_records where issuer='https://auth.example.test'), 'trusted service role has privileged idempotency access');
reset role;

rollback;
