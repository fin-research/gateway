import { Buffer } from 'node:buffer';
import type { SiteIdentity } from './lib/identity.ts';

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
