import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.mjs';
import { unavailable, unauthenticated } from '../src/errors.mjs';
import { serve, config, matchesSchema } from './support.mjs';

// This is a real PostgreSQL test. Auth claims are supplied by a TEST adapter;
// this cannot prove Supabase Auth/PostgREST JWT signature verification.
const connectionString = process.env.BEDLINK_TEST_DATABASE_URL;
if (!connectionString) throw new Error('Set BEDLINK_TEST_DATABASE_URL to a disposable local database; database tests never silently skip.');
const target = new URL(connectionString);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
  !/^\/bedlink_step[23]_[a-zA-Z0-9_]+$/.test(target.pathname)) throw new Error('Refusing nonlocal/non-disposable database');
const db = new pg.Pool({ connectionString, max: 6, connectionTimeoutMillis: 3000, statement_timeout: 10000 });
const nurse = randomUUID(), secondNurse = randomUUID(), dispatcher = randomUUID(), inactive = randomUUID();
const hospital = randomUUID(), otherHospital = randomUUID(), poolId = randomUUID(), otherPool = randomUUID();
const issuer = 'http://local-test/auth/v1';
const mutationName = 'bedlink_update_availability';
const argsFor = (version, count = 3, key = randomUUID(), operation = 'update') => ({
  p_hospital_id: hospital, p_bed_pool_id: poolId, p_operation: operation,
  p_reported_free_beds: count, p_version: version, p_idempotency_key: key,
});
async function beginAs(client, actor, tokenIssuer = issuer) {
  await client.query('BEGIN');
  await client.query('SET LOCAL ROLE authenticated');
  await client.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actor, iss: tokenIssuer, role: 'authenticated' })]);
}
async function invoke(client, name, args) {
  if (name === 'bedlink_read_availability') {
    return (await client.query('SELECT public.bedlink_read_availability($1) AS result', [args.p_hospital_id])).rows[0].result;
  }
  assert.equal(name, mutationName);
  return (await client.query('SELECT public.bedlink_update_availability($1,$2,$3,$4,$5,$6) AS result',
    [args.p_hospital_id, args.p_bed_pool_id, args.p_operation, args.p_reported_free_beds, args.p_version, args.p_idempotency_key])).rows[0].result;
}
async function rpc(name, args, actor = nurse) {
  const client = await db.connect();
  try {
    await beginAs(client, actor);
    const result = await invoke(client, name, args);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
const read = (id = hospital, actor = nurse) => rpc('bedlink_read_availability', { p_hospital_id: id }, actor);
const current = async () => (await read()).body.bedPools[0];
const save = (args, actor = nurse) => rpc(mutationName, args, actor);

test('PostgreSQL availability transactions, authorization and HTTP integration', async t => {
  let fixturesReady = false;
  t.after(async () => {
    try {
      if (!fixturesReady) return;
    // Delete only this run's randomly identified fixtures; never reset the database.
    await db.query('DELETE FROM bedlink_private.idempotency_records WHERE actor_id=ANY($1::uuid[])', [[nurse,secondNurse,dispatcher,inactive]]);
    await db.query('DELETE FROM public.holds WHERE hospital_id=$1', [hospital]);
    await db.query('DELETE FROM public.hospital_attempts WHERE hospital_id=$1', [hospital]);
    await db.query('DELETE FROM public.patient_requests WHERE owner_id=$1', [dispatcher]);
    await db.query('DELETE FROM public.staff_memberships WHERE user_id=ANY($1::uuid[])', [[nurse,secondNurse,dispatcher,inactive]]);
    await db.query('DELETE FROM public.bed_pools WHERE id=ANY($1::uuid[])', [[poolId,otherPool]]);
    await db.query('DELETE FROM public.hospitals WHERE id=ANY($1::uuid[])', [[hospital,otherHospital]]);
    await db.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])', [[nurse,secondNurse,dispatcher,inactive]]);
    } finally { await db.end(); }
  });
  await db.query('SELECT public.bedlink_read_availability(null)'); // fail immediately if migration is missing
  await db.query('BEGIN');
  try {
    await db.query('INSERT INTO auth.users(id) VALUES ($1),($2),($3),($4)', [nurse, secondNurse, dispatcher, inactive]);
    await db.query(`INSERT INTO public.hospitals(id,name,latitude,longitude) VALUES
      ($1,'Step 3 local test',20,70),($2,'Step 3 other hospital',21,71)`, [hospital, otherHospital]);
    await db.query(`INSERT INTO public.bed_pools(id,hospital_id,label,resources,capacity,reported_free_beds,verified_at)
      VALUES ($1,$2,'Test ICU',ARRAY['icu']::public.bed_resource[],5,3,now()-interval '3 minutes'),
        ($3,$4,'Zero availability',ARRAY['oxygen']::public.bed_resource[],2,0,null)`, [poolId,hospital,otherPool,otherHospital]);
    await db.query(`INSERT INTO public.staff_memberships(user_id,role,hospital_id,is_active) VALUES
      ($1,'nurse',$5,true),($2,'nurse',$5,true),($3,'dispatcher',null,true),($4,'nurse',$5,false)`,
    [nurse, secondNurse, dispatcher, inactive, hospital]);
    await db.query('COMMIT');
    fixturesReady = true;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  const base = await serve(t, createApp({ config, logger: () => {},
    authenticate: async header => {
      const actor = header?.replace('Bearer ', '');
      if (![nurse,secondNurse,dispatcher,inactive].includes(actor)) throw unauthenticated();
      return { userId: actor };
    },
    rpc: async (name, args, identity) => { try { return await rpc(name,args,identity.userId); } catch { throw unavailable(); } },
  }));
  const httpSave = (body, key, actor = nurse) => fetch(`${base}/hospitals/${hospital}/bed-pools/${poolId}`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${actor}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body),
  });

  await t.test('authorized catalog includes zero pools; direct-table RLS stays scoped', async () => {
    for (const actor of [nurse, dispatcher]) {
      const result = await read(null, actor);
      assert.equal(result.status, 200);
      matchesSchema('HospitalsResponse', result.body);
      assert.ok(result.body.hospitals.some(h => h.id === otherHospital && h.bedPools[0].availableBeds === 0));
    }
    const before = await current();
    const result = await read();
    matchesSchema('BedPoolsResponse', result.body);
    assert.equal(result.body.bedPools[0].verifiedAt, before.verifiedAt);
    assert.equal(result.body.bedPools[0].version, before.version);
    assert.equal((await read(hospital, inactive)).status, 403);
    assert.equal((await read(randomUUID())).status, 404);
    assert.equal((await read(hospital, randomUUID())).status, 403);
    const client = await db.connect();
    try {
      await beginAs(client, nurse);
      assert.equal((await client.query('SELECT id FROM public.hospitals WHERE id=$1', [otherHospital])).rowCount, 0);
      await assert.rejects(client.query('UPDATE public.bed_pools SET reported_free_beds=0 WHERE id=$1', [poolId]), { code: '42501' });
      await client.query('ROLLBACK');
      await beginAs(client, nurse);
      await assert.rejects(client.query('SELECT * FROM bedlink_private.idempotency_records'), { code: '42501' });
      await client.query('ROLLBACK');
    } finally { client.release(); }
    const grants = (await db.query(`SELECT has_function_privilege('anon','public.bedlink_read_availability(uuid)','execute') AS anon,
      has_function_privilege('authenticated','bedlink_private.pool_json(public.bed_pools,timestamp with time zone)','execute') AS helper`)).rows[0];
    assert.deepEqual(grants, { anon: false, helper: false });
  });

  await t.test('HTTP save returns persisted schema, replay stays exact, reuse conflicts', async () => {
    const before = await current(), key = randomUUID();
    const body = { operation: 'update', reportedFreeBeds: 4, version: before.version };
    const first = await httpSave(body, key), saved = await first.json();
    assert.equal(first.status, 200);
    matchesSchema('BedPoolResponse', saved);
    assert.equal(saved.bedPool.version, before.version + 1);
    assert.equal(saved.bedPool.reportedFreeBeds, 4);
    assert.equal(saved.bedPool.verifiedAt, saved.serverTime);
    const replay = await httpSave(body, key);
    assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
    assert.deepEqual(await replay.json(), saved);
    assert.equal((await current()).version, saved.bedPool.version);
    const conflict = await httpSave({ ...body, reportedFreeBeds: 2 }, key);
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, 'IDEMPOTENCY_KEY_REUSED');
  });

  await t.test('authorization checked before mutation and before cached replay', async () => {
    const before = await current(), key = randomUUID();
    assert.equal((await save({ ...argsFor(before.version), p_hospital_id: otherHospital, p_bed_pool_id: otherPool })).status, 404);
    assert.equal((await save(argsFor(before.version), dispatcher)).status, 403);
    assert.equal((await save(argsFor(before.version), inactive)).status, 403);
    const args = argsFor(before.version, 3, key);
    assert.equal((await save(args)).status, 200);
    await db.query('UPDATE public.staff_memberships SET is_active=false WHERE user_id=$1', [nurse]);
    try { assert.equal((await save(args)).status, 403); }
    finally { await db.query('UPDATE public.staff_memberships SET is_active=true WHERE user_id=$1', [nurse]); }
    assert.equal((await save(argsFor((await current()).version, 3, key), secondNurse)).status, 200);
  });

  await t.test('invalid counts do not cache; verify requires same count and current version', async () => {
    let pool = await current();
    const key = randomUUID();
    assert.equal((await save(argsFor(pool.version, 6, key))).status, 400);
    assert.equal((await save(argsFor(pool.version, -1))).status, 400);
    assert.equal((await save(argsFor(pool.version, 2, randomUUID(), 'bad'))).status, 400);
    assert.equal((await save(argsFor(pool.version, 3, ''))).body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
    assert.equal((await save(argsFor(pool.version, 4, randomUUID(), 'verify'))).body.error.code, 'VERIFICATION_COUNT_CHANGED');
    const confirmed = await save(argsFor(pool.version, pool.reportedFreeBeds, key, 'verify'));
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.bedPool.version, pool.version + 1);
    assert.ok(confirmed.body.bedPool.verifiedAt >= pool.verifiedAt);
    pool = await current();
    assert.equal((await save(argsFor(pool.version - 1, pool.reportedFreeBeds, randomUUID(), 'verify'))).body.error.code, 'VERSION_CONFLICT');
  });

  await t.test('two writers at one version produce exactly one saved update; conflict replay is stable', async () => {
    const before = await current();
    const intents = [argsFor(before.version, 1), argsFor(before.version, 2)];
    const results = await Promise.all(intents.map(a => save(a)));
    assert.deepEqual(results.map(r => r.status).sort(), [200,409]);
    assert.equal((await current()).version, before.version + 1);
    const loser = results.findIndex(r => r.status === 409);
    matchesSchema('ErrorResponse', results[loser].body);
    assert.equal(results[loser].body.error.code, 'VERSION_CONFLICT');
    const replay = await save(intents[loser]);
    assert.deepEqual(replay.body, results[loser].body);
    assert.equal(replay.headers['Idempotency-Replayed'], 'true');
  });

  await t.test('simultaneous same-key retries cannot refresh or apply twice', async () => {
    const before = await current(), args = argsFor(before.version, 3);
    const client = await db.connect();
    let first;
    try {
      await beginAs(client, nurse);
      first = await invoke(client, mutationName, args); // keep transaction/advisory lock open
      assert.equal(first.status, 200);
      const concurrent = await save(args);
      assert.equal(concurrent.body.error.code, 'IDEMPOTENCY_IN_PROGRESS');
      assert.equal(concurrent.headers['Retry-After'], '1');
      await client.query('COMMIT');
    } finally { await client.query('ROLLBACK'); client.release(); }
    const replay = await save(args);
    assert.deepEqual(replay.body, first.body);
    assert.equal((await current()).version, before.version + 1);
  });

  await t.test('issuer scope, missing identity, and expired replay retention', async () => {
    const pool = await current(), key = randomUUID();
    const original = await save(argsFor(pool.version, 3, key));
    assert.equal(original.status, 200);
    const client = await db.connect();
    try {
      await beginAs(client, null);
      assert.equal((await invoke(client, mutationName, argsFor(pool.version))).status, 401);
      await client.query('ROLLBACK');
      await beginAs(client, nurse, null);
      assert.equal((await invoke(client, mutationName, argsFor(pool.version))).status, 401);
      await client.query('ROLLBACK');
      await beginAs(client, nurse, 'http://second-test-issuer/auth/v1');
      const independent = await invoke(client, mutationName, argsFor(original.body.bedPool.version, 3, key));
      assert.equal(independent.status, 200);
      assert.equal(independent.headers['Idempotency-Replayed'], 'false');
      await client.query('COMMIT');
    } finally { await client.query('ROLLBACK'); client.release(); }
    await db.query(`UPDATE bedlink_private.idempotency_records SET created_at=created_at-interval '25 hours',
      completed_at=completed_at-interval '25 hours',expires_at=expires_at-interval '25 hours',updated_at=updated_at-interval '25 hours'
      WHERE actor_id=$1 AND issuer=$2 AND idempotency_key=$3`, [nurse,issuer,key]);
    const fresh = await save(argsFor((await current()).version, 3, key));
    assert.equal(fresh.status, 200);
    assert.equal(fresh.headers['Idempotency-Replayed'], 'false');
    assert.ok(fresh.body.bedPool.version > original.body.bedPool.version);
  });

  await t.test('freshness boundaries and capacity use only active unexpired holds', async () => {
    for (const [minutes, expected] of [[0,'fresh'],[10,'aging'],[30,'stale']]) {
      const row = (await db.query(`SELECT bedlink_private.pool_json(
        jsonb_populate_record(null::public.bed_pools,to_jsonb(p)||jsonb_build_object('verified_at',$2::timestamptz-$3::int*interval '1 minute')),
        $2::timestamptz) AS pool FROM public.bed_pools p WHERE id=$1`, [poolId,'2026-10-02T12:00:00.000Z',minutes])).rows[0].pool;
      assert.equal(row.freshness, expected); assert.equal(row.dataAgeMinutes, minutes);
    }
    assert.equal((await read(otherHospital)).body.bedPools[0].freshness, 'unverified');
    for (const expired of [false, true]) {
      const request = randomUUID(), attempt = randomUUID();
      await db.query(`INSERT INTO public.patient_requests(id,owner_id,patient_reference,latitude,longitude,resources,status)
        VALUES ($1,$2,'test-anonymous',20,70,ARRAY['icu']::public.bed_resource[],'held')`, [request,dispatcher]);
      await db.query(`INSERT INTO public.hospital_attempts(id,request_id,hospital_id,bed_pool_id,status,created_at,response_deadline_at,resolved_at)
        VALUES ($1,$2,$3,$4,'accepted',now()-interval '10 minutes',now()-interval '8 minutes',now()-interval '9 minutes')`,
      [attempt,request,hospital,poolId]);
      await db.query(`INSERT INTO public.holds(request_id,attempt_id,hospital_id,bed_pool_id,created_at,expires_at)
        VALUES ($1,$2,$3,$4,now()-interval '9 minutes',now()+$5::int*interval '1 minute')`, [request,attempt,hospital,poolId,expired ? -1 : 30]);
    }
    const before = await current();
    assert.equal(before.activeHoldCount, 1);
    assert.equal(before.availableBeds, before.reportedFreeBeds - 1);
    assert.equal((await save(argsFor(before.version, 0))).body.error.code, 'FREE_COUNT_BELOW_HOLDS');
    const saved = await save(argsFor(before.version, 1));
    assert.equal(saved.status, 200); assert.equal(saved.body.bedPool.availableBeds, 0);
    assert.equal(saved.body.bedPool.loadRatio, 1);
    assert.equal((await current()).verifiedAt, saved.body.bedPool.verifiedAt);
  });

  await t.test('idempotency persistence failure rolls back the inventory write and emits safe HTTP 503', async () => {
    const before = await current(), key = randomUUID();
    // Dedicated disposable DB only. Fail AFTER the UPDATE, while saving its result.
    const trigger = `step3_failure_${randomUUID().replaceAll('-', '')}`;
    await db.query(`CREATE FUNCTION public.${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF new.idempotency_key='${key}' THEN RAISE EXCEPTION 'secret database internals'; END IF; RETURN new; END; $$`);
    await db.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON bedlink_private.idempotency_records FOR EACH ROW EXECUTE FUNCTION public.${trigger}()`);
    try {
      const response = await httpSave({ operation:'update',reportedFreeBeds:2,version:before.version }, key);
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.error.code, 'SERVICE_UNAVAILABLE');
      assert.ok(!JSON.stringify(body).includes('secret'));
      const after = await current();
      assert.equal(after.version, before.version); assert.equal(after.verifiedAt, before.verifiedAt);
      assert.equal(after.reportedFreeBeds, before.reportedFreeBeds);
      assert.equal((await db.query('SELECT 1 FROM bedlink_private.idempotency_records WHERE idempotency_key=$1', [key])).rowCount, 0);
    } finally {
      await db.query(`DROP TRIGGER ${trigger} ON bedlink_private.idempotency_records`);
      await db.query(`DROP FUNCTION public.${trigger}()`);
    }
  });
});
