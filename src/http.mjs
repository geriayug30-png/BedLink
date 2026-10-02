import express from 'express';
import { ApiError } from './errors.mjs';
import { noQuery } from './validation.mjs';

export function authenticatedRequest(authenticate) {
  return async (req, res, next) => {
    req.identity = await authenticate(req.get('Authorization'), req.bedlinkSignal);
    noQuery(req);
    next();
  };
}

export function jsonBody(limit) {
  return [(req, res, next) => {
    if (!req.is('application/json')) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json.');
    next();
  }, express.json({ limit, strict: true, inflate: false })];
}

export function sendResult(res, result) {
  for (const name of ['Idempotency-Replayed', 'Idempotency-Expires-At', 'Retry-After']) {
    const value = result.headers?.[name];
    if (typeof value === 'string' && !/[\r\n]/.test(value)) res.set(name, value);
  }
  if (result.status === 401) res.set('WWW-Authenticate', 'Bearer');
  if (result.status === 503) res.set('Retry-After', '1');
  res.status(result.status).json(result.body);
}
