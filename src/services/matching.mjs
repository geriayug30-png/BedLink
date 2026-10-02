import { ApiError, unavailable } from '../errors.mjs';
import { DEFAULT_MATCHING_POLICY } from '../matching-policy.mjs';
import { simulatedTravelProvider } from '../travel/simulated.mjs';

const compareId = (a, b) => {
  const left = Array.from(a, c => c.codePointAt(0)), right = Array.from(b, c => c.codePointAt(0));
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
};
// Decimal exponent shifting gives positive half-up rounding without toFixed's binary ties.
export function roundScore(value, places) {
  const [coefficient, exponent = '0'] = String(value).split('e');
  return Number(`${Math.round(Number(`${coefficient}e${Number(exponent) + places}`))}e-${places}`);
}

async function travelEstimates(hospitals, needs, provider, policy, signal, timeoutMs) {
  if (!hospitals.length) return [];
  const timeout = new AbortController();
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  let abortListener;
  try {
    combined.throwIfAborted();
    const cancelled = new Promise((_, reject) => {
      abortListener = () => reject(combined.reason);
      combined.addEventListener('abort', abortListener, { once: true });
    });
    const estimates = await Promise.race([cancelled, Promise.all(hospitals.map(hospital => provider.estimate({
      origin: { ...needs.location }, destination: { ...hospital.location }, policy, signal: combined,
    })))]);
    for (const travel of estimates) {
      if (!travel || !Number.isFinite(travel.distanceKm) || travel.distanceKm < 0 ||
        !Number.isSafeInteger(travel.estimatedTravelMinutes) || travel.estimatedTravelMinutes < 1 ||
        travel.source !== 'simulatedDistance' || travel.trafficConsidered !== false) throw unavailable();
    }
    return estimates.map(t => ({ distanceKm: t.distanceKm, estimatedTravelMinutes: t.estimatedTravelMinutes,
      source: t.source, trafficConsidered: t.trafficConsidered }));
  } catch {
    if (signal?.aborted) signal.throwIfAborted();
    throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Travel estimates temporarily unavailable.');
  } finally {
    clearTimeout(timer);
    if (abortListener) combined.removeEventListener('abort', abortListener);
    timeout.abort();
  }
}

// Internal reuse boundary for Step 5. Caller must supply an authorized catalog and
// trusted attempted-hospital IDs. Public request bodies cannot set exclusions.
export async function rankHospitals({ hospitals, needs, clock = Date.now,
  policy = DEFAULT_MATCHING_POLICY, excludedHospitalIds = [], travelProvider = simulatedTravelProvider,
  signal, travelTimeoutMs = 5000 }) {
  signal?.throwIfAborted();
  const now = Number(clock());
  if (!Number.isFinite(now)) throw unavailable();
  const excluded = new Set(excludedHospitalIds);
  const diagnostics = { excludedHospitalIds: [...excluded].sort(compareId), compatiblePoolCount: 0,
    freshPoolCount: 0, stalePoolCount: 0, unverifiedPoolCount: 0, freshAvailablePoolCount: 0 };
  const eligible = [];
  for (const hospital of hospitals) {
    if (excluded.has(hospital.id)) continue;
    const pools = [];
    for (const pool of hospital.bedPools) {
      if (!needs.resources.every(resource => pool.resources.includes(resource)) ||
        (needs.specialty != null && !pool.specialties.includes(needs.specialty))) continue;
      diagnostics.compatiblePoolCount++;
      if (pool.freshnessPolicy.agingAfterMinutes !== policy.agingAfterMinutes ||
        pool.freshnessPolicy.staleAfterMinutes !== policy.staleAfterMinutes) throw unavailable();
      if (pool.verifiedAt === null) { diagnostics.unverifiedPoolCount++; continue; }
      const age = (now - Date.parse(pool.verifiedAt)) / 60000;
      if (!Number.isFinite(age) || age < 0) throw unavailable();
      if (age >= policy.staleAfterMinutes) { diagnostics.stalePoolCount++; continue; }
      diagnostics.freshPoolCount++;
      // Do not trust cached derived fields; maintain the same F-H counting invariant.
      const { capacity, reportedFreeBeds: free, activeHoldCount: held } = pool;
      if (![capacity, free, held].every(Number.isSafeInteger) || capacity <= 0 || held < 0 || held > free || free > capacity) throw unavailable();
      const available = free - held;
      if (available === 0) continue;
      diagnostics.freshAvailablePoolCount++;
      pools.push({ ...pool, availableBeds: available, loadRatio: 1 - available / capacity,
        dataAgeMinutes: age, freshness: age >= policy.agingAfterMinutes ? 'aging' : 'fresh' });
    }
    if (pools.length) eligible.push({ hospital, pools });
  }
  // The caller's catalog RPC has already completed. Never hold DB locks around providers.
  const travels = await travelEstimates(eligible.map(e => e.hospital), needs, travelProvider, policy, signal, travelTimeoutMs);
  const candidates = eligible.map(({ hospital, pools }, index) => {
    const travel = travels[index];
    const scored = pools.map(bedPool => {
      const travelScore = Math.max(0, 100 * (1 - travel.estimatedTravelMinutes / policy.travelScoreHorizonMinutes));
      const freshnessScore = Math.max(0, 100 * (1 - bedPool.dataAgeMinutes / policy.staleAfterMinutes));
      const headroomScore = 100 * bedPool.availableBeds / bedPool.capacity;
      const score = roundScore(travelScore * policy.travelWeight + freshnessScore * policy.freshnessWeight + headroomScore * policy.headroomWeight, 2);
      return { bedPool, score, scoreBreakdown: { travelScore: roundScore(travelScore, 4),
        freshnessScore: roundScore(freshnessScore, 4), headroomScore: roundScore(headroomScore, 4) } };
    }).sort((a,b) => b.score - a.score || compareId(a.bedPool.id, b.bedPool.id));
    return { hospital: { id: hospital.id, name: hospital.name, location: { ...hospital.location } },
      ...scored[0], matchesAllRequirements: true, travel };
  }).sort((a,b) => b.score - a.score || a.travel.estimatedTravelMinutes - b.travel.estimatedTravelMinutes || compareId(a.hospital.id,b.hospital.id))
    .map((candidate, index) => ({ rank: index + 1, ...candidate }));
  const outcome = candidates.length ? 'matchesFound' : diagnostics.stalePoolCount + diagnostics.unverifiedPoolCount > 0
    ? 'availabilityOutdated' : diagnostics.compatiblePoolCount > 0 ? 'capacityUnavailable' : 'noEligibleHospitals';
  return { serverTime: new Date(now).toISOString(), result: { outcome, candidates, diagnostics, policy: { ...policy } } };
}

export function createMatchingService({ rpc, policy = DEFAULT_MATCHING_POLICY, travelProvider = simulatedTravelProvider,
  travelTimeoutMs = 5000, clock }) {
  return async (needs, identity, signal, { excludedHospitalIds = [] } = {}) => {
    const snapshot = await rpc('bedlink_read_matching_catalog', {}, identity, signal);
    if (snapshot.status !== 200) return snapshot;
    if (!Array.isArray(snapshot.body.hospitals)) throw unavailable();
    // Use DB snapshot time for BOTH holds and freshness, independent of host clock skew.
    const body = await rankHospitals({ hospitals: snapshot.body.hospitals, needs, policy, travelProvider,
      travelTimeoutMs, excludedHospitalIds, signal, clock: clock || (() => Date.parse(snapshot.body.serverTime)) });
    return { status: 200, headers: {}, body };
  };
}
