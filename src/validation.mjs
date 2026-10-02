import { ApiError } from './errors.mjs';
const invalid = message => new ApiError(400, 'INVALID_INPUT', message);

export function noQuery(req) {
  if (Object.keys(req.query).length) throw invalid('Query parameters are not supported.');
}
export function resourceId(value) {
  // IDs stay opaque to clients. Unknown storage IDs have the same 404 as absent rows.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '')) {
    throw new ApiError(404, 'NOT_FOUND', 'Resource not found.');
  }
  return value.toLowerCase();
}
export function mutation(body, key) {
  if (!key) throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required.');
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw invalid('Invalid Idempotency-Key.');
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
    Object.keys(body).length !== 3 || !['operation', 'reportedFreeBeds', 'version'].every(k => Object.hasOwn(body, k)) ||
    !['update', 'verify'].includes(body.operation) ||
    !Number.isSafeInteger(body.reportedFreeBeds) || body.reportedFreeBeds < 0 || body.reportedFreeBeds > 2147483647 ||
    !Number.isSafeInteger(body.version) || body.version < 1) throw invalid('Invalid availability update.');
  return { p_operation: body.operation, p_reported_free_beds: body.reportedFreeBeds,
    p_version: body.version, p_idempotency_key: key };
}
