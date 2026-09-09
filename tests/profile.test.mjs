import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfileService, readProfileJson } from '../src/lib/server/profile.ts';

const config = { AUTH0_DOMAIN: 'example.auth0.com', AUTH0_CLIENT_ID: 'login-client', AUTH0_MANAGEMENT_CLIENT_ID: 'manager', AUTH0_MANAGEMENT_CLIENT_SECRET: 'test-service-secret' };
const identity = { auth0Id: 'auth0|me', email: 'me@18.cn' };
const user = { user_id: 'auth0|me', email: 'me@18.cn', email_verified: true, name: '原姓名', identities: [{ connection: 'eastmoney-email', access_token: 'must-not-be-returned' }] };
function fixture({ account = user, respond } = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, path, ...init, body });
    assert.equal(init.redirect, 'manual');
    if (respond) {
      const result = await respond({ url, path, ...init, body });
      if (result) return result;
    }
    if (path === '/oauth/token') return Response.json({ access_token: 'service-token', expires_in:60 });
    if (path === '/dbconnections/change_password') return new Response('sent');
    assert.equal(init.headers.Authorization, 'Bearer service-token');
    if (path.endsWith('/roles')) return Response.json([{ id: 'role-admin', name: 'admin', description: '管理员', secret: 'private' }]);
    if (path.endsWith('/permissions')) return Response.json([{ permission_name: 'report_generate', description: '周报生成', resource_server_identifier: 'https://eastmoney.hasbai.xyz/financing', sources: ['internal'] }]);
    if (init.method === 'PATCH') return Response.json({ ...account, ...body });
    assert.equal(path, '/api/v2/users/auth0%7Cme');
    return Response.json(account);
  };
  return { calls, service: createProfileService(config, identity, fetcher) };
}

test('profile reads the signed subject and returns only public profile and permission fields', async () => {
  const { service, calls } = fixture();
  assert.deepEqual(await service.read(), { name: '原姓名', email: 'me@18.cn', emailVerified: true,
    roles: [{ name: 'admin', description: '管理员' }], permissions: [] });
  assert.equal(calls.filter((call) => call.path === '/oauth/token').length, 1);
  assert.ok(calls.every((call) => !call.path.includes('users-by-email')));
});

test('profile refuses anonymous or unmapped identities and missing management configuration', () => {
  assert.throws(() => createProfileService(config, null), { status: 401 });
  assert.throws(() => createProfileService(config, { ...identity, auth0Id: null }), { status: 503 });
  assert.throws(() => createProfileService({ ...config, AUTH0_MANAGEMENT_CLIENT_SECRET: '' }, identity), { status: 503 });
});

test('name update targets only the current identity and uses the confirmed upstream name', async () => {
  const { service, calls } = fixture();
  assert.deepEqual(await service.update({ action: 'name', name: '  新姓名  ' }), { message: '个人资料已保存', name: '新姓名' });
  const mutation = calls.find((call) => call.method === 'PATCH');
  assert.equal(mutation.path, '/api/v2/users/auth0%7Cme');
  assert.deepEqual(mutation.body, { name: '新姓名' });
});

test('profile rejects arbitrary IDs, permissions, metadata, invalid emails and unconfirmed email changes before any request', async () => {
  const { service, calls } = fixture();
  for (const change of [
    { action: 'name', name: '' }, { action: 'name', name: 'a'.repeat(51) },
    { action: 'name', name: 'x', user_id: 'auth0|someone' },
    { action: 'name', name: 'x', app_metadata: { role: 'admin' } },
    { action: 'email', email: 'me@example.com', confirmed: true },
    { action: 'email', email: 'new@18.cn', confirmed: false },
    { action: 'email', email: 'new@18.cn' },
    { action: 'password', email: 'other@18.cn' },
    { action: 'password', password: 'never-accept-password' },
  ]) await assert.rejects(service.update(change), { status: 400 });
  assert.equal(calls.length, 0);
});

test('email update resets verification, requests verification and tells the client to log out', async () => {
  const { service, calls } = fixture();
  const result = await service.update({ action: 'email', email: 'NEW@18.CN', confirmed: true });
  assert.equal(result.logout, true);
  assert.deepEqual(calls.find((call) => call.method === 'PATCH').body, {
    email: 'new@18.cn', email_verified: false, verify_email: true, connection: 'eastmoney-email', client_id: 'login-client',
  });
});

test('email already in use remains a 409 and an unchanged address is rejected', async () => {
  const { service } = fixture({ respond: ({ method }) => method === 'PATCH' ? new Response('private diagnostics', { status: 409 }) : null });
  await assert.rejects(service.update({ action: 'email', email: 'taken@18.cn', confirmed: true }), { status: 409, message: '该邮箱已被使用，请更换邮箱' });
  await assert.rejects(service.update({ action: 'email', email: 'me@18.cn', confirmed: true }), { status: 400 });
});

test('password reset sends only to the server-verified account and never returns a ticket', async () => {
  const { service, calls } = fixture();
  assert.deepEqual(await service.update({ action: 'password' }), { message: '密码重置邮件已请求发送，请在登录邮箱中完成修改' });
  assert.deepEqual(calls.find((call) => call.path === '/dbconnections/change_password').body,
    { client_id: 'login-client', email: 'me@18.cn', connection: 'eastmoney-email' });
  assert.equal(calls.filter((call) => call.method === 'PATCH').length, 0);
});

test('stale identity, blocked accounts and foreign connections cannot read or mutate accounts', async () => {
  for (const [account, status] of [
    [{ ...user, email: 'changed@18.cn' }, 401], [{ ...user, user_id: 'auth0|other' }, 401],
    [{ ...user, blocked: true }, 403], [{ ...user, identities: [{ connection: 'other' }] }, 403],
  ]) {
    const { service, calls } = fixture({ account });
    await assert.rejects(service.update({ action: 'name', name: 'new' }), { status });
    assert.equal(calls.filter((call) => call.method === 'PATCH').length, 0);
  }
});

test('upstream credential errors and redirects are service failures without credential leakage', async () => {
  for (const status of [301, 302, 401, 403, 429, 500]) {
    const { service } = fixture({ respond: () => new Response('secret diagnostics', { status }) });
    await assert.rejects(service.read(), { status: 503, message: '账号服务暂时不可用，请稍后重试' });
  }
});

test('role listing consumes pagination while permission display uses application authorization', async () => {
 const { service, calls } = fixture({ respond: ({ url, path }) => {
   if (!path.endsWith('/roles')) return;
   return Response.json(new URL(url).searchParams.get('page') === '0' ? Array.from({length:100}, (_,i)=>({name:`role${i}`})) : []);
 } });
 const profile=await service.read();
 assert.equal(profile.roles.length,100);
 assert.equal(calls.filter(call=>call.path.endsWith('/roles')).length,2);
 assert.deepEqual(profile.permissions,[]);
 assert.equal(calls.filter(call=>call.path.endsWith('/permissions')).length,0);
});

test('malformed or oversized upstream responses are rejected', async () => {
  for (const body of ['not-json', JSON.stringify({ secret: 'x'.repeat(512 * 1024) })]) {
    const { service } = fixture({ respond: ({ path }) => path === '/oauth/token' ? new Response(body) : null });
    await assert.rejects(service.read(), { status: 503 });
  }
});

test('profile request bodies are bounded independently of Content-Length', async () => {
  assert.deepEqual(await readProfileJson(new Request('https://local.test', { method: 'POST', body: '{"ok":true}' }), 16), { ok: true });
  await assert.rejects(readProfileJson(new Request('https://local.test', { method: 'POST', body: 'x'.repeat(20) }), 16), { status: 413 });
  await assert.rejects(readProfileJson(new Request('https://local.test', { method: 'POST', body: 'bad' }), 16), { status: 400 });
});
