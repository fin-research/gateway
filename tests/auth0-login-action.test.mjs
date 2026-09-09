import test from 'node:test';
import assert from 'node:assert/strict';
import action from '../auth0/actions/eastmoney-login.cjs';

const legacyId = '12345678-1234-1234-1234-123456789abc';
function context(user = {}, { canRedirect = true, client = 'eastmoney' } = {}) {
  const calls = { denied: [], redirected: [], claims: [] };
  return {
    event: { client: { client_id: client }, secrets: { EASTMONEY_CLIENT_ID: 'eastmoney' },
      user: { user_id: 'auth0|new-account', email: 'new@18.cn', email_verified: false, ...user } },
    api: { access: { deny: (message) => calls.denied.push(message) },
      redirect: { canRedirect: () => canRedirect, sendUserTo: (...args) => calls.redirected.push(args) },
      accessToken: { setCustomClaim() {} }, idToken: { setCustomClaim: (...args) => calls.claims.push(args) } }, calls,
  };
}

test('unverified signup suspends login at the public email notice without denial, tokens or personal data', async () => {
  const { event, api, calls } = context();
  await action.onExecutePostLogin(event, api);
  assert.deepEqual(calls, { denied: [], redirected: [['https://eastmoney.hasbai.xyz/auth/verify-email']], claims: [] });
});

test('verified users receive the stable identity claim and are not redirected', async () => {
  const { event, api, calls } = context({ email_verified: true });
  await action.onExecutePostLogin(event, api);
  assert.deepEqual(calls, { denied: [], redirected: [], claims: [['eastmoney_user_id', 'auth0|new-account']] });
});

test('only the exact migrated ID and original email retain the established verification exception', async () => {
  const user = { user_id: `auth0|${legacyId}`, email: 'old@18.cn', email_verified: false,
    app_metadata: { migrated_from: 'neon', neon_auth_user_id: legacyId, neon_email: 'old@18.cn' } };
  const good = context(user);
  await action.onExecutePostLogin(good.event, good.api);
  assert.equal(good.calls.claims.length, 1);
  for (const changed of [{ ...user, email: 'changed@18.cn' }, { ...user, user_id: 'auth0|different' },
    { ...user, app_metadata: { ...user.app_metadata, neon_auth_user_id: 'not-a-uuid' } }]) {
    const { event, api, calls } = context(changed);
    await action.onExecutePostLogin(event, api);
    assert.equal(calls.redirected.length, 1);
    assert.equal(calls.claims.length, 0);
  }
});

test('other domains are still denied rather than being described as a successful registration', async () => {
  const { event, api, calls } = context({ email: 'someone@example.com', email_verified: true });
  await action.onExecutePostLogin(event, api);
  assert.deepEqual(calls, { denied: ['仅允许使用 18.cn 邮箱登录'], redirected: [], claims: [] });
});

test('non-browser exchanges cannot skip verification when redirects are unavailable', async () => {
  const { event, api, calls } = context({}, { canRedirect: false });
  await action.onExecutePostLogin(event, api);
  assert.equal(calls.denied.length, 1);
  assert.equal(calls.claims.length, 0);
  assert.equal(calls.redirected.length, 0);
});

test('manually resuming the suspended transaction cannot bypass verification', async () => {
  for (const verified of [false, true]) {
    const { event, api, calls } = context({ email_verified: verified });
    await action.onContinuePostLogin(event, api);
    assert.deepEqual(calls, { denied: ['请完成邮箱验证后重新登录'], redirected: [], claims: [] });
  }
});

test('other Auth0 applications remain unaffected on execute and continue', async () => {
  const { event, api, calls } = context({}, { client: 'other-application' });
  await action.onExecutePostLogin(event, api);
  await action.onContinuePostLogin(event, api);
  assert.deepEqual(calls, { denied: [], redirected: [], claims: [] });
});

test('the dedicated portal client receives the same verified-user gate and claims', async () => {
  for (const verified of [false, true]) {
    const { event, api, calls } = context({ email: 'test@18.cn', email_verified: verified }, { client: 'M1a5PF3UJaFIZv1k4HO4IV06Z5fXQBHV' });
    await action.onExecutePostLogin(event, api);
    assert.equal(calls.claims.length, verified ? 1 : 0);
    assert.equal(calls.redirected.length, verified ? 0 : 1);
  }
});
