import { authorizeRequest } from './lib/server/authorization.ts';
import { accessFailure, AccessError } from './lib/server/access.ts';
import { loginUrl } from './lib/auth-navigation.ts';
import { canonicalPath, dashboardRoute, clientPageShell, pageDataRequest } from './policy.ts';
import { forwardedRequest } from './forward.ts';
import { clearLegacyCookies } from './session.ts';
import { dataRequest } from './data.ts';
import { permissionCache } from './lib/server/permission-cache.ts';
import { profileRequest } from './identity-service.ts';
import { createDirectory } from './lib/server/auth0-directory.ts';
import { Hono } from 'hono';
import { ProfileError, readProfileJson } from './lib/server/profile.ts';

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
// The single aggregate endpoint is hosted by Cloudflare MCP Portals. Do not
// redirect POST requests across origins with caller credentials or proxy tools.
app.all('/mcp', c => c.json({ detail: '统一 MCP 入口已迁移至 Cloudflare MCP 门户', mcpUrl: 'https://mcp.hasbai.xyz/mcp' }, 410, { 'Cache-Control': 'no-store' }));
app.all('/auth/session', c => c.json({ detail: '入口已移除' }, 404, { 'Cache-Control': 'no-store' }));
app.all('*', async c => {
    const request = c.req.raw, env = c.env;
    const path = canonicalPath(request);
    const route = dashboardRoute(request);
    if (clientPageShell(request, route)) {
      const response = await env.DASHBOARD.fetch(forwardedRequest(request, { version: 1, user: null, choice: { status: 401 } }));
      const shell = new Response(response.body, response);
      shell.headers.set('Cache-Control', 'no-store');
      return shell;
    }
    const { user, permissionUpdatedAt } = await authorizeRequest(request, env, route);
    if (path === '/auth/permissions') {
      return Response.json({ permissions: user!.authorization!.permissions, updatedAt: permissionUpdatedAt },
        { headers: { 'Cache-Control': 'no-store, private', Vary: 'Cookie, Authorization' } });
    }
    if (path === '/auth/permissions/refresh') {
      const snapshot = await permissionCache(env).refresh();
      return Response.json({ success: true, updatedAt: snapshot.updatedAt }, { headers: { 'Cache-Control': 'no-store, private' } });
    }
    if (path === '/api/profile') return await profileRequest(request, env, user);
    if (path === '/api/management/people') {
      const headers = { 'Cache-Control': 'no-store, private', Vary: 'Cookie, Authorization' };
      if (request.method === 'GET' || request.method === 'HEAD') {
        const response = Response.json(await createDirectory(env).people(false), { headers });
        return request.method === 'HEAD' ? new Response(null, response) : response;
      }
      if (!request.headers.get('Content-Type')?.includes('application/json')) throw new ProfileError(415, '请提交 JSON 格式的人员资料');
      return Response.json(await createDirectory(env).updatePerson(await readProfileJson(request, 4096)), { headers });
    }
    const forwarded = forwardedRequest(request, { version: 1, user, choice: { status: 401 } });
    const response = path === '/financing-model/research'
      ? await env.QUANT_REPORT.fetch(new Request(new URL('/REPORT.html', request.url), forwarded))
      : await env.DASHBOARD.fetch(forwarded);
    if (response.status === 101) return response;
    const result = new Response(response.body, response);
    if (user) {
      result.headers.set('Cache-Control', path === '/financing-model/research' ? 'no-store, private, no-transform' : 'no-store, private');
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
      && (request.headers.get('Accept')?.includes('text/html') || pageDataRequest(request))) {
      const url = new URL(request.url);
      const path = canonicalPath(request);
      if (pageDataRequest(request)) return Response.json({ type: 'redirect', location: loginUrl(path + url.search) }, { headers: { 'Cache-Control': 'no-store, private' } });
      return new Response(null, { status: 303, headers: { Location: loginUrl(path + url.search), 'Cache-Control': 'no-store, private' } });
    }
    return accessFailure(error);
});
export async function gatewayRequest(request: Request, env: Env): Promise<Response> {
  const response = await app.fetch(request, env);
  return new URL(request.url).origin === env.SITE_ORIGIN ? clearLegacyCookies(request, response) : response;
}
