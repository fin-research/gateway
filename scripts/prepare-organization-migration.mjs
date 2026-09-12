import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const yaml = createRequire(import.meta.resolve('auth0-deploy-cli'))('js-yaml');
const before = yaml.load(await readFile('.auth0-deploy/organization-before/tenant.yaml', 'utf8'));
const orgId = 'org_6yvoRRCkzk3eGkBS';
const loginNames = ['eastmoney', 'eastmoney MCP portal'];
const descriptions = {
  eastmoney: 'Eastmoney website: organization-bound authorization code + PKCE login.',
  'eastmoney MCP portal': 'Eastmoney MCP portal: per-user OAuth for Cloudflare Access and Data MCP only.',
  'eastmoney identity management': 'Eastmoney Gateway: account profiles and organization directory. No runtime role or user creation.',
  'eastmoney signup profile': 'Eastmoney hosted signup Form: save the registering user profile only.',
  'eastmoney-login-roles': 'Eastmoney login Action: read-only role catalogue for signed organization role claims.',
  'eastmoney quant gateway': 'Eastmoney Quant: dedicated machine credential (tenant plan has no M2M Organizations); data.choice:read only.',
  'eastmoney dashboard profile': 'RETIRED 2026-09-12: replaced by Gateway identity management; grants and OAuth flows disabled. Retained for reversible rollback.',
};
const clients = before.clients.filter(c => c.name in descriptions).map(c => {
  const next = { ...c, description: descriptions[c.name], client_metadata: { ...c.client_metadata, owner: 'eastmoney', lifecycle: c.name === 'eastmoney dashboard profile' ? 'retired' : 'active' } };
  delete next.created_at; delete next.updated_at;
  if (loginNames.includes(c.name)) Object.assign(next, { organization_usage: 'allow', organization_require_behavior: 'no_prompt' });
  if (c.name === 'eastmoney dashboard profile') next.grant_types = [];
  return next;
});
if (clients.length !== 7) throw new Error('Unexpected Eastmoney application inventory');
const clientGrants = before.clientGrants.filter(g => ['eastmoney identity management', 'eastmoney dashboard profile'].includes(g.client_id)).map(g => {
  if (g.client_id === 'eastmoney identity management') return { ...g, scope: ['read:users', 'update:users', 'read:roles', 'read:organization_members', 'read:organization_member_roles'] };
  if (g.client_id === 'eastmoney dashboard profile') return { ...g, scope: [] };
  throw new Error('Unexpected managed grant');
});
const eastmoney = before.organizations.find(o => o.name === 'eastmoney');
if (!eastmoney || eastmoney.connections.length || eastmoney.clients.length || eastmoney.client_grants.length) throw new Error('Review existing Eastmoney organization associations before migration');
const organizations = [{ ...eastmoney,
  connections: [{ name: 'eastmoney-email', assign_membership_on_login: true, is_signup_enabled: true, is_enabled: true }],
  clients: loginNames.map(client_id => ({ client_id, use_for_member_access: true })),
  client_grants: [],
}];
await writeFile('.auth0-deploy/organization-prepare.yaml', yaml.dump({ clients, clientGrants, organizations }), { mode: 0o600 });
await writeFile('.auth0-deploy/organization-lock.yaml', yaml.dump({ clients: clients.filter(c => loginNames.includes(c.name)).map(c => ({ ...c, organization_usage: 'require' })) }), { mode: 0o600 });
console.log(JSON.stringify({ prepared: true, clients: clients.map(c => c.name), organization: eastmoney.name, hasbaiIncluded: false, deleteResources: false }));
