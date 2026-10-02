import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import YAML from 'yaml';
import assert from 'node:assert/strict';

export async function serve(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/api/v1`;
}
const spec = YAML.parse(await readFile(new URL('../docs/api/openapi.yaml', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: 'bedlink', components: spec.components });
export function matchesSchema(name, data) {
  const valid = ajv.validate({ $ref: `bedlink#/components/schemas/${name}` }, data);
  assert.ok(valid, JSON.stringify(ajv.errors));
}
export const config = { supabaseUrl: 'http://127.0.0.1:54321', publishableKey: 'sb_publishable_test',
  timeoutMs: 1000, jsonLimit: 1024, origins: ['http://localhost:5173'] };
export const H = '10000000-0000-4000-8000-000000000001';
export const P = '20000000-0000-4000-8000-000000000001';
