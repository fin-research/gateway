import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/fixture.mjs';
import { gatewayRequest } from '../src/app.ts';
import { dashboardRoute } from '../src/policy.ts';

test('Quant report inherits the model read policy and uses only the named report binding', async t => {
  const f = await fixture(t), calls = [];
  f.env.QUANT_REPORT = { fetch: async request => {
    calls.push(request);
    return new Response('<!doctype html><title>Research</title>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  } };
  assert.equal(dashboardRoute(f.request('/financing-model/research')), '/financing-model');
  assert.equal((await gatewayRequest(f.request('/financing-model/research'), f.env)).status, 401);
  assert.equal((await gatewayRequest(f.request('/financing-model/research', { headers: { 'X-User-Id': 'test', 'X-Eastmoney-Gateway-Context': 'forged' } }), f.env)).status, 401);
  assert.equal(calls.length, 0);
  const token = await f.signed();
  for (const method of ['GET', 'HEAD']) {
    const response = await gatewayRequest(f.request('/financing-model/research', { token, method, headers: { Cookie: 'untrusted=secret', 'X-User-Id': 'attacker' } }), f.env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store, private');
    assert.match(response.headers.get('Content-Type'), /^text\/html/);
    if (method === 'HEAD') assert.equal(await response.text(), '');
    const forwarded = calls.at(-1);
    assert.equal(new URL(forwarded.url).pathname, '/REPORT.html');
    for (const header of ['Authorization', 'Cookie', 'X-User-Id']) assert.equal(forwarded.headers.has(header), false);
  }
  assert.equal(f.calls.dashboard.length, 0);
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await gatewayRequest(f.request('/financing-model/research', { token, method }), f.env)).status, 403);
  await f.updateGrants([]);
  assert.equal((await gatewayRequest(f.request('/financing-model/research', { token }), f.env)).status, 403);
  assert.equal(calls.length, 2);
  for (const path of ['/financing-model/research/manifest.json', '/REPORT.html']) {
    assert.equal((await gatewayRequest(f.request(path, { token }), f.env)).status, 403);
  }
});
