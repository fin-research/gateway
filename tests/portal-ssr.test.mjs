import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/fixture.mjs';
import { gatewayRequest } from '../src/app.ts';
import { CONTEXT_HEADER } from '../src/forward.ts';
import { SESSION_COOKIE } from '../src/session.ts';

test('public portal forwards only verified effective permissions into SSR', async t => {
  const f = await fixture(t);
  await f.updateGrants(['credit.institution:read']);
  const context = () => JSON.parse(Buffer.from(f.calls.dashboard.at(-1).headers.get(CONTEXT_HEADER), 'base64url').toString('utf8'));
  const anonymous = await gatewayRequest(f.request('/'), f.env);
  assert.equal(anonymous.status, 200);
  assert.equal(context().user, null);

  const token = await f.signed();
  const signed = await gatewayRequest(f.request('/', { token }), f.env);
  assert.equal(signed.status, 200);
  assert.equal(signed.headers.get('Cache-Control'), 'no-store, private');
  assert.equal(context().user.auth0Id, 'auth0|test');
  assert.deepEqual(context().user.authorization.permissions, ['credit.institution:read']);
  assert.equal(f.calls.dashboard.at(-1).headers.has('Cookie'), false);

  const invalid = await gatewayRequest(f.request('/', { headers: { Cookie: `${SESSION_COOKIE}=tampered` } }), f.env);
  assert.equal(invalid.status, 200);
  assert.equal(context().user, null);

  f.env.AUTHORIZATION_MODE = 'invalid';
  const unavailable = await gatewayRequest(f.request('/', { token }), f.env);
  assert.equal(unavailable.status, 200);
  assert.equal(context().user, null);
  assert.equal((await gatewayRequest(f.request('/management/me', { token }), f.env)).status, 503);
});
