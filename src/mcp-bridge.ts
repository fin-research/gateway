import { z } from 'zod';
import { AccessError } from './lib/server/access.ts';
import { readProfileJson } from './lib/server/profile.ts';
import { permissionCache } from './lib/server/permission-cache.ts';
import { hasPermission } from './lib/permissions.ts';
import { canonicalPath, dashboardPolicy } from './policy.ts';
import { forwardedRequest, type GatewayContext } from './forward.ts';

const operation = z.object({ path: z.string().max(8192), method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) });

/** Private IDENTITY binding only. Reuse the actual route policy and handlers,
 * including SvelteKit actions/RLS, instead of granting an MCP service account. */
export async function mcpBridge(request: Request, env: Env, context: GatewayContext): Promise<Response> {
  const user = context.user;
  if (!user?.authorization || user.expiresAt <= Date.now() / 1000) throw new AccessError(401, '请重新登录');
  const { permissions } = await permissionCache(env).permissions(user.authorization.roles.map(role => role.id));
  const current = { ...context, user: { ...user, authorization: { ...user.authorization, permissions } } };
  function target(path: string, method: string): Request {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('#')) throw new AccessError(403, 'MCP 目标无效');
    const url = new URL(path, env.SITE_ORIGIN);
    if (url.origin !== env.SITE_ORIGIN) throw new AccessError(403, 'MCP 目标无效');
    const probe = new Request(url, { method });
    const clean = canonicalPath(probe);
    if (!(clean.startsWith('/api/') || clean === '/financing' || clean.startsWith('/financing/') || clean === '/fund-report' || /^\/fund-report\/\d{4}-\d{2}-\d{2}\.html$/.test(clean))
      || clean === '/api/mcp' || clean === '/api/profile' || clean.startsWith('/api/notifications/') || clean.startsWith('/financing/login') || clean.startsWith('/financing/logout')) throw new AccessError(403, 'MCP 目标未开放');
    const policy = dashboardPolicy(probe);
    if (policy.permission && !hasPermission(permissions, policy.permission)) throw new AccessError(403, '当前角色无权执行该操作');
    return probe;
  }
  if (new URL(request.url).pathname === '/mcp/policies') {
    if (request.method !== 'POST') throw new AccessError(403, '操作未登记');
    const operations = z.array(operation).max(150).parse(await readProfileJson(request, 65536));
    return Response.json({ allowed: operations.map(item => {
      try { target(item.path, item.method); return true; }
      catch (error) { if (error instanceof AccessError && error.status === 403) return false; throw error; }
    }) }, { headers: { 'Cache-Control': 'no-store' } });
  }
  const parsed = operation.parse({ path: new URL(request.url).searchParams.get('target'), method: request.method });
  const probe = target(parsed.path, parsed.method);
  const headers = new Headers({ Origin: env.SITE_ORIGIN, Accept: 'application/json' });
  for (const name of ['Content-Type', 'X-SvelteKit-Action']) {
    const value = request.headers.get(name); if (value) headers.set(name, value);
  }
  // Never forward arbitrary headers, credentials or identity supplied in tool arguments.
  const delegated = new Request(probe.url, { method: parsed.method, headers, body: request.body, redirect: 'manual', signal: request.signal, duplex: 'half' } as RequestInit);
  return env.DASHBOARD.fetch(forwardedRequest(delegated, current));
}
