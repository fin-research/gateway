import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
const apply = process.argv.includes('--apply');
const root = parseEnv(await readFile(process.env.EASTMONEY_ENV_FILE || new URL('../../eastmoney/.env', import.meta.url), 'utf8'));
const authentication = spawnSync('pnpm', ['exec', 'wrangler', 'auth', 'token', '--json'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
if (authentication.status !== 0) throw new Error('Wrangler authentication unavailable');
const token = JSON.parse(authentication.stdout).token;
if (!token || !root.CLOUDFLARE_ACCESS_API_TOKEN) throw new Error('Missing Worker or Access configuration authorization');
const account = '5cecc63c78acf8f5473f8745f4244448';
const zone = 'e0665efd9fd68d06cbb9ab68a13cc7c6';
const appId = 'a9f2b190-16bf-43cb-9940-73b0a1f91280';
const hostname = 'eastmoney.hasbai.xyz';
async function api(path, method = 'GET', body, access = false) {
  const response = await fetch('https://api.cloudflare.com/client/v4/' + path, { method, redirect: 'manual', signal: AbortSignal.timeout(30000),
    headers: { Authorization: 'Bearer ' + (access ? root.CLOUDFLARE_ACCESS_API_TOKEN : token), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(`Cloudflare ${method} failed (${response.status}): ${result.errors?.map(e => e.code).join(',')}`);
  return result.result;
}
const routesPath = `zones/${zone}/workers/routes`;
const appsPath = `accounts/${account}/access/apps`;
const routes = (await api(routesPath)).filter(route => route.pattern.includes(hostname));
const apps = await api(appsPath, 'GET', undefined, true);
const app = apps.find(app => app.id === appId);
const allowedScripts = new Set(['eastmoney-dashboard', 'eastmoney-data', 'eastmoney-gateway']);
if (routes.some(route => !allowedScripts.has(route.script) || ![hostname + '/*', hostname + '/data*'].includes(route.pattern))) throw new Error('Unexpected site route; review before cutover');
if (app && (app.name !== 'eastmoney' || app.type !== 'self_hosted' || app.destinations.some(destination => destination.type !== 'public' || !destination.uri.startsWith(hostname + '/')))) throw new Error('Access application includes unexpected destinations');
console.log(JSON.stringify({ apply, routes: routes.map(r => ({ pattern: r.pattern, script: r.script })), removeAccessApp: app ? app.name : null, privateOrigins: ['eastmoney-dashboard', 'eastmoney-data'] }));
if (!apply) process.exit(0);
// Private snapshots support a deliberate rollback; never print policies or credentials.
await mkdir(new URL('../.ops/', import.meta.url), { recursive: true, mode: 0o700 });
await writeFile(new URL('../.ops/cutover-before-' + Date.now() + '.json', import.meta.url), JSON.stringify({ routes, access: app, policies: app ? await api(`${appsPath}/${appId}/policies`, 'GET', undefined, true) : [] }), { mode: 0o600 });
const gateway = await api(`accounts/${account}/workers/scripts/eastmoney-gateway/settings`);
for (const [name, service, entrypoint] of [['DASHBOARD', 'eastmoney-dashboard', 'GatewayDashboard'], ['DATA', 'eastmoney-data', 'GatewayData']]) {
  if (!gateway.bindings.some(binding => binding.name === name && binding.service === service && binding.entrypoint === entrypoint)) throw new Error('Gateway downstream binding not ready');
}
const domains = await api(`accounts/${account}/workers/domains`);
if (domains.some(domain => ['eastmoney-dashboard', 'eastmoney-data'].includes(domain.service))) throw new Error('Remove reviewed backend Custom Domains before cutover');
for (const worker of ['eastmoney-dashboard', 'eastmoney-data']) {
  await api(`accounts/${account}/workers/scripts/${worker}/subdomain`, 'POST', { enabled: false, previews_enabled: false });
}
const site = routes.find(route => route.pattern === hostname + '/*');
if (site) await api(`${routesPath}/${site.id}`, 'PUT', { pattern: hostname + '/*', script: 'eastmoney-gateway', request_limit_fail_open: false });
else await api(routesPath, 'POST', { pattern: hostname + '/*', script: 'eastmoney-gateway', request_limit_fail_open: false });
for (const route of routes.filter(route => route.pattern === hostname + '/data*')) await api(`${routesPath}/${route.id}`, 'DELETE');
// All routing now goes through Gateway. This removes only the reviewed site application.
if (app) await api(`${appsPath}/${appId}`, 'DELETE', undefined, true);
const after = (await api(routesPath)).filter(route => route.pattern.includes(hostname));
if (after.length !== 1 || after[0].script !== 'eastmoney-gateway' || after[0].pattern !== hostname + '/*' || after[0].request_limit_fail_open) throw new Error('Site route readback failed');
if ((await api(appsPath, 'GET', undefined, true)).some(app => app.id === appId)) throw new Error('Access application still present');
for (const worker of ['eastmoney-dashboard', 'eastmoney-data']) {
  const subdomain = await api(`accounts/${account}/workers/scripts/${worker}/subdomain`);
  if (subdomain.enabled || subdomain.previews_enabled) throw new Error('Backend public URL is still enabled');
}
console.log(JSON.stringify({ cutover: true, route: hostname + '/*', gateway: 'eastmoney-gateway', accessApplicationRemoved: true, backendPublicUrlsDisabled: true }));
