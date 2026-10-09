import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './helpers/fixture.mjs';
import { gatewayRequest } from '../src/app.ts';
import { CONTEXT_HEADER } from '../src/forward.ts';

async function creditFixture(t) {
  const f = await fixture(t);
  await f.updateRoles([{ id: 'rol_TestAdmin', name: 'admin' }]);
  return { ...f, token: await f.signed({ _roles: ['admin'] }) };
}

test('authorized credit PATCH/POST preserve JSON and trusted identity without directory reads', async t => {
  const f = await creditFixture(t);
  for (const method of ['PATCH', 'POST']) {
    const input = { operation: '维护', reportDate: '2026-10-09', institutionName: '测试机构', changes: { institution: { notes: '测试' } } };
    const response = await gatewayRequest(f.request('/api/credit', { token: f.token, method,
      headers: { 'Content-Type': 'application/json', 'X-User-Id': 'forged' }, body: JSON.stringify(input) }), f.env);
    assert.equal(response.status, 200);
    const forwarded = f.calls.dashboard.at(-1);
    assert.equal(forwarded.method, method);
    assert.deepEqual(await forwarded.json(), input);
    const context = JSON.parse(Buffer.from(forwarded.headers.get(CONTEXT_HEADER), 'base64url'));
    assert.equal(context.user.auth0Id, 'auth0|test');
    assert.ok(context.user.authorization.permissions.includes('credit.institution:update'));
    for (const header of ['Authorization', 'Cookie', 'X-User-Id']) assert.equal(forwarded.headers.has(header), false);
  }
  assert.equal(f.calls.auth0.length, 0);
});

test('credit backend CPU and binding failures return BACKEND_UNAVAILABLE without replay or secrets', async t => {
  const f = await creditFixture(t);
  const logs = t.mock.method(console, 'error', () => {});
  let calls = 0;
  for (const [method, message, reason] of [['GET', 'Worker exceeded CPU time limit.', 'cpu_limit'],
    ['PATCH', 'private-token body secret Cookie connection-string', 'binding_failure'],
    ['POST', 'Worker exceeded CPU time limit.', 'cpu_limit']]) {
    f.env.DASHBOARD = { async fetch() { calls++; throw new Error(message); } };
    const response = await gatewayRequest(f.request('/api/credit?private=secret', { token: f.token, method,
      ...(method === 'GET' ? {} : { body: '{"private":"secret"}', headers: { 'Content-Type': 'application/json' } }) }), f.env);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, 'BACKEND_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(body), /private-token|connection-string|secret|CPU/);
    const log = JSON.parse(logs.mock.calls.at(-1).arguments[0]);
    assert.equal(log.event, 'gateway_backend_failed');
    assert.equal(log.reason, reason);
    assert.equal(log.route, '/api/credit');
    assert.doesNotMatch(JSON.stringify(log), /private-token|connection-string|secret/);
  }
  assert.equal(calls, 3, 'each mutation is dispatched only once');
});

test('credit backend responses retain validation, permission, conflict and database errors', async t => {
  const f = await creditFixture(t);
  for (const status of [400, 403, 409, 503]) {
    f.env.DASHBOARD = { async fetch() { return Response.json({ error: '业务错误' }, { status }); } };
    const response = await gatewayRequest(f.request('/api/credit', { token: f.token, method: 'PATCH', body: '{}' }), f.env);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: '业务错误' });
  }
});

test('credit anonymous and non-maintainer writes are rejected before backend dispatch', async t => {
  const f = await fixture(t);
  const token = await f.signed();
  for (const method of ['PATCH', 'POST']) {
    assert.equal((await gatewayRequest(f.request('/api/credit', { method, body: '{}' }), f.env)).status, 401);
    assert.equal((await gatewayRequest(f.request('/api/credit', { method, token, body: '{}' }), f.env)).status, 403);
  }
  assert.equal(f.calls.dashboard.length, 0);
});

test('Gateway retains actual identity failures and distinguishes unknown gateway failures', async t => {
  const f = await creditFixture(t);
  t.mock.method(console, 'error', () => {});
  for (const [status, code] of [[503, 'IDENTITY_UNAVAILABLE'], [429, 'IDENTITY_RATE_LIMITED']]) {
    f.intercept(async url => url.pathname.startsWith('/api/v2/')
      ? new Response(null, { status, headers: { 'Retry-After': '60' } }) : undefined);
    const response = await gatewayRequest(f.request('/api/management/people', { token: f.token }), f.env);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, code);
  }
  globalThis.caches = { open: async () => { throw new Error('private cache details'); } };
  const response = await gatewayRequest(f.request('/api/credit', { token: f.token }), f.env);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'GATEWAY_UNAVAILABLE');
  assert.equal(f.calls.dashboard.length, 0);
});
