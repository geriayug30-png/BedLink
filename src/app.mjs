import express from 'express';
import { randomUUID } from 'node:crypto';
import { ApiError, errorBody } from './errors.mjs';
import { createAvailabilityService } from './services/availability.mjs';
import { availabilityRouter } from './routes/availability.mjs';
import { noQuery } from './validation.mjs';
import { authenticatedRequest } from './http.mjs';
import { matchingRouter } from './routes/matching.mjs';
import { createMatchingService } from './services/matching.mjs';

export function createApp({ config, authenticate, rpc, travelProvider, clock, logger = event => console.log(JSON.stringify(event)) }) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.use((req, res, next) => {
    const started = performance.now();
    req.requestId = randomUUID();
    const controller = new AbortController();
    req.bedlinkSignal = controller.signal;
    req.on('aborted', () => controller.abort());
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    res.set({ 'X-Request-Id': req.requestId, 'Cache-Control': 'no-store' });
    res.on('finish', () => {
      // Never log URLs, query strings, bodies, headers, tokens, or upstream errors.
      try { logger({ requestId: req.requestId, method: req.method,
        route: req.route?.path || 'unmatched', status: res.statusCode,
        durationMs: Math.round(performance.now() - started) }); } catch { /* logging must not fail requests */ }
    });
    next();
  });
  app.use((req, res, next) => {
    const origin = req.get('Origin');
    res.vary('Origin');
    if (origin && !config.origins.includes(origin)) throw new ApiError(403, 'FORBIDDEN', 'Origin is not allowed.');
    if (origin) res.set({ 'Access-Control-Allow-Origin': origin,
      'Access-Control-Expose-Headers': 'Date, X-Request-Id, Idempotency-Replayed, Idempotency-Expires-At, Retry-After' });
    if (req.method === 'OPTIONS') {
      res.set({ 'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key' });
      return res.sendStatus(204);
    }
    next();
  });
  app.get('/api/v1/health', (req, res) => {
    noQuery(req);
    res.json({ status: 'ok', serverTime: new Date().toISOString() });
  });
  app.use('/api/v1', authenticatedRequest(authenticate));
  app.use('/api/v1', availabilityRouter({
    service: createAvailabilityService(rpc), jsonLimit: config.jsonLimit }));
  app.use('/api/v1', matchingRouter({ jsonLimit: config.jsonLimit,
    service: createMatchingService({ rpc, travelProvider, clock, policy: config.matchingPolicy, travelTimeoutMs: config.travelTimeoutMs }) }));
  app.use((req, res, next) => next(new ApiError(404, 'NOT_FOUND', 'Route not found.')));
  app.use((error, req, res, next) => {
    if (req.bedlinkSignal?.aborted || res.headersSent) return res.destroy();
    let safe = error instanceof ApiError ? error : new ApiError(500, 'INTERNAL_ERROR', 'An internal error occurred.');
    if (error.type === 'entity.too.large') safe = new ApiError(413, 'INVALID_INPUT', 'Request body is too large.');
    if (error.type === 'entity.parse.failed' || error instanceof URIError) safe = new ApiError(400, 'INVALID_INPUT', 'Malformed request.');
    if (['encoding.unsupported', 'charset.unsupported'].includes(error.type)) safe = new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported encoding.');
    if (safe.status === 401) res.set('WWW-Authenticate', 'Bearer');
    if (safe.status === 503) res.set('Retry-After', '1');
    res.status(safe.status).json(errorBody(safe));
  });
  return app;
}
