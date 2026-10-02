import express from 'express';
import { resourceId, mutation } from '../validation.mjs';
import { jsonBody, sendResult as send } from '../http.mjs';

export function availabilityRouter({ service, jsonLimit }) {
  const router = express.Router();
  router.get('/hospitals', async (req, res) => send(res, await service.list(null, req.identity, req.bedlinkSignal)));
  router.get('/hospitals/:hospitalId/bed-pools', async (req, res) =>
    send(res, await service.list(resourceId(req.params.hospitalId), req.identity, req.bedlinkSignal)));
  router.patch('/hospitals/:hospitalId/bed-pools/:bedPoolId', ...jsonBody(jsonLimit), async (req, res) => {
    send(res, await service.save(resourceId(req.params.hospitalId), resourceId(req.params.bedPoolId),
      mutation(req.body, req.get('Idempotency-Key')), req.identity, req.bedlinkSignal));
  });
  return router;
}
