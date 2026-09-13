import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './helpers/fixture.mjs';
import { gatewayRequest } from '../src/app.ts';
import { SESSION_COOKIE } from '../src/session.ts';

const legacyClaims = user => ({
  'https://eastmoney.hasbai.xyz/roles': user.roles,
  'https://eastmoney.hasbai.xyz/profile': user.profile,
  'https://eastmoney.hasbai.xyz/email': user.email,
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

test('login callback continues accepting old Action claims during the reader-first rollout', async t => {
  const f = await fixture(t);
  const start = await gatewayRequest(f.request('/auth/login'), f.env);
  const auth = new URL(start.headers.get('Location'));
  const transaction = start.headers.getSetCookie().find(value => value.startsWith('__Host-eastmoney_login=')).split(';')[0];
  f.intercept(async url => url.pathname === '/oauth/token' ? Response.json({
    token_type: 'Bearer', access_token: await f.signed({ user: undefined, ...legacyClaims(f.userClaims) }),
    id_token: await f.signed({ email: 'test@18.cn', nonce: auth.searchParams.get('nonce') }, 'id'),
  }) : undefined);
  const result = await gatewayRequest(f.request('/auth/callback?code=unit&state=' + auth.searchParams.get('state'), { headers: { Cookie: transaction } }), f.env);
  assert.equal(result.status, 303);
  assert.ok(result.headers.getSetCookie().some(value => value.startsWith(SESSION_COOKIE + '=')));
});
