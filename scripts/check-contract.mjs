import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import YAML from 'yaml';

const root = new URL('../docs/api/', import.meta.url);
const spec = YAML.parse(await readFile(new URL('openapi.yaml', root), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('examples/_manifest.json', root), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: 'bedlink', components: spec.components });
const resolve = value => value.$ref ? value.$ref.slice(2).split('/').reduce((v,k) => v[k], spec) : value;
function check(schema, body, file) {
  const rooted = JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"bedlink#/components/'));
  assert.ok(ajv.validate(rooted, body), `${file}: ${JSON.stringify(ajv.errors)}`);
}
let payloads = 0;
for (const exchange of manifest.exchanges) {
  const operation = spec.paths[exchange.pathTemplate.replace('/api/v1', '')][exchange.method.toLowerCase()];
  assert.equal(operation.operationId, exchange.operationId);
  for (const kind of ['request', 'response']) {
    const file = exchange[`${kind}File`];
    if (!file) continue;
    const schema = kind === 'request' ? resolve(operation.requestBody).content['application/json'].schema
      : resolve(operation.responses[exchange.status]).content['application/json'].schema;
    check(schema, JSON.parse(await readFile(new URL(`examples/${file}`, root), 'utf8')), file);
    payloads++;
  }
}
assert.equal(payloads, 82);
check(spec.components.schemas.HealthResponse, { status: 'ok', serverTime: new Date().toISOString() }, 'health');
console.log(`Validated ${payloads} existing payloads across ${manifest.exchanges.length} exchanges, plus health schema.`);
