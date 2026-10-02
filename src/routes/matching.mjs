import express from 'express';
import { jsonBody, sendResult } from '../http.mjs';
import { matchSearch } from '../validation.mjs';

export function matchingRouter({ service, jsonLimit }) {
  const router = express.Router();
  router.post('/matches', ...jsonBody(jsonLimit), async (req, res) => {
    const needs = matchSearch(req.body);
    sendResult(res, await service(needs, req.identity, req.bedlinkSignal));
  });
  return router;
}
