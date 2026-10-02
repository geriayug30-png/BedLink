import { unavailable, unauthenticated } from '../errors.mjs';

export function createSupabaseRpc(config, fetchImpl = fetch) {
  return async function rpc(name, args, identity, signal) {
    try {
      const response = await fetchImpl(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
        method: 'POST', headers: { apikey: config.publishableKey,
          Authorization: `Bearer ${identity.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
      });
      if (response.status === 401) throw unauthenticated();
      if (!response.ok) throw unavailable();
      const result = await response.json();
      if (![200, 400, 401, 403, 404, 409, 503].includes(result?.status) ||
        !result.body || typeof result.body.serverTime !== 'string' ||
        (result.status !== 200 && typeof result.body.error?.code !== 'string')) throw unavailable();
      return result;
    } catch (error) {
      if (error.status === 401) throw error;
      throw unavailable();
    }
  };
}
