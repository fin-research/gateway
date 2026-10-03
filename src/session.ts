import { AccessError } from './lib/server/access.ts';

// These cookies are cleanup targets only. None is an authentication source.
export const SESSION_COOKIE = '__Host-eastmoney_session';
const RETIRED_COOKIES = [SESSION_COOKIE, '__Host-eastmoney_login', 'CF_Authorization', 'credit-session', 'financing_session'];

export async function accessToken(request: Request): Promise<string | null> {
  const authorization = request.headers.get('Authorization');
  if (authorization === null) return null;
  const bearer = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization);
  if (!bearer) throw new AccessError(401, '登录凭证无效');
  return bearer[1]!;
}

/** Cleanup does not parse, authenticate, or preserve retired cookie credentials. */
export function clearSession(headers: Headers): void {
  for (const name of RETIRED_COOKIES) headers.append('Set-Cookie', `${name}=; Path=${name === 'financing_session' ? '/financing' : '/'}; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
}
export function clearLegacyCookies(request: Request, response: Response): Response {
  if (response.status === 101) return response;
  const names = (request.headers.get('Cookie') ?? '').split(';').map(entry => entry.trim().split('=')[0]);
  if (!names.some(name => RETIRED_COOKIES.includes(name!))) return response;
  const result = new Response(response.body, response);
  clearSession(result.headers);
  result.headers.set('Cache-Control', 'no-store, private');
  result.headers.append('Vary', 'Cookie');
  return result;
}
