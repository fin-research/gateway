import { Auth0Error } from './auth0-management.js';

/** Shared error shape; no Cloudflare Access credentials are accepted. */
export class AccessError extends Error {
  readonly status: 401 | 403 | 503;
  readonly code: string;
  constructor(status: 401 | 403 | 503, message: string, code = status === 401 ? 'LOGIN_REQUIRED' : status === 503 ? 'IDENTITY_UNAVAILABLE' : 'ACCESS_DENIED') { super(message); this.status = status; this.code = code; }
}

export function accessFailure(error: unknown): Response {
  const failure = error instanceof AccessError ? error
    : error instanceof Auth0Error && error.code === 'AUTH0_RATE_LIMITED'
      ? new AccessError(503, error.message, 'IDENTITY_RATE_LIMITED')
      : new AccessError(503, '身份服务暂时不可用');
  return Response.json({ detail: failure.message, code: failure.code, loginUrl: '/auth/login' }, {
    status: failure.status, headers: { 'Cache-Control': 'no-store, private', Vary: 'Cookie, Authorization', ...(failure.status === 401 ? { 'WWW-Authenticate': 'Bearer realm="eastmoney"' } : {}) },
  });
}
