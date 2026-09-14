import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { management as m, AUTH0_DOMAIN } from './lib/auth0-management.mjs';
import { createAuth0ManagementClient } from '../src/lib/server/auth0-management.js';
import { GATEWAY_MANAGEMENT_CLIENT_ID as clientId, assertGatewayManagementClient } from './lib/gateway-management-client.mjs';
import { loginTestAccount, readAuthTestConfig } from './lib/programmatic-login.mjs';
const client = m('get', `clients/${clientId}`);
assertGatewayManagementClient(client, m('get', `client-grants?client_id=${clientId}`));
const runtime = createAuth0ManagementClient({ domain: AUTH0_DOMAIN, clientId, clientSecret: client.client_secret });
const organization = 'org_6yvoRRCkzk3eGkBS';
const users = await runtime.request('users-by-email?email=test%4018.cn');
assert.equal(users.length, 1); const user = users[0]; assert.equal(user.email, 'test@18.cn');
const memberRoles = await runtime.request(`organizations/${organization}/members/${encodeURIComponent(user.user_id)}/roles`);
const baseline = memberRoles.find(r => r.name === 'authenticated'); assert.ok(baseline);
const members = await runtime.request(`organizations/${organization}/members?per_page=100`);
assert.ok(members.some(u => u.user_id === user.user_id));
const denied = []; const claims = new Map(); const metadata = [];
const api = { access: { deny: value => denied.push(value) }, accessToken: { setCustomClaim: (k, v) => claims.set(k, v) }, idToken: { setCustomClaim() {} },
  redirect: { canRedirect: () => false }, user: { setAppMetadata: (...args) => metadata.push(args) } };
const common = { client: { client_id: '16vMxoYpr5AdPRiW1PkwIiHuRWszii6m' }, connection: { name: 'eastmoney-email' }, organization: { id: organization }, user };
let tokens = 0; let profileWrites = 0; let baselineWrites = 0;
const fetcher = async (url, init) => {
  const body = init?.body ? JSON.parse(init.body) : undefined;
  if (String(url).endsWith('/oauth/token')) { assert.equal(body.client_id, clientId); tokens++; }
  else if (init?.method === 'PATCH') {
    assert.equal(String(url), `https://${AUTH0_DOMAIN}/api/v2/users/${encodeURIComponent(user.user_id)}`);
    // Exercise the actual signup Action with existing values; leave test profile unchanged.
    assert.deepEqual(body, { name: user.name, nickname: user.nickname, user_metadata: { name: user.user_metadata.name, department: user.user_metadata.department } });
    profileWrites++;
  } else if (init?.method === 'POST') {
    assert.equal(String(url), `https://${AUTH0_DOMAIN}/api/v2/organizations/${organization}/members/${encodeURIComponent(user.user_id)}/roles`);
    assert.deepEqual(body, { roles: [baseline.id] }); baselineWrites++;
  }
  return fetch(url, init);
};
function load(id) {
  const action = m('get', `actions/actions/${id}`);
  assert.equal(action.all_changes_deployed, true);
  const context = { exports: {}, fetch: fetcher, AbortSignal, URL, Date, JSON, Buffer };
  runInNewContext(action.deployed_version.code, context);
  return context.exports;
}
const login = load('0b72438c-33ff-4321-b6c7-74b7d021e6a3');
await login.onExecutePostLogin({ ...common, authorization: { roles: [] }, secrets: {
  EASTMONEY_CLIENT_ID: common.client.client_id, ROLES_DOMAIN: AUTH0_DOMAIN, ROLES_CLIENT_ID: clientId, ROLES_CLIENT_SECRET: client.client_secret,
} }, api);
assert.equal(denied.length, 0); assert.equal(baselineWrites, 1); assert.ok(claims.get('user')?.roles.some(r => r.id === baseline.id));
const form = m('get', 'forms').find(f => f.name === 'eastmoney signup profile'); assert.ok(form);
const profile = load('91736f7a-024c-406d-905b-7d2daa20ec8f');
await profile.onContinuePostLogin({ ...common, user: { ...user, app_metadata: { ...user.app_metadata, eastmoney_signup_profile_pending: true } },
  prompt: { id: form.id, fields: { name: user.user_metadata.name, department: user.user_metadata.department } },
  secrets: { EASTMONEY_CLIENT_ID: common.client.client_id, PROFILE_FORM_ID: form.id, PROFILE_CLIENT_ID: clientId, PROFILE_CLIENT_SECRET: client.client_secret } }, api);
assert.equal(denied.length, 0); assert.equal(profileWrites, 1); assert.equal(tokens, 2);
assert.deepEqual(metadata, [['eastmoney_signup_profile_pending', false]]);
const after = await runtime.request(`users/${encodeURIComponent(user.user_id)}`);
for (const key of ['name', 'nickname', 'user_metadata', 'app_metadata']) assert.deepEqual(after[key], user[key]);
assert.deepEqual(await runtime.request(`organizations/${organization}/members/${encodeURIComponent(user.user_id)}/roles`), memberRoles);
const evidence = { clientId, passed: true, checkedAt: new Date().toISOString(), testAccount: 'test@18.cn', directory: true, signedBaselineRole: true,
  baselineAssignment: 'reapplied existing role only', signupProfile: 'deployed Action continuation with real Management API and unchanged values', fullHostedFormSubmission: false };
await writeFile('.auth0-deploy/m2m/verified.json', JSON.stringify(evidence, null, 2), { mode: 0o600 });
console.log(JSON.stringify(evidence));
if (process.argv.includes('--retired')) {
  for (const old of ['Ja1Jra2z1ifOKOUnA9M2qu3JzUudgW4j', 'rpBS8lgdzn7LXhImz8BGiKLPSTjztcwz']) {
    const retired = m('get', `clients/${old}`);
    assert.deepEqual(retired.grant_types, []);
    assert.ok(m('get', `client-grants?client_id=${old}`).every(g => g.scope.length === 0));
    const response = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', client_id: old,
        client_secret: retired.client_secret, audience: `https://${AUTH0_DOMAIN}/api/v2/` }) });
    const result = await response.json();
    assert.ok([401, 403].includes(response.status)); assert.equal(result.error, 'unauthorized_client');
    console.log(JSON.stringify({ retiredClient: old, tokenStatus: response.status, error: result.error }));
  }
  const session = await loginTestAccount(await readAuthTestConfig());
  assert.ok(session.profile.permissions.length > 0);
  await writeFile('.auth0-deploy/m2m/retired-verified.json', JSON.stringify({ clientId, passed: true, checkedAt: new Date().toISOString(), oldTokensRejected: true, freshLogin: true }), { mode: 0o600 });
  console.log(JSON.stringify({ afterDisable: true, freshLogin: true, permissions: session.profile.permissions.length }));
}
