-- Step 5. Backend-only transactional orchestration; no browser mutation grants.
begin;
do $$ begin
  if not exists(select 1 from pg_roles where rolname='bedlink_api') then create role bedlink_api nologin noinherit; end if;
  if not exists(select 1 from pg_roles where rolname='bedlink_worker') then create role bedlink_worker nologin noinherit; end if;
  if exists(select 1 from pg_roles where rolname in ('bedlink_api','bedlink_worker') and (rolsuper or rolbypassrls or rolcanlogin)) then
    raise exception 'Unexpected BedLink role privileges';
  end if;
end $$;
grant usage on schema public to bedlink_api,bedlink_worker;

-- Small-catalog prototype: serialize short inventory/lifecycle transactions.
-- The two-int advisory namespace cannot collide with bigint idempotency keys.
-- Lock order: membership, nonblocking actor/key, this gate, request, pool, children.
create function bedlink_private.lifecycle_gate() returns void language sql set search_path='' as $$
  select pg_advisory_xact_lock(42105,1);
$$;

create function bedlink_private.wire_reason(v text) returns text language sql immutable set search_path='' as $$
  select case v when 'no_longer_needed' then 'noLongerNeeded' when 'cannot_receive' then 'cannotReceive'
    when 'capacity_changed' then 'capacityChanged' when 'response_timeout' then 'responseTimeout'
    when 'request_cancelled' then 'requestCancelled' when 'ambulance_arrived' then 'ambulanceArrived'
    when 'transport_plan_changed' then 'transportPlanChanged' when 'hold_expired' then 'holdExpired' else v end;
$$;
create function bedlink_private.db_reason(v text) returns text language sql immutable set search_path='' as $$
  select case v when 'noLongerNeeded' then 'no_longer_needed' when 'cannotReceive' then 'cannot_receive'
    when 'capacityChanged' then 'capacity_changed' when 'transportPlanChanged' then 'transport_plan_changed' else v end;
$$;
create function bedlink_private.needs_json(r public.patient_requests) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('location',jsonb_build_object('latitude',r.latitude,'longitude',r.longitude),
    'resources',to_jsonb(r.resources),'specialty',r.specialty);
$$;
create function bedlink_private.attempt_json(a public.hospital_attempts) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('id',a.id,'requestId',a.request_id,'hospitalId',a.hospital_id,'bedPoolId',a.bed_pool_id,
    'status',case when a.status='timed_out' then 'timedOut' else a.status::text end,
    'createdAt',bedlink_private.api_time(a.created_at),'responseDeadlineAt',bedlink_private.api_time(a.response_deadline_at),
    'resolvedAt',bedlink_private.api_time(a.resolved_at),'reasonCode',bedlink_private.wire_reason(a.reason_code));
$$;
create function bedlink_private.hold_json(h public.holds) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('id',h.id,'requestId',h.request_id,'attemptId',h.attempt_id,'hospitalId',h.hospital_id,
    'bedPoolId',h.bed_pool_id,'status',h.status,'createdAt',bedlink_private.api_time(h.created_at),
    'expiresAt',bedlink_private.api_time(h.expires_at),'endedAt',bedlink_private.api_time(h.ended_at),
    'endReason',bedlink_private.wire_reason(h.end_reason));
$$;
create function bedlink_private.request_json(r public.patient_requests) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('id',r.id,'ownerId',r.owner_id,'patientReference',r.patient_reference,
    'needs',bedlink_private.needs_json(r),'status',r.status,'createdAt',bedlink_private.api_time(r.created_at),
    'updatedAt',bedlink_private.api_time(r.updated_at),'cancellationReason',bedlink_private.wire_reason(r.cancellation_reason),
    'activeAttemptId',(select id from public.hospital_attempts where request_id=r.id and status='pending'),
    'activeHoldId',(select id from public.holds where request_id=r.id and status='active'));
$$;
create function bedlink_private.request_body(r public.patient_requests,t timestamptz) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('serverTime',bedlink_private.api_time(t),'request',bedlink_private.request_json(r),
    'attempts',(select coalesce(jsonb_agg(bedlink_private.attempt_json(a) order by a.created_at,a.id),'[]'::jsonb) from public.hospital_attempts a where a.request_id=r.id),
    'holds',(select coalesce(jsonb_agg(bedlink_private.hold_json(h) order by h.created_at,h.id),'[]'::jsonb) from public.holds h where h.request_id=r.id),
    'activeHold',(select bedlink_private.hold_json(h) from public.holds h where h.request_id=r.id and h.status='active'), 'nextBest',null);
$$;

create function bedlink_private.settle_due(target_request uuid default null,target_pool uuid default null,batch_limit integer default 0,at_time timestamptz default null)
returns integer language plpgsql set search_path='' as $$
declare r public.patient_requests; a public.hospital_attempts; h public.holds;
  t timestamptz:=coalesce(at_time,date_trunc('milliseconds',clock_timestamp())); n integer:=0;
begin
  -- Caller holds lifecycle_gate. Persist deadlines as their effective transition time.
  for r in select p.* from public.patient_requests p where (target_request is null or p.id=target_request) and (
    exists(select 1 from public.hospital_attempts x where x.request_id=p.id and x.status='pending' and x.response_deadline_at<=t and (target_pool is null or x.bed_pool_id=target_pool))
    or exists(select 1 from public.holds x where x.request_id=p.id and x.status='active' and x.expires_at<=t and (target_pool is null or x.bed_pool_id=target_pool)))
    order by p.id limit nullif(batch_limit,0) for update
  loop
    for a in select * from public.hospital_attempts where request_id=r.id and status='pending' and response_deadline_at<=t loop
      update public.hospital_attempts set status='timed_out',resolved_at=a.response_deadline_at,reason_code='response_timeout',updated_at=t where id=a.id;
      update public.patient_requests set status='searching',updated_at=a.response_deadline_at where id=r.id and status='pending';
    end loop;
    for h in select * from public.holds where request_id=r.id and status='active' and expires_at<=t loop
      perform 1 from public.bed_pools where id=h.bed_pool_id for update;
      update public.holds set status='expired',ended_at=h.expires_at,end_reason='hold_expired',updated_at=t where id=h.id;
      update public.bed_pools set version=version+1,inventory_updated_at=greatest(inventory_updated_at,h.expires_at),updated_at=greatest(updated_at,t) where id=h.bed_pool_id;
      update public.patient_requests set status='searching',updated_at=h.expires_at where id=r.id and status='held';
    end loop;
    n:=n+1;
  end loop;
  return n;
end;
$$;

-- Authorization is repeated in the final transaction, including cached replays.
create function bedlink_private.workflow_authorize(action text,p jsonb) returns jsonb language plpgsql set search_path='' as $$
declare m public.staff_memberships; rid uuid; hid uuid; a public.hospital_attempts; h public.holds;
  t timestamptz:=date_trunc('milliseconds',clock_timestamp());
begin
  if auth.uid() is null then return bedlink_private.api_error(401,'UNAUTHENTICATED','Authentication required.',t); end if;
  select * into m from public.staff_memberships where user_id=auth.uid() for share;
  if not found or not m.is_active then return bedlink_private.api_error(403,'FORBIDDEN','Active staff membership required.',t); end if;
  if action not in ('create','send','status','inbox','accept','reject','arrival','cancelRequest','cancelHold') then
    return bedlink_private.api_error(400,'INVALID_INPUT','Unknown operation.',t);
  end if;
  if (action in ('create','send','status','cancelRequest','cancelHold') and m.role<>'dispatcher')
    or (action in ('inbox','accept','reject') and m.role<>'nurse') then
    return bedlink_private.api_error(403,'FORBIDDEN','Operation not permitted for this role.',t);
  end if;
  rid:=(p->>'requestId')::uuid; hid:=(p->>'hospitalId')::uuid;
  if action in ('inbox','accept','reject') then
    if hid is null or hid<>m.hospital_id then return bedlink_private.api_error(404,'NOT_FOUND','Resource not found.',t); end if;
    if action<>'inbox' then
      select * into a from public.hospital_attempts where id=(p->>'attemptId')::uuid and hospital_id=hid;
      if not found then return bedlink_private.api_error(404,'NOT_FOUND','Resource not found.',t); end if;
      rid:=a.request_id;
    end if;
  end if;
  if action in ('arrival','cancelHold') then
    select * into h from public.holds where id=coalesce(p->>'holdId',p#>>'{body,holdId}')::uuid and request_id=rid;
    if not found or (m.role='nurse' and h.hospital_id<>m.hospital_id) then
      return bedlink_private.api_error(404,'NOT_FOUND','Resource not found.',t);
    end if;
  end if;
  if action not in ('create','inbox') then
    if not exists(select 1 from public.patient_requests where id=rid and
      (m.role='nurse' or owner_id=auth.uid())) then return bedlink_private.api_error(404,'NOT_FOUND','Resource not found.',t); end if;
  end if;
  return jsonb_build_object('requestId',rid,'hospitalId',hid);
exception when invalid_text_representation then
  return bedlink_private.api_error(404,'NOT_FOUND','Resource not found.',t);
end;
$$;

create function bedlink_private.workflow_path(action text,p jsonb) returns text language sql immutable set search_path='' as $$
  select case action when 'create' then '/api/v1/patient-requests'
    when 'send' then '/api/v1/patient-requests/'||(p->>'requestId')||'/attempts'
    when 'accept' then '/api/v1/hospitals/'||(p->>'hospitalId')||'/attempts/'||(p->>'attemptId')||'/accept'
    when 'reject' then '/api/v1/hospitals/'||(p->>'hospitalId')||'/attempts/'||(p->>'attemptId')||'/reject'
    when 'arrival' then '/api/v1/patient-requests/'||(p->>'requestId')||'/arrivals'
    when 'cancelRequest' then '/api/v1/patient-requests/'||(p->>'requestId')||'/cancellations'
    when 'cancelHold' then '/api/v1/patient-requests/'||(p->>'requestId')||'/holds/'||(p->>'holdId')||'/cancellations' end;
$$;

-- Only the verified backend role can call these entry points. The HTTP boundary
-- validates strict request schemas; SQL independently enforces state/inventory/auth.
create function public.bedlink_workflow_context(action text,p jsonb,key text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare authorized jsonb; r public.patient_requests; needs jsonb; catalog jsonb;
  t timestamptz:=date_trunc('milliseconds',clock_timestamp()); v_context_issuer text; fingerprint text; prior bedlink_private.idempotency_records;
begin
  authorized:=bedlink_private.workflow_authorize(action,p);
  if authorized ? 'status' then return authorized; end if;
  if action not in ('status','inbox') then
    v_context_issuer:=nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'iss';
    if v_context_issuer is null then return bedlink_private.api_error(401,'UNAUTHENTICATED','Verified issuer required.',t); end if;
    if key is null or key='' then return bedlink_private.api_error(400,'IDEMPOTENCY_KEY_REQUIRED','Idempotency-Key is required.',t); end if;
    if key !~ '^[A-Za-z0-9._:-]{8,128}$' then return bedlink_private.api_error(400,'INVALID_INPUT','Invalid Idempotency-Key.',t); end if;
    if not pg_try_advisory_xact_lock(hashtextextended(v_context_issuer||chr(10)||auth.uid()||chr(10)||key,0)) then
      return jsonb_set(bedlink_private.api_error(409,'IDEMPOTENCY_IN_PROGRESS','Request is still in progress.',t),'{headers}','{"Retry-After":"1"}');
    end if;
    fingerprint:=encode(sha256(convert_to('POST'||chr(10)||bedlink_private.workflow_path(action,p)||chr(10)||(p->'body')::text,'UTF8')),'hex');
    select * into prior from bedlink_private.idempotency_records i where i.issuer=v_context_issuer and actor_id=auth.uid() and idempotency_key=key;
    if found and (prior.status='in_progress' or prior.expires_at>t) then
      if prior.request_fingerprint<>fingerprint then return bedlink_private.api_error(409,'IDEMPOTENCY_KEY_REUSED','Key was used for a different request.',t); end if;
      if prior.status='completed' then return jsonb_build_object('status',prior.response_status,'body',prior.response_body,'headers',prior.response_headers||'{"Idempotency-Replayed":"true"}'); end if;
      return jsonb_set(bedlink_private.api_error(409,'IDEMPOTENCY_IN_PROGRESS','Request is still in progress.',t),'{headers}','{"Retry-After":"1"}');
    end if;
  end if;
  if action='create' then needs:=p#>'{body,needs}';
  elsif action in ('status','reject','cancelHold') then
    select * into r from public.patient_requests where id=(authorized->>'requestId')::uuid;
    needs:=bedlink_private.needs_json(r);
  else return jsonb_build_object('status',200,'body',jsonb_build_object('serverTime',bedlink_private.api_time(clock_timestamp()))); end if;
  catalog:=public.bedlink_read_availability(null);
  if (catalog->>'status')::integer<>200 then return catalog; end if;
  return jsonb_build_object('status',200,'body',jsonb_build_object('serverTime',catalog#>'{body,serverTime}',
    'needs',needs,'hospitals',catalog#>'{body,hospitals}'));
end;
$$;

create function public.bedlink_workflow(action text,p jsonb,key text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare authorized jsonb; rid uuid; r public.patient_requests; a public.hospital_attempts; h public.holds; pool public.bed_pools;
  t timestamptz; v_issuer text; fingerprint text; route text; prior bedlink_private.idempotency_records;
  result jsonb; body jsonb:=p->'body'; response jsonb; catalog jsonb; offer jsonb; headers jsonb:='{}'::jsonb;
  conflict text; code integer:=200; held integer; mutation boolean:=action not in ('status','inbox');
begin
  t:=date_trunc('milliseconds',clock_timestamp());
  authorized:=bedlink_private.workflow_authorize(action,p);
  if authorized ? 'status' then return authorized; end if;
  rid:=(authorized->>'requestId')::uuid;
  if mutation then
    v_issuer:=nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'iss';
    if v_issuer is null or char_length(btrim(v_issuer)) not between 1 and 2048 then return bedlink_private.api_error(401,'UNAUTHENTICATED','Verified issuer required.',t); end if;
    if key is null or key='' then return bedlink_private.api_error(400,'IDEMPOTENCY_KEY_REQUIRED','Idempotency-Key is required.',t); end if;
    if key !~ '^[A-Za-z0-9._:-]{8,128}$' then return bedlink_private.api_error(400,'INVALID_INPUT','Invalid Idempotency-Key.',t); end if;
    route:=bedlink_private.workflow_path(action,p);
    fingerprint:=encode(sha256(convert_to('POST'||chr(10)||route||chr(10)||body::text,'UTF8')),'hex');
    if not pg_try_advisory_xact_lock(hashtextextended(v_issuer||chr(10)||auth.uid()||chr(10)||key,0)) then
      return jsonb_set(bedlink_private.api_error(409,'IDEMPOTENCY_IN_PROGRESS','Request is still in progress.',t),'{headers}','{"Retry-After":"1"}');
    end if;
    select * into prior from bedlink_private.idempotency_records where issuer=v_issuer and actor_id=auth.uid() and idempotency_key=key;
    if found and (prior.status='in_progress' or prior.expires_at>t) then
      if prior.request_fingerprint<>fingerprint then return bedlink_private.api_error(409,'IDEMPOTENCY_KEY_REUSED','Key was used for a different request.',t); end if;
      if prior.status='completed' then return jsonb_build_object('status',prior.response_status,'body',prior.response_body,
        'headers',prior.response_headers||'{"Idempotency-Replayed":"true"}'); end if;
      return jsonb_set(bedlink_private.api_error(409,'IDEMPOTENCY_IN_PROGRESS','Request is still in progress.',t),'{headers}','{"Retry-After":"1"}');
    end if;
    if found then delete from bedlink_private.idempotency_records where id=prior.id; end if;
  end if;
  perform bedlink_private.lifecycle_gate();
  -- All due transitions are reconciled before snapshots or decisions. No provider I/O here.
  t:=date_trunc('milliseconds',clock_timestamp());
  perform bedlink_private.settle_due(null,null,0,t);
  if rid is not null then select * into r from public.patient_requests where id=rid for update; end if;
  if action='create' then
    insert into public.patient_requests(owner_id,patient_reference,latitude,longitude,resources,specialty,created_at,updated_at)
      values(auth.uid(),body->>'patientReference',(body#>>'{needs,location,latitude}')::double precision,
        (body#>>'{needs,location,longitude}')::double precision,
        array(select jsonb_array_elements_text(body#>'{needs,resources}'))::public.bed_resource[],
        (body#>>'{needs,specialty}')::public.bed_specialty,t,t) returning * into r;
    rid:=r.id; code:=201; headers:=jsonb_build_object('Location','/api/v1/patient-requests/'||rid);
  elsif action='send' then
    if r.status<>'searching' then conflict:='REQUEST_NOT_SEARCHING';
    elsif exists(select 1 from public.hospital_attempts where request_id=rid and hospital_id=(body->>'hospitalId')::uuid) then conflict:='HOSPITAL_ALREADY_ATTEMPTED';
    else
      select * into pool from public.bed_pools where id=(body->>'bedPoolId')::uuid and hospital_id=(body->>'hospitalId')::uuid for update;
      if not found then return bedlink_private.api_error(404,'NOT_FOUND','Pool not found.',t); end if;
      t:=date_trunc('milliseconds',clock_timestamp());
      if not r.resources <@ pool.resources or (r.specialty is not null and not r.specialty=any(pool.specialties)) then conflict:='POOL_REQUIREMENTS_NOT_MET';
      elsif pool.verified_at is null or pool.verified_at>t or pool.verified_at<=t-interval '30 minutes' then conflict:='AVAILABILITY_OUTDATED';
      else
        select count(*) into held from public.holds where bed_pool_id=pool.id and status='active' and expires_at>t;
        if pool.reported_free_beds-held<1 then conflict:='CAPACITY_UNAVAILABLE'; end if;
      end if;
      if conflict is null then
        insert into public.hospital_attempts(request_id,hospital_id,bed_pool_id,created_at,response_deadline_at,updated_at)
          values(rid,pool.hospital_id,pool.id,t,t+interval '120 seconds',t) returning * into a;
        update public.patient_requests set status='pending',updated_at=t where id=rid returning * into r;
        code:=201; headers:=jsonb_build_object('Location','/api/v1/patient-requests/'||rid);
      end if;
    end if;
  elsif action in ('accept','reject') then
    select * into a from public.hospital_attempts where id=(p->>'attemptId')::uuid;
    select * into pool from public.bed_pools where id=a.bed_pool_id for update;
    t:=date_trunc('milliseconds',clock_timestamp());
    -- Time can advance while obtaining locks. Settle again at the decision instant.
    perform bedlink_private.settle_due(rid,null,0,t);
    select * into a from public.hospital_attempts where id=a.id;
    select * into r from public.patient_requests where id=rid;
    if a.status='timed_out' then conflict:='ATTEMPT_DEADLINE_PASSED';
    elsif a.status<>'pending' or r.status<>'pending' then conflict:='ATTEMPT_NOT_PENDING';
    elsif action='reject' then
      update public.hospital_attempts set status='rejected',resolved_at=t,reason_code=bedlink_private.db_reason(body->>'reasonCode'),updated_at=t where id=a.id returning * into a;
      update public.patient_requests set status='searching',updated_at=t where id=rid returning * into r;
    else
      if not r.resources <@ pool.resources or (r.specialty is not null and not r.specialty=any(pool.specialties)) then conflict:='POOL_REQUIREMENTS_NOT_MET';
      elsif pool.verified_at is null or pool.verified_at>t or pool.verified_at<=t-interval '30 minutes' then conflict:='AVAILABILITY_OUTDATED';
      else
        select count(*) into held from public.holds where bed_pool_id=pool.id and status='active' and expires_at>t;
        if pool.reported_free_beds-held<1 then conflict:='CAPACITY_UNAVAILABLE'; end if;
      end if;
      if conflict is null then
        update public.hospital_attempts set status='accepted',resolved_at=t,updated_at=t where id=a.id returning * into a;
        insert into public.holds(request_id,attempt_id,hospital_id,bed_pool_id,created_at,expires_at,updated_at)
          values(rid,a.id,a.hospital_id,a.bed_pool_id,t,t+interval '900 seconds',t) returning * into h;
        update public.bed_pools set version=version+1,inventory_updated_at=t,updated_at=t where id=pool.id returning * into pool;
        update public.patient_requests set status='held',updated_at=t where id=rid returning * into r;
      end if;
    end if;
  elsif action in ('arrival','cancelHold') then
    select * into h from public.holds where id=coalesce(p->>'holdId',body->>'holdId')::uuid;
    select * into pool from public.bed_pools where id=h.bed_pool_id for update;
    t:=date_trunc('milliseconds',clock_timestamp());
    perform bedlink_private.settle_due(rid,null,0,t);
    select * into h from public.holds where id=h.id;
    select * into r from public.patient_requests where id=rid;
    if h.status='expired' then conflict:='HOLD_EXPIRED';
    elsif h.status<>'active' or r.status<>'held' then conflict:='HOLD_NOT_ACTIVE';
    else
      update public.holds set status=case when action='arrival' then 'arrived'::public.bed_hold_status else 'cancelled'::public.bed_hold_status end,
        ended_at=t,end_reason=case when action='arrival' then 'ambulance_arrived' else bedlink_private.db_reason(body->>'reasonCode') end,updated_at=t where id=h.id returning * into h;
      update public.bed_pools set reported_free_beds=reported_free_beds-case when action='arrival' then 1 else 0 end,
        version=version+1,inventory_updated_at=t,updated_at=t where id=pool.id returning * into pool;
      update public.patient_requests set status=case when action='arrival' then 'arrived'::public.patient_request_status else 'searching'::public.patient_request_status end,
        updated_at=t where id=rid returning * into r;
    end if;
  elsif action='cancelRequest' then
    if r.status in ('arrived','cancelled') then conflict:='REQUEST_TERMINAL';
    else
      update public.hospital_attempts set status='cancelled',resolved_at=t,reason_code='request_cancelled',updated_at=t where request_id=rid and status='pending';
      for h in select * from public.holds where request_id=rid and status='active' loop
        perform 1 from public.bed_pools where id=h.bed_pool_id for update;
        update public.holds set status='cancelled',ended_at=t,end_reason='request_cancelled',updated_at=t where id=h.id;
        update public.bed_pools set version=version+1,inventory_updated_at=t,updated_at=t where id=h.bed_pool_id;
      end loop;
      update public.patient_requests set status='cancelled',cancellation_reason=bedlink_private.db_reason(body->>'reasonCode'),updated_at=t where id=rid returning * into r;
    end if;
  end if;
  if conflict is not null then result:=bedlink_private.api_error(409,conflict,'Operation conflicts with current state. Refetch before choosing another action.',t);
  else
    if action='inbox' then
      response:=jsonb_build_object('serverTime',bedlink_private.api_time(t),
        'pendingAttempts',(select coalesce(jsonb_agg(jsonb_build_object('patient',jsonb_build_object('requestId',q.id,'patientReference',q.patient_reference,'needs',bedlink_private.needs_json(q)),
          'attempt',bedlink_private.attempt_json(x)) order by x.response_deadline_at,x.id),'[]'::jsonb)
          from public.hospital_attempts x join public.patient_requests q on q.id=x.request_id where x.hospital_id=(p->>'hospitalId')::uuid and x.status='pending' and x.response_deadline_at>t),
        'activeHolds',(select coalesce(jsonb_agg(jsonb_build_object('patient',jsonb_build_object('requestId',q.id,'patientReference',q.patient_reference,'needs',bedlink_private.needs_json(q)),
          'hold',bedlink_private.hold_json(x)) order by x.expires_at,x.id),'[]'::jsonb)
          from public.holds x join public.patient_requests q on q.id=x.request_id where x.hospital_id=(p->>'hospitalId')::uuid and x.status='active' and x.expires_at>t));
    elsif action in ('accept','reject') then
      response:=jsonb_build_object('serverTime',bedlink_private.api_time(t),'attempt',bedlink_private.attempt_json(a),'requestStatus',r.status,
        'hold',case when action='accept' then bedlink_private.hold_json(h) else null end,'bedPool',bedlink_private.pool_json(pool,t),'nextBest',null);
    elsif action='arrival' then
      response:=jsonb_build_object('serverTime',bedlink_private.api_time(t),'requestId',rid,'requestStatus','arrived','hold',bedlink_private.hold_json(h),'bedPool',bedlink_private.pool_json(pool,t));
    else response:=bedlink_private.request_body(r,t);
    end if;
    if action<>'inbox' and r.status='searching' then
      -- Private snapshot supplied only to the backend for pure, cached-provider ranking.
      catalog:=bedlink_private.read_availability_v3(null);
      if (catalog->>'status')::integer<>200 then raise exception using errcode='BL001',message='Catalog unavailable'; end if;
      -- Re-anchor all response fields at the catalog observation time.
      t:=(catalog#>>'{body,serverTime}')::timestamptz;
      response:=jsonb_set(response,'{serverTime}',to_jsonb(bedlink_private.api_time(t)));
      if action='reject' then response:=jsonb_set(response,'{bedPool}',bedlink_private.pool_json(pool,t)); end if;
      offer:=jsonb_build_object('needs',bedlink_private.needs_json(r),'hospitals',catalog#>'{body,hospitals}',
        'excludedHospitalIds',(select coalesce(jsonb_agg(hospital_id order by hospital_id),'[]'::jsonb) from public.hospital_attempts where request_id=rid));
    end if;
    result:=jsonb_build_object('status',code,'body',response,'headers',headers);
  end if;
  if mutation then
    -- A committed in-progress row is prohibited by the deferred constraint below.
    insert into bedlink_private.idempotency_records(issuer,actor_id,idempotency_key,http_method,request_path,request_fingerprint,created_at,updated_at)
      values(v_issuer,auth.uid(),key,'POST',route,fingerprint,t,t) returning * into prior;
    result:=result||jsonb_build_object('recordId',prior.id);
  end if;
  if offer is not null then result:=result||jsonb_build_object('offer',offer); end if;
  return result;
end;
$$;

create function public.bedlink_workflow_finish(record_id uuid,result jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t timestamptz:=date_trunc('milliseconds',clock_timestamp()); hdr jsonb; rec bedlink_private.idempotency_records;
begin
  select * into rec from bedlink_private.idempotency_records where id=record_id and actor_id=auth.uid()
    and issuer=nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'iss' and status='in_progress' for update;
  if not found or result->>'status' not in ('200','201','409') or jsonb_typeof(result->'body')<>'object' then
    raise exception using errcode='BL002',message='Invalid transaction result';
  end if;
  hdr:=coalesce(result->'headers','{}'::jsonb)||jsonb_build_object('Idempotency-Replayed','false','Idempotency-Expires-At',bedlink_private.api_time(t+interval '24 hours'));
  update bedlink_private.idempotency_records set status='completed',response_status=(result->>'status')::smallint,
    response_body=result->'body',response_headers=hdr,completed_at=t,expires_at=t+interval '24 hours',updated_at=t where id=record_id;
  return jsonb_build_object('status',(result->>'status')::integer,'body',result->'body','headers',hdr);
end;
$$;

create function bedlink_private.require_completed_replay() returns trigger language plpgsql set search_path='' as $$
begin
  if exists(select 1 from bedlink_private.idempotency_records where id=new.id and status='in_progress') then
    raise exception using errcode='BL002',message='Incomplete idempotency result cannot commit';
  end if;
  return null;
end;
$$;
create constraint trigger idempotency_completed_at_commit after insert or update on bedlink_private.idempotency_records
  deferrable initially deferred for each row execute function bedlink_private.require_completed_replay();

create function public.bedlink_worker_tick(batch_limit integer default 100) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  if batch_limit is null or batch_limit not between 1 and 1000 then raise exception 'Invalid worker batch limit'; end if;
  if not pg_try_advisory_xact_lock(42105,1) then return jsonb_build_object('processed',0,'busy',true); end if;
  return jsonb_build_object('processed',bedlink_private.settle_due(null,null,batch_limit),'busy',false);
end;
$$;

-- Preserve the established availability implementation behind expiry-aware wrappers.

create function bedlink_private.read_availability_v3(p_hospital_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare t timestamptz := date_trunc('milliseconds',clock_timestamp()); result jsonb; hospital jsonb;
begin
  if auth.uid() is null then
    return bedlink_private.api_error(401,'UNAUTHENTICATED','Authentication required.',t);
  end if;
  if not exists(select 1 from public.staff_memberships where user_id=auth.uid() and is_active) then
    return bedlink_private.api_error(403,'FORBIDDEN','Active staff membership required.',t);
  end if;
  -- Deliberately broader than direct-table nurse RLS: catalog only, no patient data.
  select coalesce(jsonb_agg(jsonb_build_object('id',h.id,'name',h.name,
    'location',jsonb_build_object('latitude',h.latitude,'longitude',h.longitude),
    'bedPools',(select coalesce(jsonb_agg(bedlink_private.pool_json(p,t) order by p.id),'[]'::jsonb)
      from public.bed_pools p where p.hospital_id=h.id)) order by h.id),'[]'::jsonb)
    into result from public.hospitals h where p_hospital_id is null or h.id=p_hospital_id;
  if p_hospital_id is null then
    result := jsonb_build_object('serverTime',bedlink_private.api_time(t),'hospitals',result);
  else
    if jsonb_array_length(result)=0 then
      return bedlink_private.api_error(404,'NOT_FOUND','Hospital not found.',t);
    end if;
    hospital := result->0;
    result := jsonb_build_object('serverTime',bedlink_private.api_time(t),
      'hospital',hospital-'bedPools','bedPools',hospital->'bedPools');
  end if;
  return jsonb_build_object('status',200,'body',result,'headers','{}'::jsonb);
exception when sqlstate 'BL001' then
  return bedlink_private.api_error(503,'SERVICE_UNAVAILABLE','Availability temporarily unavailable.',t);
end;
$$;

create function bedlink_private.update_availability_v3(p_hospital_id uuid, p_bed_pool_id uuid,
  p_operation text, p_reported_free_beds integer, p_version bigint, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  t timestamptz := date_trunc('milliseconds',clock_timestamp());
  actor uuid := auth.uid(); v_issuer text; membership public.staff_memberships;
  pool public.bed_pools; prior bedlink_private.idempotency_records;
  fingerprint text; route text; held integer; result jsonb; headers jsonb;
begin
  if actor is null then
    return bedlink_private.api_error(401,'UNAUTHENTICATED','Authentication required.',t);
  end if;
  -- Claims are injected by verified PostgREST authentication, never a RPC parameter.
  v_issuer := nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'iss';
  if v_issuer is null or char_length(btrim(v_issuer)) not between 1 and 2048 then
    return bedlink_private.api_error(401,'UNAUTHENTICATED','Verified issuer required.',t);
  end if;
  select * into membership from public.staff_memberships where user_id=actor for share;
  if not found or not membership.is_active or membership.role<>'nurse' then
    return bedlink_private.api_error(403,'FORBIDDEN','Active nurse membership required.',t);
  end if;
  if p_hospital_id is null or membership.hospital_id<>p_hospital_id or not exists
    (select 1 from public.bed_pools where id=p_bed_pool_id and hospital_id=p_hospital_id) then
    return bedlink_private.api_error(404,'NOT_FOUND','Bed pool not found.',t);
  end if;
  if p_idempotency_key is null or p_idempotency_key='' then
    return bedlink_private.api_error(400,'IDEMPOTENCY_KEY_REQUIRED','Idempotency-Key is required.',t);
  end if;
  if p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,128}$' or p_operation is null
    or p_operation not in ('update','verify') or p_reported_free_beds is null
    or p_reported_free_beds<0 or p_version is null or p_version not between 1 and 9007199254740991 then
    return bedlink_private.api_error(400,'INVALID_INPUT','Invalid mutation input.',t);
  end if;
  route := '/api/v1/hospitals/'||p_hospital_id||'/bed-pools/'||p_bed_pool_id;
  fingerprint := encode(sha256(convert_to('PATCH'||chr(10)||route||chr(10)||
    jsonb_build_object('operation',p_operation,'reportedFreeBeds',p_reported_free_beds,'version',p_version)::text,'UTF8')),'hex');
  -- Nonblocking mutex also covers the first request before its row is committed.
  if not pg_try_advisory_xact_lock(hashtextextended(v_issuer||chr(10)||actor||chr(10)||p_idempotency_key,0)) then
    result := bedlink_private.api_error(409,'IDEMPOTENCY_IN_PROGRESS','Request is still in progress.',t);
    return jsonb_set(result,'{headers}','{"Retry-After":"1"}'::jsonb);
  end if;
  select * into prior from bedlink_private.idempotency_records
    where idempotency_key=p_idempotency_key and actor_id=actor and idempotency_records.issuer=v_issuer;
  if found then
    if prior.status='completed' and prior.expires_at<=t then
      delete from bedlink_private.idempotency_records where id=prior.id;
    elsif prior.request_fingerprint<>fingerprint then
      return bedlink_private.api_error(409,'IDEMPOTENCY_KEY_REUSED','Key was used for a different request.',t);
    elsif prior.status='completed' then
      return jsonb_build_object('status',prior.response_status,'body',prior.response_body,
        'headers',prior.response_headers||'{"Idempotency-Replayed":"true"}'::jsonb);
    else
      result := bedlink_private.api_error(409,'IDEMPOTENCY_IN_PROGRESS','Request is still in progress.',t);
      return jsonb_set(result,'{headers}','{"Retry-After":"1"}'::jsonb);
    end if;
  end if;
  -- All future hold/census writers must lock this same pool before changing inventory.
  select * into pool from public.bed_pools where id=p_bed_pool_id and hospital_id=p_hospital_id for update;
  if not found then return bedlink_private.api_error(404,'NOT_FOUND','Bed pool not found.',t); end if;
  t := date_trunc('milliseconds',clock_timestamp());
  if p_reported_free_beds>pool.capacity then
    return bedlink_private.api_error(400,'INVALID_INPUT','Reported count exceeds capacity.',t);
  end if;
  select count(*) into held from public.holds where bed_pool_id=pool.id and status='active' and expires_at>t;
  if pool.version<>p_version then
    result := bedlink_private.api_error(409,'VERSION_CONFLICT','Pool changed; refetch before retrying.',t);
  elsif p_operation='verify' and pool.reported_free_beds<>p_reported_free_beds then
    result := bedlink_private.api_error(409,'VERIFICATION_COUNT_CHANGED','Verification must confirm the saved count.',t);
  elsif p_reported_free_beds<held then
    result := bedlink_private.api_error(409,'FREE_COUNT_BELOW_HOLDS','Reported count cannot be below live holds.',t);
  elsif pool.version=9007199254740991 then
    return bedlink_private.api_error(503,'SERVICE_UNAVAILABLE','Availability temporarily unavailable.',t);
  else
    update public.bed_pools set reported_free_beds=p_reported_free_beds,version=version+1,
      verified_at=t,inventory_updated_at=t,updated_at=greatest(t,created_at)
      where id=pool.id and version=p_version returning * into pool;
    result := jsonb_build_object('status',200,'body',jsonb_build_object('serverTime',bedlink_private.api_time(t),
      'bedPool',bedlink_private.pool_json(pool,t)),'headers','{}'::jsonb);
  end if;
  headers := jsonb_build_object('Idempotency-Replayed','false',
    'Idempotency-Expires-At',bedlink_private.api_time(t+interval '24 hours'));
  -- Insertion, saved response and inventory write commit or roll back together.
  insert into bedlink_private.idempotency_records(issuer,actor_id,idempotency_key,http_method,request_path,
    request_fingerprint,status,response_status,response_body,response_headers,created_at,completed_at,expires_at,updated_at)
    values(v_issuer,actor,p_idempotency_key,'PATCH',route,fingerprint,'completed',(result->>'status')::smallint,
      result->'body',headers,t,t,t+interval '24 hours',t);
  return jsonb_set(result,'{headers}',headers);
exception when sqlstate 'BL001' then
  -- PL/pgSQL exception block rolls back all writes before returning this error.
  return bedlink_private.api_error(503,'SERVICE_UNAVAILABLE','Availability temporarily unavailable.',t);
end;
$$;

create or replace function public.bedlink_read_availability(p_hospital_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or not exists(select 1 from public.staff_memberships where user_id=auth.uid() and is_active) then
    return bedlink_private.read_availability_v3(p_hospital_id);
  end if;
  perform bedlink_private.lifecycle_gate();
  perform bedlink_private.settle_due();
  return bedlink_private.read_availability_v3(p_hospital_id);
end;
$$;
create or replace function public.bedlink_update_availability(p_hospital_id uuid,p_bed_pool_id uuid,
  p_operation text,p_reported_free_beds integer,p_version bigint,p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare issuer text; t timestamptz:=date_trunc('milliseconds',clock_timestamp());
begin
  if auth.uid() is null or not bedlink_private.is_nurse_for(p_hospital_id)
    or p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,128}$' then
    return bedlink_private.update_availability_v3(p_hospital_id,p_bed_pool_id,p_operation,p_reported_free_beds,p_version,p_idempotency_key);
  end if;
  issuer:=nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'iss';
  if issuer is null then return bedlink_private.api_error(401,'UNAUTHENTICATED','Verified issuer required.',t); end if;
  if not pg_try_advisory_xact_lock(hashtextextended(issuer||chr(10)||auth.uid()||chr(10)||p_idempotency_key,0)) then
    return jsonb_set(bedlink_private.api_error(409,'IDEMPOTENCY_IN_PROGRESS','Request is still in progress.',t),'{headers}','{"Retry-After":"1"}');
  end if;
  perform bedlink_private.lifecycle_gate();
  perform bedlink_private.settle_due(null,p_bed_pool_id);
  return bedlink_private.update_availability_v3(p_hospital_id,p_bed_pool_id,p_operation,p_reported_free_beds,p_version,p_idempotency_key);
end;
$$;

alter function bedlink_private.require_completed_replay() security definer;
-- Harden every new helper, including copied V3 bodies; existing RLS helper grants stay intact.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='bedlink_private' and p.proname not in
      ('array_is_set','is_dispatcher','is_nurse_for','owns_request','api_time','api_error','pool_json')
  loop
    execute format('alter function %s owner to postgres',f.signature);
    execute format('revoke all on function %s from public,anon,authenticated,service_role,bedlink_api,bedlink_worker',f.signature);
  end loop;
end $$;
alter function public.bedlink_workflow_context(text,jsonb,text) owner to postgres;
alter function public.bedlink_workflow(text,jsonb,text) owner to postgres;
alter function public.bedlink_workflow_finish(uuid,jsonb) owner to postgres;
alter function public.bedlink_worker_tick(integer) owner to postgres;
revoke all on function public.bedlink_workflow_context(text,jsonb,text),public.bedlink_workflow(text,jsonb,text),
  public.bedlink_workflow_finish(uuid,jsonb),public.bedlink_worker_tick(integer)
  from public,anon,authenticated,service_role,bedlink_api,bedlink_worker;
grant execute on function public.bedlink_workflow_context(text,jsonb,text),public.bedlink_workflow(text,jsonb,text),
  public.bedlink_workflow_finish(uuid,jsonb) to bedlink_api;
grant execute on function public.bedlink_worker_tick(integer) to bedlink_worker;
commit;
