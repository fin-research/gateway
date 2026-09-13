import { EncryptJWT, jwtDecrypt, base64url } from 'jose';
import { z } from 'zod';
import { AccessError } from './lib/server/access.ts';
import { readProfileJson } from './lib/server/profile.ts';
import { safeReturnTo } from './lib/auth-navigation.ts';
import { auth0Issuer, verifyToken, userClaims } from './tokens.ts';

export const SESSION_COOKIE = '__Host-eastmoney_session';
export const SESSION_MAX_AGE = 24 * 3600;
const TRANSACTION_COOKIE = '__Host-eastmoney_login';
type SessionEnv = Pick<Env, 'SESSION_SECRET' | 'SITE_ORIGIN' | 'AUTH0_LOGIN_DOMAIN' | 'AUTH0_CLIENT_ID' | 'AUTH0_CLIENT_SECRET' | 'AUTH0_AUDIENCE' | 'AUTH0_ORGANIZATION_ID' | 'AUTH0_MACHINE_CLIENT_IDS'>;
const now = () => Math.floor(Date.now() / 1000);
const random = () => base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
function key(env: SessionEnv) {
  try { const value = base64url.decode(env.SESSION_SECRET); if (value.length === 32) return value; } catch { /* fail closed */ }
  throw new AccessError(503, '会话服务尚未配置完成');
}
export function readCookie(request: Request, name: string): string | null {
  const matches = (request.headers.get('Cookie') ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(name + '='));
  if (matches.length > 1) throw new AccessError(401, '会话无效，请重新登录');
  return matches[0]?.slice(name.length + 1) || null;
}
function cookie(name: string, value: string, maxAge: number) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}
async function seal(payload: Record<string, unknown>, purpose: string, expiry: number, env: SessionEnv) {
  return new EncryptJWT(payload).setProtectedHeader({ alg: 'dir', enc: 'A256GCM' }).setIssuer(env.SITE_ORIGIN)
    .setAudience(purpose).setIssuedAt().setExpirationTime(expiry).encrypt(key(env));
}
async function unseal(value: string, purpose: string, env: SessionEnv) {
  const secret = key(env);
  try { return (await jwtDecrypt(value, secret, { issuer: env.SITE_ORIGIN, audience: purpose, keyManagementAlgorithms: ['dir'], contentEncryptionAlgorithms: ['A256GCM'], requiredClaims: ['iat', 'exp'] })).payload; }
  catch { throw new AccessError(401, '会话已失效，请重新登录'); }
}
export async function accessToken(request: Request): Promise<string | null> {
  const authorization = request.headers.get('Authorization');
  if (authorization !== null) {
    if (!/^Bearer [A-Za-z0-9_.-]+$/.test(authorization)) throw new AccessError(401, '登录凭证无效');
    return authorization.slice(7);
  }
  const value = readCookie(request, SESSION_COOKIE);
  if (!value) return null;
  if (value.length > 3800 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) throw new AccessError(401, '会话无效，请重新登录');
  // Extraction is not authentication: the caller must verify the Auth0 signature and claims.
  return value;
}
export function clearSession(headers: Headers): void {
  for (const name of [SESSION_COOKIE, TRANSACTION_COOKIE, 'CF_Authorization', 'credit-session']) headers.append('Set-Cookie', cookie(name, '', 0));
  headers.append('Set-Cookie', 'financing_session=; Path=/financing; Secure; HttpOnly; SameSite=Lax; Max-Age=0');
}

/** Expire retired host-only cookies when their browser next reaches the Gateway. */
export function clearLegacyCookies(request: Request, response: Response): Response {
  if (response.status === 101) return response;
  const retired = new Set<string>();
  for (const entry of (request.headers.get('Cookie') ?? '').split(';')) {
    const [name, value = ''] = entry.trim().split('=');
    if (name === 'credit-session' || name === SESSION_COOKIE && value.split('.').length === 5) retired.add(name);
  }
  const issued = response.headers.getSetCookie();
  for (const name of retired) if (issued.some(value => value.startsWith(name + '='))) retired.delete(name);
  if (!retired.size) return response;
  const result = new Response(response.body, response);
  for (const name of retired) result.headers.append('Set-Cookie', cookie(name, '', 0));
  result.headers.set('Cache-Control', 'no-store, private');
  result.headers.append('Vary', 'Cookie');
  return result;
}
function redirect(location: string, headers = new Headers()) {
  headers.set('Location', location); headers.set('Cache-Control', 'no-store, private'); headers.set('Referrer-Policy', 'no-referrer');
  return new Response(null, { status: 303, headers });
}
export async function login(request: Request, env: SessionEnv) {
  const url = new URL(request.url);
  const state = random(), nonce = random(), verifier = random();
  const expiry = now() + 600;
  const target = new URL('authorize', auth0Issuer(env));
  target.search = new URLSearchParams({ client_id: env.AUTH0_CLIENT_ID, response_type: 'code',
    redirect_uri: env.SITE_ORIGIN + '/auth/callback', audience: env.AUTH0_AUDIENCE, scope: 'openid profile email',
    organization: env.AUTH0_ORGANIZATION_ID, state, nonce, code_challenge: base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))), code_challenge_method: 'S256' }).toString();
  const transaction = await seal({ state, nonce, verifier, returnTo: safeReturnTo(url.searchParams.get('returnTo')), popup: z.string().regex(/^[A-Za-z0-9_-]{32,64}$/).optional().parse(url.searchParams.get('popup') ?? undefined) }, 'login', expiry, env);
  return redirect(target.toString(), new Headers({ 'Set-Cookie': cookie(TRANSACTION_COOKIE, transaction, 600) }));
}
export async function callback(request: Request, env: SessionEnv, fetcher: typeof fetch = fetch) {
  const headers = new Headers({ 'Set-Cookie': cookie(TRANSACTION_COOKIE, '', 0), 'Cache-Control': 'no-store, private', 'Referrer-Policy': 'no-referrer' });
  let popup: string | undefined;
  try {
    const params = new URL(request.url).searchParams;
    const raw = readCookie(request, TRANSACTION_COOKIE);
    if (!raw || params.getAll('state').length !== 1) throw new AccessError(401, '登录事务无效，请重新登录');
    const transaction = z.object({ state: z.string(), nonce: z.string(), verifier: z.string(), returnTo: z.string(), popup: z.string().regex(/^[A-Za-z0-9_-]{32,64}$/).optional() }).parse(await unseal(raw, 'login', env));
    if (params.get('state') !== transaction.state) throw new AccessError(401, '登录事务不匹配');
    popup = transaction.popup;
    if (params.getAll('code').length !== 1 || params.has('error')) throw new AccessError(401, '登录未完成，请重试');
    const code = params.get('code')!;
    if (!code || code.length > 4096) throw new AccessError(401, '登录事务无效');
    const response = await fetcher(new URL('oauth/token', auth0Issuer(env)), { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', client_id: env.AUTH0_CLIENT_ID,
        client_secret: env.AUTH0_CLIENT_SECRET, redirect_uri: env.SITE_ORIGIN + '/auth/callback', code, code_verifier: transaction.verifier }) });
    if (!response.ok) { await response.body?.cancel(); throw new AccessError(response.status >= 500 ? 503 : 401, '登录交换失败，请重新登录'); }
    const tokens = z.object({ access_token: z.string(), id_token: z.string(), token_type: z.literal('Bearer') }).parse(await readProfileJson(response, 32768));
    const [identity, access] = await Promise.all([verifyToken(tokens.id_token, env, 'id'), verifyToken(tokens.access_token, env)]);
    if (identity.nonce !== transaction.nonce || identity.sub !== access.sub || access.azp !== env.AUTH0_CLIENT_ID
      || typeof identity.email !== 'string' || identity.email.toLowerCase() !== String(userClaims(access).email).toLowerCase()) throw new AccessError(401, '登录身份不匹配');
    const expiry = Math.min(access.exp!, access.iat! + SESSION_MAX_AGE, now() + SESSION_MAX_AGE);
    if (expiry <= now()) throw new AccessError(401, '登录已失效，请重新登录');
    const session = tokens.access_token;
    if (session.length > 3800) throw new AccessError(503, '会话超出安全长度');
    headers.append('Set-Cookie', cookie(SESSION_COOKIE, session, expiry - now()));
    return popup ? popupResult(popup, true, env, headers) : redirect(safeReturnTo(transaction.returnTo), headers);
  } catch (error) {
    if (popup) return popupResult(popup, false, env, headers);
    return Response.json({ detail: error instanceof AccessError ? error.message : '登录失败，请重新登录' }, { status: error instanceof AccessError ? error.status : 503, headers });
  }
}
export function logout(env: SessionEnv) {
  const target = new URL('v2/logout', auth0Issuer(env));
  target.search = new URLSearchParams({ client_id: env.AUTH0_CLIENT_ID, returnTo: env.SITE_ORIGIN + '/' }).toString();
  const headers = new Headers(); clearSession(headers);
  return redirect(target.toString(), headers);
}

/** No credentials or return URL cross the window boundary. The parent rechecks /auth/session. */
function popupResult(id: string, ok: boolean, env: SessionEnv, headers: Headers): Response {
  const nonce = random();
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
  headers.set('X-Content-Type-Options', 'nosniff');
  const message = JSON.stringify({ type: 'eastmoney:login', id, ok });
  const origin = JSON.stringify(new URL(env.SITE_ORIGIN).origin).replace(/</g, '\u003c');
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${ok ? '登录成功' : '登录未完成'}</title><body><p>${ok ? '登录成功，可以关闭此窗口并回到原页面。' : '登录未完成，请回到原页面重试。'}</p><script nonce="${nonce}">
    history.replaceState(null, '', '/auth/callback');
    const message = ${message};
    if (window.opener) window.opener.postMessage(message, ${origin});
    try { const channel = new BroadcastChannel('eastmoney:login:' + message.id); channel.postMessage(message); channel.close(); } catch {}
    if (message.ok) window.close();
  </script></body></html>`, { headers });
}
