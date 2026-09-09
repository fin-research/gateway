import { Kind, parse, getOperationAST, type SelectionSetNode, type FragmentDefinitionNode } from 'graphql';
import { readProfileJson } from './lib/server/profile.ts';
import { authorizeData } from './lib/server/authorization.ts';
import { AccessError } from './lib/server/access.ts';
import { forwardedRequest, type GatewayContext } from './forward.ts';
import { canonicalPath, publicDataRead, requireSameOrigin } from './policy.ts';

export const CHOICE_FIELDS = new Set(['choiceCsd', 'choiceCss', 'choiceCtr', 'choiceEdb', 'choiceDataStatistics']);
export function hasChoiceField(query: string, operationName?: string): boolean {
  const document = parse(query, { maxTokens: 15000 });
  const operation = getOperationAST(document, operationName);
  if (!operation) return false; // GraphQL will reject an ambiguous/unknown operation.
  const fragments = new Map<string, FragmentDefinitionNode>(document.definitions.filter(node => node.kind === Kind.FRAGMENT_DEFINITION).map(node => [node.name.value, node]));
  const visited = new Set<string>();
  function walk(selection: SelectionSetNode): boolean {
    for (const node of selection.selections) {
      if (node.kind === Kind.FIELD && CHOICE_FIELDS.has(node.name.value)) return true;
      if (node.kind === Kind.INLINE_FRAGMENT && walk(node.selectionSet)) return true;
      if (node.kind === Kind.FRAGMENT_SPREAD && !visited.has(node.name.value)) {
        visited.add(node.name.value);
        const fragment = fragments.get(node.name.value);
        if (fragment && walk(fragment.selectionSet)) return true;
      }
    }
    return false;
  }
  return walk(operation.selectionSet);
}

export async function dataRequest(request: Request, env: Env): Promise<Response> {
  const context: GatewayContext = { version: 1, user: null, choice: { status: 401 } };
  const path = canonicalPath(request);
  if (publicDataRead(request)) return env.DATA.fetch(forwardedRequest(request, context));
  if (path === '/data/graphql' && ['GET', 'HEAD', 'POST'].includes(request.method)) {
    if (request.method === 'POST') {
      // Bound before cloning; reconstruct the same body for the Data executor.
      const body = await readProfileJson(request, 65536);
      const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
      const headers = new Headers(request.headers); headers.delete('Content-Length');
      request = new Request(request, { headers, body: JSON.stringify(body) });
      let needsIdentity = false;
      try { needsIdentity = typeof input.query === 'string' && hasChoiceField(input.query, typeof input.operationName === 'string' ? input.operationName : undefined); }
      catch { /* malformed query is rejected by Data; Choice remains denied */ }
      if (needsIdentity) {
        try { await authorizeData(request, env); if (!request.headers.has('Authorization')) requireSameOrigin(request); context.choice.status = 204; }
        catch (error) { context.choice.status = error instanceof AccessError ? error.status : 503; }
      }
    }
    return env.DATA.fetch(forwardedRequest(request, context));
  }
  await authorizeData(request, env);
  if (!request.headers.has('Authorization')) requireSameOrigin(request);
  context.choice.status = 204;
  return env.DATA.fetch(forwardedRequest(request, context));
}
