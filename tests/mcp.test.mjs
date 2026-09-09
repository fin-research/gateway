import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { gatewayRequest } from '../src/app.ts';
import { fixture } from './helpers/fixture.mjs';
import { researchArguments } from '../src/mcp.ts';

async function upstream(request, source, calls) {
  assert.equal(request.redirect, 'manual');
  assert.equal(request.headers.has('Authorization'), false);
  assert.equal(request.headers.has('Cookie'), false);
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  const body = await request.json(); calls.push({ source, body });
  if (!('id' in body)) return new Response(null, { status: 202 });
  const result = body.method === 'initialize' ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: source, version: '1' } }
    : body.method === 'tools/list' ? { tools: [{ name: source === 'data' ? 'health' : 'search', inputSchema: { type: 'object', properties: {}, additionalProperties: true } }] }
    : { content: [{ type: 'text', text: source }], structuredContent: { source } };
  return Response.json({ jsonrpc: '2.0', id: body.id, result });
}

test('missing authentication is 401 and registry errors are distinct from account denial', async t => {
  const f = await fixture(t);
  for (const path of ['/choice/css', '/unknown', '/data/choice/css', '/data/mcp', '/mcp']) {
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

test('research defaults use Shanghai days and preserve explicit historical filters', () => {
  const result = researchArguments({ query: '债券' }, Date.parse('2026-09-09T03:00:00Z'));
  assert.deepEqual(result.ai_search_options.retrieval.filters.published_at, { $gte: Date.parse('2026-09-03T00:00:00+08:00'), $lte: Date.parse('2026-09-09T23:59:59.999+08:00') });
  const explicit = researchArguments({ ai_search_options: { retrieval: { max_num_results: 1, filters: { type: { $eq: '研报' }, published_at: { $gte: 1, $lte: 1000 } } } } });
  assert.equal(explicit.ai_search_options.retrieval.max_num_results, 50);
  assert.deepEqual(explicit.ai_search_options.retrieval.filters, { type: { $eq: '研报' }, published_at: { $gte: 1, $lte: 1000 } });
});

test('MCP validates identity before CSRF, never admits Quant credentials and checks account revocation', async t => {
  const f = await fixture(t);
  for (const path of ['/data/mcp', '/mcp']) {
    assert.equal((await gatewayRequest(new Request(f.env.SITE_ORIGIN + path, { method: 'POST', body: '{}' }), f.env)).status, 401);
    const machine = await f.signed({ gty: 'client-credentials', azp: 'quant', sub: 'quant@clients', scope: 'data.choice:read' });
    assert.equal((await gatewayRequest(f.request(path, { method: 'POST', token: machine, body: '{}' }), f.env)).status, 403);
    f.updateProfile({ blocked: true });
    assert.equal((await gatewayRequest(f.request(path, { method: 'POST', token: await f.signed(), body: '{}' }), f.env)).status, 403);
  }
  assert.equal(f.calls.data.length, 0);
});

test('unified MCP discovers both sources and routes calls without forwarding credentials', async t => {
  const f = await fixture(t); const calls = [];
  f.env.AI_SEARCH_MCP_URL = 'https://research.hasbai.xyz/mcp';
  f.env.DATA = { fetch(request) {
    const context = JSON.parse(Buffer.from(request.headers.get('X-Eastmoney-Gateway-Context'), 'base64url'));
    assert.equal(context.choice.status, 204);
    assert.equal(new URL(request.url).pathname, '/data/mcp');
    return upstream(request, 'data', calls);
  } };
  const identityFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    if (request.url === f.env.AI_SEARCH_MCP_URL) {
      assert.equal(request.headers.get('Origin'), f.env.SITE_ORIGIN);
      return upstream(request, 'search', calls);
    }
    return identityFetch(input, init);
  };
  const token = await f.signed();
  const client = new Client({ name: 'test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(f.env.SITE_ORIGIN + '/mcp'), {
      fetch: (url, init) => {
        const request = new Request(url, init); request.headers.set('Authorization', 'Bearer ' + token);
        return gatewayRequest(request, f.env);
      },
    }));
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['data_health', 'search_search']);
    for (const [name, source] of [['data_health', 'data'], ['search_search', 'search']]) {
      assert.deepEqual((await client.callTool({ name, arguments: {} })).structuredContent, { source });
    }
    await assert.rejects(client.callTool({ name: 'unknown_search' }));
    await assert.rejects(client.callTool({ name: 'search_delete' }));
    assert.equal(calls.filter(call => call.body.method === 'tools/call').length, 2);
    f.updateProfile({ blocked: true });
    await assert.rejects(client.listTools());
  } finally { await client.close(); }
});
