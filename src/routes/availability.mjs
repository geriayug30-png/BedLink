import express from 'express';
import { ApiError } from '../errors.mjs';
import { noQuery, resourceId, mutation } from '../validation.mjs';

export function availabilityRouter({ authenticate, service, jsonLimit }) {
  const router = express.Router();
  router.use(async (req, res, next) => {
    req.identity = await authenticate(req.get('Authorization'), req.bedlinkSignal);
    noQuery(req);
    next();
  });
  const send = (res, result) => {
    for (const name of ['Idempotency-Replayed', 'Idempotency-Expires-At', 'Retry-After']) {
      const value = result.headers?.[name];
      if (typeof value === 'string' && !/[\r\n]/.test(value)) res.set(name, value);
    }
    if (result.status === 401) res.set('WWW-Authenticate', 'Bearer');
    if (result.status === 503) res.set('Retry-After', '1');
    res.status(result.status).json(result.body);
  };
  router.get('/hospitals', async (req, res) => send(res, await service.list(null, req.identity, req.bedlinkSignal)));
  router.get('/hospitals/:hospitalId/bed-pools', async (req, res) =>
    send(res, await service.list(resourceId(req.params.hospitalId), req.identity, req.bedlinkSignal)));
  router.patch('/hospitals/:hospitalId/bed-pools/:bedPoolId', (req, res, next) => {
    if (!req.is('application/json')) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json.');
    next();
  }, express.json({ limit: jsonLimit, strict: true, inflate: false }), async (req, res) => {
    send(res, await service.save(resourceId(req.params.hospitalId), resourceId(req.params.bedPoolId),
      mutation(req.body, req.get('Idempotency-Key')), req.identity, req.bedlinkSignal));
  });
  return router;
}
