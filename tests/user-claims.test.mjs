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
  for (const headers of [{ Cookie: SESSION_COOKIE + '=' + token }, { Authorization: 'Bearer ' + token }]) {
    for (const path of ['/api/credit', '/data/choice/css']) {
      assert.equal((await gatewayRequest(f.request(path, { headers }), f.env)).status, 200);
    }
    const session = await gatewayRequest(f.request('/auth/session', { headers }), f.env);
    assert.equal(session.status, 200);
    const data = await session.json();
    assert.deepEqual(data.account, { name: '测试账号', department: '测试' });
    assert.deepEqual(data.roles, [{ id: 'rol_Authenticated', name: 'authenticated' }]);
    assert.equal(data.user.email, 'test@18.cn');
    assert.equal(data.role, undefined);
    assert.equal(data._roles, undefined);
  }
  const minimal = await f.signed({ user: undefined, ...f.flatClaims, username: undefined, department: undefined, picture: undefined });
  const session = await (await gatewayRequest(f.request('/auth/session', { token: minimal }), f.env)).json();
  assert.deepEqual(session.account, { name: 'test@18.cn', department: '' });
  assert.equal(f.calls.auth0.length, 0);
});

test('flat role array is authoritative; database role and reserved roles never grant business privileges', async t => {
  const f = await fixture(t);
  const adminLegacy = { ...f.userClaims, roles: [{ id: 'rol_TestAdmin', name: 'admin' }] };
  for (const role of ['admin', 'superadmin', 'authenticated']) {
    const token = await f.signed({ user: adminLegacy, ...legacyClaims(adminLegacy), ...f.flatClaims, role, roles: ['admin'], permissions: ['credit.institution:update'] });
    assert.equal((await gatewayRequest(f.request('/management/people', { token }), f.env)).status, 403);
    assert.equal((await gatewayRequest(f.request('/api/credit', { token, method: 'POST' }), f.env)).status, 403);
    const session = await (await gatewayRequest(f.request('/auth/session', { token }), f.env)).json();
    assert.deepEqual(session.roles, [{ id: 'rol_Authenticated', name: 'authenticated' }]);
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
  assert.equal((await gatewayRequest(f.request('/api/credit', { token: missingEmail }), f.env)).status, 403);
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

test('new user fields and existing namespaced JWTs authorize the same Cookie and Bearer requests', async t => {
  const f = await fixture(t);
  for (const claims of [{}, { user: undefined, ...legacyClaims(f.userClaims) }]) {
    const token = await f.signed(claims);
    for (const headers of [{ Cookie: SESSION_COOKIE + '=' + token }, { Authorization: 'Bearer ' + token }]) {
      for (const path of ['/api/credit', '/data/choice/css']) {
        assert.equal((await gatewayRequest(f.request(path, { headers }), f.env)).status, 200);
      }
      const session = await gatewayRequest(f.request('/auth/session', { headers }), f.env);
      assert.equal(session.status, 200);
      assert.equal((await session.json()).user.email, 'test@18.cn');
    }
  }
  assert.equal(f.calls.auth0.length, 0, 'claim migration must not introduce Management API lookups');
});

test('present user claim never falls back to old roles, profile or email', async t => {
  const f = await fixture(t);
  const legacy = legacyClaims(f.userClaims);
  for (const [user, status] of [[null, 401], [[], 401], ['invalid', 401],
    [{ ...f.userClaims, roles: undefined }, 401], [{ ...f.userClaims, profile: undefined }, 401],
    [{ ...f.userClaims, email: undefined }, 403], [{ ...f.userClaims, roles: [] }, 403]]) {
    const token = await f.signed({ ...legacy, user });
    assert.equal((await gatewayRequest(f.request('/api/credit', { token }), f.env)).status, status);
  }
  assert.equal(f.calls.dashboard.length, 0);
  const token = await f.signed({ ...legacy, 'https://eastmoney.hasbai.xyz/email': 'wrong@example.com' });
  assert.equal((await gatewayRequest(f.request('/api/credit', { token }), f.env)).status, 200);
});

test('login callback accepts flat and legacy Action claims and rejects mismatched email', async t => {
  const f = await fixture(t);
  for (const claims of [{ user: undefined, ...legacyClaims(f.userClaims) }, { user: undefined, ...f.flatClaims }, { ...f.flatClaims, email: 'different@18.cn' }]) {
    const start = await gatewayRequest(f.request('/auth/login'), f.env);
    const auth = new URL(start.headers.get('Location'));
    const transaction = start.headers.getSetCookie().find(value => value.startsWith('__Host-eastmoney_login=')).split(';')[0];
    f.intercept(async url => url.pathname === '/oauth/token' ? Response.json({
      token_type: 'Bearer', access_token: await f.signed(claims),
      id_token: await f.signed({ email: 'test@18.cn', nonce: auth.searchParams.get('nonce') }, 'id'),
    }) : undefined);
    const result = await gatewayRequest(f.request('/auth/callback?code=unit&state=' + auth.searchParams.get('state'), { headers: { Cookie: transaction } }), f.env);
    const matched = claims.email !== 'different@18.cn';
    assert.equal(result.status, matched ? 303 : 401);
    assert.equal(result.headers.getSetCookie().some(value => value.startsWith(SESSION_COOKIE + '=')), matched);
  }
});
