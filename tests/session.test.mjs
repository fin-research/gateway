import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeJwt } from 'jose';
import { fixture } from './helpers/fixture.mjs';
import { gatewayRequest } from '../src/app.ts';
import { accessToken, SESSION_COOKIE } from '../src/session.ts';
import { CLIENT_PAGE_ROUTES } from '../src/policy.ts';

test('generic Bearer is the only token transport, including case-insensitive scheme and caller stripping', async t => {
  const f = await fixture(t), token = await f.signed();
  for (const scheme of ['Bearer','bearer','BEARER']) {
    const request = f.request('/api/credit', { headers:{Authorization:scheme+' '+token} });
    assert.equal(await accessToken(request), token);
    assert.equal((await gatewayRequest(request,f.env)).status,200);
    assert.equal(f.calls.dashboard.at(-1).headers.has('Authorization'),false);
  }
});

test('cookies never authenticate even when signed, encrypted, tampered or duplicated', async t => {
  const f = await fixture(t), token = await f.signed();
  for (const Cookie of [`${SESSION_COOKIE}=${token}`,`${SESSION_COOKIE}=one; ${SESSION_COOKIE}=two`,'credit-session=opaque','CF_Authorization='+token]) {
    const request = f.request('/api/credit',{headers:{Cookie}});
    assert.equal(await accessToken(request),null);
    assert.equal((await gatewayRequest(request,f.env)).status,401);
  }
  assert.equal(f.calls.dashboard.length,0);
});

test('malformed Authorization never falls back to cookies', async t => {
  const f = await fixture(t), token = await f.signed();
  for (const Authorization of ['Basic '+token,'Bearer','Bearer '+token+', Bearer '+token,'Bearer a.b.','Bearer a b c']) {
    const response = await gatewayRequest(f.request('/api/credit',{headers:{Authorization,Cookie:SESSION_COOKIE+'='+token}}),f.env);
    assert.equal(response.status,401);
  }
});

test('Bearer signature, issuer, audience, nonce-independent API time and ID-token boundaries remain enforced', async t => {
  const f = await fixture(t), valid = await f.signed(), parts = valid.split('.');
  parts[1]=Buffer.from(JSON.stringify({...decodeJwt(valid),sub:'auth0|forged'})).toString('base64url');
  for (const token of [parts.join('.'),await f.signed({},'id'),await f.signed({exp:1}),await f.signed({aud:'other'}),await f.signed({iss:'https://other.test/'}),await f.signed({iat:9999999999}),await f.signed({nbf:9999999999})]) {
    assert.equal((await gatewayRequest(f.request('/api/credit',{token}),f.env)).status,401);
  }
  assert.equal(f.calls.dashboard.length,0);
});

test('anonymous client page HTML is only a shell; server data, files and mutations remain protected', async t => {
  const f=await fixture(t);
  for (const route of CLIENT_PAGE_ROUTES) {
    const path=route.replace('/[[view]]','').replace('[view]','research').replace('[id]','unit');
    const response=await gatewayRequest(f.request(path,{headers:{Accept:'text/html'}}),f.env);
    assert.equal(response.status,200,path);
    const context=JSON.parse(Buffer.from(f.calls.dashboard.at(-1).headers.get('X-Eastmoney-Gateway-Context'),'base64url').toString());
    assert.equal(context.user,null);
    const data=await gatewayRequest(f.request(path+'/__data.json',{headers:{Accept:'application/json'}}),f.env);
    assert.equal((await data.json()).type,'redirect',path);
  }
  for (const path of ['/fund-report/2026-10-04.html','/financing-model/research','/financing/data/token','/financing/projects/options','/api/profile']) {
    assert.notEqual((await gatewayRequest(f.request(path,{headers:{Accept:'text/html'}}),f.env)).status,200,path);
  }
  assert.equal((await gatewayRequest(f.request('/financing/projects',{method:'POST',headers:{Accept:'text/html'}}),f.env)).status,401);
});

test('retired cookies are expired on responses without issuing new credential cookies', async t => {
  const f=await fixture(t),Cookie=SESSION_COOKIE+'='+await f.signed()+'; credit-session=opaque';
  for (const path of ['/','/auth/login','/auth/callback','/auth/logout','/data/health','/api/credit']) {
    const response=await gatewayRequest(f.request(path,{headers:{Cookie}}),f.env);
    for (const value of response.headers.getSetCookie()) assert.match(value,/Max-Age=0/);
    assert.ok(response.headers.getSetCookie().some(value=>value.startsWith(SESSION_COOKIE+'=;')));
    assert.match(response.headers.get('Cache-Control'),/no-store/);
  }
});

test('all SvelteKit data suffixes require authentication even with an HTML Accept header', async t => {
  const f=await fixture(t);
  for (const path of ['/articles/unit.html__data.json','/news/unit.html__data.json','/commentaries/unit.html__data.json','/financing/projects/unit.html__data.json','/management/%5f%5fdata.json','/management/__data.json']) {
    const response=await gatewayRequest(f.request(path,{headers:{Accept:'text/html'}}),f.env);
    const result=await response.json();
    assert.equal(result.type,'redirect',path);
    assert.match(result.location,/^\/auth\/login\?returnTo=/,path);
    assert.equal(f.calls.dashboard.length,0,path);
  }
});

test('client OAuth pages are public and Gateway never runs the old code exchange or popup protocol', async t => {
  const f=await fixture(t);
  for (const path of ['/auth/login','/auth/callback?state=opaque&code=unit','/auth/logout']) {
    assert.equal((await gatewayRequest(f.request(path),f.env)).status,200);
    assert.equal(f.calls.auth0.length,0);
  }
  assert.equal((await gatewayRequest(f.request('/auth/login',{method:'POST'}),f.env)).status,403);
});

test('session endpoint is removed and permission endpoint returns only live grants and timestamp', async t => {
  const f=await fixture(t),token=await f.signed();
  assert.equal((await gatewayRequest(f.request('/auth/session',{token}),f.env)).status,404);
  const response=await gatewayRequest(f.request('/auth/permissions',{token}),f.env);
  assert.deepEqual(Object.keys(await response.json()).sort(),['permissions','updatedAt']);
  assert.equal(response.headers.has('Set-Cookie'),false);
});
