import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { fixture } from './helpers/fixture.mjs';
import { gatewayRequest } from '../src/app.ts';
import { accessToken, readCookie, SESSION_COOKIE } from '../src/session.ts';

function jarCookie(response, name) { return response.headers.getSetCookie().find(value => value.startsWith(name + '=')).split(';')[0]; }

test('authorization-code login binds state, nonce and PKCE and seals only the API token in an HttpOnly host cookie', async t => {
  const f = await fixture(t);
  const start = await gatewayRequest(f.request('/auth/login?returnTo=%2Fprofile'), f.env);
  assert.equal(start.status, 303);
  const auth = new URL(start.headers.get('Location'));
  assert.equal(auth.origin, 'https://' + f.env.AUTH0_LOGIN_DOMAIN);
  assert.equal(auth.searchParams.get('audience'), f.env.AUTH0_AUDIENCE);
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('redirect_uri'), f.env.SITE_ORIGIN + '/auth/callback');
  const transactionCookie = jarCookie(start, '__Host-eastmoney_login');
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
  assert.ok(!sessionCookie.includes(access));
  const setCookie = result.headers.getSetCookie().find(value => value.startsWith(SESSION_COOKIE + '='));
  for (const flag of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax', 'Max-Age=']) assert.ok(setCookie.includes(flag));
  assert.equal(await accessToken(f.request('/api/credit', { headers: { Cookie: sessionCookie } }), f.env), access);
  f.intercept(undefined);
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
  await assert.rejects(accessToken(f.request('/profile', { headers: { Cookie: SESSION_COOKIE + '=tampered' } }), f.env), { status: 401 });
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

test('session lifetime is capped at 24h and never outlives its verified access token', async t => {
  const f = await fixture(t);
  const { jwtDecrypt, base64url } = await import('jose');
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
    const { payload } = await jwtDecrypt(token, base64url.decode(f.env.SESSION_SECRET));
    assert.ok(payload.exp <= expiration); assert.ok(payload.exp - payload.iat <= 86400);
  }
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
