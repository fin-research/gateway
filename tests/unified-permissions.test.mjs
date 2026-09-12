import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { Client } from 'pg';
import { PERMISSION_CODES, hasPermission } from '../src/lib/permissions.ts';
import { requestPolicy, ROUTE_PERMISSIONS } from '../src/lib/server/permission-policy.ts';
import { authorizeRequest, authorizationMode } from '../src/lib/server/authorization.ts';
import { createDirectory } from '../src/lib/server/auth0-directory.ts';

const request = (path, method = 'GET', headers = {}) => new Request('https://eastmoney.hasbai.xyz' + path, { method, headers: { Origin: 'https://eastmoney.hasbai.xyz', ...headers } });

test('read and write policies are distinct, and unknown routes/actions and ambiguous action names fail closed', () => {
  assert.equal(requestPolicy(request('/market-briefing'), '/market-briefing').public, true);
  assert.deepEqual(requestPolicy(request('/api/market-resources/omo'), '/api/market-resources/[resource]'), { public: true });
  assert.equal(requestPolicy(request('/financing/projects'), '/financing/projects').permission, 'financing.project:read');
  assert.equal(requestPolicy(request('/financing/projects?/createProject','POST'), '/financing/projects').permission, 'financing.project:create');
  assert.equal(requestPolicy(request('/api/credit-assistant/session','DELETE'), '/api/credit-assistant/session').permission, 'credit.assistant:delete');
  assert.equal(requestPolicy(request('/api/credit-assistant/session/events'), '/api/credit-assistant/session/events').permission, 'credit.assistant:read');
  assert.throws(() => requestPolicy(request('/api/credit-assistant/session/events','POST'), '/api/credit-assistant/session/events'), { status: 403 });
  assert.equal(requestPolicy(request('/data/graphql','POST'), '/data/[...path]').permission, 'data.graphql:read');
  assert.equal(requestPolicy(request('/data/choice/css','POST'), '/data/[...path]').login, true);
  assert.equal(requestPolicy(request('/financing/data/api/rpc/liability_weekly_report_data','POST'), '/financing/data/api/[...path]').permission, 'financing.report:read');
  assert.throws(() => requestPolicy(request('/unregistered'), null), { status: 403 });
  assert.throws(() => requestPolicy(request('/financing/projects?/deleteEverything','POST'), '/financing/projects'), { status: 403 });
  assert.throws(() => requestPolicy(request('/financing/projects?/createProject&/deleteProject','POST'), '/financing/projects'), { status: 403 });
  assert.equal(hasPermission(['financing.project:create'], 'financing.project:delete'), false);
  for (const mode of [undefined, '', 'legacy', 'open', 'typo']) assert.throws(() => authorizationMode(mode), { status: 503 });
});

test('JWT role membership is stable until renewal while permission grants are read on every request', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk={...await exportJWK(publicKey),alg:'RS256',kid:'jwt-roles'};
  const env={AUTH0_LOGIN_DOMAIN:'jwt-roles.auth0.com',AUTH0_AUDIENCE:'site',AUTH0_ORGANIZATION_ID:'org_Eastmoney',AUTH0_CLIENT_ID:'login',AUTHORIZATION_MODE:'enforce',AUTHORIZATION_DB:{connectionString:'postgres://fixture'}};
  const sign=roles=>new SignJWT({org_id:'org_Eastmoney',azp:'login','https://eastmoney.hasbai.xyz/email':'test@18.cn',
    'https://eastmoney.hasbai.xyz/roles':roles,'https://eastmoney.hasbai.xyz/profile':{name:'测试账号',department:'测试',picture:'',connection:'eastmoney-email',verified:true}})
    .setProtectedHeader({alg:'RS256',kid:jwk.kid}).setSubject('auth0|test').setIssuer('https://'+env.AUTH0_LOGIN_DOMAIN+'/').setAudience('site').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const roles=[{id:'rol_A',name:'角色 A',description:''},{id:'rol_B',name:'角色 B',description:''}];
  let granted=['financing.project:read'];let queries=[];
  const originalFetch=globalThis.fetch;const original={connect:Client.prototype.connect,query:Client.prototype.query,end:Client.prototype.end};
  globalThis.fetch=async input=>{assert.ok(String(input).endsWith('/jwks.json'),'only JWKS network access is permitted');return Response.json({keys:[jwk]})};
  Client.prototype.connect=async function(){};Client.prototype.end=async function(){};
  Client.prototype.query=async function(sql,values){queries.push(values);return {rows:granted.map(permission_code=>({permission_code}))}};
  const forbidden=async()=>{throw Error('Management API must not be called')};
  try {
    const token=await sign(roles);const req=request('/financing/projects','GET',{Authorization:'Bearer '+token});
    assert.deepEqual((await authorizeRequest(req,env,'/financing/projects',forbidden)).permissions,granted);
    assert.deepEqual(queries.at(-1),[['rol_A','rol_B']]);
    granted=[];await assert.rejects(authorizeRequest(req,env,'/financing/projects',forbidden),{status:403});
    granted=['financing.project:read'];assert.deepEqual((await authorizeRequest(req,env,'/financing/projects',forbidden)).user.authorization.roles,roles);
    const renewed=await sign([{id:'rol_C',name:'角色 C'}]);
    await authorizeRequest(request('/financing/projects','GET',{Authorization:'Bearer '+renewed}),env,'/financing/projects',forbidden);
    assert.deepEqual(queries.at(-1),[['rol_C']]);assert.equal(queries.length,4);
    env.AUTHORIZATION_MODE='beta-open';const before=queries.length;
    assert.deepEqual((await authorizeRequest(req,env,'/financing/projects',forbidden)).permissions,PERMISSION_CODES);assert.equal(queries.length,before);
    const noRoles=await sign([]);assert.deepEqual((await authorizeRequest(request('/financing/projects','GET',{Authorization:'Bearer '+noRoles}),env,'/financing/projects',forbidden)).user.authorization.roles,[]);
    for(const roleClaim of [undefined,['admin'],[{id:'invalid',name:'bad'}],[roles[0],roles[0]]]){
      const invalid=await sign(roleClaim);await assert.rejects(authorizeRequest(request('/financing/projects','GET',{Authorization:'Bearer '+invalid}),env,'/financing/projects',forbidden),{status:401});
    }
    assert.equal((await authorizeRequest(request('/market-briefing'),env,'/market-briefing',forbidden)).user,null);
  } finally {globalThis.fetch=originalFetch;Object.assign(Client.prototype,original)}
});

test('Auth0 roles are paginated and no user/role tables or permission writes are needed for the directory', async () => {
  let calls=0;
  const directory=createDirectory({AUTH0_ORGANIZATION_ID:'org_Eastmoney',AUTH0_DOMAIN:'directory.eu.auth0.com',AUTH0_MANAGEMENT_CLIENT_ID:'directory',AUTH0_MANAGEMENT_CLIENT_SECRET:'fixture'}, async input=>{
    const url=new URL(input); if(url.pathname==='/oauth/token')return Response.json({access_token:'fixture'});
    calls++;assert.equal(url.pathname,'/api/v2/roles');return Response.json(url.searchParams.get('page')==='0'?Array.from({length:100},(_,i)=>({id:`rol_R${i}`,name:`Role ${i}`,owner_id:'org_Eastmoney'})):[]);
  });
  assert.equal((await directory.roles()).length,100);assert.equal((await directory.roles()).length,100);assert.equal(calls,2);
});

 test('public static assets do not consult identity or database services', async () => {
   for(const path of ['/favicon.svg','/institution-logos/cicc.ico','/_app/immutable/chunks/app.js']) {
     const result=await authorizeRequest(request(path),{},null,async()=>{throw new Error('unexpected identity lookup')});
     assert.equal(result.user,null);assert.deepEqual(result.permissions,[]);
   }
 });

test('client navigation and legacy workbench aliases require the same resource permission as their destination', () => {
 for(const [path,route,permission] of [
   ['/credit-workbench/assistant/__data.json','/credit-workbench/[[view]]','credit.assistant:read'],
   ['/trading-research/secondary-bond-pool/__data.json','/trading-research/[view]','bond.ledger:read'],
   ['/trading-research/bond','/trading-research/[view]','bond.ledger:read'],
   ['/trading-research/credit-assistant','/trading-research/[view]','credit.assistant:read'],
 ]) assert.equal(requestPolicy(request(path),route).permission,permission);
});

test('permission reads and role configuration cannot fall back to the cached business binding', async () => {
 const authorization=await readFile(new URL('../src/lib/server/authorization.ts',import.meta.url),'utf8');
 const configuration=await readFile(new URL('../src/identity-service.ts',import.meta.url),'utf8');
 assert.match(authorization,/AUTHORIZATION_DB/);assert.doesNotMatch(authorization,/env\.HYPERDRIVE/);
 assert.match(configuration,/AUTHORIZATION_DB/);assert.doesNotMatch(configuration,/getDatabase|env\.HYPERDRIVE/);
});
