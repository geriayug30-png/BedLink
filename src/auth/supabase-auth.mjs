import { unauthenticated, unavailable } from '../errors.mjs';

export function createSupabaseAuth(config, fetchImpl = fetch) {
  return async function authenticate(authorization, signal) {
    const match = /^Bearer ([^\s,]+)$/i.exec(authorization || '');
    if (!match) throw unauthenticated();
    const token = match[1];
    let response;
    try {
      response = await fetchImpl(`${config.supabaseUrl}/auth/v1/user`, {
        headers: { apikey: config.publishableKey, Authorization: `Bearer ${token}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
      });
      if ([400, 401, 403].includes(response.status)) throw unauthenticated();
      if (!response.ok) throw unavailable();
      const user = await response.json();
      if (typeof user.id !== 'string' || !user.id) throw unavailable();
      return { token, userId: user.id };
    } catch (error) {
      if (error.status === 401) throw error;
      throw unavailable();
    }
  };
}
