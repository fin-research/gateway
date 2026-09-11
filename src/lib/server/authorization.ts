import { AccessError } from './access.ts';
import { z } from 'zod';
import { PERMISSION_CODES, hasPermission, type AuthorizationMode } from '../permissions.ts';
import { requestPolicy } from './permission-policy.ts';
import { rolePermissions } from './permission-repository.ts';
import { withPostgres } from './postgres.ts';
import type { SiteIdentity } from '../identity.ts';
import { verifyToken, EMAIL_CLAIM, ROLES_CLAIM, PROFILE_CLAIM } from '../../tokens.ts';
import { accessToken } from '../../session.ts';
import { requireSameOrigin } from '../../policy.ts';
import type { JWTPayload } from 'jose';

export function authorizationMode(value: unknown): AuthorizationMode {
  if (value !== 'beta-open' && value !== 'enforce') throw new AccessError(503, '权限模式尚未配置完成');
  return value;
}

export async function userIdentity(request: Request, env: Env, optional = false): Promise<SiteIdentity | null> {
  const token = await accessToken(request, env);
  if (!token && optional) return null;
  const payload = await verifyToken(token ?? '', env);
  return identityFromPayload(payload, env);
}

function identityFromPayload(payload: JWTPayload, env: Env, clientId: string = env.AUTH0_CLIENT_ID): SiteIdentity {
  if (!/^auth0\|[^\s]{1,249}$/.test(payload.sub ?? '') || payload.azp !== clientId || payload.gty === 'client-credentials') throw new AccessError(403, '请使用本站用户账号登录');
  const email = String(payload[EMAIL_CLAIM] ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@18\.cn$/.test(email)) throw new AccessError(403, '请使用 18.cn 邮箱登录');
  const roles = z.array(z.object({ id: z.string().regex(/^rol_[A-Za-z0-9]+$/), name: z.string().max(200), description: z.string().optional().default('') })).max(50).safeParse(payload[ROLES_CLAIM]);
  const profile = z.object({ name: z.string().max(200), department: z.string().max(100), picture: z.string().max(2048),
    connection: z.literal('eastmoney-email'), verified: z.literal(true) }).safeParse(payload[PROFILE_CLAIM]);
  if (!roles.success || !profile.success || new Set(roles.data.map(role => role.id)).size !== roles.data.length) {
    throw new AccessError(401, '登录凭证需更新，请重新登录或刷新登录状态', 'TOKEN_REFRESH_REQUIRED');
  }
  return { id: payload.sub!, auth0Id: payload.sub!, email, issuedAt: payload.iat!, expiresAt: payload.exp!,
    authorization: { name: profile.data.name || email, department: profile.data.department, picture: profile.data.picture,
      roles: roles.data, permissions: [], mode: 'enforce' } };

}

/** Role membership comes only from the signed JWT. Permission grants are read per request. */
export async function authorizeRequest(request: Request, env: Env, routeId: string | null, fetcher: typeof fetch = fetch) {
  let policy;
  try { policy = requestPolicy(request, routeId); }
  catch (error) {
    // Missing/invalid authentication must not be reported as missing route
    // permission. Authenticated callers still receive the explicit registry error.
    if (error instanceof AccessError && error.code === 'ROUTE_NOT_REGISTERED') await userIdentity(request, env);
    throw error;
  }
  if (policy.public && routeId !== '/auth/session') {
    requireSameOrigin(request);
    return { user: null, permissions: [] as string[], directory: undefined };
  }
  let user: SiteIdentity | null;
  try { user = await userIdentity(request, env, policy.public); }
  catch (error) {
    if (policy.public && error instanceof AccessError && error.status === 401) return { user: null, permissions: [] as string[], directory: undefined };
    throw error;
  }
  if (!user) return { user: null, permissions: [] as string[], directory: undefined };
  requireSameOrigin(request);
  const mode = authorizationMode(env.AUTHORIZATION_MODE);
  const profile = user.authorization!;
  const permissions = mode === 'beta-open' ? [...PERMISSION_CODES]
    : await withPostgres(env.AUTHORIZATION_DB?.connectionString, 'eastmoney-authorization', db => rolePermissions(db, profile.roles.map(role => role.id)));
  user.authorization = { ...profile, permissions, mode };
  if (policy.permission && !hasPermission(permissions, policy.permission)) throw new AccessError(403, '当前角色无权执行该操作');
  return { user, permissions, directory: undefined };
}

/** Data retains its login-only boundary; machine tokens have a separate quota scope. */
export async function authorizeData(request: Request, env: Env, fetcher: typeof fetch = fetch): Promise<void> {
  const token = await accessToken(request, env);
  const payload = await verifyToken(token ?? '', env);
  if (payload.gty === 'client-credentials') {
    const allowed = env.AUTH0_MACHINE_CLIENT_IDS.split(',').map(value => value.trim()).filter(Boolean);
    const client = String(payload.azp ?? '');
    const path = new URL(request.url).pathname;
    if (!allowed.includes(client) || payload.sub !== client + '@clients' || !String(payload.scope ?? '').split(' ').includes('data.choice:read')
      || !(path.startsWith('/data/choice/') && ['GET', 'HEAD'].includes(request.method) || path === '/data/graphql' && request.method === 'POST')) throw new AccessError(403, '机器身份无权执行该操作');
    return;
  }
  const isMcpClient = new URL(request.url).pathname.replace(/\/$/, '') === '/data/mcp'
    && env.AUTH0_MCP_CLIENT_ID && payload.azp === env.AUTH0_MCP_CLIENT_ID;
  identityFromPayload(payload, env, isMcpClient ? env.AUTH0_MCP_CLIENT_ID : env.AUTH0_CLIENT_ID);
}
