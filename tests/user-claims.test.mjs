import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './helpers/fixture.mjs';
import { gatewayRequest } from '../src/app.ts';
import { SESSION_COOKIE } from '../src/session.ts';
import { authorizeRequest } from '../src/lib/server/authorization.ts';

const legacyClaims = user => ({
  'https://eastmoney.hasbai.xyz/roles': user.roles,
  'https://eastmoney.hasbai.xyz/profile': user.profile,
  'https://eastmoney.hasbai.xyz/email': user.email,
});

test('flat claims normalize Cookie/Bearer identity and resolve role names using cached organization roles', async t => {
  const f = await fixture(t);
  const token = await f.signed({ user: undefined, ...f.flatClaims });
  for (const headers of [{ Authorization: 'Bearer ' + token }]) {
    for (const path of ['/api/credit', '/data/choice/css']) {
      assert.equal((await gatewayRequest(f.request(path, { headers }), f.env)).status, 200);
    }
    const permissions = await gatewayRequest(f.request('/auth/permissions', { headers }), f.env);
    assert.equal(permissions.status, 200);
    assert.deepEqual(Object.keys(await permissions.json()).sort(), ['permissions','updatedAt']);
    const data = await authorizeRequest(f.request('/api/credit', { headers }), f.env, '/api/credit');
    assert.equal(data.user.email, 'test@18.cn');
    assert.equal(data.user.authorization.name, '测试账号');
    assert.deepEqual(data.user.authorization.roles.map(({ id,name }) => ({ id,name })), [{ id:'rol_Authenticated',name:'authenticated' }]);
  }
  const minimal = await f.signed({ username: undefined, department: undefined, picture: undefined });
  const data = await authorizeRequest(f.request('/api/credit', { token:minimal }), f.env, '/api/credit');
  assert.equal(data.user.authorization.name, 'test@18.cn');
  assert.equal(data.user.authorization.department, '');
  assert.equal(f.calls.auth0.length, 0);
});

test('flat role array is authoritative; database role and reserved roles never grant business privileges', async t => {
  const f = await fixture(t);
  const adminLegacy = { ...f.userClaims, roles: [{ id: 'rol_TestAdmin', name: 'admin' }] };
  for (const role of ['admin', 'superadmin', 'authenticated']) {
    const token = await f.signed({ user: adminLegacy, ...legacyClaims(adminLegacy), ...f.flatClaims, role, roles: ['admin'], permissions: ['credit.institution:update'] });
    assert.equal((await gatewayRequest(f.request('/management/people', { token }), f.env)).status, 403);
    assert.equal((await gatewayRequest(f.request('/api/credit', { token, method: 'POST' }), f.env)).status, 403);
    const data = await authorizeRequest(f.request('/api/credit', { token }), f.env, '/api/credit');
    assert.deepEqual(data.user.authorization.roles.map(({ id,name }) => ({ id,name })), [{ id:'rol_Authenticated',name:'authenticated' }]);
  }
  const admin = await f.signed({ ...f.flatClaims, _roles: ['admin'], role: 'authenticated' });
  const result = await authorizeRequest(f.request('/management/people', { token: admin }), f.env, '/management/people');
  assert.equal(result.user.authorization.roles[0].id, 'rol_TestAdmin');
  assert.ok(result.permissions.includes('credit.institution:update'));
  const empty = await f.signed({ ...f.flatClaims, _roles: [], role: 'admin' });
  assert.equal((await gatewayRequest(f.request('/api/credit', { token: empty }), f.env)).status, 403);
  assert.equal((await gatewayRequest(f.request('/data/choice/css', { token: empty }), f.env)).status, 200);
});

test('malformed, unknown, duplicate and ambiguous role names fail closed without legacy fallback', async t => {
  const f = await fixture(t);
  for (const _roles of [undefined, null, 'admin', {}, [null], [{ id: 'rol_TestAdmin', name: 'admin' }],
    ['authenticated', 'authenticated'], ['unknown'], [''], ['a'.repeat(201)], Array.from({ length: 51 }, (_, i) => 'role' + i)]) {
    const token = await f.signed({ ...legacyClaims(f.userClaims), ...f.flatClaims, _roles });
    for (const path of ['/api/credit', '/data/choice/css']) {
      const response = await gatewayRequest(f.request(path, { token }), f.env);
      assert.equal(response.status, 401);
      assert.equal((await response.json()).code, 'TOKEN_REFRESH_REQUIRED');
    }
  }
  for (const fields of [{ username: null }, { department: 1 }, { picture: [] }]) {
    const token = await f.signed({ ...f.flatClaims, ...fields });
    assert.equal((await gatewayRequest(f.request('/api/credit', { token }), f.env)).status, 401);
  }
  const missingEmail = await f.signed({ ...f.flatClaims, email: undefined });
  assert.equal((await gatewayRequest(f.request('/api/credit', { token: missingEmail }), f.env)).status, 401);
  await f.updateRoles([{ id: 'rol_A', name: 'admin' }, { id: 'rol_B', name: 'admin' }]);
  const ambiguous = await f.signed({ ...f.flatClaims, _roles: ['admin'] });
  assert.equal((await gatewayRequest(f.request('/api/credit', { token: ambiguous }), f.env)).status, 401);
  assert.equal(f.calls.dashboard.length, 0);
  assert.equal(f.calls.data.length, 0);
});

test('flat roles use one snapshot for name resolution and grants, and revoked grants take effect', async t => {
  const f = await fixture(t);
  const originalCaches = globalThis.caches;
  let reads = 0;
  globalThis.caches = { open: async name => {
    const cache = await originalCaches.open(name);
    return { put: cache.put, match: async key => { reads++; return cache.match(key); } };
  } };
  t.after(() => { globalThis.caches = originalCaches; });
  const token = await f.signed({ ...f.flatClaims });
  const own = await gatewayRequest(f.request('/auth/permissions', { token }), f.env);
  assert.equal(own.status, 200);
  assert.equal(reads, 1);
  await f.updateGrants([]);
  assert.equal((await gatewayRequest(f.request('/api/credit', { token }), f.env)).status, 403);
  await f.updateRoles([]);
  assert.equal((await gatewayRequest(f.request('/data/choice/css', { token }), f.env)).status, 401);
});

test('flat credit role names require the current organization role and disappear on catalogue removal', async t => {
  const f = await fixture(t);
  await f.updateRoles([{ id: 'rol_Authenticated', name: 'authenticated' }, { id: 'rol_Credit', name: 'credit' }]);
  const token = await f.signed({ ...f.flatClaims, _roles: ['authenticated', 'credit'] });
  const request = f.request('/api/credit', { token, method: 'POST' });
  const result = await authorizeRequest(request, f.env, '/api/credit');
  assert.ok(result.permissions.includes('credit.institution:update'));
  assert.deepEqual(result.user.authorization.roles.map(role => role.id), ['rol_Authenticated', 'rol_Credit']);
  await f.updateRoles([{ id: 'rol_Authenticated', name: 'authenticated' }]);
  await assert.rejects(authorizeRequest(request, f.env, '/api/credit'), { status: 401, code: 'TOKEN_REFRESH_REQUIRED' });
});

test('flat claims preserve MCP client isolation and fail closed when permission cache is unavailable', async t => {
  const f = await fixture(t);
  f.env.AUTH0_MCP_CLIENT_ID = 'mcp';
  const token = await f.signed({ ...f.flatClaims, azp: 'mcp' });
  assert.equal((await gatewayRequest(f.request('/data/mcp', { token }), f.env)).status, 200);
  assert.equal((await gatewayRequest(f.request('/data/choice/css', { token }), f.env)).status, 403);
  await authorizeRequest(f.request('/api/mcp', { token }), f.env, '/api/mcp');
  globalThis.caches = { open: async () => ({ match: async () => undefined, put: async () => {} }) };
  f.intercept(async url => url.pathname === '/api/v2/roles' ? new Response(null, { status: 503 }) : undefined);
  const siteToken = await f.signed({ ...f.flatClaims });
  for (const path of ['/api/credit', '/data/choice/css']) {
    const response = await gatewayRequest(f.request(path, { token: siteToken }), f.env);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'PERMISSION_CACHE_UNAVAILABLE');
  }
  assert.equal((await gatewayRequest(f.request('/', { token: siteToken }), f.env)).status, 200);
});

test('nested user and namespaced JWTs are rejected even when correctly signed', async t => {
  const f = await fixture(t);
  for (const claims of [{ user: f.userClaims }, legacyClaims(f.userClaims)]) {
    const token = await f.signed({ ...claims, username: undefined, email: undefined, role: undefined, _roles: undefined, department: undefined, picture: undefined });
    for (const headers of [{ Authorization: 'Bearer ' + token }]) {
      for (const path of ['/api/credit', '/data/choice/css']) {
        const response = await gatewayRequest(f.request(path, { headers }), f.env);
        assert.equal(response.status, 401);
        assert.equal((await response.json()).code, 'TOKEN_REFRESH_REQUIRED');
      }
    }
  }
  assert.equal(f.calls.auth0.length, 0);
  assert.equal(f.calls.dashboard.length, 0);
  assert.equal(f.calls.data.length, 0);
});

test('incomplete new claims never fall back to nested user or namespaced fields', async t => {
  const f = await fixture(t);
  for (const fields of [{ _roles: undefined }, { email: undefined }, { role: undefined }]) {
    const token = await f.signed({ ...legacyClaims(f.userClaims), user: f.userClaims, ...fields });
    assert.equal((await gatewayRequest(f.request('/api/credit', { token }), f.env)).status, 401);
  }
});

test('Auth0 callbacks are forwarded to the client without exchanging codes or issuing session cookies', async t => {
  const f = await fixture(t);
  const response = await gatewayRequest(f.request('/auth/callback?code=unit&state=unit'), f.env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.has('Set-Cookie'), false);
  assert.equal(f.calls.auth0.length, 0);
  assert.equal(f.calls.dashboard.length, 1);
});
