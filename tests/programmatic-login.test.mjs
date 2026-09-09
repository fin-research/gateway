import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionCookies, createHttpSession, loginTestAccount, parseLoginPage } from '../scripts/lib/programmatic-login.mjs';

const site = 'https://eastmoney.hasbai.xyz';
const team = 'https://hasbai.cloudflareaccess.com';
const auth = 'https://auth.hasbai.xyz';
const redirect = (location, cookies = []) => new Response(null, { status: 302, headers: [['Location', location], ...cookies.map(c => ['Set-Cookie', c])] });

test('programmatic HTTP login preserves form state and verifies the resulting test identity without browser APIs', async () => {
  const steps = [];
  const fetcher = async (url, options) => {
    steps.push(`${options.method} ${url.origin}${url.pathname}`);
    assert.equal(options.redirect, 'manual');
    switch (steps.length) {
      case 1: return redirect(auth + '/authorize?state=one&client_id=fixture', ['__Host-eastmoney_login=fixture; Path=/; Secure; HttpOnly']);
      case 2: assert.equal(options.headers.get('Cookie'), null); return redirect('/u/login/identifier?state=one', ['auth0=fixture; Path=/; Secure; HttpOnly']);
      case 3: return new Response('<form method="POST"><input name="state" value="one&amp;two"><input name="username"><button name="action" value="default">Next</button></form>');
      case 4: {
        const body = new URLSearchParams(options.body);
        assert.equal(body.get('username'), 'test@18.cn'); assert.equal(body.get('state'), 'one&two'); assert.equal(body.get('action'), 'default');
        assert.equal(body.has('password'), false); return redirect('/u/login/password?state=two');
      }
      case 5: return new Response('<form method="post"><input name="state" value="two"><input name="username"><input name="password" type="password"><button name="action" value="default">Login</button></form>');
      case 6: assert.equal(new URLSearchParams(options.body).get('password'), 'unit-password'); return redirect(site + '/auth/callback?code=fixture&state=one');
      case 7: assert.match(options.headers.get('Cookie'), /__Host-eastmoney_login=fixture/); return redirect('/profile', ['__Host-eastmoney_session=fixture-user; Path=/; Secure; HttpOnly']);
      case 8: assert.match(options.headers.get('Cookie'), /__Host-eastmoney_session=fixture-user/); return new Response('Profile');
      case 9: return Response.json({ email: 'test@18.cn', emailVerified: true });
      default: throw new Error('unexpected request');
    }
  };
  const session = await loginTestAccount({ email: 'test@18.cn', password: 'unit-password' }, fetcher);
  assert.equal(session.profile.email, 'test@18.cn'); assert.equal(steps.length, 9);
});

test('cookie domain and path scoping prevent user sessions leaking to the identity provider', () => {
  const jar = new SessionCookies();
  jar.update(new Headers({ 'Set-Cookie': '__Host-eastmoney_session=fixture; Path=/private; Secure' }), site + '/private');
  assert.equal(jar.header(auth), ''); assert.equal(jar.header(site + '/private-other'), '');
  assert.equal(jar.header(site + '/private/child'), '__Host-eastmoney_session=fixture');
  jar.update(new Headers({ 'Set-Cookie': 'bad=fixture; Domain=evil.test; Path=/' }), site);
  assert.equal(jar.header('https://evil.test/'), '');
  jar.update(new Headers({ 'Set-Cookie': '__Host-eastmoney_session=; Max-Age=0; Path=/private' }), site);
  assert.equal(jar.header(site + '/private'), '');
});

test('login fails safely on untrusted redirects and reports required profile completion without account mutation', async () => {
  const session = createHttpSession(async () => redirect('https://evil.test/collect'));
  await assert.rejects(session.request(site), { code: 'UNTRUSTED_ORIGIN' });
  const replay = createHttpSession(async () => new Response(null, { status: 307, headers: { Location: '/u/login/password' } }));
  await assert.rejects(replay.request(auth + '/u/login/password', { method: 'POST', body: 'password=unit' }), { code: 'POST_REDIRECT' });
  const result = parseLoginPage('<form method="POST" action="/u/login"><input name="state" value="&#65;&amp;B"></form>');
  assert.equal(result.forms[0].controls[0].value, 'A&B');
  let calls = 0;
  await assert.rejects(loginTestAccount({ email: 'test@18.cn', password: 'unit-password' }, async () => ++calls === 1
    ? redirect(auth + '/u/custom-prompt/profile') : new Response('Complete profile')), { code: 'PROFILE_REQUIRED' });
  assert.equal(calls, 2);
});
