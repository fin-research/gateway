import { z } from 'zod';
import { auth0ProfileCanLogin, createAuth0ManagementClient } from './auth0-management.js';
import { AccessError } from './access.ts';
import type { SiteIdentity } from '../identity.ts';

type Config = Pick<Env, 'AUTH0_DOMAIN' | 'AUTH0_MANAGEMENT_CLIENT_ID' | 'AUTH0_MANAGEMENT_CLIENT_SECRET'>;
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
  const roles = () => roleRequest ??= manager.list('roles').then((rows) => z.array(roleSchema).parse(rows));
  async function user(id: string) {
    const parsed = userSchema.parse(await manager.request(`users/${encodeURIComponent(id)}`));
    if (parsed.user_id !== id || !parsed.identities.some((item) => item.connection === 'eastmoney-email')) throw new AccessError(403, '账号不属于本站');
    return parsed;
  }
  async function userRoles(id: string) {
    return z.array(roleSchema).parse(await manager.list(`users/${encodeURIComponent(id)}/roles`));
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
        const allRoles = await roles();
        const memberships = new Map<string, Auth0Role[]>();
        // Sequential role paging bounds fanout and respects Management API rate limits.
        for (const role of allRoles) {
          for (const member of await manager.list(`roles/${encodeURIComponent(role.id)}/users`)) {
            const id = z.object({ user_id: z.string() }).parse(member).user_id;
            memberships.set(id, [...(memberships.get(id) ?? []), role]);
          }
        }
        const users = z.array(userSchema).parse(await manager.list('users?search_engine=v3&q=' + encodeURIComponent('identities.connection:"eastmoney-email"')));
        return users.filter((item) => item.identities.some((entry) => entry.connection === 'eastmoney-email')).map((item) => ({
          id: item.user_id, name: item.name || item.email, email: item.email,
          active: auth0ProfileCanLogin(item), roles: memberships.get(item.user_id) ?? [],
        })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      })();
    },
  };
}
export type Auth0Directory = ReturnType<typeof createDirectory>;
