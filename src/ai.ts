import { z } from 'zod';
import { ProfileError, readProfileJson } from './lib/server/profile.ts';

const MODEL = 'gpt-6-luna';
const PROVIDER = 'custom-codex';
const PRIVATE = { 'Cache-Control': 'private, no-store, no-transform', Vary: 'Authorization, Origin', 'X-Content-Type-Options': 'nosniff' };
const requestSchema = z.object({
  model: z.literal(MODEL).optional(),
  input: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
  instructions: z.string().optional(),
  stream: z.boolean().optional(),
  tools: z.array(z.object({ type: z.enum(['function', 'web_search']) }).passthrough()).optional(),
  tool_choice: z.unknown().optional(),
  parallel_tool_calls: z.boolean().optional(),
  reasoning: z.object({ effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
    summary: z.string().optional(), context: z.string().optional() }).strict().optional(),
  text: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  prompt_cache_key: z.string().optional(),
  service_tier: z.string().optional(),
  truncation: z.literal('disabled').optional(),
  // Accept the stateless SDK default without sending persistence upstream.
  store: z.literal(false).optional(),
  background: z.literal(false).optional(),
  previous_response_id: z.null().optional(),
  conversation: z.null().optional(),
  include: z.array(z.string()).optional(),
}).strict();

const publicError = { code: 'AI_UPSTREAM_ERROR', message: '模型服务请求失败' };

/** Keep native successful events; provider errors must not expose account details. */
function safeEvent(frame: string): string {
  const lines = frame.split(/\r\n|\r|\n/);
  const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
  if (!data || data === '[DONE]') return frame;
  const value = JSON.parse(data);
  let changed = false;
  if (value.type === 'error') {
    return [...lines.filter(line => !line.startsWith('data:')), `data: ${JSON.stringify({ type: 'error', sequence_number: value.sequence_number, ...publicError, param: null })}`].join('\n');
  }
  if (value.response?.error) { value.response.error = publicError; changed = true; }
  if (value.error) { value.error = publicError; changed = true; }
  return changed ? [...lines.filter(line => !line.startsWith('data:')), `data: ${JSON.stringify(value)}`].join('\n') : frame;
}

function remoteReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(remoteReference);
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return item.type === 'item_reference' || 'file_id' in item || Object.values(item).some(remoteReference);
}

function failure(status: number, code: string, message: string, headers?: Headers): Response {
  return Response.json({ error: { type: 'gateway_error', code, message } }, { status, headers: { ...PRIVATE, ...Object.fromEntries(headers ?? []) } });
}

/** Called only after Gateway has authenticated and authorized the site user. */
export async function aiResponses(request: Request, env: Pick<Env, 'CLOUDFLARE_ACCOUNT_ID' | 'AI_GATEWAY_ID' | 'CF_AIG_TOKEN'>,
  fetcher: typeof fetch = fetch): Promise<Response> {
  if (request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    return failure(415, 'INVALID_CONTENT_TYPE', '请提交 JSON 请求');
  }
  if (Number(request.headers.get('Content-Length')) > 1024 * 1024) return failure(413, 'REQUEST_TOO_LARGE', '请求内容过大');
  let parsed;
  try { parsed = requestSchema.safeParse(await readProfileJson(request, 1024 * 1024)); }
  catch (error) {
    if (error instanceof ProfileError) return failure(error.status, 'INVALID_REQUEST', error.message);
    return failure(400, 'INVALID_REQUEST', '请求内容无效');
  }
  if (!parsed.success || remoteReference(parsed.data.input)) return failure(400, 'INVALID_REQUEST', 'Responses 请求参数无效或包含远端资源引用');
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.AI_GATEWAY_ID || !env.CF_AIG_TOKEN) return failure(503, 'AI_NOT_CONFIGURED', 'AI 服务尚未配置');
  const { store, background, previous_response_id, conversation, include, ...body } = parsed.data;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, 300_000);
  const cleanup = () => { clearTimeout(timeout); request.signal.removeEventListener('abort', abort); };
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) abort();
  try {
    const upstream = await fetcher(`https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/${encodeURIComponent(env.AI_GATEWAY_ID)}/${PROVIDER}/responses`, {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'cf-aig-authorization': `Bearer ${env.CF_AIG_TOKEN}`,
        'cf-aig-skip-cache': 'true', 'cf-aig-collect-log': 'true', 'cf-aig-request-timeout': '300000',
        'cf-aig-metadata': JSON.stringify({ task_type: 'site_responses', prompt_version: 'site-responses-v1', ai_model: MODEL, ai_provider: PROVIDER, attempt: 'primary' }),
      },
      body: JSON.stringify({ ...body, model: MODEL, include: include?.filter(value => value !== 'reasoning.encrypted_content'),
        reasoning: { effort: 'xhigh', ...body.reasoning, summary: 'auto', context: 'current_turn' } }),
    });
    const headers = new Headers(PRIVATE);
    const logId = upstream.headers.get('cf-aig-log-id');
    if (logId) headers.set('cf-aig-log-id', logId);
    if (!upstream.ok) {
      await upstream.body?.cancel(); cleanup();
      console.error(JSON.stringify({ event: 'ai_upstream_failed', status: upstream.status, gatewayLogId: logId }));
      const status = upstream.status >= 400 && ![401, 403].includes(upstream.status) ? upstream.status : 502;
      return failure(status, 'AI_UPSTREAM_ERROR', publicError.message, headers);
    }
    const contentType = upstream.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase();
    if (!upstream.body || contentType !== (body.stream ? 'text/event-stream' : 'application/json')) {
      await upstream.body?.cancel(); cleanup();
      return failure(502, 'AI_INVALID_RESPONSE', '模型服务响应格式无效', headers);
    }
    headers.set('Content-Type', contentType);
    if (!body.stream) {
      const value = await readProfileJson(upstream, 16 * 1024 * 1024);
      const envelope = z.object({ object: z.literal('response'), id: z.string(), output: z.array(z.unknown()), status: z.string() }).passthrough().safeParse(value);
      cleanup();
      if (!envelope.success) return failure(502, 'AI_INVALID_RESPONSE', '模型服务响应格式无效', headers);
      if (envelope.data.error) envelope.data.error = publicError;
      return Response.json(envelope.data, { headers });
    }
    // Read one chunk per pull: preserve native Responses SSE and backpressure.
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
    const encoder = new TextEncoder();
    let pending = '';
    let ended = false;
    const finish = () => { ended = true; cleanup(); controller.signal.removeEventListener('abort', stop); };
    let output: ReadableStreamDefaultController<Uint8Array>;
    const stop = () => {
      if (ended) return;
      finish(); output.error(new Error('AI stream aborted'));
      // The fetch signal cancels upstream I/O even when the consumer is idle.
    };
    const stream = new ReadableStream<Uint8Array>({
      start(value) { output = value; controller.signal.addEventListener('abort', stop, { once: true }); if (controller.signal.aborted) stop(); },
      async pull(value) {
        try {
          while (!ended) {
            const chunk = await reader.read();
            if (ended) return;
            pending += decoder.decode(chunk.value, { stream: !chunk.done });
            let ready = '';
            let boundary;
            while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(pending))) {
              if (encoder.encode(pending.slice(0, boundary.index)).byteLength > 16 * 1024 * 1024) throw new Error('AI event too large');
              ready += safeEvent(pending.slice(0, boundary.index)) + boundary[0];
              pending = pending.slice(boundary.index + boundary[0].length);
            }
            if (encoder.encode(pending).byteLength > 16 * 1024 * 1024) throw new Error('AI event too large');
            if (chunk.done) {
              if (pending) ready += safeEvent(pending);
              finish();
            }
            if (ready) value.enqueue(encoder.encode(ready));
            if (chunk.done) value.close();
            if (ready || chunk.done) return;
          }
        } catch {
          if (!ended) { finish(); value.error(new Error('AI stream interrupted')); controller.abort(); await reader.cancel().catch(() => {}); }
        }
      },
      async cancel() { finish(); controller.abort(); await reader.cancel(); },
    }, { highWaterMark: 0 });
    return new Response(stream, { headers });
  } catch {
    cleanup();
    return failure(controller.signal.aborted ? 504 : 502, controller.signal.aborted ? 'AI_TIMEOUT' : 'AI_UNAVAILABLE', '模型服务暂时不可用');
  }
}
