// Run through cloudflare-task-session.py; task credential comes only from its
// child environment. Auth0's MCP client secret remains in memory throughout.
import { management } from './lib/auth0-management.mjs';
import { addChatGptRedirectUris } from './lib/mcp-client-redirects.mjs';
import { isDeepStrictEqual } from 'node:util';
const account = '5cecc63c78acf8f5473f8745f4244448';
const zone = 'e0665efd9fd68d06cbb9ab68a13cc7c6';
const clientId = 'M1a5PF3UJaFIZv1k4HO4IV06Z5fXQBHV';
const organizationId = 'org_6yvoRRCkzk3eGkBS';
const origin = 'https://mcp.hasbai.xyz';
const apiOrigin = 'https://eastmoney.hasbai.xyz';
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) throw new Error('Run with a scoped task token issued from Keychain');
async function api(path, method = 'GET', body) {
  const response = await fetch('https://api.cloudflare.com/client/v4/' + path, { method, redirect: 'error', signal: AbortSignal.timeout(45000),
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok || value.success === false) throw new Error(`Cloudflare ${method} ${path}: ${response.status} ${value.errors?.map(error => error.code).join(',')}`);
  return value.result ?? value;
}
const prefix = `accounts/${account}/access`;
async function configureClientRedirects(id) {
  const app = await api(prefix + '/apps/' + id);
  if (app.type !== 'mcp_portal' || app.domain !== 'mcp.hasbai.xyz') throw new Error('Expected the Eastmoney MCP portal application');
  const oauth = addChatGptRedirectUris(app.oauth_configuration);
  if (!isDeepStrictEqual(oauth, app.oauth_configuration)) {
    // Cloudflare requires preserving the complete existing application on PUT.
    await api(prefix + '/apps/' + id, 'PUT', { ...app, oauth_configuration: oauth });
  }
  const confirmed = await api(prefix + '/apps/' + id);
  if (!isDeepStrictEqual(confirmed.oauth_configuration, oauth)) throw new Error('Portal OAuth configuration readback mismatch');
  console.log(JSON.stringify({ portalApplicationId: id, allowedRedirectUris: oauth.dynamic_client_registration.allowed_uris }));
}
const mode = process.argv[2];
if (mode === 'upstreams') {
  const client = management('get', `clients/${clientId}?fields=client_id,client_secret,name&include_fields=true`);
  if (client.name !== 'eastmoney MCP portal' || !client.client_secret) throw new Error('Expected the dedicated MCP client');
  const providers = await api(prefix + '/identity_providers');
  let provider = providers.find(value => value.name === 'Eastmoney MCP Auth0');
  if (!provider) provider = await api(prefix + '/identity_providers', 'POST', { name: 'Eastmoney MCP Auth0', type: 'oidc', config: {
    client_id: clientId, client_secret: client.client_secret,
    auth_url: 'https://auth.hasbai.xyz/authorize?organization=org_6yvoRRCkzk3eGkBS&connection=eastmoney-email',
    token_url: 'https://auth.hasbai.xyz/oauth/token', certs_url: 'https://auth.hasbai.xyz/.well-known/jwks.json',
    scopes: ['openid', 'profile', 'email'], pkce_enabled: true,
  } });
  const servers = await api(prefix + '/ai-controls/mcp/servers');
  let data = servers.find(value => value.id === 'data');
  if (!data) data = await api(prefix + '/ai-controls/mcp/servers', 'POST', {
    id: 'data', name: 'Eastmoney Data', hostname: apiOrigin + '/data/mcp', auth_type: 'oauth',
    is_shared_oauth_callback_enabled: false, client_secret: client.client_secret,
    auth_credentials: JSON.stringify({ auth_mode: 'manual', config: {
      issuer: 'https://auth.hasbai.xyz/', authorization_endpoint: 'https://auth.hasbai.xyz/authorize?audience=' + encodeURIComponent(apiOrigin + '/') + '&organization=' + organizationId + '&connection=eastmoney-email',
      token_endpoint: 'https://auth.hasbai.xyz/oauth/token', revocation_endpoint: 'https://auth.hasbai.xyz/oauth/revoke', resource: apiOrigin + '/',
    }, registration_info: { client_id: clientId, redirect_uris: [origin + '/servers-callback'], token_endpoint_auth_method: 'client_secret_post', scope: 'openid profile email offline_access' } }),
  });
  console.log(JSON.stringify({ providerId: provider.id, dataServerId: data.id, authenticationStatus: data.authentication_status, status: data.status }));
} else if (mode === 'organization' || mode === 'organization-plan') {
  const provider = (await api(prefix + '/identity_providers')).find(value => value.name === 'Eastmoney MCP Auth0');
  const data = await api(prefix + '/ai-controls/mcp/servers/data');
  if (!provider || provider.config?.client_id !== clientId || data.id !== 'data' || data.hostname !== apiOrigin + '/data/mcp') throw new Error('Unexpected Eastmoney OAuth resources');
  const providerConfig = { ...provider.config };
  const authUrl = new URL(providerConfig.auth_url);
  if (authUrl.origin !== 'https://auth.hasbai.xyz' || authUrl.pathname !== '/authorize') throw new Error('Unexpected provider authorize URL');
  authUrl.searchParams.set('organization', organizationId); providerConfig.auth_url = authUrl.href;
  const summary = data.auth_config_summary;
  const credentials = summary && { auth_mode: summary.auth_mode, config: { ...summary.config }, registration_info: { ...summary.registration_info } };
  if (credentials?.registration_info?.client_id !== clientId || credentials.auth_mode !== 'manual') throw new Error('Unexpected Data manual OAuth credentials');
  const endpoint = new URL(credentials.config.authorization_endpoint);
  if (endpoint.origin !== 'https://auth.hasbai.xyz' || endpoint.pathname !== '/authorize') throw new Error('Unexpected Data authorize URL');
  endpoint.searchParams.set('organization', organizationId); credentials.config.authorization_endpoint = endpoint.href;
  console.log(JSON.stringify({ mode, providerId: provider.id, dataServer: data.id, organization: organizationId, otherProvidersChanged: false }));
  if (mode === 'organization') {
    const client = management('get', `clients/${clientId}?fields=client_id,client_secret,name&include_fields=true`);
    if (!client.client_secret || client.name !== 'eastmoney MCP portal') throw new Error('Expected dedicated MCP client');
    await api(prefix + '/identity_providers/' + provider.id, 'PUT', { name: provider.name, type: provider.type, config: { ...providerConfig, client_secret: client.client_secret } });
    await api(prefix + '/ai-controls/mcp/servers/data', 'PUT', { name: data.name, hostname: data.hostname, auth_type: data.auth_type,
      is_shared_oauth_callback_enabled: data.is_shared_oauth_callback_enabled, client_secret: client.client_secret, auth_credentials: JSON.stringify(credentials) });
    const updatedProvider = await api(prefix + '/identity_providers/' + provider.id);
    const updatedData = await api(prefix + '/ai-controls/mcp/servers/data');
    const updatedCredentials = updatedData.auth_config_summary;
    if (new URL(updatedProvider.config.auth_url).searchParams.get('organization') !== organizationId
      || new URL(updatedCredentials.config.authorization_endpoint).searchParams.get('organization') !== organizationId) throw new Error('MCP organization readback failed');
    console.log(JSON.stringify({ organizationConfigured: true, providerId: provider.id, dataServer: data.id }));
  }
} else if (mode === 'applications') {
  const provider = (await api(prefix + '/identity_providers')).find(value => value.name === 'Eastmoney MCP Auth0');
  if (!provider) throw new Error('Dedicated provider missing');
  const apps = await api(prefix + '/apps');
  const config = { allowed_idps: [provider.id], auto_redirect_to_identity: true, session_duration: '24h', http_only_cookie_attribute: true,
    policies: [{ name: 'Eastmoney 18.cn users', decision: 'allow', include: [{ email_domain: { domain: '18.cn' } }], require: [{ login_method: { id: provider.id } }], exclude: [] }] };
  for (const [id, name] of [['data', 'Eastmoney Data MCP'], ['research', 'Eastmoney Research MCP']]) {
    let app = apps.find(value => value.name === name);
    if (!app) app = await api(prefix + '/apps', 'POST', { ...config, name, type: 'mcp', destinations: [{ type: 'via_mcp_server_portal', mcp_server_id: id }] });
    console.log(JSON.stringify({ application: name, id: app.id, type: app.type }));
  }
  let portalApp = apps.find(value => value.domain === 'mcp.hasbai.xyz');
  if (!portalApp) portalApp = await api(prefix + '/apps', 'POST', { ...config, name: 'Eastmoney MCP Portal', type: 'mcp_portal', domain: 'mcp.hasbai.xyz',
    destinations: [{ type: 'public', uri: 'mcp.hasbai.xyz' }], oauth_configuration: addChatGptRedirectUris({ enabled: true, dynamic_client_registration: { enabled: true, allow_any_on_localhost: true, allow_any_on_loopback: true }, grant: { access_token_lifetime: '15m', session_duration: '336h' } }) });
  await configureClientRedirects(portalApp.id);
  const portal = await api(prefix + '/ai-controls/mcp/portals/eastmoney');
  await api(prefix + '/ai-controls/mcp/portals/eastmoney', 'PUT', { name: portal.name, hostname: portal.hostname, description: portal.description, code_mode: 'off', secure_web_gateway: false,
    servers: [{ server_id: 'data', on_behalf: true, default_disabled: false }, { server_id: 'research', on_behalf: false, default_disabled: false }] });
  const records = await api(`zones/${zone}/dns_records?name=mcp.hasbai.xyz`);
  if (records.length && !records.every(record => record.type === 'CNAME' && record.content === 'gateway.agents.cloudflare.com' && record.proxied)) throw new Error('Conflicting portal DNS; inspect before changing');
  if (!records.length) await api(`zones/${zone}/dns_records`, 'POST', { type: 'CNAME', name: 'mcp.hasbai.xyz', content: 'gateway.agents.cloudflare.com', proxied: true, ttl: 1 });
  console.log(JSON.stringify({ portalApplicationId: portalApp.id, endpoint: origin + '/mcp', dataOnBehalf: true, dnsReady: true }));
} else if (mode === 'client-redirects') {
  const app = (await api(prefix + '/apps')).find(value => value.domain === 'mcp.hasbai.xyz');
  if (!app) throw new Error('MCP portal application missing');
  await configureClientRedirects(app.id);
} else throw new Error('Expected upstreams, applications, client-redirects, organization-plan or organization');
