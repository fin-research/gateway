import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { createDirectory } from './lib/server/auth0-directory.ts';
import { createProfileService, ProfileError, readProfileJson } from './lib/server/profile.ts';
import { AccessError, accessFailure } from './lib/server/access.ts';
import { roleConfiguration, saveRoleConfiguration, PermissionConfigurationError } from './lib/server/permission-repository.ts';
import { withPostgres } from './lib/server/postgres.ts';
import { hasPermission, isPermissionCode } from './lib/permissions.ts';
import { CONTEXT_HEADER, type GatewayContext } from './forward.ts';
import { clearSession } from './session.ts';

const privateHeaders = { 'Cache-Control': 'no-store, private', Vary: 'Cookie, Authorization' };
const permissionChange = z.object({ roleId: z.string().regex(/^rol_[A-Za-z0-9]+$/), version: z.string().regex(/^[a-f0-9]{64}$/),
  permissions: z.array(z.string().refine(isPermissionCode)).max(256) }).strict();

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
    if (path !== '/roles/configurations' || !['GET', 'POST'].includes(request.method)) throw new AccessError(403, '服务操作未登记');
    if (!hasPermission(user.authorization?.permissions, request.method === 'GET' ? 'auth.permission:read' : 'auth.permission:update')) throw new AccessError(403, '当前角色无权配置权限');
    const roles = await directory.roles();
    if (request.method === 'GET') {
      const configurations: Record<string, { permissions: string[]; version: string }> = {};
      await withPostgres(env.AUTHORIZATION_DB?.connectionString, 'eastmoney-role-configuration', async db => {
        for (const role of roles) configurations[role.id] = await roleConfiguration(db, role.id);
      });
      return Response.json({ roles, configurations, mode: user.authorization!.mode }, { headers: privateHeaders });
    }
    const parsed = permissionChange.safeParse(await readProfileJson(request, 32768));
    if (!parsed.success) throw new PermissionConfigurationError(400, '权限配置格式无效');
    const { roleId, permissions, version } = parsed.data;
    const role = roles.find(role => role.id === roleId);
    if (!role) throw new PermissionConfigurationError(400, 'Auth0 角色已不存在，请刷新页面');
    const configuration = await withPostgres(env.AUTHORIZATION_DB?.connectionString, 'eastmoney-role-configuration', async db => {
      await db.query('BEGIN');
      try {
        const result = await saveRoleConfiguration(db, roleId, permissions, version, user.auth0Id!);
        await db.query('COMMIT'); return result;
      } catch (error) { await db.query('ROLLBACK'); throw error; }
    });
    return Response.json({ success: true, roleId, configuration, message: `${role.name} 的权限已保存` }, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof PermissionConfigurationError || error instanceof ProfileError) return Response.json({ detail: error.message }, { status: error.status, headers: privateHeaders });
    return accessFailure(error);
  }
}
