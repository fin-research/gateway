import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalJWKSet } from 'jose';
import { fixture } from './helpers/fixture.mjs';
import { gatewayRequest } from '../src/app.ts';
import { verifyToken } from '../src/tokens.ts';
import { dashboardRoute } from '../src/policy.ts';
import { ROUTE_PERMISSIONS } from '../src/lib/route-permissions.ts';
import { PUBLIC_DATA_RESOURCES } from '../src/policy.ts';

// Migrated Data JWT/route regression coverage now exercises its new owning boundary.
test('Auth0 JWKS rejects wrong issuer/audience, ID tokens, expired/future/forged claims and Access cookies', async t => {
  const f = await fixture(t), keys = createLocalJWKSet({ keys: [f.jwk] });
  const valid = await f.signed();
  assert.equal((await verifyToken(valid, f.env, 'access', keys)).sub, 'auth0|test');
  for (const claims of [{ iss: 'https://test.cloudflareaccess.com' }, { aud: 'other' }, { exp: 1 }, { nbf: 9999999999 }, { iat: 9999999999 }, { azp: null }]) {
    await assert.rejects(verifyToken(await f.signed(claims), f.env, 'access', keys), { status: 401 });
  }
  await assert.rejects(verifyToken(await f.signed({}, 'id'), f.env, 'access', keys), { status: 401 });
  const parts = valid.split('.'); parts[2] = 'a'.repeat(parts[2].length);
  await assert.rejects(verifyToken(parts.join('.'), f.env, 'access', keys), { status: 401 });
  const response = await gatewayRequest(f.request('/api/credit', { headers: { Cookie: 'CF_Authorization=' + valid, 'Cf-Access-Jwt-Assertion': valid, 'Cf-Access-Authenticated-User-Email': 'test@18.cn' } }), f.env);
  assert.equal(response.status, 401); assert.equal(f.calls.dashboard.length, 0);
});

test('real URL matching covers every registered route and method/action without caller-supplied route IDs', async t => {
  const f = await fixture(t); const token = await f.signed();
  for (const [id, methods] of Object.entries(ROUTE_PERMISSIONS)) {
    const path = id.replace('/[[view]]', '').replace('[...path]', 'table').replace('[resource]', 'omo').replace('[date]', '2026-09-09').replace('[view]', 'research').replace('[id]', '0123456789abcdef01234567');
    assert.equal(dashboardRoute(f.request(path)), id, path);
    for (const [operation, scope] of Object.entries(methods)) {
      const [method, action] = operation.split(':');
      const url = path + (action ? '?/' + action : '');
      // Auth endpoints and profile have dedicated execution tests, with no real account writes.
      if (path.startsWith('/auth/') || ['/financing/login', '/financing/logout', '/api/profile'].includes(path)) continue;
      const anonymous = await gatewayRequest(f.request(url, { method }), f.env);
      assert.equal(anonymous.status, scope === 'public' ? 200 : 401, `anonymous ${method} ${url}`);
      assert.equal((await gatewayRequest(f.request(url, { token, method }), f.env)).status, 200, `${method} ${url}`);
    }
  }
  for (const [path, method] of [['/unknown', 'GET'], ['/financing/projects?/createProject&/deleteProject', 'POST'], ['/api/credit', 'DELETE'], ['/data%2fchoice/css', 'GET'], ['/api/%2563redit', 'GET'], ['/api/credit/extra', 'GET']]) {
    assert.equal((await gatewayRequest(f.request(path, { method, token }), f.env)).status, 403, path);
  }
  assert.equal((await gatewayRequest(f.request('/financing/projects?/createProject', { token, method: 'POST', headers: { Origin: 'https://other.test' } }), f.env)).status, 403);
});

test('public Data resource/method matrix never calls identity, and protected resources cannot use spoofed headers', async t => {
  const f = await fixture(t);
  for (const path of [...PUBLIC_DATA_RESOURCES, '/news/article']) for (const method of ['GET', 'HEAD']) {
    for (const Cookie of ['', 'CF_Authorization=forged', '__Host-eastmoney_session=expired']) {
      assert.equal((await gatewayRequest(f.request('/data' + path, { method, headers: { Cookie } }), f.env)).status, 200);
    }
  }
  assert.equal(f.calls.auth0.length, 0);
  for (const path of PUBLIC_DATA_RESOURCES) for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal((await gatewayRequest(f.request('/data' + path, { method }), f.env)).status, 401);
  }
  for (const path of ['/choice/css', '/choice/csd', '/choice/ctr', '/choice/edb', '/choice/data-statistics', '/camel', '/camel/accounts', '/omo/extra', '/news/id/extra']) {
    const spoof = { 'X-Eastmoney-Gateway-Context': JSON.stringify({ version: 1, choice: { status: 204 } }), 'X-Internal-Service': 'dashboard', 'Cf-Access-Authenticated-User-Email': 'test@18.cn' };
    assert.equal((await gatewayRequest(f.request('/data' + path, { headers: spoof }), f.env)).status, 401);
    assert.equal((await gatewayRequest(f.request('/data' + path, { token: await f.signed() }), f.env)).status, 200);
  }
});

test('Gateway normalizes identity, strips all caller credentials and requires signed role claims without Management API reads', async t => {
  const f = await fixture(t); const token = await f.signed();
  const request = f.request('/api/credit', { token, headers: { Cookie: 'untrusted=secret', 'X-User-Id': 'attacker', 'X-Eastmoney-Gateway-Context': 'forged', 'Cf-Access-Jwt-Assertion': 'old' } });
  assert.equal((await gatewayRequest(request, f.env)).status, 200);
  const forwarded = f.calls.dashboard.at(-1);
  for (const name of ['Authorization', 'Cookie', 'X-User-Id', 'Cf-Access-Jwt-Assertion']) assert.equal(forwarded.headers.has(name), false);
  const context = JSON.parse(Buffer.from(forwarded.headers.get('X-Eastmoney-Gateway-Context'), 'base64url').toString());
  assert.equal(context.user.id, 'auth0|test'); assert.equal(context.user.email, 'test@18.cn');
  // Existing signed tokens retain their role/account snapshot until token renewal.
  f.updateProfile({ blocked: true }); assert.equal((await gatewayRequest(request, f.env)).status, 200);
  assert.equal(f.calls.auth0.length, 0, 'ordinary requests must not read Management API');
  const legacy = await f.signed({user:{...f.userClaims,roles:undefined}});
  assert.equal((await gatewayRequest(f.request('/api/credit', {token:legacy}), f.env)).status,401);

});

test('machines require an explicit client and Choice scope and never become Dashboard users or CAMEL users', async t => {
  const f = await fixture(t);
  for (const [claims, status] of [[{ azp: 'quant', sub: 'quant@clients', scope: 'data.choice:read' }, 200], [{ azp: 'unknown', sub: 'unknown@clients', scope: 'data.choice:read' }, 403], [{ azp: 'quant', sub: 'quant@clients', scope: '' }, 403]]) {
    const token = await f.signed({ gty: 'client-credentials', ...claims });
    assert.equal((await gatewayRequest(f.request('/data/choice/css', { token }), f.env)).status, status);
    for (const path of ['/data/camel', '/api/profile', '/api/credit']) assert.equal((await gatewayRequest(f.request(path, { token }), f.env)).status, 403);
  }
  assert.equal(f.calls.auth0.length, 0);
});

test('GraphQL aliases, selected operations and fragments receive a field verdict before private execution', async t => {
  const f = await fixture(t);
  const query = (query, token, extra = {}) => gatewayRequest(f.request('/data/graphql', { token, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, ...extra }) }), f.env);
  for (const text of ['{ health private: choiceCtr(reportName: "fixture") { rows } }', 'query { ...Limited } fragment Limited on Query { choiceEdb(edbIds: "1", startDate: "2026-01-01", endDate: "2026-01-02") { rows } }', '{ choiceCss(codes: "a", indicators: "b") { rows } }', '{ choiceCsd(codes: "a", indicators: "b", startDate: "2026-01-01", endDate: "2026-01-02") { rows } }', '{ choiceDataStatistics { rows } }']) {
    await query(text);
    assert.equal(JSON.parse(Buffer.from(f.calls.data.at(-1).headers.get('X-Eastmoney-Gateway-Context'), 'base64url').toString()).choice.status, 401);
    const body = await f.calls.data.at(-1).json(); assert.equal(body.query, text);
    await query(text, await f.signed());
    assert.equal(JSON.parse(Buffer.from(f.calls.data.at(-1).headers.get('X-Eastmoney-Gateway-Context'), 'base64url').toString()).choice.status, 204);
  }
  const before = f.calls.auth0.length;
  await query('query Public { health } query Private { choiceCtr(reportName: "x") { rows } }', await f.signed(), { operationName: 'Public' });
  assert.equal(f.calls.auth0.length, before);
});
