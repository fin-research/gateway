import assert from 'node:assert/strict';
import test from 'node:test';
import { gatewayRequest } from '../src/app.ts';
import { fixture } from './helpers/fixture.mjs';

test('missing authentication is 401 and registry errors are distinct from account denial', async t => {
  const f = await fixture(t);
  for (const path of ['/choice/css', '/unknown', '/data/choice/css']) {
    const response = await gatewayRequest(new Request(f.env.SITE_ORIGIN + path), f.env);
    assert.equal(response.status, 401, path);
    assert.equal((await response.json()).code, 'LOGIN_REQUIRED');
    assert.match(response.headers.get('WWW-Authenticate'), /^Bearer/);
  }
  const response = await gatewayRequest(f.request('/choice/css', { token: await f.signed() }), f.env);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'ROUTE_NOT_REGISTERED');
  assert.equal(f.calls.data.length, 0); assert.equal(f.calls.dashboard.length, 0);
  const html = await gatewayRequest(f.request('/data/choice/css', { headers: { Accept: 'text/html' } }), f.env);
  assert.equal(html.status, 401);
});

test('MCP validates identity before CSRF, never admits Quant credentials and requires current-format signed claims', async t => {
  const f = await fixture(t);
  for (const path of ['/mcp']) {
    assert.equal((await gatewayRequest(new Request(f.env.SITE_ORIGIN + path, { method: 'POST', body: '{}' }), f.env)).status, 401);
    const machine = await f.signed({ gty: 'client-credentials', azp: 'quant', sub: 'quant@clients', scope: 'data.choice:read' });
    assert.equal((await gatewayRequest(f.request(path, { method: 'POST', token: machine, body: '{}' }), f.env)).status, 403);
    const legacy=await f.signed({_roles:undefined,user:f.userClaims});
    assert.equal((await gatewayRequest(f.request(path, { method: 'POST', token: legacy, body: '{}' }), f.env)).status, 401);
  }
  assert.equal(f.calls.data.length, 0);
});

test('retired MCP paths advertise the direct endpoint without forwarding credentials', async t => {
  const f = await fixture(t);
  for (const method of ['GET', 'POST', 'DELETE']) {
    const response = await gatewayRequest(f.request('/api/mcp', { method, token: await f.signed(), headers: { Cookie: 'private=fixture' } }), f.env);
    assert.equal(response.status, 410);
    assert.equal(response.headers.has('Location'), false);
    assert.equal((await response.json()).mcpUrl, f.env.SITE_ORIGIN + '/mcp');
  }
  assert.equal(f.calls.data.length, 0); assert.equal(f.calls.dashboard.length, 0); assert.equal(f.calls.auth0.length, 0);
});

test('Dashboard MCP discovers Auth0 OAuth from an unauthenticated challenge', async t => {
  const f = await fixture(t);
  for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    const response = await gatewayRequest(new Request(f.env.SITE_ORIGIN + path), f.env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    assert.deepEqual(await response.json(), {
      resource: f.env.SITE_ORIGIN + '/', resource_name: 'Eastmoney',
      authorization_servers: [`https://${f.env.AUTH0_LOGIN_DOMAIN}/`],
      scopes_supported: ['offline_access'], bearer_methods_supported: ['header'],
    });
  }
  for (const token of [undefined, 'invalid']) {
    const response = await gatewayRequest(f.request('/mcp', { method: 'POST', token, body: '{}' }), f.env);
    assert.equal(response.status, 401);
    assert.match(response.headers.get('WWW-Authenticate'), /resource_metadata="https:\/\/eastmoney\.hasbai\.xyz\/\.well-known\/oauth-protected-resource\/mcp"/);
  }
  assert.equal(f.calls.dashboard.length, 0);
  const other = await gatewayRequest(f.request('/api/profile'), f.env);
  assert.equal(other.headers.get('WWW-Authenticate'), 'Bearer realm="eastmoney"');
});

test('retired portal Auth0 tokens cannot authorize Data MCP or ordinary API users', async t => {
  const f = await fixture(t);
  const token = await f.signed({ azp: 'portal' });
  const request = path => f.request(path, { token, method: 'POST', body: '{}' });
  assert.equal((await gatewayRequest(request('/data/mcp'), f.env)).status, 410);
  for (const path of ['/api/profile', '/data/choice/css', '/data/graphql', '/data/camel']) {
    assert.equal((await gatewayRequest(request(path), f.env)).status, path === '/data/graphql' ? 200 : 403);
  }
  f.updateProfile({ blocked: true });
  assert.equal((await gatewayRequest(request('/data/mcp'), f.env)).status, 410);
  assert.equal(f.calls.auth0.length,0);
});
