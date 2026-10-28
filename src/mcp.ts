import { createMcpHandler } from 'agents/mcp/server';
import { Server, ProtocolError, ProtocolErrorCode, type Tool, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { forwardedRequest, type GatewayContext } from './forward.ts';
import type { SiteIdentity } from './lib/identity.ts';

const dashboardTools = new Set(['market_report', 'save_market_report', 'hotspots', 'policies', 'research_search', 'policy_articles',
  'update_policy_articles', 'article', 'news', 'commentaries', 'commentary', 'commentary_revisions',
  'create_commentary', 'update_commentary', 'economic_indicators', 'credit_report', 'bond_ledger']);
const dataTools = new Set(['trading_days', 'chinamoney_shibor', 'omo', 'cfets', 'cfets_histories', 'bond_top_case',
  'futures_latest', 'margin', 'primary_issues', 'broker_bond_registrations', 'today_trades', 'favorite_quotes',
  'bond_infos', 'news_list', 'news_detail', 'wechat_articles', 'industry', 'choice_csd', 'choice_css', 'choice_ctr',
  'choice_edb', 'choice_data_statistics']);
const MAX_REQUEST = 1024 * 1024, MAX_RESPONSE = 8 * 1024 * 1024;
const toolList = z.object({ tools: z.array(z.object({ name: z.string(), inputSchema: z.object({ type: z.literal('object') }).passthrough() }).passthrough()).max(150), nextCursor: z.string().optional() });
const callResult = z.object({ content: z.array(z.record(z.string(), z.unknown())), isError: z.boolean().optional() }).passthrough();

async function boundedText(source: Request | Response, limit: number) {
  const reader = source.body?.getReader(); if (!reader) return '';
  let size = 0, text = ''; const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > limit) throw new RangeError('内容超过 MCP 大小限制');
      text += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Stateless private JSON-RPC adapts the applications' transport versions.
 * User tokens never leave Gateway; application schemas and business rules stay there. */
async function applicationRpc(owner: 'dashboard' | 'data', method: string, params: unknown,
  env: Env, context: GatewayContext, signal: AbortSignal) {
  const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    Host: new URL(env.SITE_ORIGIN).host, Origin: env.SITE_ORIGIN, 'MCP-Protocol-Version': '2025-11-25' });
  const path = owner === 'dashboard' ? '/api/mcp' : '/data/mcp';
  const request = forwardedRequest(new Request(env.SITE_ORIGIN + path, { method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal }), context);
  const response = await (owner === 'dashboard' ? env.DASHBOARD : env.DATA).fetch(request);
  if (!response.ok) { await response.body?.cancel(); throw new Error('MCP application unavailable'); }
  const raw = await boundedText(response, MAX_RESPONSE);
  // Both upstreams are stateless: exactly one finite response, JSON or SSE.
  const value = response.headers.get('Content-Type')?.includes('text/event-stream')
    ? raw.replace(/\r\n/g, '\n').split('\n\n').map(event => event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'))
      .filter(Boolean).map(data => JSON.parse(data)).find(message => message.id === 1)
    : JSON.parse(raw);
  if (!value || value.jsonrpc !== '2.0' || value.id !== 1) throw new Error('Invalid MCP application response');
  if (value.error) throw new ProtocolError(value.error.code, value.error.message);
  return value.result;
}

export async function handleMcp(request: Request, env: Env, user: SiteIdentity): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } });
  let body: string;
  try { body = await boundedText(request, MAX_REQUEST); }
  catch (error) {
    if (error instanceof RangeError) return Response.json({ error: error.message }, { status: 413, headers: { 'Cache-Control': 'no-store' } });
    throw error;
  }
  const headers = new Headers(request.headers); headers.delete('Content-Length');
  const context: GatewayContext = { version: 1, user, choice: { status: 204 } };
  const handler = createMcpHandler(() => {
    const server = new Server({ name: 'eastmoney', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', async params => {
      if (params.params?.cursor) throw new ProtocolError(ProtocolErrorCode.InvalidParams, '目录不使用游标');
      const results = await Promise.all((['dashboard', 'data'] as const).map(async owner => {
        const list = toolList.parse(await applicationRpc(owner, 'tools/list', {}, env, context, request.signal));
        if (list.nextCursor) throw new Error('Unexpected application pagination');
        const published = owner === 'dashboard' ? dashboardTools : dataTools;
        return list.tools.filter(tool => published.has(tool.name));
      }));
      const tools = results.flat();
      if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error('Duplicate MCP tool name');
      return { tools: tools as Tool[] };
    });
    server.setRequestHandler('tools/call', async call => {
      const name = call.params.name;
      const owner = dashboardTools.has(name) ? 'dashboard' : dataTools.has(name) ? 'data' : undefined;
      if (!owner) throw new ProtocolError(ProtocolErrorCode.InvalidParams, '工具未发布');
      try { return callResult.parse(await applicationRpc(owner, 'tools/call', call.params, env, context, request.signal)) as CallToolResult; }
      catch (error) {
        if (error instanceof ProtocolError) throw error;
        return { isError: true, content: [{ type: 'text', text: '应用服务暂时不可用；修改操作请先核对当前记录，避免重复提交' }] };
      }
    });
    return server;
  }, { route: '/mcp', corsOptions: false, allowedHostnames: ['eastmoney.hasbai.xyz'], allowedOriginHostnames: ['eastmoney.hasbai.xyz'] });
  const response = await handler.fetch(new Request(request, { headers, body }));
  const result = new Response(response.body, response);
  result.headers.set('Cache-Control', 'no-store, private'); result.headers.set('Vary', 'Authorization, Origin');
  return result;
}
