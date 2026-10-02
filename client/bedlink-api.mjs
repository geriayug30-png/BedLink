export class BedLinkApiError extends Error {
  constructor(message, { status = null, code, details, requestId = null } = {}) {
    super(message);
    Object.assign(this, { status, code, details, requestId });
  }
}
export const createIdempotencyKey = () => globalThis.crypto.randomUUID();

export function createBedLinkApi({ baseUrl, getAccessToken, fetchImpl = globalThis.fetch }) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.search || base.hash || base.username || base.password) {
    throw new TypeError('baseUrl must be an API HTTP(S) URL');
  }
  const root = base.href.replace(/\/$/, '');
  async function request(path, { method = 'GET', body, key, signal } = {}) {
    signal?.throwIfAborted();
    let response;
    try {
      const token = await getAccessToken();
      signal?.throwIfAborted();
      if (!token) throw new BedLinkApiError('Sign in before making a request.', { code: 'UNAUTHENTICATED', status: 401 });
      response = await fetchImpl(`${root}${path}`, {
        method, signal, headers: { Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
        ...(body ? { body } : {}),
      });
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError' || error instanceof BedLinkApiError) throw error;
      throw new BedLinkApiError(key ? 'Request failed; the save outcome may be unknown.' : 'Request failed. Try again when connected.', { code: 'NETWORK_ERROR' });
    }
    const requestId = response.headers.get('X-Request-Id');
    let data;
    try { data = await response.json(); } catch {
      signal?.throwIfAborted();
      throw new BedLinkApiError('Invalid API response.', { status: response.status, code: 'INVALID_RESPONSE', requestId });
    }
    if (!response.ok) throw new BedLinkApiError(data.error?.message || 'Request failed.', {
      status: response.status, code: data.error?.code || 'INVALID_RESPONSE', details: data.error?.details, requestId,
    });
    return { data, meta: { requestId, idempotencyReplayed: response.headers.get('Idempotency-Replayed') === 'true',
      idempotencyExpiresAt: response.headers.get('Idempotency-Expires-At') } };
  }
  const path = id => `/hospitals/${encodeURIComponent(id)}/bed-pools`;
  const save = (operation, hospitalId, poolId, { reportedFreeBeds, version, idempotencyKey, signal }) => {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey || '')) throw new TypeError('Supply a stable idempotencyKey');
    return request(`${path(hospitalId)}/${encodeURIComponent(poolId)}`, { method: 'PATCH', signal, key: idempotencyKey,
      body: JSON.stringify({ operation, reportedFreeBeds, version }) });
  };
  return {
    findMatches: (needs, { signal } = {}) => request('/matches', { method: 'POST', body: JSON.stringify({ needs }), signal }),
    listHospitals: ({ signal } = {}) => request('/hospitals', { signal }),
    listBedPools: (hospitalId, { signal } = {}) => request(path(hospitalId), { signal }),
    updateCount: (hospitalId, poolId, intent) => save('update', hospitalId, poolId, intent),
    verifyCount: (hospitalId, poolId, intent) => save('verify', hospitalId, poolId, intent),
  };
}
