import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowInput } from '../src/validation.mjs';
import { verifiedClaims } from '../src/db/workflow.mjs';
import { workerConfig, runTimeoutWorker } from '../src/services/timeout-worker.mjs';
import { createBedLinkApi } from '../client/bedlink-api.mjs';
import { createApp } from '../src/app.mjs';
import { unauthenticated } from '../src/errors.mjs';
import { config, H, P, serve } from './support.mjs';

test('workflow boundary rejects unknown fields, malformed resources, references and commands', () => {
  const valid = { patientReference:'ANON_1', needs:{location:{latitude:20,longitude:70},resources:['oxygen','icu']} };
  assert.deepEqual(workflowInput('create',{},valid,'stable-key').body.needs.resources,['icu','oxygen']);
  for (const body of [null,[],{...valid,name:'private'},{...valid,patientReference:'full name'},
    {...valid,needs:{...valid.needs,location:{latitude:91,longitude:70}}},
    {...valid,needs:{...valid.needs,resources:['icu','icu']}}]) {
    assert.throws(()=>workflowInput('create',{},body,'stable-key'),{status:400});
  }
  assert.throws(()=>workflowInput('accept',{hospitalId:H,attemptId:P},{},null),{code:'IDEMPOTENCY_KEY_REQUIRED'});
  assert.throws(()=>workflowInput('accept',{hospitalId:H,attemptId:P},{force:true},'stable-key'),{status:400});
  assert.throws(()=>workflowInput('reject',{hospitalId:H,attemptId:P},{reasonCode:'free text'},'stable-key'),{status:400});
  assert.throws(()=>workflowInput('send',{requestId:P},{hospitalId:H,bedPoolId:3},'stable-key'),{status:400});
  assert.throws(()=>workflowInput('arrival',{requestId:P},{holdId:'missing'},'stable-key'),{status:404});
});

test('verified identity projection checks subject/expiry and never trusts a token role', () => {
  const identity = claims => ({userId:H,token:`test.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.test`});
  const claims={sub:H,iss:'http://test/auth/v1',exp:4102444800,role:'service_role'};
  assert.deepEqual(verifiedClaims(identity(claims)),{sub:H,iss:claims.iss,role:'authenticated'});
  for (const patch of [{sub:P},{exp:0},{iss:''},{exp:'4102444800'}])
    assert.throws(()=>verifiedClaims(identity({...claims,...patch})),{status:401});
  // Token verification itself belongs to Supabase Auth, not this projection helper.
});

test('all lifecycle client paths preserve explicit keys and never retry automatically',async()=>{
  const calls=[], options={idempotencyKey:'stable-key'};
  const api=createBedLinkApi({baseUrl:'https://api.example/api/v1',getAccessToken:async()=> 'token',
    fetchImpl:async(url,init)=>{calls.push({url,init});return Response.json({serverTime:'2026-10-02T00:00:00Z'});} });
  await api.createPatientRequest({patientReference:'ANON_1'},options);
  await api.getPatientRequest('request/id');
  await api.createAttempt('r',{hospitalId:'h',bedPoolId:'p'},options);
  await api.getHospitalInbox('h');
  await api.acceptAttempt('h','a',options);
  await api.rejectAttempt('h','a','cannotReceive',options);
  await api.recordArrival('r','hold',options);
  await api.cancelPatientRequest('r','other',options);
  await api.cancelActiveHold('r','hold','transportPlanChanged',options);
  assert.equal(calls.length,9);
  assert.deepEqual(calls.map(c=>c.url.replace('https://api.example/api/v1','')), [
    '/patient-requests','/patient-requests/request%2Fid','/patient-requests/r/attempts',
    '/hospitals/h/incoming-requests','/hospitals/h/attempts/a/accept','/hospitals/h/attempts/a/reject',
    '/patient-requests/r/arrivals','/patient-requests/r/cancellations','/patient-requests/r/holds/hold/cancellations']);
  for (const [index,call] of calls.entries()) {
    const read=[1,3].includes(index);
    assert.equal(call.init.method,read?'GET':'POST');
    assert.equal(call.init.headers['Idempotency-Key'],read?undefined:'stable-key');
  }
  assert.equal(calls[4].init.body,'{}');
  assert.deepEqual(JSON.parse(calls[6].init.body),{holdId:'hold'});
  assert.throws(()=>api.acceptAttempt('h','a'),TypeError);
});

test('HTTP workflow uses shared auth, strict parsing and body size limits before service calls',async t=>{
  let called=0;
  const url=await serve(t,createApp({config,logger:()=>{},authenticate:async token=>{
    if(token!=='Bearer valid')throw unauthenticated();return {userId:H,token};
  },workflow:async()=>{called++;return {status:200,body:{serverTime:new Date().toISOString()}};} }));
  const headers={Authorization:'Bearer valid','Content-Type':'application/json','Idempotency-Key':'stable-key'};
  const route=`${url}/hospitals/${H}/attempts/${P}/accept`;
  assert.equal((await fetch(route,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  assert.equal((await fetch(route,{method:'POST',headers,body:'{"unknown":true}'})).status,400);
  assert.equal((await fetch(route,{method:'POST',headers,body:'{'})).status,400);
  assert.equal((await fetch(route,{method:'POST',headers,body:JSON.stringify({x:'x'.repeat(2000)})})).status,413);
  assert.equal((await fetch(`${route}?force=true`,{method:'POST',headers,body:'{}'})).status,400);
  assert.equal(called,0);
  assert.equal((await fetch(route,{method:'POST',headers,body:'{}'})).status,200);
  assert.equal(called,1);
});

test('worker retries transient failure, emits safe logs, observes configured limits and aborts',async()=>{
  assert.deepEqual(workerConfig(),{pollMs:2000,batchSize:100});
  for (const env of [{WORKER_POLL_MS:'0'},{WORKER_BATCH_SIZE:'1001'},{WORKER_POLL_MS:'NaN'}]) assert.throws(()=>workerConfig(env));
  const controller=new AbortController(),logs=[];let calls=0,waits=0;
  const database={transaction:async(_,callback)=>callback(async(name,args)=>{
    assert.equal(name,'tick');assert.deepEqual(args,[2]);
    if(++calls===1)throw new Error('private SQL and credentials');return {processed:1};
  })};
  await runTimeoutWorker({database,signal:controller.signal,pollMs:50,batchSize:2,logger:e=>logs.push(e),
    wait:async ms=>{assert.equal(ms,50);if(++waits===2)controller.abort();}});
  assert.equal(calls,2);
  assert.deepEqual(logs,[{event:'timeout_batch_failed'},{event:'timeout_batch',processed:1}]);
});

