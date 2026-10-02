import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';
import { createSupabaseAuth } from '../src/auth/supabase-auth.mjs';
import { createSupabaseRpc } from '../src/db/supabase-rpc.mjs';
import { readConfig } from '../src/config.mjs';
import { serve, config, H, P, matchesSchema } from './support.mjs';

test('HTTP auth, validation, CORS, health, safe errors and private logs', async t => {
  const logs = [], authCalls = [], rpcCalls = [];
  const authenticate = createSupabaseAuth(config, async (url, options) => {
    authCalls.push({ url, options });
    if (options.headers.Authorization !== 'Bearer valid') return Response.json({ message: 'secret upstream token' }, { status: 401 });
    return Response.json({ id: 'trusted-id', user_metadata: { role: 'admin' } });
  });
  const rpc = async (...args) => {
    rpcCalls.push(args);
    return { status: 200, headers: {}, body: { serverTime: new Date().toISOString(), hospitals: [] } };
  };
  const base = await serve(t, createApp({ config, authenticate, rpc, logger: e => logs.push(e) }));
  const call = (path, options = {}) => fetch(base + path, options);
  let response = await call('/health');
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(await response.json()).sort(), ['serverTime', 'status']);
  assert.equal(authCalls.length, 0);
  for (const authorization of [undefined, 'bad', 'Bearer invalid', 'Bearer expired']) {
    response = await call('/hospitals', { headers: authorization ? { Authorization: authorization } : {} });
    assert.equal(response.status, 401);
    const body = await response.json();
    matchesSchema('ErrorResponse', body);
    assert.equal(body.error.code, 'UNAUTHENTICATED');
    assert.equal(response.headers.get('WWW-Authenticate'), 'Bearer');
  }
  response = await call('/hospitals', { headers: { Authorization: 'Bearer valid' } });
  assert.equal(response.status, 200);
  matchesSchema('HospitalsResponse', await response.json());
  assert.equal(rpcCalls[0][2].userId, 'trusted-id');
  assert.equal(authCalls.at(-1).url, config.supabaseUrl + '/auth/v1/user');
  const patch = (body, extra = {}) => call(`/hospitals/${H}/bed-pools/${P}`, {
    method: 'PATCH', headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json', 'Idempotency-Key': 'test-key-123', ...extra },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  for (const count of [-1, 1.5, '1', null, 2147483648]) {
    response = await patch({ operation: 'update', reportedFreeBeds: count, version: 1 });
    assert.equal(response.status, 400);
  }
  for (const body of ['{', '[]', '{}', '{"operation":"update","reportedFreeBeds":1,"version":1,"role":"nurse"}']) {
    assert.equal((await patch(body)).status, 400);
  }
  assert.equal((await patch('x'.repeat(2048))).status, 413);
  assert.equal((await patch('{}', { 'Content-Type': 'text/plain' })).status, 415);
  response = await patch({ operation: 'update', reportedFreeBeds: 1, version: 1 }, { 'Idempotency-Key': '' });
  assert.equal((await response.json()).error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  response = await call('/hospitals?patient=private', { headers: { Authorization: 'Bearer valid' } });
  assert.equal(response.status, 400);
  assert.equal((await call('/hospitals/unknown/bed-pools', { headers: { Authorization: 'Bearer valid' } })).status, 404);
  response = await call('/hospitals', { method: 'OPTIONS', headers: { Origin: config.origins[0] } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), config.origins[0]);
  assert.equal((await call('/hospitals', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.ok(logs.every(e => /^[a-f0-9-]{36}$/.test(e.requestId)));
  assert.ok(!/private|Bearer|secret|patient/.test(JSON.stringify(logs)));
  assert.equal(new Set(logs.map(e => e.requestId)).size, logs.length);
});

test('database adapter forwards user identity and hides transport/database failure details', async t => {
  let captured;
  const identity = { token: 'verified-token' };
  const rpc = createSupabaseRpc(config, async (url, options) => {
    captured = { url, options };
    return Response.json({ password: 'secret', message: 'internal SQL details' }, { status: 500 });
  });
  const base = await serve(t, createApp({ config, authenticate: async () => identity, rpc, logger: () => {} }));
  const response = await fetch(base + '/hospitals');
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Retry-After'), '1');
  const body = await response.json();
  matchesSchema('ErrorResponse', body);
  assert.equal(body.error.code, 'SERVICE_UNAVAILABLE');
  assert.ok(!/SQL|password|secret/.test(JSON.stringify(body)));
  assert.equal(captured.options.headers.Authorization, 'Bearer verified-token');
  assert.equal(captured.options.headers.apikey, config.publishableKey);
  assert.equal(captured.url, config.supabaseUrl + '/rest/v1/rpc/bedlink_read_availability');
  for (const fetchImpl of [async () => { throw new Error('secret network'); }, async () => Response.json({ bad: true })]) {
    await assert.rejects(createSupabaseRpc(config, fetchImpl)('x', {}, identity, new AbortController().signal), { status: 503 });
  }
  await assert.rejects(createSupabaseAuth(config, async () => Response.json({ secret: true }, { status: 503 }))('Bearer valid', new AbortController().signal), { status: 503 });
});

test('environment refuses privileged keys, unsafe origins and invalid limits', () => {
  const env = { SUPABASE_URL: config.supabaseUrl, SUPABASE_PUBLISHABLE_KEY: config.publishableKey };
  assert.equal(readConfig(env).port, 3000);
  for (const extra of [{ SUPABASE_PUBLISHABLE_KEY: 'sb_secret_bad' }, { CORS_ORIGINS: '*' },
    { SUPABASE_URL: 'http://remote.example' }, { JSON_LIMIT_BYTES: '-1' }, { PORT: '3.2' }]) {
    assert.throws(() => readConfig({ ...env, ...extra }));
  }
  const legacyKey = role => `header.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.signature`;
  assert.throws(() => readConfig({ ...env, SUPABASE_PUBLISHABLE_KEY: legacyKey('service_role') }));
  assert.equal(readConfig({ ...env, SUPABASE_PUBLISHABLE_KEY: legacyKey('anon') }).publishableKey, legacyKey('anon'));
});
