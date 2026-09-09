import type { PermissionCode } from '../permissions.ts';
import { AccessError } from './access.ts';

type Policy = { permission?: PermissionCode; public?: boolean; login?: boolean };
export { ROUTE_PERMISSIONS } from '../route-permissions.ts';
import { ROUTE_PERMISSIONS, pagePermission } from '../route-permissions.ts';

export function actionNameFromUrl(url: URL): string {
  const names = [...url.searchParams.keys()].filter((name) => name.startsWith('/'));
  if (names.length > 1 || (names[0] && !/^\/[A-Za-z][A-Za-z0-9]*$/.test(names[0]))) throw new AccessError(403, '操作名称无效');
  return names[0]?.slice(1) ?? 'default';
}

export function requestPolicy(request: Request, routeId: string | null): Policy {
  const url = new URL(request.url);
  let path: string;
  try { path = decodeURIComponent(url.pathname).replace(/\/__data\.json$/, '').replace(/\/$/, '') || '/'; }
  catch { throw new AccessError(403, '请求路径无效'); }
  const method = request.method === 'HEAD' ? 'GET' : request.method;
  // Static files are not a substitute for an unregistered application endpoint.
  if (!routeId && method === 'GET' && (/^\/_app\//.test(path) || /^\/(favicon\.(ico|svg)|robots\.txt)$/.test(path) || /^\/institution-logos\/[a-z0-9-]+\.(ico|png|jpg)$/.test(path))) return { public: true };
  let value: PermissionCode | 'public' | 'login' | undefined;
  if (routeId === '/data/[...path]') {
    if (!['GET', 'POST'].includes(method)) throw new AccessError(403, '数据操作未登记');
    value = /^\/data\/choice(?:\/|$)/.test(path) ? 'login'
      : /^\/data\/camel(?:\/|$)/.test(path) ? 'login'
      : path === '/data/graphql' ? 'data.graphql:read' : method === 'GET' ? 'data.resource:read' : undefined;
  } else {
    const methods = ROUTE_PERMISSIONS[routeId ?? ''];
    const named = method === 'POST' ? actionNameFromUrl(url) : 'default';
    value = methods?.[`${method}:${named}`] ?? (named === 'default' ? methods?.[method] : undefined);
    if (method === 'GET') value = pagePermission(url.pathname, routeId);
    if (routeId === '/financing/data/api/[...path]' && path.endsWith('/rpc/liability_weekly_report_data') && method === 'POST') value = 'financing.report:read';
  }
  if (!value) throw new AccessError(403, '该入口或操作尚未登记权限');
  if (value === 'public') return { public: true };
  if (value === 'login') return { login: true };
  return { permission: value };
}
