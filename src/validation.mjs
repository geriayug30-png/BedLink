import { ApiError } from './errors.mjs';
const invalid = message => new ApiError(400, 'INVALID_INPUT', message);

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function matchSearch(body) {
  if (!object(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'needs')) throw invalid('Expected needs only.');
  const needs = body.needs;
  if (!object(needs) || Object.keys(needs).some(k => !['location', 'resources', 'specialty'].includes(k))) throw invalid('Invalid needs.');
  const location = needs.location;
  if (!object(location) || Object.keys(location).length !== 2 ||
    !Number.isFinite(location.latitude) || Math.abs(location.latitude) > 90 ||
    !Number.isFinite(location.longitude) || Math.abs(location.longitude) > 180) throw invalid('Invalid location coordinates.');
  if (!Array.isArray(needs.resources) || needs.resources.length < 1 || needs.resources.length > 3 ||
    needs.resources.some(r => !['icu', 'ventilator', 'oxygen'].includes(r)) ||
    new Set(needs.resources).size !== needs.resources.length) throw invalid('Invalid resource requirements.');
  const specialty = needs.specialty === undefined ? null : needs.specialty;
  if (![null, 'cardiac', 'burns'].includes(specialty)) throw invalid('Invalid specialty.');
  return { location: { latitude: location.latitude, longitude: location.longitude },
    resources: [...needs.resources].sort(), specialty };
}

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

export function workflowInput(action, params, body, key) {
  const normalized = Object.fromEntries(Object.entries(params).map(([k,v]) => [k, resourceId(v)]));
  if (['status','inbox'].includes(action)) return normalized;
  if (!key) throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required.');
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw invalid('Invalid Idempotency-Key.');
  const fields = { create:['patientReference','needs'],send:['hospitalId','bedPoolId'],accept:[],reject:['reasonCode'],
    arrival:['holdId'],cancelRequest:['reasonCode'],cancelHold:['reasonCode'] }[action];
  if (!object(body) || !fields || Object.keys(body).length !== fields.length || fields.some(f => !Object.hasOwn(body,f))) throw invalid('Invalid request body.');
  if (action === 'create') {
    if (typeof body.patientReference !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(body.patientReference)) throw invalid('Invalid anonymous reference.');
    normalized.body = { patientReference: body.patientReference, needs: matchSearch({needs:body.needs}) };
  } else if (action === 'send' || action === 'arrival') {
    normalized.body = {};
    for (const field of fields) {
      if (typeof body[field] !== 'string' || body[field].length < 1 || body[field].length > 128) throw invalid('Invalid resource ID.');
      normalized.body[field] = resourceId(body[field]);
    }
  } else {
    const reasons = { reject:['cannotReceive','capacityChanged','other'],cancelRequest:['noLongerNeeded','duplicate','other'],cancelHold:['transportPlanChanged','other'] }[action];
    if (reasons && !reasons.includes(body.reasonCode)) throw invalid('Invalid reason code.');
    normalized.body = { ...body };
  }
  return normalized;
}
