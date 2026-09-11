import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.resolve('auth0-deploy-cli'));
const yaml = require('js-yaml');
const before = yaml.load(await readFile(new URL('../.auth0-deploy/gateway-before/tenant.yaml', import.meta.url), 'utf8'));
const login = before.clients.find(client => client.name === 'eastmoney');
if (!login || login.app_type !== 'regular_web') throw new Error('Expected the exported existing web application');
const origin = 'https://eastmoney.hasbai.xyz';
const callbacks = [...new Set([...login.callbacks, origin + '/auth/callback'])];
const config = {
  clients: [{ ...login, callbacks }, { name: 'eastmoney quant gateway', app_type: 'non_interactive', grant_types: ['client_credentials'], token_endpoint_auth_method: 'client_secret_post', is_first_party: true, jwt_configuration: { alg: 'RS256' } }],
  resourceServers: [{ name: 'eastmoney gateway', identifier: origin + '/', signing_alg: 'RS256', token_lifetime: 86400, token_lifetime_for_web: 86400,
    allow_offline_access: false, skip_consent_for_verifiable_first_party_clients: true, enforce_policies: false, token_dialect: 'access_token', scopes: [{ value: 'data.choice:read', description: 'Read generic Choice data through the Gateway' }] }],
  clientGrants: [{ client_id: 'eastmoney quant gateway', audience: origin + '/', scope: ['data.choice:read'], subject_type: 'client' }],
};
for (const client of config.clients) { delete client.created_at; delete client.updated_at; }
await writeFile(new URL('../.auth0-deploy/gateway-tenant.yaml', import.meta.url), yaml.dump(config), { mode: 0o600 });
console.log(JSON.stringify({ clients: config.clients.map(c => c.name), callbackAdded: origin + '/auth/callback', audience: origin + '/', machineScopes: ['data.choice:read'], existingCallbacksPreserved: true }));
