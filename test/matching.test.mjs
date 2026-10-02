import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { rankHospitals, createMatchingService, roundScore } from '../src/services/matching.mjs';
import { simulatedTravelProvider, haversineKm } from '../src/travel/simulated.mjs';
import { DEFAULT_MATCHING_POLICY as policy, readMatchingPolicy } from '../src/matching-policy.mjs';
import { matchSearch } from '../src/validation.mjs';
import { createApp } from '../src/app.mjs';
import { createSupabaseAuth } from '../src/auth/supabase-auth.mjs';
import { createBedLinkApi } from '../client/bedlink-api.mjs';
import { config, serve, matchesSchema } from './support.mjs';

const now = Date.parse('2026-10-02T10:00:00.000Z');
const needs = { location: { latitude: 0, longitude: 0 }, resources: ['icu'], specialty: null };
const pool = (id = 'pool', overrides = {}) => ({ id, hospitalId: 'hospital', label: id, resources: ['icu'], specialties: [],
  capacity: 10, reportedFreeBeds: 5, activeHoldCount: 0, availableBeds: 5, loadRatio: 0.5,
  verifiedAt: new Date(now - 60000).toISOString(), dataAgeMinutes: 1, freshness: 'fresh',
  freshnessPolicy: { policyVersion: 'demo-1', agingAfterMinutes: 10, staleAfterMinutes: 30 },
  inventoryUpdatedAt: new Date(now - 60000).toISOString(), version: 1, ...overrides });
const hospital = (id = 'hospital', pools = [pool()], longitude = 0) => ({ id, name: id,
  location: { latitude: 0, longitude }, bedPools: pools.map(p => ({ ...p, hospitalId: id })) });
const fixedTravel = minutes => ({ async estimate() { return { distanceKm: 1, estimatedTravelMinutes: minutes,
  source: 'simulatedDistance', trafficConsidered: false }; } });
const rank = (hospitals, overrides = {}) => rankHospitals({ hospitals, needs, clock: () => now,
  travelProvider: fixedTravel(5), ...overrides });

test('all requirements must occur in one pool; nearer incompatible hospitals never rank', async () => {
  const combined = { ...needs, resources: ['icu', 'ventilator'], specialty: 'cardiac' };
  const catalog = [hospital('near-split', [pool('icu'), pool('vent', { resources: ['ventilator'], specialties: ['cardiac'] })]),
    hospital('wrong-specialty', [pool('wrong', { resources: ['icu','ventilator'], specialties: ['burns'] })]),
    hospital('far-valid', [pool('valid', { resources: ['icu','ventilator'], specialties: ['cardiac'] })], 2)];
  let calls = 0;
  const result = await rank(catalog, { needs: combined, travelProvider: { estimate: async args => {
    calls++; assert.equal(args.destination.longitude, 2); return fixedTravel(90).estimate();
  } } });
  assert.equal(calls, 1);
  assert.deepEqual(result.result.candidates.map(c => c.hospital.id), ['far-valid']);
  assert.equal(result.result.candidates[0].scoreBreakdown.travelScore, 0);
  assert.equal(result.result.diagnostics.compatiblePoolCount, 1);
  matchesSchema('MatchesResponse', result);
});

test('headroom subtracts holds, does not trust cached availability, and excludes fully held pools', async () => {
  const result = await rank([hospital('held', [pool('held', { reportedFreeBeds: 2, activeHoldCount: 2, availableBeds: 99 })]),
    hospital('one-free', [pool('one', { reportedFreeBeds: 2, activeHoldCount: 1, availableBeds: 99 })])]);
  const [candidate] = result.result.candidates;
  assert.equal(candidate.hospital.id, 'one-free');
  assert.equal(candidate.bedPool.availableBeds, 1);
  assert.equal(candidate.bedPool.loadRatio, 0.9);
  assert.equal(candidate.scoreBreakdown.headroomScore, 10);
  assert.equal(result.result.diagnostics.freshAvailablePoolCount, 1);
});

test('fractional freshness boundaries, null verification and reads do not alter inputs', async () => {
  const ages = [0, 9.999, 10, 29.999, 30, null];
  const catalog = ages.map((age,i) => hospital(`h${i}`, [pool(`p${i}`, {
    verifiedAt: age === null ? null : new Date(now - age * 60000).toISOString(),
  })]));
  const before = structuredClone(catalog);
  const result = await rank(catalog);
  assert.equal(result.result.candidates.length, 4);
  assert.deepEqual(result.result.diagnostics, { excludedHospitalIds: [], compatiblePoolCount: 6,
    freshPoolCount: 4, stalePoolCount: 1, unverifiedPoolCount: 1, freshAvailablePoolCount: 4 });
  assert.equal(result.result.candidates.find(c => c.hospital.id === 'h2').bedPool.freshness, 'aging');
  assert.deepEqual(catalog, before);
  matchesSchema('MatchesResponse', result);
});

test('each score component can change ranking using the agreed weights and unrounded arithmetic', async () => {
  const base = hospital('a'), competitor = hospital('b');
  assert.equal((await rank([competitor, base])).result.candidates[0].hospital.id, 'a');
  const faster = await rank([base, hospital('b', [pool()], 1)], { travelProvider: {
    estimate: async ({ destination }) => fixedTravel(destination.longitude === 1 ? 1 : 50).estimate(),
  } });
  assert.equal(faster.result.candidates[0].hospital.id, 'b');
  const fresher = await rank([hospital('a', [pool('a', { verifiedAt: new Date(now-29*60000).toISOString() })]), competitor]);
  assert.equal(fresher.result.candidates[0].hospital.id, 'b');
  const freer = await rank([hospital('a', [pool('a', { reportedFreeBeds: 1 })]), competitor]);
  assert.equal(freer.result.candidates[0].hospital.id, 'b');
  const result = await rank([hospital('exact', [pool('exact', { reportedFreeBeds: 2 })])], { travelProvider: fixedTravel(3) });
  assert.equal(result.result.candidates[0].score, 80.5);
  assert.deepEqual(result.result.candidates[0].scoreBreakdown, { travelScore: 95, freshnessScore: 96.6667, headroomScore: 20 });
  assert.equal(roundScore(1.005, 2), 1.01);
  assert.equal(roundScore(99.99995, 4), 100);
});

test('one best pool per hospital, deterministic pool/hospital ties and internal exclusions', async () => {
  const best = await rank([hospital('h', [pool('a', { reportedFreeBeds: 1 }), pool('b', { reportedFreeBeds: 9 })])]);
  assert.equal(best.result.candidates.length, 1);
  assert.equal(best.result.candidates[0].bedPool.id, 'b');
  const catalog = [hospital('z', [pool('z'), pool('A')]), hospital('A'), hospital('a')];
  const result = await rank(catalog);
  assert.deepEqual(result.result.candidates.map(c => c.hospital.id), ['A', 'a', 'z']);
  assert.equal(result.result.candidates[2].bedPool.id, 'A');
  assert.deepEqual(await rank([...catalog].reverse()), result);
  const excluded = await rank(catalog, { excludedHospitalIds: ['z','A','z'] });
  assert.deepEqual(excluded.result.candidates.map(c => c.hospital.id), ['a']);
  assert.deepEqual(excluded.result.diagnostics.excludedHospitalIds, ['A','z']);
  assert.equal(excluded.result.diagnostics.compatiblePoolCount, 1);
  // Equal rounded totals: ETA is the second hospital sort key (both travel components are zero).
  const ties = await rank([hospital('a', [pool()], 100), hospital('z', [pool()], 60)], {
    travelProvider: { estimate: async ({destination}) => fixedTravel(destination.longitude).estimate() },
  });
  assert.deepEqual(ties.result.candidates.map(c => c.hospital.id), ['z','a']);
  const unicode = await rank([hospital('\u{10000}'), hospital('\ue000')]);
  assert.deepEqual(unicode.result.candidates.map(c => c.hospital.id), ['\ue000', '\u{10000}']);
});

test('empty states follow stale-before-full precedence and never call travel without eligible pools', async () => {
  const noTravel = { estimate: async () => { throw new Error('should not run'); } };
  for (const [catalog, expected] of [[[], 'noEligibleHospitals'],
    [[hospital('wrong', [pool('p', { resources: ['oxygen'] })])], 'noEligibleHospitals'],
    [[hospital('full', [pool('p', { reportedFreeBeds: 0 })])], 'capacityUnavailable'],
    [[hospital('old', [pool('p', { verifiedAt: null })]), hospital('full', [pool('p', {reportedFreeBeds: 0})])], 'availabilityOutdated']]) {
    const result = await rank(catalog, { travelProvider: noTravel });
    assert.equal(result.result.outcome, expected);
    assert.deepEqual(result.result.candidates, []);
    matchesSchema('MatchesResponse', result);
  }
});

test('simulated travel is deterministic, bounded at identical/antipodal coordinates, and uses unrounded distance', async () => {
  const estimate = (origin, destination) => simulatedTravelProvider.estimate({ origin, destination, policy });
  const origin = { latitude: 0, longitude: 0 };
  assert.deepEqual(await estimate(origin, origin), { distanceKm: 0, estimatedTravelMinutes: 1, source: 'simulatedDistance', trafficConsidered: false });
  const antipode = { latitude: 0, longitude: 180 };
  assert.ok(Math.abs(haversineKm(origin, antipode) - Math.PI * 6371) < 1e-8);
  const target = { latitude: 0, longitude: 0.00346 };
  const travel = await estimate(origin, target);
  assert.equal(travel.distanceKm, 0.4);
  assert.equal(travel.estimatedTravelMinutes, 2); // rounded 0.4 is not used for ETA arithmetic
  assert.deepEqual(travel, await estimate(origin, target));
  assert.equal((await estimate({ latitude: 90, longitude: 180 }, { latitude: -90, longitude: -180 })).trafficConsidered, false);
});

test('travel errors, invalid estimates and timeouts fail the whole ranking without partial diagnostics', async () => {
  for (const provider of [
    { estimate: async () => { throw new Error('secret provider token'); } },
    { estimate: async () => ({ distanceKm: 1, estimatedTravelMinutes: 0, source: 'simulatedDistance', trafficConsidered: false }) },
    { estimate: async () => new Promise(() => {}) },
    { estimate: async ({ destination }) => destination.longitude === 1 ? Promise.reject(new Error('partial failure')) : fixedTravel(5).estimate() },
  ]) {
    await assert.rejects(rank([hospital('a'), hospital('b', [pool()], 1)], { travelProvider: provider, travelTimeoutMs: 15 }),
      e => e.status === 503 && e.code === 'SERVICE_UNAVAILABLE' && !e.message.includes('secret'));
  }
  const controller = new AbortController();
  const pending = rank([hospital()], { signal: controller.signal, travelProvider: { estimate: async () => new Promise(() => {}) } });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('policy settings are explicit, bounded and consistent; corrupt inventory fails closed', async () => {
  assert.deepEqual(readMatchingPolicy(), policy);
  for (const env of [{ MATCH_TRAVEL_WEIGHT: '-1' }, { MATCH_TRAVEL_WEIGHT: '0.8' },
    { MATCH_SIMULATED_SPEED_KPH: '0' }, { MATCH_SIMULATED_ROAD_FACTOR: '0.5' },
    { MATCH_SIMULATED_SPEED_KPH: '40' }, { MATCH_TRAVEL_HORIZON_MINUTES: 'Infinity' }]) assert.throws(() => readMatchingPolicy(env));
  assert.equal(readMatchingPolicy({ MATCH_POLICY_VERSION: 'prototype-2', MATCH_SIMULATED_SPEED_KPH: '40' }).simulatedSpeedKph, 40);
  for (const changes of [{ activeHoldCount: 6 }, { verifiedAt: new Date(now+1).toISOString() },
    { freshnessPolicy: { agingAfterMinutes: 5, staleAfterMinutes: 20 } }]) {
    await assert.rejects(rank([hospital('bad', [pool('bad', changes)])]), { status: 503 });
  }
});

test('matching reproduces all original standalone search response fixtures', async () => {
  for (const [folder, search, catalog] of [['01-success','02-matches','01-catalog'],
    ['04-no-eligible','01-search','00-catalog'],['05-stale','01-search','00-catalog'],['06-capacity-unavailable','01-search','00-catalog']]) {
    const load = async file => JSON.parse(await readFile(new URL(`../docs/api/examples/${folder}/${file}`, import.meta.url), 'utf8'));
    const request = await load(`${search}.request.json`), expected = await load(`${search}.response.json`), snapshot = await load(`${catalog}.response.json`);
    const actual = await rankHospitals({ hospitals: snapshot.hospitals, needs: matchSearch(request), clock: () => Date.parse(expected.serverTime) });
    assert.deepEqual(actual.result, expected.result);
  }
});

test('HTTP matching/client integration uses shared auth, rejects invalid inputs, and keeps diagnostics private', async t => {
  const logs = [], rpcCalls = [];
  let providerCalls = 0, failTravel = false;
  const authenticate = createSupabaseAuth(config, async (url, options) => {
    const token = options.headers.Authorization.slice(7);
    return ['dispatcher','nurse'].includes(token) ? Response.json({ id: token }) : Response.json({}, { status: 401 });
  });
  const base = await serve(t, createApp({ config, authenticate, logger: e => logs.push(e),
    travelProvider: { estimate: async () => { providerCalls++; if (failTravel) throw new Error('private coordinates'); return fixedTravel(5).estimate(); } },
    rpc: async (name, args, identity) => {
      rpcCalls.push({ name, args, identity });
      return identity.userId === 'dispatcher' ? { status: 200, body: { serverTime: new Date(now).toISOString(), hospitals: [hospital()] } }
        : { status: 403, body: { serverTime: new Date(now).toISOString(), error: { code: 'FORBIDDEN', message: 'Active dispatcher membership required.' } } };
    } }));
  const call = (body, token = 'dispatcher', contentType = 'application/json', query = '') => fetch(`${base}/matches${query}`, {
    method: 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  for (const token of [null,'invalid','expired']) assert.equal((await call({ needs }, token)).status, 401);
  const denied = await call({ needs }, 'nurse');
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).result, undefined);
  assert.equal(providerCalls, 0);
  const invalid = [{}, { needs: null }, { needs, role: 'dispatcher' }, { needs, excludedHospitalIds: ['hospital'] },
    ...[91, -91, '0', null].map(latitude => ({ needs: { ...needs, location: { latitude, longitude: 0 } } })),
    { needs: { ...needs, location: { latitude: 0, longitude: 181 } } },
    { needs: { ...needs, location: { latitude: 0, longitude: 0, extra: 1 } } },
    ...[[], ['icu','icu'], ['cardiac'], 'icu'].map(resources => ({ needs: { ...needs, resources } })),
    { needs: { ...needs, specialty: 'unknown' } }, { needs: { ...needs, score: 100 } }, '{', '[]'];
  const before = rpcCalls.length;
  for (const body of invalid) {
    const response = await call(body); assert.equal(response.status, 400); matchesSchema('ErrorResponse', await response.json());
  }
  assert.equal(rpcCalls.length, before);
  assert.equal((await call('x'.repeat(2048))).status, 413);
  assert.equal((await call('{}','dispatcher','text/plain')).status, 415);
  assert.equal((await call({ needs },'dispatcher','application/json','?excludedHospitalIds=h')).status, 400);
  const preflight = await fetch(`${base}/matches`, { method: 'OPTIONS', headers: { Origin: config.origins[0] } });
  assert.ok(preflight.headers.get('Access-Control-Allow-Methods').includes('POST'));
  const api = createBedLinkApi({ baseUrl: base, getAccessToken: async () => 'dispatcher', fetchImpl: async (url, options) => {
    assert.equal(Object.hasOwn(options.headers, 'Idempotency-Key'), false);
    return fetch(url, options);
  } });
  const result = await api.findMatches(needs);
  matchesSchema('MatchesResponse', result.data);
  assert.equal(result.data.serverTime, new Date(now).toISOString());
  assert.equal(rpcCalls.at(-1).name, 'bedlink_read_matching_catalog');
  assert.deepEqual(rpcCalls.at(-1).args, {});
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api.findMatches(needs, { signal: controller.signal }), { name: 'AbortError' });
  failTravel = true;
  const failure = await call({ needs });
  assert.equal(failure.status, 503); assert.equal(failure.headers.get('Retry-After'), '1');
  matchesSchema('ErrorResponse', await failure.json());
  assert.ok(!/coordinates|latitude|longitude|Bearer|dispatcher|nurse/.test(JSON.stringify(logs)));
  // Boundary coordinates and omitted specialty are valid; normalize without mutating input.
  assert.equal(matchSearch({ needs: { location: { latitude: -90, longitude: 180 }, resources: ['oxygen'] } }).specialty, null);
});

test('service waits for authorized RPC completion before providers and honors injected snapshot clock', async () => {
  let completed = false;
  const service = createMatchingService({ rpc: async () => {
    completed = true; return { status: 200, body: { serverTime: '1999-01-01T00:00:00Z', hospitals: [hospital()] } };
  }, clock: () => now, travelProvider: { estimate: async () => {
    assert.equal(completed, true); return fixedTravel(5).estimate();
  } } });
  const response = await service(needs, {}, new AbortController().signal);
  assert.equal(response.body.serverTime, new Date(now).toISOString());
});
