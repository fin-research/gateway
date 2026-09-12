import { z } from 'zod';
import { auth0ProfileCanLogin, createAuth0ManagementClient } from './auth0-management.js';
import { AccessError } from './access.ts';
import type { SiteIdentity } from '../identity.ts';

type Config = Pick<Env, 'AUTH0_DOMAIN' | 'AUTH0_ORGANIZATION_ID' | 'AUTH0_MANAGEMENT_CLIENT_ID' | 'AUTH0_MANAGEMENT_CLIENT_SECRET'>;
export const roleSchema = z.object({ id: z.string().regex(/^rol_[A-Za-z0-9]+$/), name: z.string(), description: z.string().optional().default('') });
const userSchema = z.object({ user_id: z.string().regex(/^auth0\|\S+$/), email: z.string(), name: z.string().optional(),
  blocked: z.boolean().optional(), email_verified: z.boolean().optional(), picture: z.string().optional(),
  user_metadata: z.record(z.string(), z.unknown()).optional(), app_metadata: z.record(z.string(), z.unknown()).optional(),
  identities: z.array(z.object({ connection: z.string() })) });
export type Auth0Role = z.infer<typeof roleSchema>;
export type DirectoryPerson = { id: string; name: string; email: string; active: boolean; roles: Auth0Role[] };

export function createDirectory(config: Config, fetchImpl: typeof fetch = fetch) {
  const manager = createAuth0ManagementClient({ domain: config.AUTH0_DOMAIN, clientId: config.AUTH0_MANAGEMENT_CLIENT_ID,
    clientSecret: config.AUTH0_MANAGEMENT_CLIENT_SECRET, fetchImpl });
  let roleRequest: Promise<Auth0Role[]> | undefined;
  let peopleRequest: Promise<DirectoryPerson[]> | undefined;
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

  async function user(id: string) {
    if (!(await members()).has(id)) throw new AccessError(403, '账号不属于本站组织');
    const parsed = userSchema.parse(await manager.request(`users/${encodeURIComponent(id)}`));
    if (parsed.user_id !== id || !parsed.identities.some((item) => item.connection === 'eastmoney-email')) throw new AccessError(403, '账号不属于本站');
    return parsed;
  }
  async function userRoles(id: string) {
    if (!(await members()).has(id)) throw new AccessError(403, '账号不属于本站组织');
    const allowed = new Set((await roles()).map(role => role.id));
    return z.array(roleSchema).parse(await manager.list(`${org}/members/${encodeURIComponent(id)}/roles`)).filter(role => allowed.has(role.id));
  }
  return {
    roles, user, userRoles,
    async current(identity: SiteIdentity, includeRoles = true) {
      if (!identity.auth0Id) throw new AccessError(503, '账号身份声明尚未配置完成');
      let profile;
      try { profile = await user(identity.auth0Id); }
      catch (error) { if (error && typeof error === 'object' && 'status' in error && error.status === 404) throw new AccessError(401, '账号已变更，请重新登录'); throw error; }
      if (profile.email.toLowerCase() !== identity.email.toLowerCase()) throw new AccessError(401, '账号信息已变更，请重新登录');
      if (!auth0ProfileCanLogin(profile)) throw new AccessError(403, '账号已停用或邮箱尚未验证');
      return { name: profile.name || profile.email, department: typeof profile.user_metadata?.department === 'string' ? profile.user_metadata.department.trim().slice(0, 100) : '', roles: includeRoles ? await userRoles(identity.auth0Id) : [], picture: profile.picture ?? '' };
    },
    people() {
      return peopleRequest ??= (async () => {
        const people: DirectoryPerson[] = [];
        // Only organization members are read, with bounded sequential requests.
        // Auth0 organization membership responses omit account status/metadata.
        for (const id of await members()) {
          const profile = await user(id);
          people.push({ id, name: profile.name || profile.email, email: profile.email,
            active: auth0ProfileCanLogin(profile), roles: await userRoles(id) });
        }
        return people.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      })();
    },
  };
}
export type Auth0Directory = ReturnType<typeof createDirectory>;
