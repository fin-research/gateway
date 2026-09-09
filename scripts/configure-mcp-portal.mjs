// Run through cloudflare-task-session.py; task credential comes only from its
// child environment. Auth0's MCP client secret remains in memory throughout.
import { management } from './lib/auth0-management.mjs';
const account = '5cecc63c78acf8f5473f8745f4244448';
const zone = 'e0665efd9fd68d06cbb9ab68a13cc7c6';
const clientId = 'M1a5PF3UJaFIZv1k4HO4IV06Z5fXQBHV';
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
const mode = process.argv[2];
if (mode === 'upstreams') {
  const client = management('get', `clients/${clientId}?fields=client_id,client_secret,name&include_fields=true`);
  if (client.name !== 'eastmoney MCP portal' || !client.client_secret) throw new Error('Expected the dedicated MCP client');
  const providers = await api(prefix + '/identity_providers');
  let provider = providers.find(value => value.name === 'Eastmoney MCP Auth0');
  if (!provider) provider = await api(prefix + '/identity_providers', 'POST', { name: 'Eastmoney MCP Auth0', type: 'oidc', config: {
    client_id: clientId, client_secret: client.client_secret,
    auth_url: 'https://auth.hasbai.xyz/authorize?connection=eastmoney-email',
    token_url: 'https://auth.hasbai.xyz/oauth/token', certs_url: 'https://auth.hasbai.xyz/.well-known/jwks.json',
    scopes: ['openid', 'profile', 'email'], pkce_enabled: true,
  } });
  const servers = await api(prefix + '/ai-controls/mcp/servers');
  let data = servers.find(value => value.id === 'data');
  if (!data) data = await api(prefix + '/ai-controls/mcp/servers', 'POST', {
    id: 'data', name: 'Eastmoney Data', hostname: apiOrigin + '/data/mcp', auth_type: 'oauth',
    is_shared_oauth_callback_enabled: false, client_secret: client.client_secret,
    auth_credentials: JSON.stringify({ auth_mode: 'manual', config: {
      issuer: 'https://auth.hasbai.xyz/', authorization_endpoint: 'https://auth.hasbai.xyz/authorize?audience=' + encodeURIComponent(apiOrigin + '/') + '&connection=eastmoney-email',
      token_endpoint: 'https://auth.hasbai.xyz/oauth/token', revocation_endpoint: 'https://auth.hasbai.xyz/oauth/revoke', resource: apiOrigin + '/',
    }, registration_info: { client_id: clientId, redirect_uris: [origin + '/servers-callback'], token_endpoint_auth_method: 'client_secret_post', scope: 'openid profile email offline_access' } }),
  });
  console.log(JSON.stringify({ providerId: provider.id, dataServerId: data.id, authenticationStatus: data.authentication_status, status: data.status }));
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
    destinations: [{ type: 'public', uri: 'mcp.hasbai.xyz' }], oauth_configuration: { enabled: true, dynamic_client_registration: { enabled: true, allow_any_on_localhost: true, allow_any_on_loopback: true }, grant: { access_token_lifetime: '15m', session_duration: '336h' } } });
  const portal = await api(prefix + '/ai-controls/mcp/portals/eastmoney');
  await api(prefix + '/ai-controls/mcp/portals/eastmoney', 'PUT', { name: portal.name, hostname: portal.hostname, description: portal.description, code_mode: 'off', secure_web_gateway: false,
    servers: [{ server_id: 'data', on_behalf: true, default_disabled: false }, { server_id: 'research', on_behalf: false, default_disabled: false }] });
  const records = await api(`zones/${zone}/dns_records?name=mcp.hasbai.xyz`);
  if (records.length && !records.every(record => record.type === 'CNAME' && record.content === 'gateway.agents.cloudflare.com' && record.proxied)) throw new Error('Conflicting portal DNS; inspect before changing');
  if (!records.length) await api(`zones/${zone}/dns_records`, 'POST', { type: 'CNAME', name: 'mcp.hasbai.xyz', content: 'gateway.agents.cloudflare.com', proxied: true, ttl: 1 });
  console.log(JSON.stringify({ portalApplicationId: portalApp.id, endpoint: origin + '/mcp', dataOnBehalf: true, dnsReady: true }));
} else throw new Error('Expected upstreams or applications');
