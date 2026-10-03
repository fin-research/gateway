import { AccessError } from './access.ts';
import { z } from 'zod';
import { hasPermission, PERMISSION_CODES, type AuthorizationMode } from '../permissions.ts';
import { permissionCache, permissionsFromSnapshot, type PermissionSnapshot } from './permission-cache.ts';
import { requestPolicy } from './permission-policy.ts';
import type { SiteIdentity } from '../identity.ts';
import { verifyToken, userClaims } from '../../tokens.ts';
import { accessToken, SESSION_MAX_AGE } from '../../session.ts';
import { requireSameOrigin } from '../../policy.ts';
import type { JWTPayload } from 'jose';

export function authorizationMode(value: unknown): AuthorizationMode {
  if (value !== 'enforce') throw new AccessError(503, '权限模式尚未配置完成');
  return value;
}

type SnapshotLoader = () => Promise<PermissionSnapshot>;
export async function userIdentity(request: Request, env: Env, optional = false, snapshot?: SnapshotLoader): Promise<SiteIdentity | null> {
  const token = await accessToken(request);
  if (!token && optional) return null;
  const payload = await verifyToken(token ?? '', env);
  requireSessionAge(request, payload);
  const mcp = new URL(request.url).pathname.replace(/\/$/, '') === '/api/mcp';
  return identityFromPayload(payload, env, mcp && payload.azp === env.AUTH0_MCP_CLIENT_ID ? env.AUTH0_MCP_CLIENT_ID : env.AUTH0_CLIENT_ID, snapshot);
}

function requireSessionAge(request: Request, payload: JWTPayload): void {
  // Cookie expiry alone is insufficient: a copied JWT must not extend the 24h session.
  if (!request.headers.has('Authorization') && payload.iat! + SESSION_MAX_AGE <= Date.now() / 1000) {
    throw new AccessError(401, '会话已失效，请重新登录');
  }
}

async function identityFromPayload(payload: JWTPayload, env: Env, clientId: string = env.AUTH0_CLIENT_ID,
  snapshot: SnapshotLoader = () => permissionCache(env).snapshot()): Promise<SiteIdentity> {
  if (!/^auth0\|[^\s]{1,249}$/.test(payload.sub ?? '') || payload.azp !== clientId || payload.gty === 'client-credentials') throw new AccessError(403, '请使用本站用户账号登录');
  const claims = userClaims(payload);
  const email = String(claims.email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@18\.cn$/.test(email)) throw new AccessError(403, '请使用 18.cn 邮箱登录');
  const profileSchema = z.object({ name: z.string().max(200), department: z.string().max(100), picture: z.string().max(2048) });
  let signedRoles = claims.roles;
  if (claims.format === 'flat') {
    // The bound Auth0 Action enforces verified email/blocked status at issuance;
    // the organization enables only eastmoney-email. Do not invent profile flags.
    const names = z.array(z.string().min(1).max(200)).max(50).safeParse(claims.roles);
    if (!names.success || new Set(names.data).size !== names.data.length) throw tokenRefreshRequired();
    const catalogue = await snapshot();
    signedRoles = names.data.map(name => {
      const matches = catalogue.roles.filter(role => role.name === name);
      if (matches.length !== 1) throw tokenRefreshRequired();
      return matches[0];
    });
  }
  const roles = z.array(z.object({ id: z.string().regex(/^rol_[A-Za-z0-9]+$/), name: z.string().max(200), description: z.string().optional().default('') })).max(50).safeParse(signedRoles);
  const profile = (claims.format === 'flat' ? profileSchema : profileSchema.extend({
    connection: z.literal('eastmoney-email'), verified: z.literal(true) })).safeParse(claims.profile);
  if (!roles.success || !profile.success || new Set(roles.data.map(role => role.id)).size !== roles.data.length) {
    throw tokenRefreshRequired();
  }
  return { id: payload.sub!, auth0Id: payload.sub!, email, issuedAt: payload.iat!, expiresAt: payload.exp!,
    authorization: { name: profile.data.name || email, department: profile.data.department, picture: profile.data.picture,
      roles: roles.data, permissions: [], mode: 'enforce' } };

}

function tokenRefreshRequired() {
  return new AccessError(401, '登录凭证需更新，请重新登录或刷新登录状态', 'TOKEN_REFRESH_REQUIRED');
}

/** Every protected request checks the Auth0 role grants in the Gateway cache. */
export async function authorizeRequest(request: Request, env: Env, routeId: string | null, fetcher: typeof fetch = fetch) {
  let snapshotRequest: Promise<PermissionSnapshot> | undefined;
  const loadSnapshot = () => snapshotRequest ??= permissionCache(env).snapshot();
  let policy;
  try { policy = requestPolicy(request, routeId); }
  catch (error) {
    // Missing/invalid authentication must not be reported as missing route
    // permission. Authenticated callers still receive the explicit registry error.
    if (error instanceof AccessError && error.code === 'ROUTE_NOT_REGISTERED') await userIdentity(request, env);
    throw error;
  }
  if (policy.public && routeId !== '/auth/session' && routeId !== '/') {
    requireSameOrigin(request);
    return { user: null, permissions: [] as string[], directory: undefined, permissionUpdatedAt: undefined };
  }
  if (routeId === '/') requireSameOrigin(request);
  let user: SiteIdentity | null;
  try { user = await userIdentity(request, env, policy.public, loadSnapshot); }
  catch (error) {
    if (routeId === '/' || policy.public && error instanceof AccessError && error.status === 401)
      return { user: null, permissions: [] as string[], directory: undefined, permissionUpdatedAt: undefined };
    throw error;
  }
  if (!user) return { user: null, permissions: [] as string[], directory: undefined, permissionUpdatedAt: undefined };
  if (!(routeId === '/api/mcp' && request.headers.has('Authorization') && !request.headers.has('Origin'))) requireSameOrigin(request);
  try {
    const mode = authorizationMode(env.AUTHORIZATION_MODE);
    const profile = user.authorization!;
    const snapshot = await loadSnapshot();
    const isAdmin = profile.roles.some(role => role.name === 'admin' && snapshot.roles.some(current => current.id === role.id && current.name === 'admin'));
    const permissions = isAdmin ? [...PERMISSION_CODES] : permissionsFromSnapshot(snapshot, profile.roles).permissions;
    if (policy.admin && !isAdmin) throw new AccessError(403, '仅管理员可执行该操作');
    user.authorization = { ...profile, permissions, mode };
    if (policy.permission && !hasPermission(permissions, policy.permission)) throw new AccessError(403, '当前角色无权执行该操作');
    return { user, permissions, directory: undefined, permissionUpdatedAt: snapshot.updatedAt };
  } catch (error) {
    // The portal remains public when a signed session cannot be enriched with
    // current grants; never forward a partial authorization to its SSR tree.
    if (routeId === '/') return { user: null, permissions: [] as string[], directory: undefined, permissionUpdatedAt: undefined };
    throw error;
  }
}

/** Data retains its login-only boundary; machine tokens have a separate quota scope. */
export async function authorizeData(request: Request, env: Env, fetcher: typeof fetch = fetch): Promise<void> {
  const token = await accessToken(request);
  const payload = await verifyToken(token ?? '', env);
  requireSessionAge(request, payload);
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
  await identityFromPayload(payload, env, isMcpClient ? env.AUTH0_MCP_CLIENT_ID : env.AUTH0_CLIENT_ID);
}
