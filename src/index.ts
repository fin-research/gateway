import { WorkerEntrypoint } from 'cloudflare:workers';
import { gatewayRequest } from './app.ts';
import { identityService } from './identity-service.ts';

export class IdentityService extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Promise<Response> { return identityService(request, this.env); }
}

export default { fetch: gatewayRequest } satisfies ExportedHandler<Env>;
