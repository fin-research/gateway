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
