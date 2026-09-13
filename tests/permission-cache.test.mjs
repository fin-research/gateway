import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionCacheStore, CACHE_TTL_SECONDS } from '../src/lib/server/permission-cache.ts';
import { fixture } from './helpers/fixture.mjs';
import { gatewayRequest } from '../src/app.ts';

function memory() { const values=new Map(); return {values,cache:{match:async key=>values.get(key)?.clone(),put:async(key,value)=>values.set(key,value.clone())}}; }
test('Cache API stores JSON, reuses it for an hour, refreshes on expiry and never installs a partial result',async()=>{
  const state=memory();let now=1000,calls=0,fail=false,grants=['financing.project:read'];
  const reader=async()=>{calls++;if(fail)throw Error('upstream');return {version:1,updatedAt:now,roles:[],configurations:{rol_A:{permissions:grants}}}};
  const store=new PermissionCacheStore(state.cache,'https://site.test/internal',reader,()=>now);
  assert.deepEqual((await store.permissions(['rol_A'])).permissions,grants);assert.equal(calls,1);
  const saved=state.values.get('https://site.test/internal');assert.equal(saved.headers.get('Cache-Control'),'public, max-age=3600');
  assert.deepEqual((await saved.clone().json()).configurations.rol_A.permissions,grants);
  const restarted=new PermissionCacheStore(state.cache,'https://site.test/internal',reader,()=>now);
  assert.deepEqual((await restarted.permissions(['rol_A'])).permissions,grants);assert.equal(calls,1);
  grants=[];now+=1000;await store.refresh();assert.deepEqual((await store.permissions(['rol_A'])).permissions,[]);
  grants=['financing.project:delete'];fail=true;await assert.rejects(store.refresh(),{status:503});
  assert.deepEqual((await store.permissions(['rol_A'])).permissions,[]);
  now+=CACHE_TTL_SECONDS*1000;await assert.rejects(store.permissions(['rol_A']),{status:503});
  fail=false;assert.deepEqual((await store.permissions(['rol_A'])).permissions,grants);
  assert.deepEqual((await store.permissions(['rol_Unknown'])).permissions,[]);
});

test('users read their cached permissions; only authorized same-origin users can refresh shared cache',async t=>{
  const f=await fixture(t);const token=await f.signed();
  assert.equal((await gatewayRequest(f.request('/auth/permissions'),f.env)).status,401);
  const own=await gatewayRequest(f.request('/auth/permissions',{token}),f.env);
  assert.equal(own.status,200);assert.ok((await own.json()).permissions.includes('auth.permission:update'));
  assert.match(own.headers.get('Cache-Control'),/no-store/);
  const before=f.calls.auth0.length;
  await gatewayRequest(f.request('/auth/permissions',{token}),f.env);
  assert.equal(f.calls.auth0.length,before,'ordinary reads use cached JSON');
  assert.equal((await gatewayRequest(f.request('/auth/permissions/refresh',{token,method:'POST'}),f.env)).status,200);
  assert.equal((await gatewayRequest(f.request('/auth/permissions/refresh',{token,method:'POST',headers:{Origin:'https://evil.test'}}),f.env)).status,403);
  await f.updateGrants([]);
  assert.equal((await gatewayRequest(f.request('/auth/permissions',{token}),f.env)).status,200);
  assert.equal((await gatewayRequest(f.request('/auth/permissions/refresh',{token,method:'POST'}),f.env)).status,403);
  assert.equal((await gatewayRequest(f.request('/auth/permissions/refresh',{token}),f.env)).status,403);
  assert.equal((await gatewayRequest(f.request('/auth/permissions',{token:await f.signed({sub:'quant@clients',azp:'quant',gty:'client-credentials',org_id:undefined,scope:'data.choice:read'})}),f.env)).status,403);
  assert.ok(f.calls.auth0.length>before,'manual refresh consults Auth0');
  assert.equal((await gatewayRequest(f.request('/__gateway-permissions/v1/org_Eastmoney',{token}),f.env)).status,403);
});
