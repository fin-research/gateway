import assert from 'node:assert/strict';
import test from 'node:test';
import { gatewayRequest } from '../src/app.ts';
import { identityService } from '../src/identity-service.ts';
import { fixture } from './helpers/fixture.mjs';
import { mcpClientIds, mcpIdentityClaim } from '../src/mcp-auth.ts';
import { CONTEXT_HEADER } from '../src/forward.ts';

async function context(f) {
  await gatewayRequest(f.request('/api/mcp',{token:await f.signed(),method:'POST',body:'{}'}),f.env);
  const request=f.calls.dashboard.pop();
  return request.headers.get(CONTEXT_HEADER);
}
function bridge(path,ctx,method='POST',body,headers={}) { return new Request('https://identity.internal'+path,{method,headers:{[CONTEXT_HEADER]:ctx,'Content-Type':'application/json',...headers},body}); }

test('Dashboard MCP accepts only site/CIMD user JWTs, validates identity before CSRF and strips credentials',async t=>{
  const f=await fixture(t);
  const request=(token,headers={})=>new Request(f.env.SITE_ORIGIN+'/api/mcp',{method:'POST',headers:{...(token?{Authorization:'Bearer '+token}:{}),...headers},body:'{}'});
  assert.equal((await gatewayRequest(request(),f.env)).status,401);
  const token=await f.signed({azp:mcpClientIds[0],[mcpIdentityClaim]:f.flatClaims,email:undefined});
  assert.equal((await gatewayRequest(request(token),f.env)).status,200);
  assert.equal(f.calls.dashboard[0].headers.has('Authorization'),false);
  assert.equal((await gatewayRequest(request(token,{Origin:'https://evil.test'}),f.env)).status,403);
  const machine=await f.signed({azp:'quant',sub:'quant@clients',gty:'client-credentials',scope:'data.choice:read'});
  assert.equal((await gatewayRequest(request(machine),f.env)).status,403);
  assert.equal((await gatewayRequest(new Request(f.env.SITE_ORIGIN+'/api/mcp',{method:'POST',headers:{Authorization:'Bearer '+await f.signed(),Origin:'https://evil.test'},body:'{}'}),f.env)).status,403);
  for(const path of ['/api/credit','/api/profile','/financing/projects']) assert.equal((await gatewayRequest(f.request(path,{token}),f.env)).status,403,path);
});
test('CIMD identities require exact clients and their signed namespace, with no legacy fallback',async t=>{
  const f=await fixture(t);
  const request=token=>new Request(f.env.SITE_ORIGIN+'/api/mcp',{method:'POST',headers:{Authorization:'Bearer '+token},body:'{}'});
  for(const azp of mcpClientIds){
    const token=await f.signed({azp,[mcpIdentityClaim]:f.flatClaims,email:undefined});
    assert.equal((await gatewayRequest(request(token),f.env)).status,200);
    for(const path of ['/api/profile','/data/mcp','/data/choice/css'])assert.equal((await gatewayRequest(f.request(path,{token}),f.env)).status,403,path);
    assert.equal((await gatewayRequest(request(await f.signed({azp})),f.env)).status,401);
    for(const identity of [{...f.flatClaims,email:'test@example.com'},{...f.flatClaims,email:undefined},{...f.flatClaims,_roles:['unknown']}]){
      assert.ok([401,403].includes((await gatewayRequest(request(await f.signed({azp,[mcpIdentityClaim]:identity})),f.env)).status));
    }
    assert.equal((await gatewayRequest(request(await f.signed({azp,[mcpIdentityClaim]:f.flatClaims,org_id:'org_Other'})),f.env)).status,401);
  }
  for(const azp of ['M1a5PF3UJaFIZv1k4HO4IV06Z5fXQBHV','https://chatgpt.com/oauth/unknown/client.json','https://chatgpt.com.evil.test/oauth/client.json'])
    assert.equal((await gatewayRequest(request(await f.signed({azp,[mcpIdentityClaim]:f.flatClaims})),f.env)).status,403);
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
  for(const target of ['https://evil.test/api/credit','//evil.test/api/credit','/api/mcp','/api/mcp/__data.json','/api/profile','/auth/permissions','/api/notifications/settings','/api/admin/notifications','/api%2fcredit','/financing/logout','/api/unknown']) {
    const response=await identityService(bridge('/mcp/dispatch?target='+encodeURIComponent(target),ctx,'GET'),f.env);assert.equal(response.status,403,target);
  }
  const expired=JSON.parse(Buffer.from(ctx,'base64url'));expired.user.expiresAt=1;
  assert.equal((await identityService(bridge('/mcp/policies',Buffer.from(JSON.stringify(expired)).toString('base64url'),'POST','[]'),f.env)).status,401);
  assert.equal((await gatewayRequest(f.request('/mcp/dispatch?target=/api/credit',{token:await f.signed()}),f.env)).status,403);
  assert.equal(f.calls.dashboard.length,0);
});

test('canonical commentary routes share the policy boundary and reject retired write paths',async t=>{
  const f=await fixture(t);const token=await f.signed();
  await f.updateGrants(['research.article:read']);
  assert.equal((await gatewayRequest(f.request('/api/commentaries/c',{token}),f.env)).status,403);
  await f.updateGrants(['research.policy:read']);
  for(const path of ['/api/commentaries','/api/commentaries/c','/api/commentaries/c/revisions','/api/commentaries/c/pdf'])assert.equal((await gatewayRequest(f.request(path,{token}),f.env)).status,200,path);
  for(const [path,method] of [['/api/tracking-commentaries','GET'],['/api/tracking-commentaries/c','PUT'],['/api/policies/p/commentary','PUT'],['/api/policies/p/commentary','POST']])assert.equal((await gatewayRequest(f.request(path,{token,method,body:method==='GET'?undefined:'{}'}),f.env)).status,403,path);
});
