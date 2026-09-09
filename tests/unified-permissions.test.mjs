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

test('central authorization validates Auth0 accounts, opens beta to roleless users, and unions live role permissions in enforcement', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), alg: 'RS256', kid: 'unified-permissions-test', use: 'sig' };
  const env = { AUTH0_LOGIN_DOMAIN:'unified-permissions.auth0.com', AUTH0_AUDIENCE:'site', AUTH0_CLIENT_ID:'login', AUTHORIZATION_MODE:'beta-open', AUTH0_DOMAIN:'permissions.eu.auth0.com', AUTH0_MANAGEMENT_CLIENT_ID:'app', AUTH0_MANAGEMENT_CLIENT_SECRET:'fixture', AUTHORIZATION_DB:{connectionString:'postgres://fixture'} };
  const token = await new SignJWT({ azp:'login', 'https://eastmoney.hasbai.xyz/email':'person@18.cn' }).setProtectedHeader({alg:'RS256',kid:jwk.kid}).setSubject('auth0|person').setIssuer('https://' + env.AUTH0_LOGIN_DOMAIN + '/').setAudience('site').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  let blocked = false; let email = 'person@18.cn'; let roles = []; let granted = ['financing.project:read'];
  const originalFetch = globalThis.fetch;
  const original = { connect:Client.prototype.connect, query:Client.prototype.query, end:Client.prototype.end };
  const fetcher = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname.endsWith('/jwks.json')) return Response.json({keys:[jwk]});
    if (url.pathname === '/oauth/token') return Response.json({access_token:'fixture',expires_in:3600});
    if (url.pathname.endsWith('/roles')) return Response.json(roles);
    return Response.json({user_id:'auth0|person',email,name:'测试人员',email_verified:true,blocked,identities:[{connection:'eastmoney-email'}]});
  };
  globalThis.fetch=fetcher;
  Client.prototype.connect=async function(){}; Client.prototype.end=async function(){};
  Client.prototype.query=async function(sql, values) { assert.deepEqual(values, [['rol_A','rol_B']]); return {rows:granted.map(permission_code=>({permission_code}))}; };
  try {
    const req = request('/financing/projects','GET',{Authorization:'Bearer ' + token});
    const beta = await authorizeRequest(req,env,'/financing/projects',fetcher);
    assert.equal(beta.user.auth0Id,'auth0|person'); assert.equal(beta.user.id,'auth0|person');
    assert.deepEqual(beta.permissions,PERMISSION_CODES); assert.deepEqual(beta.user.authorization.roles,[]);
    await assert.rejects(authorizeRequest(request('/financing/projects'),env,'/financing/projects',fetcher), {status:401});
    blocked=true; await assert.rejects(authorizeRequest(req,env,'/financing/projects',fetcher), {status:403}); blocked=false;
    email='changed@18.cn'; await assert.rejects(authorizeRequest(req,env,'/financing/projects',fetcher), {status:401}); email='person@18.cn';
    roles=[{id:'rol_A',name:'任意角色 A'},{id:'rol_B',name:'任意角色 B'}]; env.AUTHORIZATION_MODE='enforce';
    assert.deepEqual((await authorizeRequest(req,env,'/financing/projects',fetcher)).permissions,granted);
    granted=[]; await assert.rejects(authorizeRequest(req,env,'/financing/projects',fetcher), {status:403});
    await assert.rejects(authorizeRequest(request('/financing/projects?/createProject','POST',{Authorization:'Bearer '+token,Origin:'https://other.test'}),env,'/financing/projects',fetcher), {status:403});
    const noManagement = async () => { throw new Error('market reads must not query Auth0 Management API'); };
    const marketRequest = request('/api/market-resources/omo','GET',{Authorization:'Bearer '+token});
    const market = await authorizeRequest(marketRequest, env, '/api/market-resources/[resource]', noManagement);
    assert.equal(market.user, null);
    assert.equal(market.directory, undefined);
    assert.deepEqual(market.permissions, []);
    assert.equal((await authorizeRequest(request('/api/market-resources/omo'), env, '/api/market-resources/[resource]', noManagement)).user, null);
    await assert.rejects(authorizeRequest(request('/api/market-resources/omo','POST',{Authorization:'Bearer '+token}), env, '/api/market-resources/[resource]', noManagement), {status:403});
  } finally { globalThis.fetch=originalFetch; Object.assign(Client.prototype,original); }
});

test('Auth0 roles are paginated and no user/role tables or permission writes are needed for the directory', async () => {
  let calls=0;
  const directory=createDirectory({AUTH0_DOMAIN:'directory.eu.auth0.com',AUTH0_MANAGEMENT_CLIENT_ID:'directory',AUTH0_MANAGEMENT_CLIENT_SECRET:'fixture'}, async input=>{
    const url=new URL(input); if(url.pathname==='/oauth/token')return Response.json({access_token:'fixture'});
    calls++;assert.equal(url.pathname,'/api/v2/roles');return Response.json(url.searchParams.get('page')==='0'?Array.from({length:100},(_,i)=>({id:`rol_R${i}`,name:`Role ${i}`})):[]);
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
