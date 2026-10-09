import { Buffer } from 'node:buffer';
import type { SiteIdentity } from './lib/identity.ts';
import { AccessError } from './lib/server/access.ts';

export const CONTEXT_HEADER = 'X-Eastmoney-Gateway-Context';
export interface GatewayContext {
  version: 1;
  user: SiteIdentity | null;
  choice: { status: 204 | 401 | 403 | 503 };
}

/** Trust is the named Service Binding. Incoming headers never create this context. */
export function forwardedRequest(request: Request, context: GatewayContext): Request {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (/^(?:authorization|cookie|cf-access-.*|x-(?:eastmoney|internal|user|auth|permission|role).*|forwarded|x-forwarded-.*)$/i.test(name)) headers.delete(name);
  }
  headers.set(CONTEXT_HEADER, Buffer.from(JSON.stringify(context)).toString('base64url'));
  return new Request(request, { headers, redirect: 'manual' });
}

/** A terminated private Worker is a backend failure, not an identity failure. */
export async function backendResponse(service: Pick<Fetcher, 'fetch'>, request: Request,
  backend: 'dashboard' | 'quant-report', route: string | null): Promise<Response> {
  try { return await service.fetch(request); }
  catch (error) {
    const ray = request.headers.get('CF-Ray');
    console.error(JSON.stringify({ event: 'gateway_backend_failed', backend, route, method: request.method,
      ...(ray && /^[a-z0-9-]{1,64}$/i.test(ray) ? { rayId: ray } : {}),
      reason: error instanceof Error && /(?:exceeded.*cpu|cpu.*limit)/i.test(error.message) ? 'cpu_limit' : 'binding_failure' }));
    // Never replay mutations: a failed response does not prove the write rolled back.
    throw new AccessError(503, '业务服务暂时不可用，请稍后重试', 'BACKEND_UNAVAILABLE');
  }
}
