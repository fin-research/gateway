import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { management, AUTH0_DOMAIN } from './lib/auth0-management.mjs';
import { PERMISSION_DEFINITIONS, PERMISSION_CODES } from '../src/lib/permissions.ts';
const yaml = createRequire(import.meta.resolve('auth0-deploy-cli'))('js-yaml');
const organization = 'org_6yvoRRCkzk3eGkBS';
const audience = 'https://eastmoney.hasbai.xyz/';
const legacy = new Set(['rol_eoDAJuWbdjwEzEln','rol_dUEQWoUpRu5kzcqi','rol_8WnIILDtpeyWuu3O']);
function awaitWait(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
const mode = process.argv[2];
if (!['plan', 'apply', 'verify'].includes(mode)) throw new Error('Expected plan, apply or verify');
function list(path) {
  const result = [];
  for (let page = 0; page < 100; page++) {
    let rows;
    for(let attempt=0;;attempt++) {
      try { rows = management('get', `${path}?per_page=100&page=${page}`); break; }
      catch(error) { if(attempt>=2 || error.status!==503) throw error; awaitWait(1000 * (attempt + 1)); }
    }
    if (!Array.isArray(rows)) throw new Error('Unexpected pagination');
    result.push(...rows);
    if (rows.length < 100) return result;
  }
  throw new Error('Pagination exceeded safe limit');
}
const roles = list('roles').filter(r => r.owner_id === organization || legacy.has(r.id));
const members = list(`organizations/${organization}/members`);
let baseline = roles.find(r => r.name === 'authenticated' && r.owner_id === organization);
if (mode === 'plan') {
  const before = yaml.load(await readFile('.auth0-deploy/rbac-before/tenant.yaml', 'utf8'));
  const api = before.resourceServers.find(s => s.identifier === audience);
  const grant = before.clientGrants.find(g => g.client_id === 'eastmoney-login-roles' && g.audience === `https://${AUTH0_DOMAIN}/api/v2/`);
  if (!api || !grant) throw new Error('Missing API or login client grant');
  const scopes = new Map(api.scopes.map(s => [s.value, s]));
  for (const [value, name, description] of PERMISSION_DEFINITIONS) scopes.set(value, { value, description: `${name}：${description}` });
  const next = { resourceServers: [{ ...api, scopes: [...scopes.values()], enforce_policies: true, token_dialect: 'access_token' }],
    clientGrants: [{ ...grant, scope: [...new Set([...grant.scope, 'create:organization_member_roles'])] }] };
  const snapshot = { roles: [], members: [] };
  for (const role of roles) snapshot.roles.push({ ...role, permissions: list(`roles/${role.id}/permissions`) });
  for (const member of members) snapshot.members.push({ user_id: member.user_id, roles: list(`organizations/${organization}/members/${encodeURIComponent(member.user_id)}/roles`) });
  await mkdir('.auth0-deploy/rbac', { recursive: true, mode: 0o700 });
  await writeFile('.auth0-deploy/rbac/before.json', JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  await writeFile('.auth0-deploy/rbac/tenant.yaml', yaml.dump(next), { mode: 0o600 });
  console.log(JSON.stringify({ mode, organization, users: members.length, roles: roles.map(r => r.name), createBaseline: !baseline,
    permissionsPerRole: PERMISSION_CODES.length, apiRBAC: true, runtimeGrant: next.clientGrants[0].scope,
    organizationRoleTooling: 'Deploy CLI omits organization roles; use bounded additive Management API operations after plan' }));
} else {
  // Explicit plan is mandatory; all mutations add missing grants only.
  await readFile('.auth0-deploy/rbac/before.json', 'utf8');
  if (!baseline && mode === 'apply') {
    baseline = management('post', 'roles', { name: 'authenticated', description: '本站已登录用户基础角色；内测阶段授予全部本站权限', type: 'organization', owner_id: organization });
    roles.push(baseline);
  }
  if (!baseline) throw new Error('Baseline role missing');
  for (const role of roles) {
    const existing = list(`roles/${role.id}/permissions`);
    const granted = new Set(existing.filter(p => p.resource_server_identifier === audience).map(p => p.permission_name));
    const missing = PERMISSION_CODES.filter(code => !granted.has(code));
    if (missing.length && mode === 'apply') management('post', `roles/${role.id}/permissions`, { permissions: missing.map(permission_name => ({ permission_name, resource_server_identifier: audience })) });
    else if (missing.length) throw new Error(`Incomplete role ${role.name}`);
  }
  for (const member of members) {
    const path = `organizations/${organization}/members/${encodeURIComponent(member.user_id)}/roles`;
    if (!list(path).some(role => role.id === baseline.id)) {
      if (mode === 'verify') throw new Error('Organization member missing baseline');
      management('post', path, { roles: [baseline.id] });
    }
  }
  console.log(JSON.stringify({ mode, organization, users: members.length, roles: roles.length, permissionsPerRole: PERMISSION_CODES.length, baselineRole: baseline.id }));
}
