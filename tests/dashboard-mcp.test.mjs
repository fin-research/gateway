import assert from 'node:assert/strict';
import test from 'node:test';
import { gatewayRequest } from '../src/app.ts';
import { identityService } from '../src/identity-service.ts';
import { fixture } from './helpers/fixture.mjs';
import { CONTEXT_HEADER } from '../src/forward.ts';

async function context(f) {
  await gatewayRequest(f.request('/api/mcp',{token:await f.signed(),method:'POST',body:'{}'}),f.env);
  const request=f.calls.dashboard.pop();
  return request.headers.get(CONTEXT_HEADER);
}
function bridge(path,ctx,method='POST',body,headers={}) { return new Request('https://identity.internal'+path,{method,headers:{[CONTEXT_HEADER]:ctx,'Content-Type':'application/json',...headers},body}); }

test('Dashboard MCP accepts only site/portal user JWTs, validates identity before CSRF and strips credentials',async t=>{
  const f=await fixture(t);f.env.AUTH0_MCP_CLIENT_ID='portal';
  const request=(token,headers={})=>new Request(f.env.SITE_ORIGIN+'/api/mcp',{method:'POST',headers:{...(token?{Authorization:'Bearer '+token}:{}),...headers},body:'{}'});
  assert.equal((await gatewayRequest(request(),f.env)).status,401);
  const token=await f.signed({azp:'portal'});
  assert.equal((await gatewayRequest(request(token),f.env)).status,200);
  assert.equal(f.calls.dashboard[0].headers.has('Authorization'),false);
  assert.equal((await gatewayRequest(request(token,{Origin:'https://evil.test'}),f.env)).status,403);
  const machine=await f.signed({azp:'quant',sub:'quant@clients',gty:'client-credentials',scope:'data.choice:read'});
  assert.equal((await gatewayRequest(request(machine),f.env)).status,403);
  assert.equal((await gatewayRequest(new Request(f.env.SITE_ORIGIN+'/api/mcp',{method:'POST',headers:{Cookie:'__Host-eastmoney_session='+await f.signed()},body:'{}'}),f.env)).status,403);
  for(const path of ['/api/credit','/api/profile','/financing/projects']) assert.equal((await gatewayRequest(f.request(path,{token}),f.env)).status,403,path);
});
test('private MCP policies and dispatch enforce fresh real-route permission and named action',async t=>{
  const f=await fixture(t);const ctx=await context(f);
  await f.updateGrants(['credit.institution:read']);
  const list=await identityService(bridge('/mcp/policies',ctx,'POST',JSON.stringify([{path:'/api/credit',method:'GET'},{path:'/api/credit',method:'PATCH'},{path:'/financing/projects?/createProject',method:'POST'}])),f.env);
  assert.deepEqual(await list.json(),{allowed:[true,false,false]});
  const call=(path,method='GET',body)=>identityService(bridge('/mcp/dispatch?target='+encodeURIComponent(path),ctx,method,body),f.env);
  assert.equal((await call('/api/credit')).status,200);
  assert.equal((await call('/api/credit','PATCH','{}')).status,403);
  await f.updateGrants(['financing.project:create']);
  assert.equal((await call('/financing/projects?/createProject','POST','name=test')).status,200);
  const forwarded=f.calls.dashboard.at(-1);assert.equal(forwarded.headers.get('Origin'),f.env.SITE_ORIGIN);
  const actual=JSON.parse(Buffer.from(forwarded.headers.get(CONTEXT_HEADER),'base64url'));assert.deepEqual(actual.user.authorization.permissions,['financing.project:create']);
  assert.equal((await call('/financing/projects?/deleteProject','POST','id=a')).status,403);
  assert.equal((await call('/financing/projects?/createProject&/deleteProject','POST','{}')).status,403);
});
test('private dispatch refuses recursion, external destinations, credentials APIs and expired contexts',async t=>{
  const f=await fixture(t);const ctx=await context(f);
  for(const target of ['https://evil.test/api/credit','//evil.test/api/credit','/api/mcp','/api/mcp/__data.json','/api/profile','/auth/permissions','/api/notifications/settings','/api%2fcredit','/financing/logout','/api/unknown']) {
    const response=await identityService(bridge('/mcp/dispatch?target='+encodeURIComponent(target),ctx,'GET'),f.env);assert.equal(response.status,403,target);
  }
  const expired=JSON.parse(Buffer.from(ctx,'base64url'));expired.user.expiresAt=1;
  assert.equal((await identityService(bridge('/mcp/policies',Buffer.from(JSON.stringify(expired)).toString('base64url'),'POST','[]'),f.env)).status,401);
  assert.equal((await gatewayRequest(f.request('/mcp/dispatch?target=/api/credit',{token:await f.signed()}),f.env)).status,403);
  assert.equal(f.calls.dashboard.length,0);
});
