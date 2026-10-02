import { createBedLinkApi, createIdempotencyKey } from '../client/bedlink-api.mjs';

// Framework-independent example. getAccessToken obtains the current Supabase session token.
export function availabilityExample(baseUrl, getAccessToken) {
  const api = createBedLinkApi({ baseUrl, getAccessToken });
  return {
    read: (hospitalId, signal) => api.listBedPools(hospitalId, { signal }),
    makeIntent: (pool, count) => Object.freeze({
      reportedFreeBeds: count, version: pool.version, idempotencyKey: createIdempotencyKey(),
    }),
    async save(hospitalId, poolId, intent, setState, signal) {
      setState({ status: 'pending', intent });
      try {
        const result = await api.updateCount(hospitalId, poolId, { ...intent, signal });
        // Only an acknowledged 200 may mark this intent saved. A replay has OLD freshness.
        setState({ status: 'saved', pool: result.data.bedPool, replayed: result.meta.idempotencyReplayed });
        return result;
      } catch (error) {
        // Never mark offline, aborted or uncertain saves as successfully synchronized.
        setState({ status: 'pending', intent, errorCode: error.code || error.name });
        throw error;
      }
    },
    // Use the currently displayed SAVED count/version, not an unsaved edit.
    // Create intent once with makeIntent(pool, pool.reportedFreeBeds); retain it for retries.
    verify: (hospitalId, poolId, intent, signal) => api.verifyCount(hospitalId, poolId, { ...intent, signal }),
  };
}
