import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/fixture.mjs';
import { verifyToken } from '../src/tokens.ts';
import { gatewayRequest } from '../src/app.ts';
import { createDirectory } from '../src/lib/server/auth0-directory.ts';
import action from '../auth0/actions/eastmoney-login.cjs';

test('site ID, user API and machine tokens reject absent or foreign organization claims', async t => {
  const f = await fixture(t);
  for (const kind of ['id', 'access']) {
    for (const extra of [{}, { gty: 'client-credentials', azp: 'quant', sub: 'quant@clients' }]) {
      for (const org_id of [undefined, 'org_Hasbai', ['org_Eastmoney']]) {
        await assert.rejects(verifyToken(await f.signed({ ...extra, org_id }, kind), f.env, kind), { status: 401 });
      }
      assert.equal((await verifyToken(await f.signed(extra, kind), f.env, kind)).org_id, 'org_Eastmoney');
    }
  }
  await assert.rejects(verifyToken(await f.signed({ gty: 'client-credentials', azp: 'quant', sub: 'quant@clients', org_id: undefined }), f.env), {status:401});
  await assert.rejects(verifyToken(await f.signed({ gty: 'client-credentials', azp: 'foreign', sub: 'foreign@clients', org_id: undefined }), f.env), { status: 401 });
  const foreign = await f.signed({org_id:'org_Hasbai'});
  assert.equal((await gatewayRequest(f.request('/api/credit?organization=org_Eastmoney',{token:foreign}),f.env)).status,401);
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
    const url = new URL(input), path = url.pathname; calls.push(path);
    if (path === '/oauth/token') return Response.json({ access_token: 'fixture', expires_in: 100 });
    if (path === '/api/v2/roles') return Response.json([legacy, owned, foreign, { id: 'rol_Unrelated', name: 'tenant-admin' }]);
    if (path === '/api/v2/organizations/org_Eastmoney/members') return Response.json([{ user_id: 'auth0|member', roles: [legacy, foreign] }]);
    if (path === '/api/v2/organizations/org_Eastmoney/members/auth0%7Cmember/roles') return Response.json([legacy, foreign]);
    if (path === '/api/v2/users' && url.searchParams.get('q') === 'organization_id:"org_Eastmoney"')
      return Response.json([{ user_id: 'auth0|member', email: 'member@18.cn', name: 'Member', email_verified: true,
        identities: [{ connection: 'eastmoney-email' }] }, { user_id: 'auth0|foreign', email: 'foreign@18.cn',
        identities: [{ connection: 'eastmoney-email' }] }]);
    if (path === '/api/v2/users/auth0%7Cmember') return Response.json({ user_id: 'auth0|member', email: 'member@18.cn', name: 'Member', email_verified: true, identities: [{ connection: 'eastmoney-email' }] });
    throw new Error('Unexpected directory request');
  });
  assert.deepEqual((await dir.roles()).map(r => r.id), [legacy.id, owned.id]);
  const people = await dir.people();
  assert.equal(people.length, 1); assert.deepEqual(people[0].roles.map(r => r.id), [legacy.id]);
  await assert.rejects(dir.user('auth0|foreign'), { status: 403 });
  assert.equal(calls.filter(p => p === '/api/v2/organizations/org_Eastmoney/members').length, 2);
  assert.equal(calls.filter(path => path === '/api/v2/users').length, 1);
  assert.ok(!calls.some(p => p.includes('auth0%7Cforeign')));
  assert.ok(!calls.some(p => p.endsWith('/roles') && p.includes('/members/')));
});

test('directory profile update validates fields and limits the target to organization members', async () => {
  const calls = [];
  const config = { AUTH0_ORGANIZATION_ID: 'org_Eastmoney', AUTH0_DOMAIN: 'directory-update.auth0.com',
    AUTH0_MANAGEMENT_CLIENT_ID: 'directory-update', AUTH0_MANAGEMENT_CLIENT_SECRET: 'fixture' };
  const profile = { user_id: 'auth0|member', email: 'member@18.cn', name: '旧姓名',
    user_metadata: { department: '旧部门', color: 'blue' }, identities: [{ connection: 'eastmoney-email' }] };
  const directory = createDirectory(config, async (input, init) => {
    const path = new URL(input).pathname;
    calls.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    if (path === '/oauth/token') return Response.json({ access_token: 'fixture', expires_in: 100 });
    if (path === '/api/v2/organizations/org_Eastmoney/members') return Response.json([{ user_id: profile.user_id }]);
    if (path === '/api/v2/users/auth0%7Cmember' && init.method === 'PATCH')
      return Response.json({ user_id: profile.user_id });
    if (path === '/api/v2/users/auth0%7Cmember') return Response.json(profile);
    throw new Error('Unexpected directory request');
  });
  await assert.rejects(directory.updatePerson({ id: 'auth0|member', name: 'x', department: 'd'.repeat(101) }), { status: 400 });
  assert.equal(calls.length, 0);
  await assert.rejects(directory.updatePerson({ id: 'auth0|foreign', name: 'x', department: '' }), { status: 403 });
  assert.equal(calls.some(call => call.method === 'PATCH'), false);
  assert.deepEqual(await directory.updatePerson({ id: 'auth0|member', name: ' 新姓名 ', department: ' 新部门 ' }),
    { id: 'auth0|member', name: '新姓名', department: '新部门', email: 'member@18.cn' });
  assert.deepEqual(calls.find(call => call.method === 'PATCH').body,
    { name: '新姓名', user_metadata: { department: '新部门' } });
});

test('directory aggregates organization profiles and roles without individual reads', async () => {
  const config = { AUTH0_ORGANIZATION_ID: 'org_Eastmoney', AUTH0_DOMAIN: 'directory-batch.auth0.com',
    AUTH0_MANAGEMENT_CLIENT_ID: 'directory-batch', AUTH0_MANAGEMENT_CLIENT_SECRET: 'fixture' };
  const ids = Array.from({ length: 9 }, (_, index) => `auth0|member${index}`);
  let profileReads = 0, memberRoleRequests = 0, aggregateReads = 0;
  const directory = createDirectory(config, async input => {
    const url = new URL(input), path = url.pathname;
    if (path === '/oauth/token') return Response.json({ access_token: 'fixture', expires_in: 100 });
    if (path === '/api/v2/organizations/org_Eastmoney/members') return Response.json(ids.map(user_id => ({ user_id,
      roles: [{ id: 'rol_Site', name: 'authenticated' }] })));
    if (path === '/api/v2/roles') return Response.json([{ id: 'rol_Site', name: 'authenticated', owner_id: 'org_Eastmoney' }]);
    if (path.endsWith('/roles')) { memberRoleRequests++; return Response.json([{ id: 'rol_Site', name: 'authenticated' }]); }
    if (path === '/api/v2/users') {
      aggregateReads++;
      assert.equal(url.searchParams.get('q'), 'organization_id:"org_Eastmoney"');
      assert.equal(url.searchParams.get('search_engine'), 'v3');
      return Response.json(ids.map(user_id => ({ user_id, email: `${user_id.slice('auth0|'.length)}@18.cn`, name: user_id,
        email_verified: true, identities: [{ connection: 'eastmoney-email' }] })));
    }
    if (path.startsWith('/api/v2/users/auth0%7Cmember')) {
      profileReads++;
      const id = decodeURIComponent(path.split('/').at(-1));
      return Response.json({ user_id: id, email: `${id.slice('auth0|'.length)}@18.cn`, name: id,
        email_verified: true, identities: [{ connection: 'eastmoney-email' }] });
    }
    throw new Error(`Unexpected directory path ${path}`);
  });
  const people = await directory.people();
  assert.equal(people.length, ids.length);
  assert.equal(profileReads, 0);
  assert.ok(people.every(person => person.roles[0]?.id === 'rol_Site'));
  assert.equal(memberRoleRequests, 0);
  const profiles = await directory.people(false);
  assert.equal(profiles.length, ids.length);
  assert.ok(profiles.every(person => person.roles.length === 0));
  assert.equal(memberRoleRequests, 0);
  assert.equal(profileReads, 0);
  assert.equal(aggregateReads, 2);
});

test('directory reads only missing profiles individually when aggregate search is incomplete', async () => {
  const config = { AUTH0_ORGANIZATION_ID: 'org_Eastmoney', AUTH0_DOMAIN: 'directory-fallback.auth0.com',
    AUTH0_MANAGEMENT_CLIENT_ID: 'directory-fallback', AUTH0_MANAGEMENT_CLIENT_SECRET: 'fixture' };
  const ids = ['auth0|a', 'auth0|b', 'auth0|c'];
  const profileReads = [];
  const directory = createDirectory(config, async input => {
    const url = new URL(input), path = url.pathname;
    if (path === '/oauth/token') return Response.json({ access_token: 'fixture', expires_in: 100 });
    if (path === '/api/v2/organizations/org_Eastmoney/members') return Response.json(ids.map(user_id => ({ user_id })));
    if (path === '/api/v2/users') return Response.json([{ user_id: ids[0], email: 'a@18.cn',
      identities: [{ connection: 'eastmoney-email' }] }, { user_id: ids[1], email: 'b@18.cn' },
    { user_id: 'auth0|foreign', email: 'foreign@18.cn', identities: [{ connection: 'eastmoney-email' }] }]);
    if (path.startsWith('/api/v2/users/auth0%7C')) {
      const id = decodeURIComponent(path.split('/').at(-1));
      profileReads.push(id);
      return Response.json({ user_id: id, email: `${id.split('|')[1]}@18.cn`, identities: [{ connection: 'eastmoney-email' }] });
    }
    throw new Error(`Unexpected directory path ${path}`);
  });
  assert.deepEqual((await directory.people(false)).map(person => person.id), ids);
  assert.deepEqual(profileReads, ['auth0|b', 'auth0|c']);
});
