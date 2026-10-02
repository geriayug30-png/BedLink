import test from 'node:test';
import assert from 'node:assert/strict';
import { createBedLinkApi, BedLinkApiError } from '../client/bedlink-api.mjs';

test('client captures mutation payload and preserves key/version on explicit retry', async () => {
  const calls = [];
  let token = 'first';
  const api = createBedLinkApi({ baseUrl: 'https://api.example/api/v1/', getAccessToken: async () => token,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ serverTime: '2026-10-02T00:00:00Z' }, { headers: { 'Idempotency-Replayed': 'true', 'X-Request-Id': 'id' } });
    } });
  const intent = { reportedFreeBeds: 3, version: 4, idempotencyKey: 'stable-key' };
  const saved = await api.updateCount('hospital', 'pool', intent);
  token = 'second';
  await api.updateCount('hospital', 'pool', intent);
  await api.verifyCount('hospital', 'pool', intent);
  await api.listHospitals();
  await api.listBedPools('hospital');
  assert.equal(calls.length, 5);
  assert.equal(calls[0].options.body, calls[1].options.body);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer second');
  assert.equal(calls[1].options.headers['Idempotency-Key'], 'stable-key');
  assert.deepEqual(JSON.parse(calls[2].options.body), { operation: 'verify', reportedFreeBeds: 3, version: 4 });
  assert.equal(saved.meta.idempotencyReplayed, true);
  assert.throws(() => api.updateCount('h', 'p', { version: 1, reportedFreeBeds: 0 }), TypeError);
});

test('client structured conflicts, uncertain network saves, no auto retries and cancellation', async () => {
  let calls = 0;
  const api = createBedLinkApi({ baseUrl: 'https://api.example/api/v1', getAccessToken: async () => 'token',
    fetchImpl: async () => { calls++; return Response.json({ error: { code: 'VERSION_CONFLICT', message: 'Refetch.' } }, { status: 409 }); } });
  await assert.rejects(api.updateCount('h', 'p', { version: 1, reportedFreeBeds: 0, idempotencyKey: 'stable-key' }),
    e => e instanceof BedLinkApiError && e.status === 409 && e.code === 'VERSION_CONFLICT');
  assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api.listHospitals({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
  const offline = createBedLinkApi({ baseUrl: 'https://api.example/api/v1', getAccessToken: async () => 'token',
    fetchImpl: async () => { throw new Error('offline'); } });
  await assert.rejects(offline.listHospitals(), { code: 'NETWORK_ERROR', status: null });
});
