import { matchDashboardRoute } from './lib/route-permissions.ts';
import { ROUTE_PERMISSIONS, requestPolicy } from './lib/server/permission-policy.ts';
import { AccessError } from './lib/server/access.ts';

export function canonicalPath(request: Request): string {
  const path = new URL(request.url).pathname;
  // Reject encodings that different routers could interpret as extra segments.
  if (/%(?:2f|5c|00|25)/i.test(path)) throw new AccessError(403, '请求路径无效');
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { throw new AccessError(403, '请求路径无效'); }
  if (/[\\\x00-\x1f\x7f?#]/.test(decoded) || decoded.includes('//')) throw new AccessError(403, '请求路径无效');
  return decoded.replace(/\.html__data\.json$/, '.html').replace(/\/__data\.json$/, '').replace(/\/$/, '') || '/';
}

/** Match both SvelteKit data suffixes; encoded variants also fail closed. */
export function pageDataRequest(request: Request): boolean {
  return /(?:\/|\.html)__data\.json$/.test(decodeURIComponent(new URL(request.url).pathname).replace(/\/$/, ''));
}

export function dashboardRoute(request: Request): string | null {
  const path = canonicalPath(request);
  // The Quant research document is a read-only part of the existing model page.
  if (path === '/financing-model/research') return '/financing-model';
  return matchDashboardRoute(path);
}
export function dashboardPolicy(request: Request) { return requestPolicy(request, dashboardRoute(request)); }

export const PUBLIC_DATA_RESOURCES = new Set([
  '/chinamoney/shibor', '/health', '/config', '/docs', '/redoc', '/openapi.json', '/omo', '/cfets', '/cfets-histories', '/bond-top-case',
  '/futures-latest', '/margin', '/industry', '/trading-days', '/stock-summary', '/primary-issues', '/broker-bond-registrations',
  '/today-trades', '/favorite-quotes', '/bond-infos', '/news', '/wechat-articles',
]);
export function publicDataRead(request: Request): boolean {
  const path = canonicalPath(request).slice('/data'.length);
  return ['GET', 'HEAD'].includes(request.method) && (PUBLIC_DATA_RESOURCES.has(path) || /^\/news\/[^/]+$/.test(path));
}
export function requireSameOrigin(request: Request): void {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.get('Origin') !== new URL(request.url).origin) throw new AccessError(403, '仅允许从本站提交操作');
}

/** Exact CSR +page IDs: anonymous HTML contains only a shell, never business load data. */
export const CLIENT_PAGE_ROUTES = new Set([
  '/articles/[id]', '/bond', '/commentaries/[id]', '/credit-assistant', '/credit-workbench/[[view]]',
  '/financing', '/financing/bond-investors', '/financing/clients', '/financing/data', '/financing/debts/[id]',
  '/financing/liability-report', '/financing/projects', '/financing/projects/[id]',
  '/financing/sop', '/financing/sop/[id]', '/financing/sop/reminders', '/financing-model', '/fund-report',
  '/management', '/management/me', '/management/messenger', '/management/notifications', '/management/people',
  '/management/permissions', '/market-hotspots', '/news/[id]', '/policy-tracking', '/profile',
  '/secondary-bond-pool', '/trading-research', '/trading-research/[view]',
]);
export function clientPageShell(request: Request, routeId: string | null): boolean {
  return ['GET', 'HEAD'].includes(request.method) && request.headers.get('Accept')?.includes('text/html') === true
    && !pageDataRequest(request) && canonicalPath(request) !== '/financing-model/research'
    && routeId !== null && CLIENT_PAGE_ROUTES.has(routeId);
}
