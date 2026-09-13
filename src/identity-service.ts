import { Buffer } from 'node:buffer';
import { createDirectory } from './lib/server/auth0-directory.ts';
import { createProfileService, ProfileError, readProfileJson } from './lib/server/profile.ts';
import { AccessError, accessFailure } from './lib/server/access.ts';
import { permissionCache } from './lib/server/permission-cache.ts';
import { hasPermission } from './lib/permissions.ts';
import { CONTEXT_HEADER, type GatewayContext } from './forward.ts';
import { clearSession } from './session.ts';

const privateHeaders = { 'Cache-Control': 'no-store, private', Vary: 'Cookie, Authorization' };
export async function profileRequest(request: Request, env: Env, user: GatewayContext['user']) {
  const headers = new Headers(privateHeaders);
  try {
    const service = createProfileService(env, user);
    if (request.method === 'GET' || request.method === 'HEAD') return Response.json(await service.read(), { headers });
    if (request.method !== 'POST') throw new AccessError(403, '操作未登记');
    if (!request.headers.get('Content-Type')?.includes('application/json')) return Response.json({ detail: '请提交 JSON 格式的个人信息' }, { status: 415, headers });
    const result = await service.update(await readProfileJson(request, 4096));
    if (result.logout) clearSession(headers);
    return Response.json(result, { headers });
  } catch (error) {
    if (error instanceof AccessError) return accessFailure(error);
    return Response.json({ detail: error instanceof ProfileError ? error.message : '个人信息操作失败，请稍后重试' }, { status: error instanceof ProfileError ? error.status : 503, headers });
  }
}

/** Callable only by the explicit Dashboard binding, including its reminder Cron. */
export async function identityService(request: Request, env: Env): Promise<Response> {
  try {
    const path = new URL(request.url).pathname;
    const directory = createDirectory(env);
    if (request.method === 'GET' && path === '/directory/people') return Response.json(await directory.people(), { headers: privateHeaders });
    if (request.method === 'GET' && path === '/directory/roles') return Response.json(await directory.roles(), { headers: privateHeaders });
    const context: GatewayContext = JSON.parse(Buffer.from(request.headers.get(CONTEXT_HEADER) ?? '', 'base64url').toString('utf8'));
    if (!context || context.version !== 1 || !context.user?.auth0Id) throw new AccessError(401, '缺少已验证身份');
    const user = context.user;
    if (path === '/api/profile') {
      if (!hasPermission(user.authorization?.permissions, request.method === 'POST' ? 'account.profile:update' : 'account.profile:read')) throw new AccessError(403, '当前角色无权执行该操作');
      return profileRequest(request, env, user);
    }
    if (path !== '/roles/configurations' || request.method !== 'GET') throw new AccessError(403, '角色权限请在 Auth0 管理');
    if (!hasPermission(user.authorization?.permissions, 'auth.permission:read')) throw new AccessError(403, '当前角色无权查看权限');
    const snapshot = await permissionCache(env).snapshot();
    return Response.json({ roles: snapshot.roles, configurations: snapshot.configurations, updatedAt: snapshot.updatedAt, mode: user.authorization!.mode }, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof ProfileError) return Response.json({ detail: error.message }, { status: error.status, headers: privateHeaders });
    return accessFailure(error);
  }
}
