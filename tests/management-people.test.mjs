import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './helpers/fixture.mjs';
import { gatewayRequest } from '../src/app.ts';

test('Gateway serves the admin personnel directory and update without Dashboard forwarding', async t => {
  const f = await fixture(t);
  const person = { user_id: 'auth0|test', email: 'test@18.cn', name: '旧姓名', email_verified: true,
    user_metadata: { department: '旧部门' }, identities: [{ connection: 'eastmoney-email' }] };
  const writes = [];
  f.intercept((url, init) => {
    if (url.pathname === '/api/v2/organizations/org_Eastmoney/members') return Response.json([{ user_id: person.user_id }]);
    if (url.pathname === '/api/v2/users') return Response.json([person]);
    if (url.pathname === '/api/v2/users/auth0%7Ctest') {
      if (init.method === 'PATCH') {
        writes.push(JSON.parse(init.body));
        return Response.json({ user_id: person.user_id });
      }
      return Response.json(person);
    }
    return null;
  });
  const admin = await f.signed({ user: { ...f.userClaims, roles: [{ id: 'rol_TestAdmin', name: 'admin' }] } });
  const get = await gatewayRequest(f.request('/api/management/people', { token: admin }), f.env);
  assert.equal(get.status, 200);
  assert.deepEqual((await get.json()).map(({ id, name, department }) => ({ id, name, department })),
    [{ id: 'auth0|test', name: '旧姓名', department: '旧部门' }]);
  const post = body => f.request('/api/management/people', { token: admin, method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const response = await gatewayRequest(post({ id: 'auth0|test', name: '新姓名', department: '新部门' }), f.env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: 'auth0|test', name: '新姓名', department: '新部门', email: 'test@18.cn' });
  assert.deepEqual(writes, [{ name: '新姓名', user_metadata: { department: '新部门' } }]);
  assert.deepEqual(f.calls.dashboard, []);

  assert.equal((await gatewayRequest(f.request('/api/management/people'), f.env)).status, 401);
  assert.equal((await gatewayRequest(f.request('/api/management/people', { token: await f.signed() }), f.env)).status, 403);
  assert.equal((await gatewayRequest(post({ id: 'auth0|test', name: '无效', department: '', app_metadata: {} }), f.env)).status, 400);
  assert.equal((await gatewayRequest(f.request('/api/management/people', { token: admin, method: 'POST',
    headers: { Origin: 'https://other.test', 'Content-Type': 'application/json' }, body: '{}' }), f.env)).status, 403);
  assert.equal(writes.length, 1);
});
