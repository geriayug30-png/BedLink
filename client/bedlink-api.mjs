export class BedLinkApiError extends Error {
  constructor(message, { status = null, code, details, requestId = null } = {}) {
    super(message);
    this.name = 'BedLinkApiError';
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
  const idempotencyPattern = /^[A-Za-z0-9._:-]{8,128}$/;

  function validateIdempotencyKey(idempotencyKey) {
    if (!idempotencyKey || !idempotencyPattern.test(idempotencyKey)) {
      throw new TypeError('Supply a stable idempotencyKey');
    }
  }

  async function request(path, { method = 'GET', body, key, signal } = {}) {
    signal?.throwIfAborted();

    let response;
    try {
      const token = await getAccessToken();
      signal?.throwIfAborted();

      if (!token) {
        throw new BedLinkApiError('Sign in before making a request.', { code: 'UNAUTHENTICATED', status: 401 });
      }

      response = await fetchImpl(`${root}${path}`, {
        method,
        signal,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        ...(body ? { body } : {}),
      });
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError' || error instanceof BedLinkApiError) {
        throw error;
      }

      throw new BedLinkApiError(
        key ? 'Request failed; the save outcome may be unknown.' : 'Request failed. Try again when connected.',
        { code: 'NETWORK_ERROR', status: null }
      );
    }

    const requestId = response.headers.get('X-Request-Id');
    let data;
    try {
      data = await response.json();
    } catch {
      signal?.throwIfAborted();
      throw new BedLinkApiError('Invalid API response.', { status: response.status, code: 'INVALID_RESPONSE', requestId });
    }

    if (!response.ok) {
      throw new BedLinkApiError(data.error?.message || 'Request failed.', {
        status: response.status,
        code: data.error?.code || 'INVALID_RESPONSE',
        details: data.error?.details,
        requestId,
      });
    }

    return {
      data,
      meta: {
        requestId,
        idempotencyReplayed: response.headers.get('Idempotency-Replayed') === 'true',
        idempotencyExpiresAt: response.headers.get('Idempotency-Expires-At'),
      },
    };
  }

  const path = id => `/hospitals/${encodeURIComponent(id)}/bed-pools`;

  const save = (operation, hospitalId, poolId, { reportedFreeBeds, version, idempotencyKey, signal }) => {
    validateIdempotencyKey(idempotencyKey);
    return request(`${path(hospitalId)}/${encodeURIComponent(poolId)}`, {
      method: 'PATCH',
      signal,
      key: idempotencyKey,
      body: JSON.stringify({ operation, reportedFreeBeds, version }),
    });
  };

  const command = (requestPath, body, { idempotencyKey, signal } = {}) => {
    validateIdempotencyKey(idempotencyKey);
    return request(requestPath, {
      method: 'POST',
      body: JSON.stringify(body),
      key: idempotencyKey,
      signal,
    });
  };

  const reqPath = id => `/patient-requests/${encodeURIComponent(id)}`;
  const attemptPath = (hospitalId, attemptId) => `/hospitals/${encodeURIComponent(hospitalId)}/attempts/${encodeURIComponent(attemptId)}`;

  return {
    createPatientRequest: (body, options) => command('/patient-requests', body, options),
    getPatientRequest: (requestId, { signal } = {}) => request(reqPath(requestId), { signal }),
    createAttempt: (requestId, body, options) => command(`${reqPath(requestId)}/attempts`, body, options),
    getHospitalInbox: (hospitalId, { signal } = {}) => request(`/hospitals/${encodeURIComponent(hospitalId)}/incoming-requests`, { signal }),
    acceptAttempt: (hospitalId, attemptId, options) => command(`${attemptPath(hospitalId, attemptId)}/accept`, {}, options),
    rejectAttempt: (hospitalId, attemptId, reasonCode, options) => command(`${attemptPath(hospitalId, attemptId)}/reject`, { reasonCode }, options),
    recordArrival: (requestId, holdId, options) => command(`${reqPath(requestId)}/arrivals`, { holdId }, options),
    cancelPatientRequest: (requestId, reasonCode, options) => command(`${reqPath(requestId)}/cancellations`, { reasonCode }, options),
    cancelActiveHold: (requestId, holdId, reasonCode, options) => command(`${reqPath(requestId)}/holds/${encodeURIComponent(holdId)}/cancellations`, { reasonCode }, options),
    findMatches: (needs, { signal } = {}) => request('/matches', { method: 'POST', body: JSON.stringify({ needs }), signal }),
    listHospitals: ({ signal } = {}) => request('/hospitals', { signal }),
    listBedPools: (hospitalId, { signal } = {}) => request(path(hospitalId), { signal }),
    updateCount: (hospitalId, poolId, intent) => save('update', hospitalId, poolId, intent),
    verifyCount: (hospitalId, poolId, intent) => save('verify', hospitalId, poolId, intent),
  };
}
