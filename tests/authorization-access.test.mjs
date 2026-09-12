import assert from 'node:assert/strict';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { authorizeRequest } from '../src/lib/server/authorization.ts';
import { ROUTE_PERMISSIONS } from '../src/lib/server/permission-policy.ts';
import { PERMISSION_CODES } from '../src/lib/permissions.ts';

const origin = 'https://eastmoney.hasbai.xyz';
const requestFor = (path, method, cookie) => new Request(origin + path, {
  method, headers: { Origin: origin, ...(cookie ? { Authorization: 'Bearer ' + cookie } : {}) },
});
const concretePath = (id) => id.replace('/[[view]]', '').replace('[...path]', 'financial_monthly_data')
  .replace('[resource]', 'omo').replace('[date]', '2026-09-08').replace('[view]', 'research')
  .replace('[id]', '0123456789abcdef01234567');

// Exercise the authorization function for every registered HTTP method/action,
// without running a business handler or sending any production mutation.
test('anonymous and test@18.cn cover all registered routes and actions through central authorization', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'two-identities', alg: 'RS256' };
  const env = {
    AUTH0_LOGIN_DOMAIN: 'auth-matrix.auth0.com', AUTH0_AUDIENCE: 'site', AUTH0_ORGANIZATION_ID:'org_Eastmoney',AUTH0_CLIENT_ID: 'login',
    AUTHORIZATION_MODE: 'beta-open', AUTH0_DOMAIN: 'auth-matrix.eu.auth0.com',
    AUTH0_MANAGEMENT_CLIENT_ID: 'two-identities', AUTH0_MANAGEMENT_CLIENT_SECRET: 'unit-fixture',
  };
  const token = await new SignJWT({org_id:'org_Eastmoney', azp: 'login', 'https://eastmoney.hasbai.xyz/roles': [], 'https://eastmoney.hasbai.xyz/profile': {name:'测试账号',department:'测试',picture:'',connection:'eastmoney-email',verified:true}, 'https://eastmoney.hasbai.xyz/email': 'test@18.cn' })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setSubject('auth0|unit-test-account')
    .setIssuer(`https://${env.AUTH0_LOGIN_DOMAIN}/`).setAudience('site').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  let managementCalls = 0;
  const auth0 = async (input) => {
    managementCalls++;
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === '/oauth/token') return Response.json({ access_token: 'unit-fixture', expires_in: 3600 });
    if (url.pathname.endsWith('/roles')) return Response.json([]);
    assert.equal(decodeURIComponent(url.pathname), '/api/v2/users/auth0|unit-test-account');
    return Response.json({ user_id: 'auth0|unit-test-account', email: 'test@18.cn', email_verified: true,
      name: '权限测试账号', identities: [{ connection: 'eastmoney-email' }] });
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), `https://${env.AUTH0_LOGIN_DOMAIN}/.well-known/jwks.json`);
    return Response.json({ keys: [jwk] });
  };
  try {
    const cases = Object.entries(ROUTE_PERMISSIONS).flatMap(([id, methods]) => Object.entries(methods).flatMap(([operation, scope]) => {
      const [method, action] = operation.split(':');
      const path = concretePath(id) + (action ? `?/${action}` : '');
      return (method === 'GET' ? ['GET', 'HEAD'] : [method]).map(verb => ({ id, path, method: verb, scope }));
    }));
    cases.push(
      { id: '/credit-workbench/[[view]]', path: '/credit-workbench/assistant', method: 'GET', scope: 'credit.assistant:read' },
      { id: '/trading-research/[view]', path: '/trading-research/market-hotspots', method: 'GET', scope: 'research.hotspot:read' },
      { id: '/trading-research/[view]', path: '/trading-research/secondary-bond-pool', method: 'GET', scope: 'bond.ledger:read' },
      { id: '/data/[...path]', path: '/data/news', method: 'GET', scope: 'data.resource:read' },
      { id: '/data/[...path]', path: '/data/graphql', method: 'POST', scope: 'data.graphql:read' },
      { id: '/data/[...path]', path: '/data/choice/css', method: 'GET', scope: 'login' },
      { id: '/data/[...path]', path: '/data/camel', method: 'GET', scope: 'login' },
      { id: '/financing/data/api/[...path]', path: '/financing/data/api/rpc/liability_weekly_report_data', method: 'POST', scope: 'financing.report:read' },
    );
    for (const { id, path, method, scope } of cases) {
      const before = managementCalls;
      const anonymous = authorizeRequest(requestFor(path, method), env, id, auth0);
      if (scope === 'public') assert.equal((await anonymous).user, null, `${method} ${path}`);
      else await assert.rejects(anonymous, { status: 401 }, `anonymous ${method} ${path}`);
      assert.equal(managementCalls, before, `anonymous request consulted Auth0: ${method} ${path}`);
      const signed = await authorizeRequest(requestFor(path, method, token), env, id, auth0);
      if (scope !== 'public') assert.equal(signed.user.email, 'test@18.cn', `${method} ${path}`);
      if (!['public', 'login'].includes(scope)) {
        assert.ok(signed.permissions.includes(scope), `missing scope for ${method} ${path}`);
        assert.deepEqual(signed.permissions, PERMISSION_CODES);
        assert.equal(signed.user.auth0Id, 'auth0|unit-test-account');
      }
    }
    assert.equal(managementCalls, 0, 'business authorization must not consult Auth0 Management API');
    assert.ok(cases.length > 100, 'route matrix unexpectedly lost application coverage');
  } finally { globalThis.fetch = originalFetch; }
});
