import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/fixture.mjs';
import { identityService } from '../src/identity-service.ts';

test('notification eligibility reads only selected members and checks status and roles on every request', async t => {
  const f = await fixture(t), calls = [];
  let roles = [{ id: 'rol_TestAdmin', name: 'admin' }];
  let members = [{ user_id: 'auth0|test' }, { user_id: 'auth0|unsubscribed' }];
  f.intercept(async url => {
    calls.push(url.pathname);
    if (url.pathname === '/api/v2/organizations/org_Eastmoney/members') return Response.json(members);
    if (url.pathname === '/api/v2/organizations/org_Eastmoney/members/auth0%7Ctest/roles') return Response.json(roles);
  });
  const read = async () => {
    const query = new URLSearchParams([['userId', 'auth0|test'], ['userId', 'auth0|test'], ['userId', 'auth0|foreign']]);
    const response = await identityService(new Request('https://identity.internal/directory/notification-users?' + query), f.env);
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.deepEqual(await read(), [{ id: 'auth0|test', categories: ['workflow', 'trading', 'financing'] }]);
  assert.equal(calls.filter(path => path === '/api/v2/users/auth0%7Ctest').length, 1);
  assert.ok(!calls.some(path => path.includes('auth0%7Cunsubscribed') || path.includes('auth0%7Cforeign')));
  roles = [];
  assert.deepEqual(await read(), [{ id: 'auth0|test', categories: [] }]);
  f.updateProfile({ blocked: true });
  assert.deepEqual(await read(), []);
  members = [];
  assert.deepEqual(await read(), []);
});

test('notification eligibility rejects invalid filters before upstream work and never falls back to the full directory', async t => {
  const f = await fixture(t);
  for (const query of ['userId=', 'userId=foreign', new URLSearchParams(Array.from({ length: 101 }, () => ['userId', 'auth0|test'])).toString()]) {
    const response = await identityService(new Request('https://identity.internal/directory/notification-users?' + query), f.env);
    assert.equal(response.status, 400);
  }
  assert.equal(f.calls.auth0.length, 0);
});

test('unfiltered notification eligibility remains compatible and upstream failure fails closed', async t => {
  const f = await fixture(t);
  f.intercept(async url => {
    if (url.pathname === '/api/v2/organizations/org_Eastmoney/members') return Response.json([{ user_id: 'auth0|test' }]);
  });
  const request = () => new Request('https://identity.internal/directory/notification-users');
  const response = await identityService(request(), f.env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{ id: 'auth0|test', categories: [] }]);
  f.intercept(async () => new Response(null, { status: 503 }));
  assert.equal((await identityService(request(), f.env)).status, 503);
});
