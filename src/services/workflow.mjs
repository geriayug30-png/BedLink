import { rankHospitals, travelEstimates } from './matching.mjs';
import { DEFAULT_MATCHING_POLICY } from '../matching-policy.mjs';
import { simulatedTravelProvider } from '../travel/simulated.mjs';
import { unavailable } from '../errors.mjs';

const coordinateKey = location => JSON.stringify([location.latitude, location.longitude]);
// Precompute provider results outside transactions, retaining failures per destination.
// Pure ranking inside the final transaction uses only these cached results.
async function prepareTravel(context, policy, provider, signal, timeoutMs) {
  const estimates = new Map();
  const compatible = context.hospitals.filter(h => h.bedPools.some(p =>
    context.needs.resources.every(r => p.resources.includes(r)) &&
    (context.needs.specialty == null || p.specialties.includes(context.needs.specialty))));
  await Promise.all(compatible.map(async hospital => {
    const key = coordinateKey(hospital.location);
    if (estimates.has(key)) return;
    const task = (async () => {
      // Reuse Step 4's bounded provider interface without inventing pool inventory.
      const [value] = await travelEstimates([hospital], context.needs, provider, policy, signal, timeoutMs);
      return { value };
    })().catch(() => ({ failed: true }));
    estimates.set(key, task);
    await task;
  }));
  // Resolve every promise BEFORE the final transaction. No asynchronous provider I/O remains.
  const values = new Map();
  for (const [key, task] of estimates) values.set(key, await task);
  signal?.throwIfAborted();
  return { async estimate({ destination }) {
    const entry = values.get(coordinateKey(destination));
    if (!entry || entry.failed) throw unavailable();
    return entry.value;
  } };
}

export function createWorkflowService({ database, policy = DEFAULT_MATCHING_POLICY,
  travelProvider = simulatedTravelProvider, travelTimeoutMs = 5000 }) {
  return async (action, params, key, identity, signal) => {
    signal?.throwIfAborted();
    const context = await database.transaction(identity, query => query('context', [action, params, key]));
    if (context.status >= 400 || context.headers?.['Idempotency-Replayed'] === 'true') return context;
    const cachedProvider = context.body.needs ? await prepareTravel(context.body, policy, travelProvider, signal, travelTimeoutMs) : null;
    signal?.throwIfAborted();
    return database.transaction(identity, async query => {
      const result = await query('run', [action, params, key]);
      if (result.offer) {
        if (!cachedProvider) throw unavailable();
        const ranked = await rankHospitals({ ...result.offer, policy, travelProvider: cachedProvider,
          clock: () => Date.parse(result.body.serverTime), signal, travelTimeoutMs });
        result.body.nextBest = ranked.result;
      }
      signal?.throwIfAborted();
      if (result.recordId) return query('finish', [result.recordId,
        { status: result.status, headers: result.headers, body: result.body }]);
      return { status: result.status, headers: result.headers || {}, body: result.body };
    });
  };
}
