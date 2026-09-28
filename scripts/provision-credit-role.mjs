import { management } from './lib/auth0-management.mjs';

const organization = 'org_6yvoRRCkzk3eGkBS';
const legacy = new Set(['rol_eoDAJuWbdjwEzEln', 'rol_dUEQWoUpRu5kzcqi', 'rol_8WnIILDtpeyWuu3O']);
const audience = 'https://eastmoney.hasbai.xyz/';
const read = 'credit.institution:read';
const update = 'credit.institution:update';
const mode = process.argv[2];
if (!['plan', 'apply', 'verify'].includes(mode)) throw new Error('Expected plan, apply or verify');

function list(path) {
  const result = [];
  for (let page = 0; page < 100; page++) {
    const rows = management('get', `${path}?per_page=100&page=${page}`);
    if (!Array.isArray(rows)) throw new Error('Unexpected Auth0 pagination');
    result.push(...rows);
    if (rows.length < 100) return result;
  }
  throw new Error('Auth0 pagination exceeded safe limit');
}

const belongsToSite = role => role.owner_id === organization || legacy.has(role.id);
const roles = list('roles').filter(belongsToSite);
let credit = roles.find(role => role.name === 'credit');
const permission = permission_name => ({ permission_name, resource_server_identifier: audience });
function has(role, name) {
  return list(`roles/${role.id}/permissions`).some(row => row.resource_server_identifier === audience && row.permission_name === name);
}
const revoke = roles.filter(role => role.name !== 'credit' && role.name !== 'admin' && has(role, update));

if (mode === 'plan') {
  console.log(JSON.stringify({ mode, organization, createCredit: !credit,
    grant: credit ? [read, update].filter(name => !has(credit, name)) : [read, update],
    revokeFrom: revoke.map(role => role.name), membersToAssign: 0 }));
} else {
  if (mode === 'apply') {
    if (!credit) {
      credit = management('post', 'roles', { name: 'credit', description: '授信管理员', type: 'organization', owner_id: organization });
      if (!credit?.id) throw new Error('Auth0 did not return the new credit role');
    }
    const missing = [read, update].filter(name => !has(credit, name));
    if (missing.length) management('post', `roles/${credit.id}/permissions`, { permissions: missing.map(permission) });
    for (const role of revoke) management('delete', `roles/${role.id}/permissions`, { permissions: [permission(update)] });
  }
  const current = list('roles').find(role => role.id === credit?.id && role.name === 'credit' && role.owner_id === organization);
  if (!current || !has(current, read) || !has(current, update)) throw new Error('Credit role grant verification failed');
  const residual = list('roles').filter(role => belongsToSite(role) && role.name !== 'credit' && role.name !== 'admin' && has(role, update));
  if (residual.length) throw new Error(`Credit update still granted to ${residual.map(role => role.name).join(', ')}`);
  console.log(JSON.stringify({ mode, organization, role: current.name, roleId: current.id,
    permissions: [read, update], otherRolesWithUpdate: 0, membersChanged: 0 }));
}
