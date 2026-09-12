import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/fixture.mjs';
import { verifyToken } from '../src/tokens.ts';
import { login } from '../src/session.ts';
import { createDirectory } from '../src/lib/server/auth0-directory.ts';
import action from '../auth0/actions/eastmoney-login.cjs';

test('site ID, user API and machine tokens reject absent or foreign organization claims', async t => {
  const f = await fixture(t);
  for (const kind of ['id', 'access']) {
    for (const extra of [{}, { gty: 'client-credentials', azp: 'quant', sub: 'quant@clients' }]) {
      for (const org_id of [...(kind === 'access' && extra.gty ? [] : [undefined]), 'org_Hasbai', ['org_Eastmoney']]) {
        await assert.rejects(verifyToken(await f.signed({ ...extra, org_id }, kind), f.env, kind), { status: 401 });
      }
      assert.equal((await verifyToken(await f.signed(extra, kind), f.env, kind)).org_id, 'org_Eastmoney');
    }
  }
  assert.equal((await verifyToken(await f.signed({ gty: 'client-credentials', azp: 'quant', sub: 'quant@clients', org_id: undefined }), f.env)).azp, 'quant');
  await assert.rejects(verifyToken(await f.signed({ gty: 'client-credentials', azp: 'foreign', sub: 'foreign@clients', org_id: undefined }), f.env), { status: 401 });
  const result = await login(f.request('/auth/login?organization=org_Hasbai'), f.env);
  assert.equal(new URL(result.headers.get('Location')).searchParams.get('organization'), 'org_Eastmoney');
});

test('Eastmoney Action rejects missing/foreign org while other applications remain untouched', async () => {
  for (const client of ['website', 'M1a5PF3UJaFIZv1k4HO4IV06Z5fXQBHV', 'hasbai-app']) {
    for (const organization of [undefined, { id: 'org_Hasbai' }]) {
      const denied = [];
      await action.onExecutePostLogin({ client: { client_id: client }, secrets: { EASTMONEY_CLIENT_ID: 'website' }, organization },
        { access: { deny: value => denied.push(value) } });
      assert.equal(denied.length, client === 'hasbai-app' ? 0 : 1);
    }
  }
});

test('role catalogue matching excludes a foreign organization role with an identical name', async t => {
  const denied = [], claims = [];
  t.mock.method(globalThis, 'fetch', async url => Response.json(String(url).endsWith('/oauth/token')
    ? { access_token: 'fixture', expires_in: 100 }
    : [{ id: 'rol_Foreign', name: 'Admin', owner_id: 'org_Hasbai' }]));
  await action.onExecutePostLogin({ client: { client_id: 'website' }, organization: { id: 'org_6yvoRRCkzk3eGkBS' },
    connection: { name: 'eastmoney-email' }, user: { user_id: 'auth0|test', email: 'test@18.cn', email_verified: true },
    authorization: { roles: ['Admin'] }, secrets: { EASTMONEY_CLIENT_ID: 'website', ROLES_DOMAIN: 'hasbai.eu.auth0.com', ROLES_CLIENT_ID: 'fixture', ROLES_CLIENT_SECRET: 'fixture' } },
  { access: { deny: v => denied.push(v) }, accessToken: { setCustomClaim: (...v) => claims.push(v) } });
  assert.equal(denied.length, 1); assert.equal(claims.length, 0);
});

test('directory reads only organization members and scoped roles, preserving legacy permission IDs', async () => {
  const calls = [];
  const config = { AUTH0_ORGANIZATION_ID: 'org_Eastmoney', AUTH0_DOMAIN: 'directory-test.auth0.com', AUTH0_MANAGEMENT_CLIENT_ID: 'directory-org', AUTH0_MANAGEMENT_CLIENT_SECRET: 'fixture' };
  const legacy = { id: 'rol_eoDAJuWbdjwEzEln', name: 'financing:admin' };
  const owned = { id: 'rol_Owned', name: 'financing', owner_id: 'org_Eastmoney' };
  const foreign = { id: 'rol_Foreign', name: 'hasbai-admin', owner_id: 'org_Hasbai' };
  const dir = createDirectory(config, async input => {
    const path = new URL(input).pathname; calls.push(path);
    if (path === '/oauth/token') return Response.json({ access_token: 'fixture', expires_in: 100 });
    if (path === '/api/v2/roles') return Response.json([legacy, owned, foreign, { id: 'rol_Unrelated', name: 'tenant-admin' }]);
    if (path === '/api/v2/organizations/org_Eastmoney/members') return Response.json([{ user_id: 'auth0|member' }]);
    if (path === '/api/v2/organizations/org_Eastmoney/members/auth0%7Cmember/roles') return Response.json([legacy, foreign]);
    if (path === '/api/v2/users/auth0%7Cmember') return Response.json({ user_id: 'auth0|member', email: 'member@18.cn', name: 'Member', email_verified: true, identities: [{ connection: 'eastmoney-email' }] });
    throw new Error('Unexpected directory request');
  });
  assert.deepEqual((await dir.roles()).map(r => r.id), [legacy.id, owned.id]);
  const people = await dir.people();
  assert.equal(people.length, 1); assert.deepEqual(people[0].roles.map(r => r.id), [legacy.id]);
  await assert.rejects(dir.user('auth0|foreign'), { status: 403 });
  assert.equal(calls.filter(p => p === '/api/v2/organizations/org_Eastmoney/members').length, 1);
  assert.ok(!calls.includes('/api/v2/users') && !calls.some(p => p.includes('auth0%7Cforeign')));
});
