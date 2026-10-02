import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createWorkflowDatabase } from '../src/db/workflow.mjs';
import { createWorkflowService } from '../src/services/workflow.mjs';
import { createApp } from '../src/app.mjs';
import { createBedLinkApi } from '../client/bedlink-api.mjs';
import { runTimeoutWorker } from '../src/services/timeout-worker.mjs';
import { config, serve, matchesSchema } from './support.mjs';
import { unauthenticated } from '../src/errors.mjs';

const connectionString = process.env.BEDLINK_TEST_DATABASE_URL;
if (!connectionString) throw new Error('BEDLINK_TEST_DATABASE_URL is required; real lifecycle tests never skip.');
const target = new URL(connectionString);
if (!['localhost','127.0.0.1','[::1]'].includes(target.hostname) || !/^\/bedlink_step[235]_[\w]+$/.test(target.pathname)) throw new Error('Disposable local database required');
const admin = new pg.Pool({ connectionString, max: 12, statement_timeout: 10000 });
const database = createWorkflowDatabase({ connectionString, allowPrivilegedForTests: true });
const worker = createWorkflowDatabase({ connectionString, role:'bedlink_worker', allowPrivilegedForTests:true });
const ids = { dispatcher:randomUUID(),other:randomUUID(),nurse:randomUUID(),nurse2:randomUUID(),inactive:randomUUID(),
  hospital:randomUUID(),second:randomUUID(),pool:randomUUID(),secondPool:randomUUID() };
const needs = { location:{latitude:20,longitude:70},resources:['icu','oxygen','ventilator'],specialty:'burns' };
// TEST ONLY: Auth verification is stubbed; these unsigned token-shaped strings must never authenticate production traffic.
const identity = id => ({ userId:id,token:`test.${Buffer.from(JSON.stringify({sub:id,iss:'http://test/auth/v1',exp:4102444800})).toString('base64url')}.test` });
let providerFailure = false, verifyOutsideTransactions = false, providerProbe = Promise.resolve();
const provider = { async estimate() {
  if (verifyOutsideTransactions) {
    await (providerProbe = providerProbe.then(async () => {
    const connection = await admin.connect();
    try {
      await connection.query('BEGIN');
      assert.equal((await connection.query('SELECT pg_try_advisory_xact_lock(42105,1) AS free')).rows[0].free,true);
    } finally { await connection.query('ROLLBACK'); connection.release(); }
    }));
  }
  if (providerFailure) throw new Error('private provider error');
  return { distanceKm:1,estimatedTravelMinutes:3,source:'simulatedDistance',trafficConsidered:false };
} };
const service = createWorkflowService({ database,travelProvider:provider,travelTimeoutMs:100 });
const call = (action,params,actor=ids.dispatcher,key=randomUUID()) => service(action,params,key,identity(actor),new AbortController().signal);
const body = body => ({ body });
const create = async () => {
  const result=await call('create',body({patientReference:'ANON_TEST',needs}));
  assert.equal(result.status,201,JSON.stringify(result)); matchesSchema('RequestResponse',result.body);
  return result.body.request.id;
};
const send = (requestId,hospitalId=ids.hospital,bedPoolId=ids.pool,key=randomUUID()) => call('send',{requestId,body:{hospitalId,bedPoolId}},ids.dispatcher,key);
const pending = async (hospital=ids.hospital,pool=ids.pool) => {
  const requestId=await create(), sent=await send(requestId,hospital,pool);
  assert.equal(sent.status,201,JSON.stringify(sent)); return {requestId,attemptId:sent.body.request.activeAttemptId};
};
const accept = (attemptId,key=randomUUID(),actor=ids.nurse,hospitalId=ids.hospital) => call('accept',{hospitalId,attemptId,body:{}},actor,key);
const status = requestId => call('status',{requestId},ids.dispatcher,null);
const cancel = requestId => call('cancelRequest',{requestId,body:{reasonCode:'other'}});
const tick = () => worker.transaction(null,q=>q('tick',[100]));
const readPool = async () => (await admin.query('SELECT * FROM public.bed_pools WHERE id=$1',[ids.pool])).rows[0];
async function nurseUpdate(count, version, key=randomUUID()) {
  const connection=await admin.connect();
  try {
    await connection.query('BEGIN'); await connection.query('SET LOCAL ROLE authenticated');
    await connection.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:ids.nurse,iss:'http://test/auth/v1'})]);
    const result=(await connection.query('SELECT public.bedlink_update_availability($1,$2,$3,$4,$5,$6) AS result',
      [ids.hospital,ids.pool,'update',count,version,key])).rows[0].result;
    await connection.query('COMMIT');return result;
  } finally { await connection.query('ROLLBACK');connection.release(); }
}
async function restoreCapacity(count=3) {
  // Only our randomly identified fixture pool. Keep verification fresh for race tests.
  await admin.query('UPDATE public.bed_pools SET reported_free_beds=$2,verified_at=clock_timestamp() WHERE id=$1',[ids.pool,count]);
}
async function dueAttempt(attemptId) {
  await admin.query(`WITH cutoff AS MATERIALIZED (SELECT date_trunc('milliseconds',clock_timestamp()) t)
    UPDATE public.hospital_attempts SET created_at=t-interval '120 seconds',response_deadline_at=t FROM cutoff WHERE id=$1`,[attemptId]);
}
async function dueHold(holdId) {
  await admin.query(`WITH cutoff AS MATERIALIZED (SELECT date_trunc('milliseconds',clock_timestamp()) t)
    UPDATE public.holds SET created_at=t-interval '900 seconds',expires_at=t FROM cutoff WHERE id=$1`,[holdId]);
}

test('real PostgreSQL lifecycle, deadlines, independent-connection races and recovery',async t=>{
  t.after(async()=>{
    try {
      await admin.query('DELETE FROM bedlink_private.idempotency_records WHERE actor_id=ANY($1::uuid[])',[Object.values(ids).slice(0,5)]);
      await admin.query('DELETE FROM public.holds WHERE request_id IN (SELECT id FROM public.patient_requests WHERE owner_id=ANY($1::uuid[]))',[[ids.dispatcher,ids.other]]);
      await admin.query('DELETE FROM public.hospital_attempts WHERE request_id IN (SELECT id FROM public.patient_requests WHERE owner_id=ANY($1::uuid[]))',[[ids.dispatcher,ids.other]]);
      await admin.query('DELETE FROM public.patient_requests WHERE owner_id=ANY($1::uuid[])',[[ids.dispatcher,ids.other]]);
      await admin.query('DELETE FROM public.staff_memberships WHERE user_id=ANY($1::uuid[])',[Object.values(ids).slice(0,5)]);
      await admin.query('DELETE FROM public.bed_pools WHERE id=ANY($1::uuid[])',[[ids.pool,ids.secondPool]]);
      await admin.query('DELETE FROM public.hospitals WHERE id=ANY($1::uuid[])',[[ids.hospital,ids.second]]);
      await admin.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])',[Object.values(ids).slice(0,5)]);
    } finally { await Promise.all([database.close(),worker.close(),admin.end()]); }
  });
  await admin.query('INSERT INTO auth.users(id) SELECT unnest($1::uuid[])',[Object.values(ids).slice(0,5)]);
  await admin.query(`INSERT INTO public.hospitals(id,name,latitude,longitude) VALUES ($1,'Lifecycle test A',20,70),($2,'Lifecycle test B',20.1,70.1)`,[ids.hospital,ids.second]);
  await admin.query(`INSERT INTO public.bed_pools(id,hospital_id,label,resources,specialties,capacity,reported_free_beds,verified_at)
    VALUES ($1,$2,'Combined resources',ARRAY['icu','oxygen','ventilator']::public.bed_resource[],ARRAY['burns']::public.bed_specialty[],5,3,now()),
    ($3,$4,'Backup combined',ARRAY['icu','oxygen','ventilator']::public.bed_resource[],ARRAY['burns']::public.bed_specialty[],5,3,now())`,[ids.pool,ids.hospital,ids.secondPool,ids.second]);
  await admin.query(`INSERT INTO public.staff_memberships(user_id,role,hospital_id,is_active) VALUES
    ($1,'dispatcher',null,true),($2,'dispatcher',null,true),($3,'nurse',$6,true),($4,'nurse',$7,true),($5,'dispatcher',null,false)`,
    [ids.dispatcher,ids.other,ids.nurse,ids.nurse2,ids.inactive,ids.hospital,ids.second]);

  await t.test('complete HTTP create/send/inbox/accept/arrival flow, schemas, saved replay and privacy',async()=>{
    const base=await serve(t,createApp({config,workflow:service,logger:()=>{},rpc:async()=>{},
      authenticate:async header=>{
        const who=Object.values(ids).find(id=>header===`Bearer ${identity(id).token}`);
        if(!who)throw unauthenticated();return identity(who);
      }}));
    const api=actor=>createBedLinkApi({baseUrl:base,getAccessToken:async()=>identity(actor).token});
    const dispatch=api(ids.dispatcher), nurse=api(ids.nurse);
    verifyOutsideTransactions=true;
    const created=await dispatch.createPatientRequest({patientReference:'ANON_FLOW',needs},{idempotencyKey:randomUUID()});
    verifyOutsideTransactions=false;
    matchesSchema('RequestResponse',created.data);
    const rid=created.data.request.id;
    const sent=await dispatch.createAttempt(rid,{hospitalId:ids.hospital,bedPoolId:ids.pool},{idempotencyKey:randomUUID()});
    const attempt=sent.data.attempts[0];
    assert.equal(Date.parse(attempt.responseDeadlineAt)-Date.parse(attempt.createdAt),120000);
    const inbox=await nurse.getHospitalInbox(ids.hospital);matchesSchema('InboxResponse',inbox.data);
    assert.ok(inbox.data.pendingAttempts.some(x=>x.attempt.id===attempt.id));
    assert.ok(!JSON.stringify(inbox.data).includes('ownerId'));
    const before=await readPool(), key=randomUUID();
    const saved=await nurse.acceptAttempt(ids.hospital,attempt.id,{idempotencyKey:key});
    matchesSchema('AttemptActionResponse',saved.data);
    assert.equal(saved.data.bedPool.activeHoldCount,1);
    assert.equal(saved.data.bedPool.reportedFreeBeds,before.reported_free_beds);
    assert.equal(saved.data.bedPool.version,Number(before.version)+1);
    assert.equal(Date.parse(saved.data.hold.expiresAt)-Date.parse(saved.data.hold.createdAt),900000);
    assert.deepEqual((await nurse.acceptAttempt(ids.hospital,attempt.id,{idempotencyKey:key})).data,saved.data);
    const arrivalKey=randomUUID();
    const arrived=await nurse.recordArrival(rid,saved.data.hold.id,{idempotencyKey:arrivalKey});
    matchesSchema('ArrivalResponse',arrived.data);
    assert.equal(arrived.data.bedPool.reportedFreeBeds,before.reported_free_beds-1);
    assert.equal(arrived.data.bedPool.availableBeds,saved.data.bedPool.availableBeds);
    assert.equal(arrived.data.bedPool.verifiedAt,saved.data.bedPool.verifiedAt);
    assert.deepEqual((await nurse.recordArrival(rid,saved.data.hold.id,{idempotencyKey:arrivalKey})).data,arrived.data);
    await assert.rejects(dispatch.recordArrival(rid,saved.data.hold.id,{idempotencyKey:randomUUID()}),{code:'HOLD_NOT_ACTIVE'});
    assert.equal((await cancel(rid)).body.error.code,'REQUEST_TERMINAL');
  });

  await t.test('authorization and backend-only grants protect patient history and mutations',async()=>{
    const rid=await create();
    assert.equal((await call('status',{requestId:rid},ids.other,null)).status,404);
    assert.equal((await call('status',{requestId:rid},ids.nurse,null)).status,403);
    assert.equal((await call('create',body({patientReference:'A',needs}),ids.inactive)).status,403);
    const sent=await send(rid);const aid=sent.body.request.activeAttemptId;
    assert.equal((await accept(aid,randomUUID(),ids.nurse2)).status,404);
    assert.equal((await accept(aid,randomUUID(),ids.dispatcher)).status,403);
    const permissions=(await admin.query(`SELECT
      has_function_privilege('authenticated','public.bedlink_workflow(text,jsonb,text)','execute') AS browser,
      has_function_privilege('authenticated','public.bedlink_workflow_finish(uuid,jsonb)','execute') AS forge,
      has_function_privilege('bedlink_api','public.bedlink_worker_tick(integer)','execute') AS worker,
      has_table_privilege('bedlink_api','public.holds','INSERT') AS direct_insert`)).rows[0];
    assert.deepEqual(permissions,{browser:false,forge:false,worker:false,direct_insert:false});
    await cancel(rid);
  });

  await t.test('rejection offers fallback, excludes every attempted hospital, never sends automatically, and exhausts options',async()=>{
    const rid=await create();let current=await status(rid), attempts=0;
    while(current.body.nextBest.candidates.length){
      const choice=current.body.nextBest.candidates[0];
      const sent=await send(rid,choice.hospital.id,choice.bedPool.id);
      assert.equal(sent.status,201);
      await admin.query('UPDATE public.staff_memberships SET hospital_id=$1 WHERE user_id=$2',[choice.hospital.id,ids.nurse2]);
      const key=randomUUID();
      const rejected=await call('reject',{hospitalId:choice.hospital.id,attemptId:sent.body.request.activeAttemptId,body:{reasonCode:'cannotReceive'}},ids.nurse2,key);
      assert.equal(rejected.status,200,JSON.stringify(rejected));matchesSchema('AttemptActionResponse',rejected.body);
      assert.equal(rejected.body.requestStatus,'searching');assert.equal(rejected.body.hold,null);
      assert.ok(!rejected.body.nextBest.candidates.some(c=>c.hospital.id===choice.hospital.id));
      assert.deepEqual((await call('reject',{hospitalId:choice.hospital.id,attemptId:sent.body.request.activeAttemptId,body:{reasonCode:'cannotReceive'}},ids.nurse2,key)).body,rejected.body);
      current=await status(rid);assert.equal(current.body.request.activeAttemptId,null);
      assert.equal(current.body.attempts.length,++attempts);
      assert.ok(attempts<20,'bounded demo catalog');
    }
    assert.ok(['noEligibleHospitals','availabilityOutdated','capacityUnavailable'].includes(current.body.nextBest.outcome));
    const first=current.body.attempts[0];
    assert.equal((await send(rid,first.hospitalId,first.bedPoolId)).body.error.code,'HOSPITAL_ALREADY_ATTEMPTED');
    await admin.query('UPDATE public.staff_memberships SET hospital_id=$1 WHERE user_id=$2',[ids.second,ids.nurse2]);
    await cancel(rid);
  });

  await t.test('reads and acceptance enforce the exact deadline without a worker; late conflict replay remains exact',async()=>{
    await restoreCapacity();const {requestId,attemptId}=await pending();await dueAttempt(attemptId);
    const key=randomUUID(), late=await accept(attemptId,key);
    assert.equal(late.body.error.code,'ATTEMPT_DEADLINE_PASSED');
    assert.deepEqual((await accept(attemptId,key)).body,late.body);
    const view=await status(requestId);matchesSchema('RequestResponse',view.body);
    assert.equal(view.body.attempts[0].status,'timedOut');
    assert.equal(view.body.attempts[0].resolvedAt,view.body.attempts[0].responseDeadlineAt);
    assert.equal(view.body.request.status,'searching');
    assert.ok(!view.body.nextBest.candidates.some(c=>c.hospital.id===ids.hospital));
    assert.equal(view.body.holds.length,0);await cancel(requestId);
  });

  await t.test('two independent requests compete for the last bed; only one hold commits',async()=>{
    await restoreCapacity(1);const a=await pending(),b=await pending();
    const results=await Promise.all([accept(a.attemptId),accept(b.attemptId)]);
    assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);
    assert.equal(results.find(x=>x.status===409).body.error.code,'CAPACITY_UNAVAILABLE');
    const rows=await admin.query("SELECT count(*)::int AS n FROM public.holds WHERE bed_pool_id=$1 AND status='active'",[ids.pool]);
    assert.equal(rows.rows[0].n,1);
    await cancel(a.requestId);await cancel(b.requestId);
  });

  await t.test('duplicate acceptance and key reuse; simultaneous retry responds in-progress before commit',async()=>{
    await restoreCapacity(1);const {requestId,attemptId}=await pending();const key=randomUUID();
    const connection=await admin.connect();let original;
    try{
      await connection.query('BEGIN');await connection.query('SET LOCAL ROLE bedlink_api');
      await connection.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:ids.nurse,iss:'http://test/auth/v1'})]);
      original=(await connection.query('SELECT public.bedlink_workflow($1,$2,$3) AS result',['accept',{hospitalId:ids.hospital,attemptId,body:{}},key])).rows[0].result;
      assert.equal(original.status,200);
      original=(await connection.query('SELECT public.bedlink_workflow_finish($1,$2) AS result',[original.recordId,original])).rows[0].result;
      assert.equal((await accept(attemptId,key)).body.error.code,'IDEMPOTENCY_IN_PROGRESS');
      await connection.query('COMMIT');
    } finally{await connection.query('ROLLBACK');connection.release();}
    assert.deepEqual((await accept(attemptId,key)).body,original.body);
    assert.equal((await accept(attemptId)).body.error.code,'ATTEMPT_NOT_PENDING');
    assert.equal((await call('reject',{hospitalId:ids.hospital,attemptId,body:{reasonCode:'other'}},ids.nurse,key)).body.error.code,'IDEMPOTENCY_KEY_REUSED');
    const cross=await nurseUpdate(1,(await readPool()).version,key);assert.equal(cross.body.error.code,'IDEMPOTENCY_KEY_REUSED');
    await cancel(requestId);
  });

  await t.test('acceptance races with cancellation and timeout on independent connections',async()=>{
    await restoreCapacity(1);const a=await pending();
    const [accepted,cancelled]=await Promise.all([accept(a.attemptId),cancel(a.requestId)]);
    assert.equal(cancelled.status,200);
    assert.ok([200,409].includes(accepted.status));
    const final=await status(a.requestId);assert.equal(final.body.request.status,'cancelled');
    assert.ok(final.body.holds.every(h=>h.status!=='active'));
    const b=await pending();await dueAttempt(b.attemptId);
    const [late]=await Promise.all([accept(b.attemptId),tick()]);
    assert.equal(late.body.error.code,'ATTEMPT_DEADLINE_PASSED');
    assert.equal((await status(b.requestId)).body.holds.length,0);await cancel(b.requestId);
  });

  await t.test('nurse update versus acceptance cannot invalidate held capacity',async()=>{
    await restoreCapacity(1);const a=await pending(),before=await readPool();
    const [accepted,updated]=await Promise.all([accept(a.attemptId),nurseUpdate(0,Number(before.version))]);
    assert.equal([accepted,updated].filter(x=>x.status===200).length,1);
    if(accepted.status===200) assert.equal(updated.body.error.code,'VERSION_CONFLICT');
    else assert.equal(accepted.body.error.code,'CAPACITY_UNAVAILABLE');
    const counts=(await admin.query(`SELECT p.reported_free_beds,(SELECT count(*)::int FROM public.holds WHERE bed_pool_id=p.id AND status='active' AND expires_at>clock_timestamp()) AS held FROM public.bed_pools p WHERE id=$1`,[ids.pool])).rows[0];
    assert.ok(counts.held<=counts.reported_free_beds);await cancel(a.requestId);
  });

  await t.test('hold release, expiry, arrival after expiry and arrival-versus-release affect inventory once',async()=>{
    await restoreCapacity(2);const a=await pending(),accepted=await accept(a.attemptId);const free=accepted.body.bedPool.reportedFreeBeds;
    const released=await call('cancelHold',{requestId:a.requestId,holdId:accepted.body.hold.id,body:{reasonCode:'transportPlanChanged'}});
    assert.equal(released.status,200);matchesSchema('RequestResponse',released.body);
    assert.equal(released.body.request.status,'searching');assert.equal((await readPool()).reported_free_beds,free);
    assert.equal((await call('cancelHold',{requestId:a.requestId,holdId:accepted.body.hold.id,body:{reasonCode:'other'}})).body.error.code,'HOLD_NOT_ACTIVE');
    await cancel(a.requestId);
    const b=await pending(),held=await accept(b.attemptId);await dueHold(held.body.hold.id);
    const version=Number((await readPool()).version);
    const late=await call('arrival',{requestId:b.requestId,body:{holdId:held.body.hold.id}});
    assert.equal(late.body.error.code,'HOLD_EXPIRED');
    const after=await readPool();assert.equal(after.reported_free_beds,free);assert.equal(Number(after.version),version+1);
    await tick();assert.equal(Number((await readPool()).version),version+1);
    const view=await status(b.requestId);assert.equal(view.body.holds[0].endedAt,view.body.holds[0].expiresAt);await cancel(b.requestId);
    const c=await pending(),hold=await accept(c.attemptId);
    const [arrive,release]=await Promise.all([call('arrival',{requestId:c.requestId,body:{holdId:hold.body.hold.id}}),
      call('cancelHold',{requestId:c.requestId,holdId:hold.body.hold.id,body:{reasonCode:'other'}})]);
    assert.equal([arrive,release].filter(r=>r.status===200).length,1);
    assert.equal([arrive,release].find(r=>r.status===409).body.error.code,'HOLD_NOT_ACTIVE');
    if(release.status===200)await cancel(c.requestId);
  });

  await t.test('worker catches up after restart, duplicate workers are safe and cleanly stop',async()=>{
    await restoreCapacity();const a=await pending(),b=await pending();const held=await accept(b.attemptId);
    await dueAttempt(a.attemptId);await dueHold(held.body.hold.id);
    const before=await readPool();
    const results=await Promise.all([tick(),tick()]);
    assert.equal(results.reduce((n,r)=>n+r.processed,0),2);
    assert.equal(Number((await readPool()).version),Number(before.version)+1);
    const controller=new AbortController(),logs=[];
    await runTimeoutWorker({database:worker,signal:controller.signal,logger:e=>logs.push(e),wait:async()=>controller.abort()});
    assert.equal((await tick()).processed,0);assert.equal(Number((await readPool()).version),Number(before.version)+1);
    assert.equal((await status(a.requestId)).body.attempts[0].status,'timedOut');
    assert.equal((await status(b.requestId)).body.holds[0].status,'expired');
    await cancel(a.requestId);await cancel(b.requestId);
  });

  await t.test('exact deadline and expiry equality settle once at the supplied database test instant',async()=>{
    await restoreCapacity();const a=await pending();
    const deadline=(await admin.query('SELECT response_deadline_at FROM public.hospital_attempts WHERE id=$1',[a.attemptId])).rows[0].response_deadline_at;
    const connection=await admin.connect();
    try {
      await connection.query('BEGIN');await connection.query('SELECT bedlink_private.lifecycle_gate()');
      assert.equal((await connection.query('SELECT bedlink_private.settle_due($1,null,0,$2) AS n',[a.requestId,deadline])).rows[0].n,1);
      const attempt=(await connection.query('SELECT status,resolved_at=response_deadline_at AS exact FROM public.hospital_attempts WHERE id=$1',[a.attemptId])).rows[0];
      assert.deepEqual(attempt,{status:'timed_out',exact:true});
      assert.equal((await connection.query('SELECT bedlink_private.settle_due($1,null,0,$2) AS n',[a.requestId,deadline])).rows[0].n,0);
    } finally {await connection.query('ROLLBACK');connection.release();}
    const held=await accept(a.attemptId),before=await readPool();
    const expiry=held.body.hold.expiresAt,second=await admin.connect();
    try {
      await second.query('BEGIN');await second.query('SELECT bedlink_private.lifecycle_gate()');
      await second.query('SELECT bedlink_private.settle_due($1,null,0,$2)',[a.requestId,expiry]);
      const hold=(await second.query('SELECT status,ended_at=expires_at AS exact FROM public.holds WHERE id=$1',[held.body.hold.id])).rows[0];
      assert.deepEqual(hold,{status:'expired',exact:true});
      const after=(await second.query('SELECT version,reported_free_beds,verified_at FROM public.bed_pools WHERE id=$1',[ids.pool])).rows[0];
      assert.equal(Number(after.version),Number(before.version)+1);
      assert.equal(after.reported_free_beds,before.reported_free_beds);
      assert.deepEqual(after.verified_at,before.verified_at);
    } finally {await second.query('ROLLBACK');second.release();}
    await cancel(a.requestId);
  });

  await t.test('send revalidates pool, capability, freshness and capacity; competing sends leave one pending attempt',async()=>{
    await restoreCapacity();const requestId=await create();
    assert.equal((await send(requestId,ids.second,ids.pool)).status,404);
    await admin.query("UPDATE public.bed_pools SET resources=ARRAY['icu']::public.bed_resource[] WHERE id=$1",[ids.pool]);
    try {assert.equal((await send(requestId)).body.error.code,'POOL_REQUIREMENTS_NOT_MET');}
    finally {await admin.query("UPDATE public.bed_pools SET resources=ARRAY['icu','oxygen','ventilator']::public.bed_resource[] WHERE id=$1",[ids.pool]);}
    await admin.query("UPDATE public.bed_pools SET verified_at=clock_timestamp()-interval '30 minutes' WHERE id=$1",[ids.pool]);
    assert.equal((await send(requestId)).body.error.code,'AVAILABILITY_OUTDATED');
    await restoreCapacity(0);assert.equal((await send(requestId)).body.error.code,'CAPACITY_UNAVAILABLE');
    await restoreCapacity();
    const result=await Promise.all([send(requestId),send(requestId,ids.second,ids.secondPool)]);
    assert.deepEqual(result.map(r=>r.status).sort(),[201,409]);
    assert.equal((await status(requestId)).body.attempts.length,1);await cancel(requestId);
  });

  await t.test('restricted runtime login works without test privilege bypass and cannot mutate tables',async()=>{
    const name=`step5_login_${randomUUID().replaceAll('-','')}`,password=randomUUID();
    await admin.query(`CREATE ROLE ${name} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
    await admin.query(`GRANT bedlink_api TO ${name}`);
    const url=new URL(connectionString);url.username=name;url.password=password;
    const restricted=createWorkflowDatabase({connectionString:url.href});
    const restrictedService=createWorkflowService({database:restricted,travelProvider:provider});
    const denied=createWorkflowDatabase({connectionString});
    try {
      const result=await restrictedService('create',body({patientReference:'ANON_TEST',needs}),randomUUID(),identity(ids.dispatcher));
      assert.equal(result.status,201);await cancel(result.body.request.id);
      const raw=new pg.Client({connectionString:url.href});await raw.connect();
      try {await assert.rejects(raw.query('UPDATE public.bed_pools SET reported_free_beds=0'),{code:'42501'});}
      finally {await raw.end();}
      await assert.rejects(denied.transaction(identity(ids.dispatcher),q=>q('context',['create',body({patientReference:'ANON_TEST',needs}),randomUUID()])),{status:503});
    } finally {await restricted.close();await denied.close();await admin.query(`DROP ROLE ${name}`);}
  });

  await t.test('provider failure and incomplete/persistence failures roll back state and replay records',async()=>{
    await restoreCapacity();const a=await pending(),key=randomUUID();providerFailure=true;
    try { await assert.rejects(call('reject',{hospitalId:ids.hospital,attemptId:a.attemptId,body:{reasonCode:'other'}},ids.nurse,key),{status:503}); }
    finally { providerFailure=false; }
    assert.equal((await status(a.requestId)).body.request.status,'pending');
    assert.equal((await admin.query('SELECT 1 FROM bedlink_private.idempotency_records WHERE idempotency_key=$1',[key])).rowCount,0);
    const connection=await admin.connect();
    try{
      await connection.query('BEGIN');await connection.query('SET LOCAL ROLE bedlink_api');
      await connection.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:ids.nurse,iss:'http://test/auth/v1'})]);
      await connection.query('SELECT public.bedlink_workflow($1,$2,$3)',['accept',{hospitalId:ids.hospital,attemptId:a.attemptId,body:{}},randomUUID()]);
      await assert.rejects(connection.query('COMMIT'),{code:'BL002'});
    }finally{await connection.query('ROLLBACK');connection.release();}
    assert.equal((await status(a.requestId)).body.request.status,'pending');
    assert.equal((await status(a.requestId)).body.holds.length,0);
    const failureKey=randomUUID(),trigger=`step5_failure_${randomUUID().replaceAll('-','')}`;
    await admin.query(`CREATE FUNCTION public.${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF new.idempotency_key='${failureKey}' AND new.status='completed' THEN RAISE EXCEPTION 'private persistence failure'; END IF;
      RETURN new; END $$`);
    await admin.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON bedlink_private.idempotency_records FOR EACH ROW EXECUTE FUNCTION public.${trigger}()`);
    try {
      const before=await readPool();await assert.rejects(accept(a.attemptId,failureKey),{status:503});
      assert.equal((await readPool()).version,before.version);
      assert.equal((await status(a.requestId)).body.holds.length,0);
      assert.equal((await admin.query('SELECT 1 FROM bedlink_private.idempotency_records WHERE idempotency_key=$1',[failureKey])).rowCount,0);
    } finally {await admin.query(`DROP TRIGGER ${trigger} ON bedlink_private.idempotency_records`);await admin.query(`DROP FUNCTION public.${trigger}()`);}
    await cancel(a.requestId);
  });
});
