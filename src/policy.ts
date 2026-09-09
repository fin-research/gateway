import { ROUTE_PERMISSIONS, requestPolicy } from './lib/server/permission-policy.ts';
import { AccessError } from './lib/server/access.ts';

export function canonicalPath(request: Request): string {
  const path = new URL(request.url).pathname;
  // Reject encodings that different routers could interpret as extra segments.
  if (/%(?:2f|5c|00|25)/i.test(path)) throw new AccessError(403, '请求路径无效');
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { throw new AccessError(403, '请求路径无效'); }
  if (/[\\\x00-\x1f\x7f?#]/.test(decoded) || decoded.includes('//')) throw new AccessError(403, '请求路径无效');
  return decoded.replace(/\/__data\.json$/, '').replace(/\/$/, '') || '/';
}

const routes = Object.keys(ROUTE_PERMISSIONS).map(id => {
  const pattern = id.split('/').map(segment => {
    if (/^\[\[.+\]\]$/.test(segment)) return '(?:/[^/]+)?';
    if (/^\[\.\.\..+\]$/.test(segment)) return '/.+';
    if (segment === '') return '';
    return '/' + segment.split(/(\[[^\]]+\])/).map(part => /^\[/.test(part) ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  }).join('');
  return { id, pattern: new RegExp('^' + (pattern || '/') + '$'), dynamic: (id.match(/\[/g) ?? []).length };
}).sort((a, b) => a.dynamic - b.dynamic || b.id.length - a.id.length);

export function dashboardRoute(request: Request): string | null {
  const path = canonicalPath(request);
  return routes.find(route => route.pattern.test(path))?.id ?? null;
}
export function dashboardPolicy(request: Request) { return requestPolicy(request, dashboardRoute(request)); }

export const PUBLIC_DATA_RESOURCES = new Set([
  '/health', '/config', '/docs', '/redoc', '/openapi.json', '/omo', '/cfets', '/cfets-histories', '/bond-top-case',
  '/futures-latest', '/margin', '/industry', '/stock-summary', '/primary-issues', '/broker-bond-registrations',
  '/today-trades', '/favorite-quotes', '/bond-infos', '/news', '/wechat-articles',
]);
export function publicDataRead(request: Request): boolean {
  const path = canonicalPath(request).slice('/data'.length);
  return ['GET', 'HEAD'].includes(request.method) && (PUBLIC_DATA_RESOURCES.has(path) || /^\/news\/[^/]+$/.test(path));
}
export function requireSameOrigin(request: Request): void {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.get('Origin') !== new URL(request.url).origin) throw new AccessError(403, '仅允许从本站提交操作');
}
