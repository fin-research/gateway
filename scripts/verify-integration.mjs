// Real SvelteKit and Data handlers behind the real Gateway; all upstream services are mocked.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { fixture } from '../tests/helpers/fixture.mjs';
import { gatewayRequest } from '../src/app.ts';
import { SESSION_COOKIE } from '../src/session.ts';
import { identityService } from '../src/identity-service.ts';
import { PUBLIC_DATA_RESOURCES } from '../src/policy.ts';
const dashboard = resolve(process.env.DASHBOARD_CHECKOUT || '../dashboard');
const data = resolve(process.env.DATA_CHECKOUT || '../data');
const { Server } = await import(pathToFileURL(join(dashboard, '.svelte-kit/output/server/index.js')).href);
const { manifest } = await import(pathToFileURL(join(dashboard, '.svelte-kit/output/server/manifest.js')).href);
const cleanup = [];
const f = await fixture({ after(fn) { cleanup.push(fn); } });
let personnelPatch;
f.intercept(async (url, init) => {
  if (url.pathname === '/api/v2/organizations/org_Eastmoney/members') return Response.json([{ user_id: 'auth0|member' }]);
  if (url.pathname === '/api/v2/users/auth0%7Cmember') {
    if (init.method === 'PATCH') {
      personnelPatch = JSON.parse(init.body);
      return Response.json({ user_id: 'auth0|member' });
    }
    return Response.json({ user_id: 'auth0|member', email: 'member@18.cn', name: '旧姓名',
      user_metadata: { department: '旧部门' }, email_verified: true, identities: [{ connection: 'eastmoney-email' }] });
  }
  return null;
});
const require = createRequire(import.meta.resolve('wrangler'));
const { build } = require('esbuild');
const directory = await mkdtemp(join(tmpdir(), 'eastmoney-gateway-integration-'));
let checks = 0;
try {
  await build({ entryPoints: [join(data, 'src/public-access.ts')], bundle: true, outfile: join(directory, 'data.mjs'), format: 'esm', platform: 'node', target: 'es2022', logLevel: 'silent' });
  const { handleGatewayRequest, handlePublicRequest } = await import(pathToFileURL(join(directory, 'data.mjs')).href);
  const storage = new Map();
  const identityPaths = [];
  const appEnv = {
    EASTMONEY: { async list() { return { objects: [], truncated: false }; }, async head(key) { return storage.has(key) ? { key } : null; }, async put(key, value) { storage.set(key, value); return { key }; } },
    IDENTITY: { fetch(request) { const url = new URL(request.url); identityPaths.push(url.pathname + url.search); return identityService(request, f.env); } },
  };
  const server = new Server(manifest); await server.init({ env: appEnv });
  f.env.DASHBOARD = { fetch(request) {
    const context = JSON.parse(Buffer.from(request.headers.get('X-Eastmoney-Gateway-Context'), 'base64url').toString());
    const headers = new Headers(request.headers); headers.delete('X-Eastmoney-Gateway-Context');
    return server.respond(new Request(request, { headers }), { getClientAddress: () => '127.0.0.1', platform: { env: { ...appEnv, GATEWAY_CONTEXT: context }, context: { waitUntil() {} } } });
  } };
  f.env.DATA = { fetch: request => handleGatewayRequest(request, {}) };
  const token = await f.signed();
  const adminToken = await f.signed({ user: { ...f.userClaims, roles: [{ id: 'rol_TestAdmin', name: 'admin' }] } });
  const respond = (path, authenticated = true, init = {}) => gatewayRequest(f.request(path, {
    ...init, headers: { ...(authenticated ? { Cookie: SESSION_COOKIE + '=' + token } : {}), ...init.headers },
  }), f.env);
  const payload = async path => { const response = await respond(path); assert.equal(response.status, 200, path); return response.json(); };
  const bootstrap = await payload('/trading-research/research/__data.json?x-sveltekit-invalidated=11');
  assert.equal(bootstrap.type, 'data'); assert.deepEqual(bootstrap.nodes[0].uses.dependencies, ['site:session']);
  assert.ok(!bootstrap.nodes[0].uses.url); checks++;
  for (const path of ['/trading-research/market-hotspots', '/trading-research/policy-tracking', '/credit-workbench/calendar']) {
    const result = await payload(path + '/__data.json?x-sveltekit-invalidated=01');
    assert.equal(result.nodes[0].type, 'skip'); checks++;
  }
  assert.deepEqual(await payload('/profile/__data.json?x-sveltekit-invalidated=01'),
    { type: 'redirect', location: '/management/me' }); checks++;
  for (const path of ['/profile', '/trading-research', '/credit-workbench']) {
    const response = await respond(path, false, { headers: { Accept: 'text/html' } });
    assert.equal(response.status, 303); checks++;
    const dataResponse = await respond(path + '/__data.json', false);
    assert.deepEqual(await dataResponse.json(), { type: 'redirect', location: '/auth/login?returnTo=' + encodeURIComponent(path) }); checks++;
    const signed = await respond(path);
    assert.equal(signed.status, path === '/profile' ? 303 : 200, path);
    if (path === '/profile') assert.equal(signed.headers.get('location'), '/management/me');
    checks++;
  }
  const notice = await respond('/auth/verify-email?state=opaque&email=must-not-render%4018.cn', false);
  assert.equal(notice.status, 200); assert.doesNotMatch(await notice.text(), /opaque|must-not-render/); checks++;
  for (const headers of [{}, { 'X-Eastmoney-Gateway-Context': 'forged', Authorization: 'Bearer fake' }]) {
    assert.equal((await handlePublicRequest(new Request('https://data.workers.dev/data/choice/css', { headers }), {})).status, 404); checks++;
  }
  assert.equal((await respond('/data/health', false)).status, 200); checks++;
  for (const path of ['/data/choice/css', '/data/choice/csd', '/data/choice/ctr', '/data/choice/edb']) {
    assert.equal((await respond(path, false)).status, 401); assert.equal((await respond(path)).status, 422); checks += 2;
  }
  for (const authenticated of [false, true]) {
    const response = await respond('/data/graphql', authenticated, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '{ health private: choiceCtr(reportName: "") { rows } }' }) });
    const result = await response.json(); assert.deepEqual(result.data.health, { status: 'ok' });
    if (!authenticated) assert.equal(result.errors[0].extensions.code, 'LOGIN_REQUIRED');
    else { assert.match(result.errors[0].message, /reportName/); assert.notEqual(result.errors[0].extensions?.code, 'LOGIN_REQUIRED'); }
    checks++;
  }
  const badUpload = await respond('/api/fund-report', false, { method: 'POST' });
  assert.equal(badUpload.status, 401); assert.equal(storage.size, 0); checks++;
  const profile = await payload('/api/profile'); assert.equal(profile.email, 'test@18.cn'); checks++;
  f.updateProfile({ blocked: true });
  assert.equal((await respond('/management/me/__data.json')).status, 200); checks++;
  f.updateProfile({ blocked: false, email: 'changed@18.cn' });
  assert.equal((await (await respond('/management/me/__data.json')).json()).type, 'data'); checks++;
  const adminHeaders = { Cookie: SESSION_COOKIE + '=' + adminToken };
  let beforeDirectory = identityPaths.length;
  const peoplePage = await respond('/management/people', true, { headers: { ...adminHeaders, Accept: 'text/html' } });
  assert.equal(peoplePage.status, 200);
  assert.match(await peoplePage.text(), /人员资料/);
  assert.deepEqual(identityPaths.slice(beforeDirectory), ['/directory/people?view=profiles']); checks++;
  beforeDirectory = identityPaths.length;
  const rolesPage = await respond('/management/people?tab=roles', true, { headers: { ...adminHeaders, Accept: 'text/html' } });
  assert.equal(rolesPage.status, 200);
  assert.match(await rolesPage.text(), /刷新授权缓存/);
  assert.deepEqual(identityPaths.slice(beforeDirectory), ['/roles/configurations']); checks++;
  const change = { id: 'auth0|member', name: '新姓名', department: '新部门' };
  const personResponse = await respond('/api/management/people', true, { method: 'POST',
    headers: { ...adminHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(change) });
  assert.equal(personResponse.status, 200);
  assert.deepEqual(await personResponse.json(), { ...change, email: 'member@18.cn' });
  assert.deepEqual(personnelPatch, { name: '新姓名', user_metadata: { department: '新部门' } }); checks++;
  personnelPatch = undefined;
  const foreignResponse = await respond('/api/management/people', true, { method: 'POST',
    headers: { ...adminHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...change, id: 'auth0|foreign' }) });
  assert.equal(foreignResponse.status, 403);
  assert.equal(personnelPatch, undefined); checks++;
  console.log(JSON.stringify({ integration: true, checks, gateway: 'Hono', dashboard: 'built SvelteKit', data: 'bundled real handler', externalServices: 'mocked', browserUsed: false }));
} finally { for (const fn of cleanup) fn(); await rm(directory, { recursive: true, force: true }); }
