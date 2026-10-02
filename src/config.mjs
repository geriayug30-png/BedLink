import { readMatchingPolicy } from './matching-policy.mjs';

export function readConfig(env = process.env) {
  const integer = (name, fallback, min, max) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    return value;
  };
  const url = new URL(env.SUPABASE_URL);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('SUPABASE_URL must be an HTTPS origin or local HTTP origin');
  }
  const key = env.SUPABASE_PUBLISHABLE_KEY;
  // Decoding here only rejects unsafe configuration; it never authenticates a user.
  let legacyRole;
  try { legacyRole = JSON.parse(Buffer.from(key.split('.')[1], 'base64url')).role; } catch { /* modern key */ }
  if (!key || !(key.startsWith('sb_publishable_') || legacyRole === 'anon')) {
    throw new Error('Use a Supabase publishable or legacy anon key');
  }
  const origins = (env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) throw new Error('Invalid CORS_ORIGINS');
  }
  return { supabaseUrl: url.origin, publishableKey: key, origins,
    port: integer('PORT', 3000, 1, 65535), host: env.HOST || '127.0.0.1',
    jsonLimit: integer('JSON_LIMIT_BYTES', 16384, 1024, 1048576),
    timeoutMs: integer('UPSTREAM_TIMEOUT_MS', 10000, 100, 60000),
    matchingPolicy: readMatchingPolicy(env), travelTimeoutMs: integer('MATCH_TRAVEL_TIMEOUT_MS', 5000, 1, 60000) };
}
