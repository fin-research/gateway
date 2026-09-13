import assert from 'node:assert/strict';
import test from 'node:test';
import { gatewayRequest } from '../src/app.ts';
import { fixture } from './helpers/fixture.mjs';

test('missing authentication is 401 and registry errors are distinct from account denial', async t => {
  const f = await fixture(t);
  for (const path of ['/choice/css', '/unknown', '/data/choice/css', '/data/mcp']) {
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

test('retired aggregate endpoint never executes research requests', async t => {
  const f = await fixture(t);
  const response = await gatewayRequest(f.request('/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_search', arguments: { query: '债券' } } }) }), f.env);
  assert.equal(response.status, 410);
  assert.equal((await response.json()).mcpUrl, 'https://mcp.hasbai.xyz/mcp');
  assert.equal(f.calls.data.length, 0); assert.equal(f.calls.dashboard.length, 0); assert.equal(f.calls.auth0.length, 0);
});

test('MCP validates identity before CSRF, never admits Quant credentials and requires current-format signed claims', async t => {
  const f = await fixture(t);
  for (const path of ['/data/mcp']) {
    assert.equal((await gatewayRequest(new Request(f.env.SITE_ORIGIN + path, { method: 'POST', body: '{}' }), f.env)).status, 401);
    const machine = await f.signed({ gty: 'client-credentials', azp: 'quant', sub: 'quant@clients', scope: 'data.choice:read' });
    assert.equal((await gatewayRequest(f.request(path, { method: 'POST', token: machine, body: '{}' }), f.env)).status, 403);
    const legacy=await f.signed({user:{...f.userClaims,roles:undefined}});
    assert.equal((await gatewayRequest(f.request(path, { method: 'POST', token: legacy, body: '{}' }), f.env)).status, 401);
  }
  assert.equal(f.calls.data.length, 0);
});

test('only the managed portal is advertised and old MCP credentials are never forwarded', async t => {
  const f = await fixture(t);
  for (const method of ['GET', 'POST', 'DELETE']) {
    const response = await gatewayRequest(f.request('/mcp', { method, token: await f.signed(), headers: { Cookie: 'private=fixture' } }), f.env);
    assert.equal(response.status, 410);
    assert.equal(response.headers.has('Location'), false);
    assert.equal((await response.json()).mcpUrl, 'https://mcp.hasbai.xyz/mcp');
  }
  assert.equal(f.calls.data.length, 0); assert.equal(f.calls.dashboard.length, 0); assert.equal(f.calls.auth0.length, 0);
});

test('portal Auth0 tokens authorize Data MCP only and cannot become Dashboard or general API users', async t => {
  const f = await fixture(t); f.env.AUTH0_MCP_CLIENT_ID = 'portal';
  const token = await f.signed({ azp: 'portal' });
  const request = path => f.request(path, { token, method: 'POST', body: '{}' });
  assert.equal((await gatewayRequest(request('/data/mcp'), f.env)).status, 200);
  for (const path of ['/api/profile', '/data/choice/css', '/data/graphql', '/data/camel']) {
    assert.equal((await gatewayRequest(request(path), f.env)).status, path === '/data/graphql' ? 200 : 403);
  }
  f.updateProfile({ blocked: true });
  assert.equal((await gatewayRequest(request('/data/mcp'), f.env)).status, 200);
  assert.equal(f.calls.auth0.length,0);
});
