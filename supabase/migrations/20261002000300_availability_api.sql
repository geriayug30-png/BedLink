-- Step 3: narrowly authorized catalog reads and atomic census mutations.
begin;

create function bedlink_private.api_time(t timestamptz) returns text
language sql immutable set search_path = '' as $$
  select to_char(t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

create function bedlink_private.api_error(s integer, c text, m text, t timestamptz)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('status',s,'headers','{}'::jsonb,'body',
    jsonb_build_object('serverTime',bedlink_private.api_time(t),
      'error',jsonb_build_object('code',c,'message',m)));
$$;

create function bedlink_private.pool_json(p public.bed_pools, t timestamptz)
returns jsonb language plpgsql stable set search_path = '' as $$
declare held integer; age numeric; v timestamptz;
begin
  select count(*) into held from public.holds h
    where h.bed_pool_id=p.id and h.status='active' and h.expires_at>t;
  v := date_trunc('milliseconds',p.verified_at);
  age := extract(epoch from (t-v))/60;
  if held>p.reported_free_beds or age<0 then
    raise exception using errcode='BL001', message='Inventory invariant unavailable';
  end if;
  return jsonb_build_object('id',p.id,'hospitalId',p.hospital_id,'label',p.label,
    'resources',to_jsonb(p.resources),'specialties',to_jsonb(p.specialties),
    'capacity',p.capacity,'reportedFreeBeds',p.reported_free_beds,'activeHoldCount',held,
    'availableBeds',p.reported_free_beds-held,
    'loadRatio',1-(p.reported_free_beds-held)::numeric/p.capacity,
    'verifiedAt',bedlink_private.api_time(v),'dataAgeMinutes',age,
    'freshness',case when v is null then 'unverified' when age>=30 then 'stale'
      when age>=10 then 'aging' else 'fresh' end,
    'freshnessPolicy',jsonb_build_object('policyVersion','demo-1','agingAfterMinutes',10,'staleAfterMinutes',30),
    'inventoryUpdatedAt',bedlink_private.api_time(p.inventory_updated_at),'version',p.version);
end;
$$;

create function public.bedlink_read_availability(p_hospital_id uuid default null)
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

create function public.bedlink_update_availability(p_hospital_id uuid, p_bed_pool_id uuid,
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

alter function bedlink_private.api_time(timestamptz) owner to postgres;
alter function bedlink_private.api_error(integer,text,text,timestamptz) owner to postgres;
alter function bedlink_private.pool_json(public.bed_pools,timestamptz) owner to postgres;
alter function public.bedlink_read_availability(uuid) owner to postgres;
alter function public.bedlink_update_availability(uuid,uuid,text,integer,bigint,text) owner to postgres;
revoke all on function bedlink_private.api_time(timestamptz),
  bedlink_private.api_error(integer,text,text,timestamptz),
  bedlink_private.pool_json(public.bed_pools,timestamptz),public.bedlink_read_availability(uuid),
  public.bedlink_update_availability(uuid,uuid,text,integer,bigint,text)
  from public,anon,authenticated,service_role;
grant execute on function public.bedlink_read_availability(uuid),
  public.bedlink_update_availability(uuid,uuid,text,integer,bigint,text) to authenticated;
commit;
