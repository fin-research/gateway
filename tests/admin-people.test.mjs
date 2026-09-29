import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/fixture.mjs';
import { identityService } from '../src/identity-service.ts';
import { CONTEXT_HEADER } from '../src/forward.ts';

test('private personnel update requires a registered admin role and an organization member', async t => {
  const f = await fixture(t);
  const writes = [];
  const member = { user_id: 'auth0|test', email: 'test@18.cn', name: '旧姓名',
    user_metadata: { department: '旧部门', color: 'blue' }, identities: [{ connection: 'eastmoney-email' }] };
  f.intercept(async (url, init) => {
    if (url.pathname === '/api/v2/organizations/org_Eastmoney/members') return Response.json([{ user_id: member.user_id }]);
    if (url.pathname === '/api/v2/users/auth0%7Ctest') {
      if (init.method === 'PATCH') {
        writes.push(JSON.parse(init.body));
        return Response.json({ ...member, name: '新姓名', user_metadata: { ...member.user_metadata, department: '新部门' } });
      }
      return Response.json(member);
    }
    return null;
  });
  const request = (roles, body, headers = {}) => new Request('https://identity.internal/directory/people/profile', {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      [CONTEXT_HEADER]: Buffer.from(JSON.stringify({ version: 1, user: { id: 'auth0|test', auth0Id: 'auth0|test', email: 'test@18.cn',
        authorization: { roles, permissions: [] } } })).toString('base64url'), ...headers },
    body: JSON.stringify(body),
  });
  const admin = [{ id: 'rol_TestAdmin', name: 'admin' }];
  const change = { id: 'auth0|test', name: '新姓名', department: '新部门' };
  assert.equal((await identityService(request([{ id: 'rol_Authenticated', name: 'authenticated' }], change), f.env)).status, 403);
  assert.equal((await identityService(request([{ id: 'rol_Forged', name: 'admin' }], change), f.env)).status, 403);
  assert.equal((await identityService(request(admin, change, { 'Content-Type': 'text/plain' }), f.env)).status, 415);
  assert.equal((await identityService(request(admin, { ...change, app_metadata: { role: 'admin' } }), f.env)).status, 400);
  assert.equal((await identityService(request(admin, { ...change, id: 'auth0|foreign' }), f.env)).status, 403);
  assert.deepEqual(writes, []);
  const response = await identityService(request(admin, change), f.env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store, private');
  assert.deepEqual(await response.json(), { id: 'auth0|test', name: '新姓名', department: '新部门', email: 'test@18.cn' });
  assert.deepEqual(writes, [{ name: '新姓名', user_metadata: { department: '新部门' } }]);
});
