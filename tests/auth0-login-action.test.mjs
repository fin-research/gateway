import test from 'node:test';
import assert from 'node:assert/strict';
import action from '../auth0/actions/eastmoney-login.cjs';

const legacyId = '12345678-1234-1234-1234-123456789abc';
function context(user = {}, { canRedirect = true, client = 'eastmoney' } = {}) {
  const calls = { denied: [], redirected: [], claims: [] };
  return {
    event: { organization: {id:'org_6yvoRRCkzk3eGkBS'}, connection: {name:'eastmoney-email'}, authorization:{roles:[]}, client: { client_id: client }, secrets: { EASTMONEY_CLIENT_ID: 'eastmoney' },
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

test('role IDs and profile are signed at login; refreshed role membership gets new claims',async t=>{
  const f=context({email_verified:true,name:'测试账号',user_metadata:{department:'测试'}},{client:'eastmoney'});
  Object.assign(f.event.secrets,{ROLES_DOMAIN:'hasbai.eu.auth0.com',ROLES_CLIENT_ID:'roles-reader',ROLES_CLIENT_SECRET:'unit-secret'});
  const cache=new Map();f.api.cache={get:key=>cache.has(key)?{value:cache.get(key)}:undefined,set:(key,value)=>cache.set(key,value)};
  const claims=new Map();f.api.accessToken.setCustomClaim=(key,value)=>claims.set(key,value);
  const calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls.push(String(url));assert.equal(options.redirect,'manual');
    if(String(url).endsWith('/oauth/token'))return Response.json({access_token:'roles-token',expires_in:86400});
    assert.ok(String(url).includes('/api/v2/roles?'));
    assert.equal(options.headers.Authorization,'Bearer roles-token');
    return Response.json([{id:'rol_eoDAJuWbdjwEzEln',name:'Admin'},{id:'rol_dUEQWoUpRu5kzcqi',name:'Reviewer'}]);
  });
  f.event.authorization.roles=['Admin'];await action.onExecutePostLogin(f.event,f.api);
  assert.deepEqual(claims.get('https://eastmoney.hasbai.xyz/roles'),[{id:'rol_eoDAJuWbdjwEzEln',name:'Admin'}]);
  assert.deepEqual(claims.get('https://eastmoney.hasbai.xyz/profile'),{name:'测试账号',department:'测试',picture:'',connection:'eastmoney-email',verified:true});
  f.event.authorization.roles=['Reviewer'];await action.onExecutePostLogin(f.event,f.api);
  assert.deepEqual(claims.get('https://eastmoney.hasbai.xyz/roles'),[{id:'rol_dUEQWoUpRu5kzcqi',name:'Reviewer'}]);
  assert.equal(calls.filter(url=>url.endsWith('/oauth/token')).length,1);
  assert.equal(calls.filter(url=>url.includes('/api/v2/roles?')).length,2);
});

test('missing or unresolved role catalogues fail login closed and do not sign privileges',async()=>{
  const f=context({email_verified:true});f.event.authorization.roles=['Admin'];
  const claims=[];f.api.accessToken.setCustomClaim=(...args)=>claims.push(args);
  await action.onExecutePostLogin(f.event,f.api);
  assert.equal(f.calls.denied.length,1);assert.equal(claims.length,0);
});

test('blocked accounts and other connections cannot mint site role claims',async()=>{
  for(const change of ['blocked','connection']){
    const f=context({email_verified:true});if(change==='blocked')f.event.user.blocked=true;else f.event.connection.name='foreign';
    await action.onExecutePostLogin(f.event,f.api);assert.equal(f.calls.denied.length,1);assert.equal(f.calls.claims.length,0);
  }
});
