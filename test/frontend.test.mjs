import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';
import { config } from './support.mjs';

test('serves the responsive frontend and shared API client without requiring authentication', async t => {
  const server = createApp({ config, authenticate: async()=>{throw new Error('not called for static files')}, logger:()=>{} }).listen(0,'127.0.0.1');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  await new Promise(resolve=>server.once('listening',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const [page,styles,script,client]=await Promise.all([
    fetch(origin),fetch(`${origin}/styles.css`),fetch(`${origin}/app.js`),fetch(`${origin}/client/bedlink-api.mjs`),
  ]);
  assert.equal(page.status,200);assert.match(await page.text(),/BedLink — Emergency care coordination/);
  assert.equal(styles.status,200);assert.match(await styles.text(),/\.dash-grid/);
  assert.equal(script.status,200);assert.match(await script.text(),/renderNurse/);
  assert.equal(client.status,200);assert.match(await client.text(),/createPatientRequest/);
  assert.equal((await fetch(`${origin}/api/v1/health`)).status,200);
});
