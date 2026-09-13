import { authorizeRequest } from './lib/server/authorization.ts';
import { accessFailure, AccessError } from './lib/server/access.ts';
import { loginUrl } from './lib/auth-navigation.ts';
import { canonicalPath, dashboardRoute, requireSameOrigin } from './policy.ts';
import { forwardedRequest } from './forward.ts';
import { login, callback, logout } from './session.ts';
import { dataRequest } from './data.ts';
import { permissionCache } from './lib/server/permission-cache.ts';
import { profileRequest } from './identity-service.ts';
import { publicSession } from './lib/identity.ts';
import { Hono } from 'hono';
import { ProfileError } from './lib/server/profile.ts';

export const app = new Hono<{ Bindings: Env }>({ strict: false });
app.use('*', async (c, next) => {
  if (new URL(c.req.url).origin !== c.env.SITE_ORIGIN) throw new AccessError(403, '请求域名无效');
  const path = canonicalPath(c.req.raw);
  if (['/auth/login', '/auth/callback', '/financing/login'].includes(path) && c.req.method !== 'GET') throw new AccessError(403, '操作未登记');
  // Normalize segment encodings/trailing slashes before dispatch, retaining the
  // original request for SvelteKit's data protocol and business handlers.
  if (path === '/data' || path.startsWith('/data/')) return dataRequest(c.req.raw, c.env);
  await next();
});
app.on('GET', ['/auth/login', '/financing/login'], c => login(c.req.raw, c.env));
app.get('/auth/callback', c => callback(c.req.raw, c.env));
// The single aggregate endpoint is hosted by Cloudflare MCP Portals. Do not
// redirect POST requests across origins with caller credentials or proxy tools.
app.all('/mcp', c => c.json({ detail: '统一 MCP 入口已迁移至 Cloudflare MCP 门户', mcpUrl: 'https://mcp.hasbai.xyz/mcp' }, 410, { 'Cache-Control': 'no-store' }));
app.on(['GET', 'POST'], ['/auth/logout', '/financing/logout'], c => { requireSameOrigin(c.req.raw); return logout(c.env); });
app.all('*', async c => {
    const request = c.req.raw, env = c.env;
    const path = canonicalPath(request);
    const route = dashboardRoute(request);
    const { user } = await authorizeRequest(request, env, route);
    if (path === '/auth/permissions') {
      const snapshot = await permissionCache(env).permissions(user!.authorization!.roles.map(role => role.id));
      return Response.json({ roles: user!.authorization!.roles, ...snapshot }, { headers: { 'Cache-Control': 'no-store, private', Vary: 'Cookie, Authorization' } });
    }
    if (path === '/auth/permissions/refresh') {
      const snapshot = await permissionCache(env).refresh();
      return Response.json({ success: true, updatedAt: snapshot.updatedAt }, { headers: { 'Cache-Control': 'no-store, private' } });
    }
    if (path === '/auth/session') return Response.json({ ...publicSession(user), enabled: true }, { headers: { 'Cache-Control': 'no-store, private', Vary: 'Cookie, Authorization' } });
    if (path === '/api/profile') return await profileRequest(request, env, user);
    const response = await env.DASHBOARD.fetch(forwardedRequest(request, { version: 1, user, choice: { status: 401 } }));
    if (response.status === 101) return response;
    const result = new Response(response.body, response);
    if (user) {
      result.headers.set('Cache-Control', 'no-store, private');
      result.headers.append('Vary', 'Cookie, Authorization');
    }
    result.headers.set('X-Eastmoney-Gateway', '1');
    return request.method === 'HEAD' ? new Response(null, result) : result;
});
app.onError((error, c) => {
    const request = c.req.raw;
    if (error instanceof ProfileError) return Response.json({ detail: error.message }, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
    if (error instanceof AccessError && error.status === 401 && request.method === 'GET'
      && !/^\/(?:api(?:\/|$)|data(?:\/|$)|mcp(?:\/|$))/.test(new URL(request.url).pathname)
      && (request.headers.get('Accept')?.includes('text/html') || new URL(request.url).pathname.endsWith('/__data.json'))) {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/__data\.json$/, '');
      if (url.pathname.endsWith('/__data.json')) return Response.json({ type: 'redirect', location: loginUrl(path + url.search) }, { headers: { 'Cache-Control': 'no-store, private' } });
      return new Response(null, { status: 303, headers: { Location: loginUrl(path + url.search), 'Cache-Control': 'no-store, private' } });
    }
    return accessFailure(error);
});
export function gatewayRequest(request: Request, env: Env): Promise<Response> { return Promise.resolve(app.fetch(request, env)); }
