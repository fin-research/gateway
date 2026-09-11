import assert from 'node:assert/strict';
import test from 'node:test';
import {createAuth0ManagementClient,Auth0Error} from '../src/lib/server/auth0-management.js';
import {accessFailure} from '../src/lib/server/access.ts';

function fixture(respond){
  const calls=[],waits=[];let n=0;
  const manager=createAuth0ManagementClient({domain:'rate-test.eu.auth0.com',clientId:crypto.randomUUID(),clientSecret:'test-secret',
    waitImpl:async ms=>{waits.push(ms)},fetchImpl:async(url,init)=>{
      calls.push({url,method:init.method});
      if(url.endsWith('/oauth/token'))return Response.json({access_token:'test-token',expires_in:86400});
      return respond(n++,url,init);
    }});
  return {manager,calls,waits};
}
test('temporary 429 retries within the same read and honors Retry-After without stale data',async()=>{
  const f=fixture(n=>n<2?new Response('limited',{status:429,headers:{'retry-after':'1'}}):Response.json({blocked:true}));
  assert.deepEqual(await f.manager.request('users/auth0%7Ctest'),{blocked:true});
  assert.equal(f.waits.length,2);assert.ok(f.waits.every(ms=>ms>=1000));
  assert.equal(f.calls.filter(c=>c.url.endsWith('/oauth/token')).length,1);
});
test('retry exhaustion is bounded, explicit, and never returns a login failure',async()=>{
  const f=fixture(()=>new Response('private details',{status:429}));
  let failure;try{await f.manager.request('roles')}catch(e){failure=e}
  assert.equal(failure.code,'AUTH0_RATE_LIMITED');assert.ok(f.waits.length<=4);assert.ok(f.waits.reduce((a,b)=>a+b,0)<=10000);
  const response=accessFailure(failure);assert.equal(response.status,503);const body=await response.json();assert.equal(body.code,'IDENTITY_RATE_LIMITED');assert.doesNotMatch(JSON.stringify(body),/private details|test-secret|test-token/);
});
test('long rate limit waits are not capped into premature retries',async()=>{
  const f=fixture(()=>new Response(null,{status:429,headers:{'retry-after':'60'}}));
  await assert.rejects(f.manager.request('roles'),{code:'AUTH0_RATE_LIMITED'});assert.equal(f.waits.length,0);
});
test('reset timestamps are honored and mutation requests are never replayed',async()=>{
  const f=fixture(n=>n===0?new Response(null,{status:429,headers:{'x-ratelimit-reset':String(Math.ceil(Date.now()/1000)+1)}}):Response.json([]));
  await f.manager.request('roles');assert.ok(f.waits[0]>=1000);
  const writes=fixture(()=>new Response(null,{status:429}));
  await assert.rejects(writes.manager.request('users/auth0%7Ctest','PATCH',{name:'new'}),{code:'AUTH0_RATE_LIMITED'});
  assert.equal(writes.waits.length,0);assert.equal(writes.calls.filter(c=>c.method==='PATCH').length,1);
});
test('non-rate-limit credential rejection never retries or becomes stale success',async()=>{
  const f=fixture(()=>new Response(null,{status:403}));await assert.rejects(f.manager.request('roles'),Auth0Error);assert.equal(f.waits.length,0);
});
