import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRemoteJWKSet, customFetch } from 'jose';
import { SessionCookies, parseLoginPage, readAuthTestConfig, boundedText } from './lib/programmatic-login.mjs';
import { verifyToken, userClaims } from '../src/tokens.ts';
import { mcpClientIds, mcpIdentityClaim } from '../src/mcp-auth.ts';

const site = 'https://eastmoney.hasbai.xyz', auth = 'https://auth.hasbai.xyz';
const config = await readAuthTestConfig();
const cookies = new SessionCookies();
const codexRedirect = 'http://127.0.0.1:53682/callback';
const chatgptRedirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
const clientId = process.env.MCP_OAUTH_CLIENT_ID ?? mcpClientIds[1];
const clientRedirect = process.env.MCP_OAUTH_REDIRECT_URI ?? codexRedirect;
assert.ok(mcpClientIds.includes(clientId), 'Use a registered MCP client');
const errorRedirect = clientId !== 'https://opencode.ai/oauth/opencode/client.json';
const callback = new URL(clientRedirect);
assert.ok(['127.0.0.1', 'localhost'].includes(callback.hostname) && callback.protocol === 'http:' && !callback.username && !callback.password);

// Never fetch client callbacks. Credentials and cookies stay on the Auth0 origin.
async function request(target, options = {}) {
  let url = new URL(target), method = options.method ?? 'GET', body = options.body;
  for (let hop = 0; hop < 16; hop++) {
    if (url.origin !== auth) {
      assert.ok([clientRedirect, chatgptRedirect].some(callback => url.origin + url.pathname === callback));
      return { url, status: 302, text: '' };
    }
    const headers = new Headers({ Accept: 'text/html', Cookie: cookies.header(url) });
    if (body) { headers.set('Content-Type', 'application/x-www-form-urlencoded'); headers.set('Origin', auth); }
    const response = await fetch(url, { method, body, headers, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    cookies.update(response.headers, url);
    if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
      assert.ok(!body || ![307, 308].includes(response.status), 'Credential replay refused');
      url = new URL(response.headers.get('location'), url); await response.body?.cancel(); method = 'GET'; body = undefined; continue;
    }
    return { url, status: response.status, text: await boundedText(response) };
  }
  throw Error('OAuth redirect limit');
}
const metadataResponse = await fetch(site + '/.well-known/oauth-protected-resource/mcp');
assert.equal(metadataResponse.status, 200);
const metadata = await metadataResponse.json();
assert.equal(metadata.authorization_servers[0], auth + '/'); assert.equal(metadata.resource, site + '/');
const discovery = await fetch(auth + '/.well-known/openid-configuration').then(response => response.json());
assert.equal(discovery.issuer, auth + '/');
assert.equal(discovery.client_id_metadata_document_supported, true);
assert.equal(discovery.authorization_response_iss_parameter_supported, true);
assert.ok(discovery.code_challenge_methods_supported.includes('S256'));

let passwordSent = false;
async function authorize(client, redirect, extra = {}) {
  const state = crypto.randomUUID();
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
  const url = new URL(discovery.authorization_endpoint);
  url.search = new URLSearchParams({ client_id: client, redirect_uri: redirect, response_type: 'code', resource: metadata.resource,
    scope: metadata.scopes_supported.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256', ...extra }).toString();
  let response = await request(url);
  for (let step = 0; step < 12 && response.url.origin === auth; step++) {
    assert.equal(response.status, 200, `OAuth rejected at ${response.url.pathname}`);
    const path = response.url.pathname;
    assert.ok(['/u/login/identifier', '/u/login/password', '/u/login', '/u/consent', '/u/organization-picker', '/u/organization', '/u/login/organization'].includes(path), `Unsupported OAuth step ${path}`);
    const form = parseLoginPage(response.text).forms.find(form => form.method?.toUpperCase() === 'POST'); assert.ok(form);
    const values = new URLSearchParams(form.controls.filter(control => control.name && !['checkbox', 'radio'].includes(control.type)).map(control => [control.name, control.value ?? '']));
    if (values.has('password')) { assert.equal(passwordSent, false, 'Password retries refused'); values.set('password', config.password); passwordSent = true; }
    if (values.has('username')) values.set('username', config.email);
    if (path === '/u/consent') values.set('action', 'accept');
    const target = new URL(form.action ?? '', response.url); assert.equal(target.origin, auth);
    response = await request(target, { method: 'POST', body: values.toString() });
  }
  assert.equal(response.url.origin + response.url.pathname, redirect);
  assert.equal(response.url.searchParams.get('state'), state);
  assert.equal(response.url.searchParams.get('iss'), discovery.issuer);
  return { callback: response.url.searchParams, verifier };
}
// The error callback must identify the issuer too; this request sends no credentials.
// Existing trusted clients return issuer-bearing errors; OpenCode retains
// Auth0's default open redirect protection. Success always checks issuer/state.
if (errorRedirect) {
  const errorFlow = await authorize(clientId, clientRedirect, { prompt: 'none' });
  assert.equal(errorFlow.callback.get('error'), 'login_required');
}
const flow = await authorize(clientId, clientRedirect);
assert.ok(!flow.callback.has('error')); assert.ok(flow.callback.get('code'));
async function exchange(values) {
  const response = await request(discovery.token_endpoint, { method: 'POST', body: new URLSearchParams(values).toString() });
  assert.equal(response.status, 200, 'OAuth token exchange failed'); return JSON.parse(response.text);
}
const tokens = await exchange({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: clientRedirect,
  resource: metadata.resource, code: flow.callback.get('code'), code_verifier: flow.verifier });
const env = { AUTH0_LOGIN_DOMAIN: 'auth.hasbai.xyz', AUTH0_AUDIENCE: site + '/', AUTH0_CLIENT_ID: '16vMxoYpr5AdPRiW1PkwIiHuRWszii6m',
  AUTH0_ORGANIZATION_ID: 'org_6yvoRRCkzk3eGkBS', AUTH0_MACHINE_CLIENT_IDS: '' };
const keys = createRemoteJWKSet(new URL(discovery.jwks_uri), { [customFetch]: fetch });
async function checkIdentity(token) {
  const payload = await verifyToken(token, env, 'access', keys); assert.equal(payload.azp, clientId);
  assert.equal(userClaims(payload[mcpIdentityClaim]).email, config.email); return payload;
}
await checkIdentity(tokens.access_token); assert.ok(tokens.refresh_token);
async function rpc(token, method, params = {}) {
  const response = await fetch(site + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60000) });
  assert.equal(response.status, 200, 'MCP request failed'); const raw = await response.text();
  const value = response.headers.get('Content-Type')?.includes('text/event-stream')
    ? raw.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).find(value => value.id === 1) : JSON.parse(raw);
  assert.ok(!value.error); return value.result;
}
const tools = await rpc(tokens.access_token, 'tools/list'); assert.equal(tools.tools.length, 39);
assert.equal((await rpc(tokens.access_token, 'tools/call', { name: 'choice_css', arguments: {} })).isError, true);
for (const path of ['/api/profile', '/data/choice/css']) {
  const response = await fetch(site + path, { headers: { Authorization: 'Bearer ' + tokens.access_token } });
  assert.equal(response.status, 403, path); await response.body?.cancel();
}
for (const path of ['/api/mcp', '/data/mcp']) {
  const response = await fetch(site + path); assert.equal(response.status, 410, path); await response.body?.cancel();
}
const refreshed = await exchange({ grant_type: 'refresh_token', client_id: clientId, resource: metadata.resource, refresh_token: tokens.refresh_token });
assert.ok(refreshed.refresh_token); assert.notEqual(refreshed.refresh_token, tokens.refresh_token);
await checkIdentity(refreshed.access_token); assert.equal((await rpc(refreshed.access_token, 'tools/list')).tools.length, 39);
console.log({ clientId, pkce: true, signedIdentity: true, refreshRotation: true, tools: tools.tools.length, ordinaryRestAndDataRejected: true, invalidChoiceRejected: true, retiredEndpoints: true });
for (const name of ['commentaries', 'credit_report', 'chinamoney_shibor', 'cfets', 'trading_days']) {
  const result = await rpc(tokens.access_token, 'tools/call', { name, arguments: {} });
  assert.ok(!result.isError, `${name} read failed`);
}
const researchTool = tools.tools.find(tool => tool.name === 'research_search');
assert.equal(researchTool?.annotations?.readOnlyHint, true);
const researchEnd = Math.floor((Date.now() + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000 + 86400000;
const researchQuery = { body: { query: '资金面 流动性 利率债 货币政策', ai_search_options: { retrieval: { retrieval_type: 'hybrid', max_num_results: 50, filters: { type: { $eq: '研报' }, published_at: { $gte: researchEnd - 7 * 86400000, $lt: researchEnd } } } } } };
const researchResult = await rpc(tokens.access_token, 'tools/call', { name: 'research_search', arguments: researchQuery });
assert.ok(!researchResult.isError, 'research_search failed');
const researchData = researchResult.structuredContent.data;
assert.equal(researchData.success, true);
assert.ok(researchData.result.chunks.length > 0, 'research_search returned no evidence');
for (const chunk of researchData.result.chunks) {
  assert.equal(chunk.item.metadata.type, '研报');
  assert.ok(Number(chunk.item.metadata.published_at) >= researchEnd - 7 * 86400000 && Number(chunk.item.metadata.published_at) < researchEnd, 'research chunk outside hard date range');
  assert.ok(chunk.scoring_details, 'research scoring missing');
}
assert.ok(researchData.result.hybrid_meta, 'hybrid metadata missing');
console.log({ researchSearch: true, chunks: researchData.result.chunks.length, typeAndDateHardFilters: true, rawScoringAndHybridMetadata: true });
const ledgerDates = await rpc(tokens.access_token, 'tools/call', { name: 'bond_ledger', arguments: {} });
assert.ok(!ledgerDates.isError, 'bond_ledger dates read failed');
const inventoryFetchedAt = new Date().toISOString();
const dates = ledgerDates.structuredContent.data;
const asOf = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const start = asOf.slice(0, 4) + '-01-01';
const eligibleDates = dates.databaseDates.filter(date => date >= start && date <= asOf).sort();
const ledgerQuery = { start, end: eligibleDates.at(-1) ?? asOf };
const ledgerReport = await rpc(tokens.access_token, 'tools/call', { name: 'bond_ledger', arguments: { query: ledgerQuery } });
assert.ok(!ledgerReport.isError, 'bond_ledger report read failed');
const reportFetchedAt = new Date().toISOString();
assert.equal(ledgerReport.structuredContent.data.hasData, eligibleDates.length > 0);
if (process.env.MCP_EVIDENCE_DIR) {
  await mkdir(process.env.MCP_EVIDENCE_DIR, { recursive: true });
  for (const [name, value] of Object.entries({ 'research-search': researchResult, 'research-query': researchQuery, 'tools-list': tools, 'bond-ledger-dates': ledgerDates, 'bond-ledger-report': ledgerReport,
    metadata: { verifiedAt: new Date().toISOString(), endpoint: site + '/mcp', asOf, inventory: { fetchedAt: inventoryFetchedAt, query: {} }, report: { fetchedAt: reportFetchedAt, query: ledgerQuery } } })) {
    await writeFile(join(process.env.MCP_EVIDENCE_DIR, name + '.json'), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  }
}
// Auth0 can authorize ChatGPT's real metadata and exact callback. Its private-key
// assertion is held by ChatGPT, so the host must perform that final exchange.
const chatgpt = await authorize(mcpClientIds[0], chatgptRedirect);
assert.ok(!chatgpt.callback.has('error')); assert.ok(chatgpt.callback.get('code'));
console.log({ discovery: true, cimd: true, clientId, issuerSuccess: true, issuerError: errorRedirect, pkce: true, signedIdentity: true, refreshRotation: true,
  tools: tools.tools.length, commentaryRead: true, maskedCreditRead: true, bondLedgerRead: true, bondLedgerQuery: ledgerQuery, dataRead: true, dmRead: true, choiceCalendarRead: true, invalidChoiceRejected: true, retiredEndpoints: true, ordinaryRestAndDataRejected: true,
  chatgptAuthorization: true, chatgptPrivateKeyExchange: 'requires ChatGPT host', browserUsed: false });
