import { StreamableHTTPTransport } from '@hono/mcp';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { Context } from 'hono';
import { authorizeData } from './lib/server/authorization.ts';
import { forwardedRequest } from './forward.ts';
import { requireSameOrigin } from './policy.ts';
import { readProfileJson } from './lib/server/profile.ts';

type Source = 'data' | 'search';
const PREFIXES: readonly Source[] = ['data', 'search'];

function object(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new McpError(ErrorCode.InvalidParams, 'Invalid research options');
  return value as Record<string, unknown>;
}

export function researchArguments(args: Record<string, unknown> = {}, now = Date.now()): Record<string, unknown> {
  const options = object(args.ai_search_options), retrieval = object(options.retrieval), filters = object(retrieval.filters);
  const published = object(filters.published_at);
  const day = 86400000, shanghaiOffset = 8 * 3600000;
  const todayEnd = Math.floor((now + shanghaiOffset) / day) * day - shanghaiOffset + day - 1;
  const upper = published.$lte ?? todayEnd;
  const lower = published.$gte ?? (typeof upper === 'number' ? Math.floor((upper + shanghaiOffset) / day) * day - shanghaiOffset - 6 * day : undefined);
  if (typeof lower !== 'number' || typeof upper !== 'number' || !Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper) {
    throw new McpError(ErrorCode.InvalidParams, 'published_at requires an ordered Unix millisecond range');
  }
  return { ...args, ai_search_options: { ...options, retrieval: { ...retrieval, max_num_results: 50,
    filters: { ...filters, published_at: { ...published, $gte: lower, $lte: upper } } } } };
}

async function withClient<T>(source: Source, env: Env, signal: AbortSignal, execute: (client: Client) => Promise<T>): Promise<T> {
  const url = new URL(source === 'data' ? '/data/mcp' : env.AI_SEARCH_MCP_URL, env.SITE_ORIGIN);
  const client = new Client({ name: 'eastmoney-gateway', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: async (input, init) => {
      const target = new URL(input instanceof Request ? input.url : String(input));
      if (target.origin !== url.origin || target.pathname !== url.pathname) throw new Error('Unexpected MCP upstream URL');
      // Never propagate user tokens/cookies to either upstream. Data trust comes
      // from GatewayData; AI Search receives only the MCP protocol headers.
      const request = new Request(target, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]), redirect: 'error' });
      if (source === 'search') request.headers.set('Origin', env.SITE_ORIGIN);
      const response = source === 'data'
        ? await env.DATA.fetch(forwardedRequest(request, { version: 1, user: null, choice: { status: 204 } }))
        : await fetch(request);
      return response;
    },
  });
  try {
    await client.connect(transport, { timeout: 60000 });
    return await execute(client);
  } finally { await client.close(); }
}

export async function unifiedMcp(context: Context<{ Bindings: Env }>): Promise<Response> {
  await authorizeData(context.req.raw, context.env);
  if (!context.req.header('Authorization')) requireSameOrigin(context.req.raw);
  if (context.req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } });
  const message = await readProfileJson(context.req.raw, 65536);
  const server = new Server({ name: 'eastmoney', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Each source has its own bounded cursor sequence; fail explicitly instead
    // of silently presenting an incomplete catalog as a healthy unified server.
    const tools = [];
    for (const source of PREFIXES) {
      const sourceTools = await withClient(source, context.env, context.req.raw.signal, async client => {
        const found = []; const cursors = new Set<string>(); let cursor: string | undefined;
        do {
          const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: 60000 });
          found.push(...result.tools.filter(tool => source !== 'search' || tool.name === 'search').map(tool => ({ ...tool, name: source + '_' + tool.name,
            ...(source === 'search' ? { description: (tool.description ?? '') + ' 默认最近 7 个上海自然日；可用 published_at 的 Unix 毫秒范围覆盖，固定最多 50 条。' } : {}),
          })));
          cursor = result.nextCursor;
          if (cursor && (cursors.has(cursor) || cursors.size >= 10)) throw new Error('Invalid MCP pagination');
          if (cursor) cursors.add(cursor);
        } while (cursor);
        return found;
      });
      tools.push(...sourceTools);
    }
    return { tools };
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const separator = request.params.name.indexOf('_');
    const source = request.params.name.slice(0, separator);
    if (separator < 1 || !PREFIXES.includes(source as Source)) throw new McpError(ErrorCode.InvalidParams, 'Unknown MCP tool');
    const name = request.params.name.slice(separator + 1);
    // The project research endpoint exposes search only. Credit material is not
    // a source here, and no caller can select an upstream URL.
    if (source === 'search' && name !== 'search') throw new McpError(ErrorCode.InvalidParams, 'Unknown research tool');
    const args = source === 'search' ? researchArguments(request.params.arguments) : request.params.arguments;
    try {
      return await withClient(source as Source, context.env, context.req.raw.signal,
        client => client.callTool({ name, arguments: args }, undefined, { timeout: 60000 }));
    } catch {
      return { isError: true, content: [{ type: 'text', text: 'MCP 上游暂时不可用，请稍后重试。' }] };
    }
  });
  const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(context, message) ?? new Response(null, { status: 202 });
    response.headers.set('Cache-Control', 'no-store, private');
    response.headers.set('Vary', 'Cookie, Authorization');
    return response;
  } finally { await server.close(); }
}
