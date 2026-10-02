import express from 'express';
import { jsonBody, sendResult } from '../http.mjs';
import { workflowInput } from '../validation.mjs';

export function workflowRouter({ service, jsonLimit }) {
  const router = express.Router();
  const routes = [
    ['post','/patient-requests','create'], ['get','/patient-requests/:requestId','status'],
    ['post','/patient-requests/:requestId/attempts','send'],
    ['get','/hospitals/:hospitalId/incoming-requests','inbox'],
    ['post','/hospitals/:hospitalId/attempts/:attemptId/accept','accept'],
    ['post','/hospitals/:hospitalId/attempts/:attemptId/reject','reject'],
    ['post','/patient-requests/:requestId/arrivals','arrival'],
    ['post','/patient-requests/:requestId/cancellations','cancelRequest'],
    ['post','/patient-requests/:requestId/holds/:holdId/cancellations','cancelHold'],
  ];
  for (const [method, path, action] of routes) router[method](path,
    ...(method === 'post' ? jsonBody(jsonLimit) : []), async (req, res) => {
      const key = method === 'post' ? req.get('Idempotency-Key') : null;
      const params = workflowInput(action, req.params, req.body, key);
      sendResult(res, await service(action, params, key, req.identity, req.bedlinkSignal));
    });
  return router;
}
