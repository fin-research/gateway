import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { decodeJwt, decodeProtectedHeader, EncryptJWT, base64url } from 'jose';
import { fixture } from './helpers/fixture.mjs';
import { gatewayRequest } from '../src/app.ts';
import { accessToken, readCookie, SESSION_COOKIE } from '../src/session.ts';

function jarCookie(response, name) { return response.headers.getSetCookie().find(value => value.startsWith(name + '=')).split(';')[0]; }

test('authorization-code login binds state, nonce and PKCE and stores the original signed API JWT in an HttpOnly host cookie', async t => {
  const f = await fixture(t);
  const start = await gatewayRequest(f.request('/auth/login?returnTo=%2Fprofile'), f.env);
  assert.equal(start.status, 303);
  const auth = new URL(start.headers.get('Location'));
  assert.equal(auth.origin, 'https://' + f.env.AUTH0_LOGIN_DOMAIN);
  assert.equal(auth.searchParams.get('audience'), f.env.AUTH0_AUDIENCE);
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('redirect_uri'), f.env.SITE_ORIGIN + '/auth/callback');
  const transactionCookie = jarCookie(start, '__Host-eastmoney_login');
  assert.equal(transactionCookie.split('=')[1].split('.').length, 5, 'PKCE transaction remains encrypted');
  let access;
  f.intercept(async (url, init) => {
    if (url.pathname !== '/oauth/token') return;
    const body = JSON.parse(init.body);
    assert.equal(body.grant_type, 'authorization_code'); assert.equal(body.code, 'unit-code');
    assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'), auth.searchParams.get('code_challenge'));
    assert.equal(init.redirect, 'manual'); assert.equal(body.client_secret, 'unit-secret');
    access = await f.signed();
    return Response.json({ token_type: 'Bearer', access_token: access, id_token: await f.signed({ email: 'test@18.cn', nonce: auth.searchParams.get('nonce') }, 'id') });
  });
  const result = await gatewayRequest(f.request('/auth/callback?code=unit-code&state=' + auth.searchParams.get('state'), { headers: { Cookie: transactionCookie } }), f.env);
  assert.equal(result.status, 303); assert.equal(result.headers.get('Location'), '/profile');
  const sessionCookie = jarCookie(result, SESSION_COOKIE);
  assert.equal(sessionCookie, SESSION_COOKIE + '=' + access);
  assert.equal(access.split('.').length, 3);
  assert.equal(decodeProtectedHeader(access).alg, 'RS256');
  const setCookie = result.headers.getSetCookie().find(value => value.startsWith(SESSION_COOKIE + '='));
  for (const flag of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax', 'Max-Age=']) assert.ok(setCookie.includes(flag));
  assert.equal(await accessToken(f.request('/api/credit', { headers: { Cookie: sessionCookie } })), access);
  f.intercept(undefined);
  f.env.SESSION_SECRET = ''; // Reading a signed session no longer needs an encryption key.
  const session = await gatewayRequest(f.request('/auth/session', { headers: { Cookie: sessionCookie } }), f.env);
  const payload = await session.json(); assert.equal(payload.user.email, 'test@18.cn');
  assert.ok(!JSON.stringify(payload).includes(access)); assert.equal(session.headers.get('Cache-Control'), 'no-store, private');
});

test('callback rejects absent/mismatched/duplicate state, ID-token nonce mismatch and code-exchange redirects', async t => {
  const f = await fixture(t);
  for (const scenario of ['absent', 'mismatch', 'duplicate', 'nonce', 'redirect']) {
    const start = await gatewayRequest(f.request('/auth/login?returnTo=https://evil.test'), f.env);
    const auth = new URL(start.headers.get('Location')); const state = auth.searchParams.get('state');
    let exchanges = 0;
    f.intercept(async (url) => {
      if (url.pathname !== '/oauth/token') return;
      exchanges++;
      if (scenario === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://evil.test' } });
      return Response.json({ token_type: 'Bearer', access_token: await f.signed(), id_token: await f.signed({ email: 'test@18.cn', nonce: 'wrong' }, 'id') });
    });
    const params = '?code=unit&state=' + (scenario === 'mismatch' ? 'wrong' : state) + (scenario === 'duplicate' ? '&state=other' : '');
    const response = await gatewayRequest(f.request('/auth/callback' + params, { headers: { Cookie: scenario === 'absent' ? '' : jarCookie(start, '__Host-eastmoney_login') } }), f.env);
    assert.equal(response.status, 401, scenario);
    assert.ok(response.headers.getSetCookie().some(value => value.startsWith('__Host-eastmoney_login=;') && value.includes('Max-Age=0')));
    if (['absent', 'mismatch', 'duplicate'].includes(scenario)) assert.equal(exchanges, 0);
  }
});

test('tampered/duplicate cookies never create identity; public session, logout and SvelteKit redirects keep their contracts', async t => {
  const f = await fixture(t);
  await assert.rejects(accessToken(f.request('/profile', { headers: { Cookie: SESSION_COOKIE + '=tampered' } })), { status: 401 });
  assert.throws(() => readCookie(f.request('/profile', { headers: { Cookie: `${SESSION_COOKIE}=one; ${SESSION_COOKIE}=two` } }), SESSION_COOKIE), { status: 401 });
  const anonymous = await gatewayRequest(f.request('/auth/session', { headers: { Cookie: SESSION_COOKIE + '=tampered' } }), f.env);
  assert.equal((await anonymous.json()).user, null);
  const data = await gatewayRequest(f.request('/profile/__data.json'), f.env);
  assert.equal(data.status, 200); assert.deepEqual(await data.json(), { type: 'redirect', location: '/auth/login?returnTo=%2Fprofile' });
  const logout = await gatewayRequest(f.request('/auth/logout?returnTo=https://evil.test'), f.env);
  const target = new URL(logout.headers.get('Location'));
  assert.equal(target.origin, 'https://' + f.env.AUTH0_LOGIN_DOMAIN); assert.equal(target.searchParams.get('returnTo'), f.env.SITE_ORIGIN + '/');
  assert.ok(logout.headers.getSetCookie().some(value => value.startsWith(SESSION_COOKIE + '=;')));
  assert.equal((await gatewayRequest(f.request('/auth/logout', { method: 'POST', headers: { Origin: 'https://evil.test' } }), f.env)).status, 403);
});

test('session cookie lifetime is capped at 24h from token issuance and never outlives the original JWT', async t => {
  const f = await fixture(t);
  for (const lifetime of [120, 86400, 172800]) {
    const start = await gatewayRequest(f.request('/auth/login'), f.env);
    const auth = new URL(start.headers.get('Location'));
    const expiration = Math.floor(Date.now() / 1000) + lifetime;
    f.intercept(async url => {
      if (url.pathname !== '/oauth/token') return;
      return Response.json({ token_type: 'Bearer', access_token: await f.signed({ exp: expiration }),
        id_token: await f.signed({ email: 'test@18.cn', nonce: auth.searchParams.get('nonce') }, 'id') });
    });
    const result = await gatewayRequest(f.request('/auth/callback?code=unit&state=' + auth.searchParams.get('state'), { headers: { Cookie: jarCookie(start, '__Host-eastmoney_login') } }), f.env);
    assert.equal(result.status, 303);
    const cookie = result.headers.getSetCookie().find(value => value.startsWith(SESSION_COOKIE + '='));
    const age = Number(/Max-Age=(\d+)/.exec(cookie)[1]);
    assert.ok(age <= Math.min(lifetime, 86400) && age >= Math.min(lifetime, 86400) - 3);
    const token = jarCookie(result, SESSION_COOKIE).slice(SESSION_COOKIE.length + 1);
    assert.equal(decodeJwt(token).exp, expiration, 'Auth0 token is retained without rewriting its claims');
  }
});

test('signed cookie sessions reject forged, expired and non-API JWTs before forwarding', async t => {
  const f = await fixture(t);
  const valid = await f.signed();
  const parts = valid.split('.');
  parts[1] = Buffer.from(JSON.stringify({ ...decodeJwt(valid), sub: 'auth0|forged' })).toString('base64url');
  const unsigned = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url') + '.' + valid.split('.')[1] + '.';
  const invalid = [parts.join('.'), unsigned, await f.signed({}, 'id')];
  for (const claims of [{ exp: 1 }, { iss: 'https://other.test/' }, { aud: 'other' }, { iat: 9999999999 }, { nbf: 9999999999 }]) invalid.push(await f.signed(claims));
  for (const token of invalid) {
    const response = await gatewayRequest(f.request('/api/credit', { headers: { Cookie: SESSION_COOKIE + '=' + token } }), f.env);
    assert.equal(response.status, 401);
  }
  assert.equal(f.calls.dashboard.length, 0);
  const response = await gatewayRequest(f.request('/api/credit', { headers: { Cookie: SESSION_COOKIE + '=' + valid } }), f.env);
  assert.equal(response.status, 200);
  assert.equal(f.calls.dashboard.at(-1).headers.has('Cookie'), false);
});

test('24h server-side cookie limit applies to Dashboard and Data without shortening API Bearer tokens', async t => {
  const f = await fixture(t);
  const now = Math.floor(Date.now() / 1000);
  const token = await f.signed({ iat: now - 86401, exp: now + 3600 });
  for (const path of ['/api/credit', '/data/choice/css']) {
    assert.equal((await gatewayRequest(f.request(path, { headers: { Cookie: SESSION_COOKIE + '=' + token } }), f.env)).status, 401);
    assert.equal((await gatewayRequest(f.request(path, { token }), f.env)).status, 200);
  }
});

test('retired credit and JWE cookies are expired on public, private, Data and logout responses', async t => {
  const f = await fixture(t);
  const legacy = await new EncryptJWT({ token: await f.signed() }).setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuer(f.env.SITE_ORIGIN).setAudience('session').setIssuedAt().setExpirationTime('1h').encrypt(base64url.decode(f.env.SESSION_SECRET));
  const Cookie = `credit-session=00000000-0000-4000-8000-000000000000; ${SESSION_COOKIE}=${legacy}`;
  for (const [path, status] of [['/', 200], ['/auth/session', 200], ['/api/credit', 401], ['/data/health', 200], ['/auth/logout', 303]]) {
    const response = await gatewayRequest(f.request(path, { headers: { Cookie } }), f.env);
    assert.equal(response.status, status);
    for (const name of ['credit-session', SESSION_COOKIE]) {
      const cleared = response.headers.getSetCookie().filter(value => value.startsWith(name + '=;'));
      assert.equal(cleared.length, 1);
      assert.match(cleared[0], /Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=0/);
    }
    assert.match(response.headers.get('Cache-Control'), /no-store/);
    if (path === '/auth/session') assert.equal((await response.json()).user, null);
  }
  const clean = await gatewayRequest(f.request('/'), f.env);
  assert.equal(clean.headers.has('Set-Cookie'), false);
  const start = await gatewayRequest(f.request('/auth/login'), f.env);
  const auth = new URL(start.headers.get('Location'));
  f.intercept(async url => url.pathname === '/oauth/token' ? Response.json({ token_type: 'Bearer', access_token: await f.signed(),
    id_token: await f.signed({ email: 'test@18.cn', nonce: auth.searchParams.get('nonce') }, 'id') }) : undefined);
  const result = await gatewayRequest(f.request('/auth/callback?code=unit&state=' + auth.searchParams.get('state'), {
    headers: { Cookie: Cookie + '; ' + jarCookie(start, '__Host-eastmoney_login') },
  }), f.env);
  assert.equal(result.status, 303);
  const sessions = result.headers.getSetCookie().filter(value => value.startsWith(SESSION_COOKIE + '='));
  assert.equal(sessions.length, 1, 'legacy cleanup must not delete the new login');
  assert.equal(sessions[0].split(';')[0].split('=')[1].split('.').length, 3);
});

test('popup completion is transaction-bound and only sends an origin-scoped success hint', async t => {
  const f = await fixture(t);
  const { runInNewContext } = await import('node:vm');
  const id = 'a'.repeat(32);
  for (const ok of [true, false]) {
    const start = await gatewayRequest(f.request('/auth/login?popup=' + id + '&returnTo=%2Fprofile'), f.env);
    const auth = new URL(start.headers.get('Location'));
    f.intercept(async url => {
      if (url.pathname !== '/oauth/token') return;
      return Response.json({ token_type: 'Bearer', access_token: await f.signed(), id_token: await f.signed({ email: 'test@18.cn', nonce: auth.searchParams.get('nonce') }, 'id') });
    });
    const result = await gatewayRequest(f.request('/auth/callback?state=' + auth.searchParams.get('state') + (ok ? '&code=unit-code' : '&error=access_denied'), { headers: { Cookie: jarCookie(start, '__Host-eastmoney_login') } }), f.env);
    assert.equal(result.status, 200); assert.equal(result.headers.get('location'), null);
    assert.match(result.headers.get('Content-Security-Policy'), /default-src 'none'.*script-src 'nonce-/);
    const html = await result.text();
    assert.ok(!html.includes('unit-code')); assert.ok(!html.includes(auth.searchParams.get('state')));
    const events = [];
    runInNewContext(/<script nonce="[^"]+">([\s\S]+)<\/script>/.exec(html)[1], {
      history: { replaceState: (_state, _title, path) => events.push(['history', path]) },
      window: { opener: { postMessage: (data, origin) => events.push(['message', JSON.parse(JSON.stringify(data)), origin]) }, close: () => events.push(['close']) },
      BroadcastChannel: class { constructor(name) { events.push(['channel', name]); } postMessage() {} close() {} },
    });
    assert.deepEqual(events[0], ['history', '/auth/callback']);
    assert.deepEqual(events[1], ['message', { type: 'eastmoney:login', id, ok }, f.env.SITE_ORIGIN]);
    assert.equal(events.some(event => event[0] === 'close'), ok);
    assert.equal(result.headers.getSetCookie().some(value => value.startsWith(SESSION_COOKIE + '=')), ok);
  }
  const plain = await gatewayRequest(f.request('/auth/callback?popup=' + id + '&code=unit&state=forged'), f.env);
  assert.equal(plain.status, 401); assert.match(plain.headers.get('Content-Type'), /json/);
});
