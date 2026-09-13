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

test('signed roles use current cached grants, never token permissions or database; cache refresh revokes existing sessions', async t => {
  const { fixture } = await import('./helpers/fixture.mjs');
  const f = await fixture(t);
  t.mock.method(Client.prototype, 'connect', async () => { throw new Error('authorization must not query Postgres'); });
  const token = await f.signed({permissions:['financing.project:delete']});
  const req=f.request('/financing/projects',{token});
  await f.updateGrants(['financing.project:read']);
  assert.deepEqual((await authorizeRequest(req,f.env,'/financing/projects')).permissions,['financing.project:read']);
  await f.updateGrants([]);
  await assert.rejects(authorizeRequest(req,f.env,'/financing/projects'),{status:403});
  await f.updateGrants(['financing.project:read']);
  for(const roles of [[],[{id:'rol_Unknown',name:'unknown'}]]) {
    await assert.rejects(authorizeRequest(f.request('/financing/projects',{token:await f.signed({user:{...f.userClaims,roles}})}),f.env,'/financing/projects'),{status:403});
  }
  for(const roles of [undefined,['admin'],[{id:'invalid',name:'bad'}],[{id:'rol_A',name:'A'},{id:'rol_A',name:'A'}]]) {
    await assert.rejects(authorizeRequest(f.request('/financing/projects',{token:await f.signed({user:{...f.userClaims,roles}})}),f.env,'/financing/projects'),{status:401});
  }
  f.env.AUTHORIZATION_MODE='beta-open';
  await assert.rejects(authorizeRequest(req,f.env,'/financing/projects'),{status:503});
  assert.equal(f.calls.auth0.length,0);
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

test('runtime authorization and role view have no database authorization fallback', async () => {
 const authorization=await readFile(new URL('../src/lib/server/authorization.ts',import.meta.url),'utf8');
 const configuration=await readFile(new URL('../src/identity-service.ts',import.meta.url),'utf8');
 assert.doesNotMatch(authorization,/AUTHORIZATION_DB|withPostgres|env\.HYPERDRIVE/);
 assert.doesNotMatch(configuration,/AUTHORIZATION_DB|withPostgres|saveRoleConfiguration|env\.HYPERDRIVE/);
});
