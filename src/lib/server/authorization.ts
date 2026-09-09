import { AccessError } from './access.ts';
import { createDirectory } from './auth0-directory.ts';
import { PERMISSION_CODES, hasPermission, type AuthorizationMode } from '../permissions.ts';
import { requestPolicy } from './permission-policy.ts';
import { rolePermissions } from './permission-repository.ts';
import { withPostgres } from './postgres.ts';
import type { SiteIdentity } from '../identity.ts';
import { verifyToken, EMAIL_CLAIM } from '../../tokens.ts';
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

function identityFromPayload(payload: JWTPayload, env: Env): SiteIdentity {
  if (!/^auth0\|[^\s]{1,249}$/.test(payload.sub ?? '') || payload.azp !== env.AUTH0_CLIENT_ID || payload.gty === 'client-credentials') throw new AccessError(403, '请使用本站用户账号登录');
  const email = String(payload[EMAIL_CLAIM] ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@18\.cn$/.test(email)) throw new AccessError(403, '请使用 18.cn 邮箱登录');
  return { id: payload.sub!, auth0Id: payload.sub!, email, issuedAt: payload.iat!, expiresAt: payload.exp! };
}

/** Identity, current account state, current roles and permissions share one request lifetime. */
export async function authorizeRequest(request: Request, env: Env, routeId: string | null, fetcher: typeof fetch = fetch) {
  const policy = requestPolicy(request, routeId);
  requireSameOrigin(request);
  if (policy.public && routeId !== '/auth/session') return { user: null, permissions: [] as string[], directory: undefined };
  let user: SiteIdentity | null;
  try { user = await userIdentity(request, env, policy.public); }
  catch (error) {
    if (policy.public && error instanceof AccessError && error.status === 401) return { user: null, permissions: [] as string[], directory: undefined };
    throw error;
  }
  if (!user) return { user: null, permissions: [] as string[], directory: undefined };
  const mode = authorizationMode(env.AUTHORIZATION_MODE);
  const directory = createDirectory(env, fetcher);
  const profile = await directory.current(user);
  const permissions = mode === 'beta-open' ? [...PERMISSION_CODES]
    : await withPostgres(env.AUTHORIZATION_DB?.connectionString, 'eastmoney-authorization', db => rolePermissions(db, profile.roles.map(role => role.id)));
  user.authorization = { ...profile, permissions, mode };
  if (policy.permission && !hasPermission(permissions, policy.permission)) throw new AccessError(403, '当前角色无权执行该操作');
  return { user, permissions, directory };
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
  const user = identityFromPayload(payload, env);
  await createDirectory(env, fetcher).current(user, false);
}
