// Membership is user data, not a Deploy CLI resource. No users are recreated,
// no password/email changes are made, and no invitations are sent.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { management as m } from './lib/auth0-management.mjs';
const org = 'org_6yvoRRCkzk3eGkBS';
const legacyIds = new Set(['rol_eoDAJuWbdjwEzEln', 'rol_dUEQWoUpRu5kzcqi', 'rol_8WnIILDtpeyWuu3O']);
const mode = process.argv[2] ?? 'plan';
const file = '.auth0-deploy/organization-members.json';
function list(path) {
  const all = [];
  for (let page = 0; page < 20; page++) {
    const rows = m('get', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(rows)) throw new Error('Unexpected membership response');
    all.push(...rows); if (rows.length < 100) return all;
  }
  throw new Error('Membership pagination limit exceeded');
}
if (mode === 'plan') {
  const members = new Set(list(`organizations/${org}/members`).map(u => u.user_id));
  const users = list('users?q=' + encodeURIComponent('identities.connection:"eastmoney-email"') + '&search_engine=v3');
  const rows = users.map(u => {
    if (!u.identities?.every(i => i.connection === 'eastmoney-email')) throw new Error('Review linked cross-connection identities first');
    const global = list(`users/${encodeURIComponent(u.user_id)}/roles`).filter(r => legacyIds.has(r.id)).map(r => r.id);
    const roles = members.has(u.user_id) ? list(`organizations/${org}/members/${encodeURIComponent(u.user_id)}/roles`).map(r => r.id) : [];
    return { user_id: u.user_id, wasMember: members.has(u.user_id), global, roles };
  });
  await mkdir('.auth0-deploy', { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify({ org, rows }, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ mode, users: rows.length, addMembers: rows.filter(u => !u.wasMember).length, copyRoleAssignments: rows.reduce((n, u) => n + u.global.filter(id => !u.roles.includes(id)).length, 0) }));
} else if (['apply', 'remove-global'].includes(mode)) {
  const plan = JSON.parse(await readFile(file, 'utf8'));
  if (plan.org !== org) throw new Error('Organization snapshot mismatch');
  const members = new Set(list(`organizations/${org}/members`).map(u => u.user_id));
  for (const u of plan.rows) {
    const userPath = `users/${encodeURIComponent(u.user_id)}`;
    const user = m('get', userPath);
    if (!user.identities?.every(i => i.connection === 'eastmoney-email')) throw new Error('User connection changed; review before migrating');
    if (mode === 'apply' && !members.has(u.user_id)) {
      m('post', `organizations/${org}/members`, { members: [u.user_id] }); members.add(u.user_id);
    }
    if (!members.has(u.user_id)) throw new Error('Organization member missing');
    const rolePath = `organizations/${org}/members/${encodeURIComponent(u.user_id)}/roles`;
    const roles = new Set(list(rolePath).map(r => r.id));
    const missing = u.global.filter(id => !roles.has(id));
    if (mode === 'apply' && missing.length) m('post', rolePath, { roles: missing });
    if (mode === 'remove-global') {
      if (missing.length) throw new Error('Refusing to remove a role absent from the organization');
      const global = list(`${userPath}/roles`).filter(r => u.global.includes(r.id)).map(r => r.id);
      if (global.length) m('delete', `${userPath}/roles`, { roles: global });
    }
    const confirmed = new Set(list(rolePath).map(r => r.id));
    if (![...u.roles, ...u.global].every(id => confirmed.has(id))) throw new Error('Organization roles failed verification');
  }
  console.log(JSON.stringify({ mode, verifiedUsers: plan.rows.length, organization: org }));
} else throw new Error('Expected plan, apply or remove-global');
