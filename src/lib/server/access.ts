/** Shared error shape; no Cloudflare Access credentials are accepted. */
export class AccessError extends Error {
  readonly status: 401 | 403 | 503;
  constructor(status: 401 | 403 | 503, message: string) { super(message); this.status = status; }
}

export function accessFailure(error: unknown): Response {
  const failure = error instanceof AccessError ? error : new AccessError(503, '身份服务暂时不可用');
  return Response.json({ detail: failure.message, code: failure.status === 401 ? 'LOGIN_REQUIRED' : 'ACCESS_DENIED', loginUrl: '/auth/login' }, {
    status: failure.status, headers: { 'Cache-Control': 'no-store, private', Vary: 'Cookie, Authorization' },
  });
}
