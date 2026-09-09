import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { SessionCookies, parseLoginPage, boundedText, readAuthTestConfig } from './lib/programmatic-login.mjs';

const portal = 'https://mcp.hasbai.xyz';
const team = 'https://hasbai.cloudflareaccess.com';
const auth = 'https://auth.hasbai.xyz';
const callback = 'http://127.0.0.1:8768/callback';
const origins = new Set([portal, team, auth, 'https://eastmoney.hasbai.xyz']);
const cookies = new SessionCookies();
const config = await readAuthTestConfig();
let passwordSent = false;

function checked(value, base) {
  const url = new URL(value, base);
  if (url.href.startsWith(callback + '?')) return url;
  if (!origins.has(url.origin) || url.username || url.password) throw new Error('Untrusted OAuth destination');
  return url;
}
function pageSummary(url, html) {
  const page = parseLoginPage(html);
  return { origin: url.origin, path: url.pathname,
    title: html.match(/<title>([^<]*)<\/title>/)?.[1],
    links: page.links.map(link => { const target = new URL(link, url); return { origin: target.origin, path: target.pathname, queryKeys: [...target.searchParams.keys()] }; }),
    scriptSources: [...html.matchAll(/<script[^>]*src=["']([^"']+)/g)].map(match => new URL(match[1], url).pathname),
    forms: page.forms.map(form => ({ action: new URL(form.action || '', url).pathname, method: form.method,
      controls: form.controls.map(control => ({ name: control.name, type: control.type, ...(control.type === 'submit' || control.name === 'action' ? { value: control.value } : {}) })) })),
  };
}

function portalBootstrap(html) {
  const marker = 'window.__MCP_PORTAL_BOOTSTRAP__';
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const value = html.slice(html.indexOf('=', start) + 1).split('</script>')[0].trim().replace(/;$/, '');
  try { return JSON.parse(value); } catch { throw new Error('Unsupported portal bootstrap encoding'); }
}

async function follow(start, stopOnServerCallback = false) {
  let url = checked(start), body, method = 'GET';
  for (let step = 0; step < 25; step++) {
    if (url.origin === new URL(callback).origin && url.pathname === '/callback') return url;
    if (stopOnServerCallback && url.origin === portal && url.pathname === '/servers-callback' && url.searchParams.has('code')) return url;
    const headers = new Headers({ Accept: 'text/html', Cookie: cookies.header(url) });
    if (body !== undefined) { headers.set('Content-Type', 'application/x-www-form-urlencoded'); headers.set('Origin', url.origin); }
    const response = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    cookies.update(response.headers, url);
    const location = response.headers.get('Location');
    if (location && response.status >= 300 && response.status < 400) {
      if (body !== undefined && [307, 308].includes(response.status)) throw new Error('Refusing to replay OAuth form');
      await response.body?.cancel(); url = checked(location, url); method = 'GET'; body = undefined; continue;
    }
    const html = await boundedText(response);
    if (response.status !== 200) throw new Error(`OAuth ${url.origin}${url.pathname}: HTTP ${response.status}`);
    const page = parseLoginPage(html);
    if (url.origin === portal) {
      const bootstrap = portalBootstrap(html);
      if (bootstrap) {
        console.log(JSON.stringify({ portalPicker: { keys: Object.keys(bootstrap), servers: bootstrap.servers?.map(server => ({ id: server.id, name: server.name, status: server.status, hasAuthorizeUrl: Boolean(server.authorizeUrl || server.authorize_url) })), hiddenFieldNames: Object.keys(bootstrap.hiddenFields || {}) } }));
        for (let poll = 0; poll < 6 && bootstrap.servers.some(server => ['connecting', 'pending'].includes(server.status)); poll++) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          const connect = checked(bootstrap.serverConnectAction, url);
          connect.searchParams.set('state', Buffer.from(JSON.stringify({ as: bootstrap.authSessionId })).toString('base64url'));
          const status = await fetch(connect, { headers: { Cookie: cookies.header(connect), Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(30000) });
          if (!status.ok) throw new Error('Portal connection poll failed');
          const result = await status.json(); if (Array.isArray(result.servers)) bootstrap.servers = result.servers;
        }
        console.log(JSON.stringify({ connectionResults: bootstrap.servers.map(server => ({ id: server.id, status: server.status, detail: String(server.errorDetail || server.error_detail || '').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/https?:\/\/[^\s?]+\?[^\s]*/g, '[URL query redacted]').slice(0, 400) })) }));
        const needsAuth = bootstrap.servers?.find(server => server.id === 'data' && server.status === 'needs_auth' && (server.authorizeUrl || server.authorize_url));
        if (needsAuth) { url = checked(needsAuth.authorizeUrl || needsAuth.authorize_url, url); method = 'GET'; body = undefined; continue; }
        if (['data', 'research'].every(id => bootstrap.servers.some(server => server.id === id && server.status === 'connected'))) {
          const values = new URLSearchParams(Object.entries(bootstrap.hiddenFields || {}).map(([name, value]) => [name, String(value)]));
          for (const id of ['data', 'research']) values.append('servers', id);
          values.set('state', Buffer.from(JSON.stringify({ as: bootstrap.authSessionId })).toString('base64url'));
          url = checked(bootstrap.finishAction, url); method = 'POST'; body = values.toString(); continue;
        }
      }
    }
    if (url.origin === team && url.pathname.startsWith('/cdn-cgi/access/login/')) {
      const providerLink = page.links.find(link => {
        const candidate = new URL(link, url);
        return candidate.origin === auth && candidate.pathname === '/authorize' && candidate.searchParams.get('client_id') === 'M1a5PF3UJaFIZv1k4HO4IV06Z5fXQBHV';
      });
      if (providerLink) { url = checked(providerLink, url); method = 'GET'; body = undefined; continue; }
    }
    const form = page.forms.find(form => form.controls.some(control => ['username', 'password'].includes(control.name)));
    if (url.origin === auth && url.pathname === '/u/consent') {
      const consent = page.forms.find(form => form.method?.toUpperCase() === 'POST' && form.controls.some(control => control.name === 'action' && control.value === 'accept'));
      if (consent) {
        const target = checked(consent.action || '', url);
        if (target.origin !== auth || target.pathname !== '/u/consent') throw new Error('Unexpected consent target');
        const values = new URLSearchParams(consent.controls.filter(control => control.name && control.name !== 'action').map(control => [control.name, control.value || '']));
        console.log(JSON.stringify({ upstreamConsent: true, siteAudience: values.get('audience') === 'https://eastmoney.hasbai.xyz/' }));
        values.set('action', 'accept'); url = target; method = 'POST'; body = values.toString(); continue;
      }
    }
    if (url.origin === auth && ['/u/login/identifier', '/u/login/password', '/u/login'].includes(url.pathname) && form) {
      const next = checked(form.action || '', url);
      if (next.origin !== auth || form.method?.toUpperCase() !== 'POST') throw new Error('Unsafe login form');
      const values = new URLSearchParams(form.controls.filter(control => control.name && !['checkbox', 'radio'].includes(control.type)).map(control => [control.name, control.value || '']));
      values.set('username', config.email);
      if (values.has('password')) {
        if (passwordSent) throw new Error('Password retry prohibited');
        passwordSent = true; values.set('password', config.password);
      }
      url = next; body = values.toString(); method = 'POST'; continue;
    }
    console.log(JSON.stringify({ pendingOAuthPage: pageSummary(url, html) }));
    throw new Error('OAuth needs an unhandled programmatic step');
  }
  throw new Error('OAuth redirect limit');
}

async function rpc(endpoint, token, method, params, id = 1, sessionId) {
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }),
  });
  const text = await boundedText(response);
  const message = response.headers.get('Content-Type')?.includes('text/event-stream')
    ? text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).find(value => value.id === id)
    : text ? JSON.parse(text) : undefined;
  if (response.status !== 200 || message?.error) throw new Error(`MCP ${method}: HTTP ${response.status}, RPC ${message?.error?.code ?? 'none'}`);
  return { result: message?.result, sessionId: response.headers.get('Mcp-Session-Id') || sessionId };
}

try {
  if (process.argv.includes('--data-only')) {
    const { management } = await import('./lib/auth0-management.mjs');
    const client = management('get', 'clients/M1a5PF3UJaFIZv1k4HO4IV06Z5fXQBHV?fields=client_id,client_secret&include_fields=true');
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
    const authorize = new URL(auth + '/authorize');
    authorize.search = new URLSearchParams({ client_id: client.client_id, response_type: 'code', redirect_uri: portal + '/servers-callback', audience: 'https://eastmoney.hasbai.xyz/', scope: 'openid profile email offline_access', connection: 'eastmoney-email', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
    const returned = await follow(authorize, true);
    if (returned.searchParams.get('state') !== state) throw new Error('Data OAuth state mismatch');
    const exchange = await fetch(auth + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', client_id: client.client_id, client_secret: client.client_secret, redirect_uri: portal + '/servers-callback', code_verifier: verifier, code: returned.searchParams.get('code') }) });
    if (!exchange.ok) throw new Error('Data OAuth exchange failed: ' + exchange.status);
    const tokens = await exchange.json();
    const response = await fetch('https://eastmoney.hasbai.xyz/data/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + tokens.access_token, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    const value = await response.json();
    console.log(JSON.stringify({ dataClientOAuth: true, status: response.status, tools: value.result?.tools?.length, detail: value.detail, code: value.code }));
    process.exitCode = response.status === 200 ? 0 : 1;
  } else {
  const metadata = await fetch(team + '/.well-known/oauth-authorization-server').then(response => response.json());
  let client;
  try { client = JSON.parse(await readFile('.ops/mcp-public-client.json', 'utf8')); } catch { /* create public client metadata once */ }
  if (!client?.client_id || client.callback !== callback) {
    const registration = await fetch(metadata.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Eastmoney programmatic MCP verification', redirect_uris: [callback], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
    if (!registration.ok) throw new Error('Portal OAuth client registration failed: ' + registration.status);
    const result = await registration.json(); client = { client_id: result.client_id, callback };
    await mkdir('.ops', { recursive: true, mode: 0o700 });
    await writeFile('.ops/mcp-public-client.json', JSON.stringify(client), { mode: 0o600 });
  }
  const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
  const authorize = checked(metadata.authorization_endpoint);
  authorize.search = new URLSearchParams({ client_id: client.client_id, response_type: 'code', redirect_uri: callback, resource: portal + '/mcp', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state }).toString();
  const returned = await follow(authorize);
  if (returned.searchParams.get('state') !== state || !returned.searchParams.get('code')) throw new Error('OAuth callback state/code failed');
  const exchange = await fetch(metadata.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code_verifier: verifier, redirect_uri: callback, code: returned.searchParams.get('code'), resource: portal + '/mcp' }).toString() });
  if (!exchange.ok) throw new Error('Portal OAuth code exchange failed: ' + exchange.status);
  const tokens = await exchange.json();
  const initial = await rpc(portal + '/mcp', tokens.access_token, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'eastmoney-verification', version: '1' } });
  const list = await rpc(portal + '/mcp', tokens.access_token, 'tools/list', {}, 2, initial.sessionId);
  const names = list.result?.tools?.map(tool => tool.name) || [];
  console.log(JSON.stringify({ managedOAuth: true, identity: config.email, server: initial.result?.serverInfo, tools: names }));
  if (!names.includes('data_health') || !names.includes('research_search')) throw new Error('Both upstream catalogs must be available');
  const health = await rpc(portal + '/mcp', tokens.access_token, 'tools/call', { name: 'data_health', arguments: {} }, 3, list.sessionId);
  if (health.result?.isError) throw new Error('Managed Data tool failed');
  const healthData = health.result?.structuredContent?.data ?? JSON.parse(health.result?.content?.find(item => item.type === 'text')?.text || 'null');
  if (healthData?.status !== 'ok') throw new Error('Managed Data health response mismatch');
  const day = 86400000, offset = 8 * 3600000, start = Math.floor((Date.now() + offset) / day) * day - offset;
  const search = await rpc(portal + '/mcp', tokens.access_token, 'tools/call', { name: 'research_search', arguments: { query: '债券发行', ai_search_options: { retrieval: { max_num_results: 50, metadata_only: true, filters: { published_at: { $gte: start - 6 * day, $lte: start + day - 1 } } } } } }, 4, list.sessionId);
  if (search.result?.isError || !Array.isArray(search.result?.content) || !search.result.content.length) throw new Error('Managed research tool failed');
  console.log(JSON.stringify({ managedToolsVerified: true, dataHealth: healthData.status, researchSearch: true, browserUsed: false }));
  }
} catch (error) {
  console.error(JSON.stringify({ managedOAuth: false, browserUsed: false, message: error.message })); process.exitCode = 1;
}
