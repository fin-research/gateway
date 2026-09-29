import { z } from 'zod';
import { auth0ProfileCanLogin, createAuth0ManagementClient } from './auth0-management.js';
import { AccessError } from './access.ts';
import { ProfileError } from './profile.ts';
import type { SiteIdentity } from '../identity.ts';

type Config = Pick<Env, 'AUTH0_DOMAIN' | 'AUTH0_ORGANIZATION_ID' | 'AUTH0_MANAGEMENT_CLIENT_ID' | 'AUTH0_MANAGEMENT_CLIENT_SECRET'>;
export const roleSchema = z.object({ id: z.string().regex(/^rol_[A-Za-z0-9]+$/), name: z.string(), description: z.string().optional().default('') });
const userSchema = z.object({ user_id: z.string().regex(/^auth0\|\S+$/), email: z.string(), name: z.string().optional(),
  blocked: z.boolean().optional(), email_verified: z.boolean().optional(), picture: z.string().optional(),
  user_metadata: z.record(z.string(), z.unknown()).optional(), app_metadata: z.record(z.string(), z.unknown()).optional(),
  identities: z.array(z.object({ connection: z.string() })) });
const memberSchema = z.object({ user_id: z.string().regex(/^auth0\|\S+$/), roles: z.array(roleSchema).optional().default([]) });
export type Auth0Role = z.infer<typeof roleSchema>;
export type DirectoryPerson = { id: string; name: string; department: string; email: string; active: boolean; roles: Auth0Role[] };
const personChange = z.object({ id: z.string().regex(/^auth0\|\S+$/), name: z.string().trim().min(1).max(50), department: z.string().trim().max(100) }).strict();
function department(profile: z.infer<typeof userSchema>): string {
  return typeof profile.user_metadata?.department === 'string' ? profile.user_metadata.department.trim().slice(0, 100) : '';
}

export function createDirectory(config: Config, fetchImpl: typeof fetch = fetch) {
  const manager = createAuth0ManagementClient({ domain: config.AUTH0_DOMAIN, clientId: config.AUTH0_MANAGEMENT_CLIENT_ID,
    clientSecret: config.AUTH0_MANAGEMENT_CLIENT_SECRET, fetchImpl });
  let roleRequest: Promise<Auth0Role[]> | undefined;
  let peopleRequest: Promise<DirectoryPerson[]> | undefined;
  let profileRequest: Promise<DirectoryPerson[]> | undefined;
  if (!/^org_[A-Za-z0-9]+$/.test(config.AUTH0_ORGANIZATION_ID)) throw new AccessError(503, '组织尚未配置完成');
  const org = `organizations/${config.AUTH0_ORGANIZATION_ID}`;
  // Existing role IDs are database permission keys. Their assignments are now
  // organization-scoped; retain definitions without exposing other tenant roles.
  const legacyRoleIds = new Set(['rol_eoDAJuWbdjwEzEln', 'rol_dUEQWoUpRu5kzcqi', 'rol_8WnIILDtpeyWuu3O']);
  const roles = () => roleRequest ??= manager.list('roles').then((rows) => {
    const scoped = z.array(roleSchema.extend({ owner_id: z.string().optional() })).parse(rows);
    return scoped.filter(role => role.owner_id === config.AUTH0_ORGANIZATION_ID || legacyRoleIds.has(role.id)).map(role => roleSchema.parse(role));
  });
  let memberRequest: Promise<Set<string>> | undefined;
  const members = () => memberRequest ??= manager.list(`${org}/members`).then(rows =>
    new Set(z.array(z.object({ user_id: z.string() })).parse(rows).map(member => member.user_id)));

  function siteUser(value: unknown, id: string) {
    const parsed = userSchema.parse(value);
    if (parsed.user_id !== id || !parsed.identities.some((item) => item.connection === 'eastmoney-email')) throw new AccessError(403, '账号不属于本站');
    return parsed;
  }
  async function user(id: string) {
    if (!(await members()).has(id)) throw new AccessError(403, '账号不属于本站组织');
    return siteUser(await manager.request(`users/${encodeURIComponent(id)}`), id);
  }
  async function userRoles(id: string) {
    if (!(await members()).has(id)) throw new AccessError(403, '账号不属于本站组织');
    const allowed = new Set((await roles()).map(role => role.id));
    return z.array(roleSchema).parse(await manager.list(`${org}/members/${encodeURIComponent(id)}/roles`)).filter(role => allowed.has(role.id));
  }
  async function readPeople(includeRoles: boolean) {
    const organizationMembers = includeRoles
      ? z.array(memberSchema).parse(await manager.list(`${org}/members?fields=user_id,roles&include_fields=true`))
      : [...await members()].map(user_id => ({ user_id, roles: [] as Auth0Role[] }));
    const memberIds = new Set(organizationMembers.map(member => member.user_id));
    const query = new URLSearchParams({ q: `organization_id:"${config.AUTH0_ORGANIZATION_ID}"`, search_engine: 'v3',
      fields: 'user_id,email,name,blocked,email_verified,picture,user_metadata,app_metadata,identities', include_fields: 'true' });
    let searched: unknown[] = [];
    try { searched = await manager.list(`users?${query}`); }
    catch { console.warn(JSON.stringify({ event: 'auth0_directory_search_fallback' })); }
    const profiles = new Map<string, z.infer<typeof userSchema>>();
    for (const row of searched) {
      const parsed = userSchema.safeParse(row);
      if (parsed.success && memberIds.has(parsed.data.user_id)
        && parsed.data.identities.some(identity => identity.connection === 'eastmoney-email')) profiles.set(parsed.data.user_id, parsed.data);
    }
    const missing = organizationMembers.filter(member => !profiles.has(member.user_id));
    for (let offset = 0; offset < missing.length; offset += 4) {
      await Promise.all(missing.slice(offset, offset + 4).map(async member => {
        profiles.set(member.user_id, siteUser(await manager.request(`users/${encodeURIComponent(member.user_id)}`), member.user_id));
      }));
    }
    const allowedRoles = includeRoles ? new Set((await roles()).map(role => role.id)) : new Set<string>();
    return organizationMembers.map(member => {
      const profile = profiles.get(member.user_id)!;
      return { id: member.user_id, name: profile.name || profile.email, department: department(profile), email: profile.email,
        active: auth0ProfileCanLogin(profile), roles: member.roles.filter(role => allowedRoles.has(role.id)) };
    }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }
  return {
    roles, user, userRoles,
    async updatePerson(input: unknown) {
      const change = personChange.safeParse(input);
      if (!change.success) throw new ProfileError(400, '请检查姓名和部门');
      const before = await user(change.data.id);
      await manager.request(`users/${encodeURIComponent(change.data.id)}`, 'PATCH',
        { name: change.data.name, user_metadata: { department: change.data.department } });
      return { id: before.user_id, name: change.data.name, department: change.data.department, email: before.email };
    },
    async current(identity: SiteIdentity, includeRoles = true) {
      if (!identity.auth0Id) throw new AccessError(503, '账号身份声明尚未配置完成');
      let profile;
      try { profile = await user(identity.auth0Id); }
      catch (error) { if (error && typeof error === 'object' && 'status' in error && error.status === 404) throw new AccessError(401, '账号已变更，请重新登录'); throw error; }
      if (profile.email.toLowerCase() !== identity.email.toLowerCase()) throw new AccessError(401, '账号信息已变更，请重新登录');
      if (!auth0ProfileCanLogin(profile)) throw new AccessError(403, '账号已停用或邮箱尚未验证');
      return { name: profile.name || profile.email, department: department(profile), roles: includeRoles ? await userRoles(identity.auth0Id) : [], picture: profile.picture ?? '' };
    },
    people(includeRoles = true) {
      return includeRoles ? (peopleRequest ??= readPeople(true)) : (profileRequest ??= readPeople(false));
    },
  };
}
export type Auth0Directory = ReturnType<typeof createDirectory>;
