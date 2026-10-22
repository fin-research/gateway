import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './helpers/fixture.mjs';
import { gatewayRequest } from '../src/app.ts';
import { aiResponses } from '../src/ai.ts';

const config = { CLOUDFLARE_ACCOUNT_ID: 'account', AI_GATEWAY_ID: 'default', CF_AIG_TOKEN: 'private-ai-token' };
const envelope = { id: 'resp_test', object: 'response', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] };
const jsonRequest = (body, options = {}) => new Request('https://eastmoney.hasbai.xyz/api/ai/responses', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...options,
});

test('AI route requires the site user Bearer, allows absent Origin, and never forwards credentials to Dashboard/provider', async t => {
  const f = await fixture(t);
  const token = await f.signed();
  const send = (token, origin) => gatewayRequest(f.request('/api/ai/responses', { token, method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: 'CF_Authorization=forged', 'cf-aig-authorization': 'attacker', 'X-Eastmoney-Gateway-Context': 'forged' },
    body: JSON.stringify({ input: 'Hello' }) }), f.env);
  assert.equal((await send(undefined, f.env.SITE_ORIGIN)).status, 401);
  for (const claims of [{ aud: 'other' }, { org_id: 'other' }, { exp: 1 }, { azp: 'other' }, { gty: 'client-credentials' }]) {
    assert.ok([401, 403].includes((await send(await f.signed(claims), f.env.SITE_ORIGIN)).status));
  }
  assert.equal(f.calls.ai.length, 0);
  await f.updateGrants([]);
  const origins = [f.env.SITE_ORIGIN, 'https://other.test', 'http://localhost:3000', 'null', undefined];
  for (const origin of origins) {
    const request = f.request('/api/ai/responses', { token, method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'untrusted=secret', Origin: origin ?? '' }, body: JSON.stringify({ input: 'Hello' }) });
    if (origin === undefined) request.headers.delete('Origin');
    const response = await gatewayRequest(request, f.env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin ?? null);
    assert.equal(response.headers.get('Access-Control-Allow-Credentials'), 'true');
    assert.match(response.headers.get('Vary'), /Origin/);
  }
  assert.equal(f.calls.dashboard.length, 0);
  assert.equal(f.calls.ai.length, origins.length);
  const headers = new Headers(f.calls.ai[0].init.headers);
  for (const name of ['Authorization', 'Cookie', 'Origin', 'X-Eastmoney-Gateway-Context']) assert.equal(headers.has(name), false);
  assert.equal(headers.get('cf-aig-authorization'), 'Bearer unit-ai-secret');
  for (const [path, method] of [['/api/ai/responses', 'GET'], ['/api/ai/responses/extra', 'POST'], ['/api/ai/responses?/other', 'POST'], ['/api/ai/responses/__data.json', 'POST']]) {
    const response = await gatewayRequest(f.request(path, { token, method }), f.env);
    assert.equal(response.status, 403);
  }
  const other = f.request('/api/messenger/settings', { token, method: 'PUT' }); other.headers.delete('Origin');
  assert.equal((await gatewayRequest(other, f.env)).status, 403);
});

test('AI CORS preflight is public and credentialed; actual errors stay readable without opening other routes', async t => {
  const f = await fixture(t);
  const origin = 'https://client.example';
  const preflight = await gatewayRequest(f.request('/api/ai/responses', { method: 'OPTIONS', headers: {
    Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,priority',
  } }), f.env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'), 'true');
  assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'POST,OPTIONS');
  assert.equal(preflight.headers.get('Access-Control-Allow-Headers'), 'authorization,content-type,priority');
  assert.equal(f.calls.auth0.length, 0);
  assert.equal(f.calls.ai.length, 0);

  const token = await f.signed();
  for (const [auth, contentType, body, status] of [
    [undefined, 'application/json', '{}', 401], ['invalid', 'application/json', '{}', 401],
    [token, 'application/json', '{', 400], [token, 'text/plain;charset=UTF-8', '{"input":"hello"}', 415],
  ]) {
    const response = await gatewayRequest(f.request('/api/ai/responses', { token: auth, method: 'POST', headers: {
      Origin: origin, 'Content-Type': contentType, Cookie: 'CF_Authorization=forged',
    }, body }), f.env);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(response.headers.get('Access-Control-Allow-Credentials'), 'true');
    assert.match(response.headers.get('Access-Control-Expose-Headers'), /WWW-Authenticate/);
  }
  assert.equal(f.calls.ai.length, 0);
  for (const path of ['/api/profile', '/api/ai/responses/extra', '/api/ai/responses/__data.json']) {
    const response = await gatewayRequest(f.request(path, { method: 'OPTIONS', headers: { Origin: origin } }), f.env);
    assert.equal(response.status, 401);
    assert.equal(response.headers.has('Access-Control-Allow-Origin'), false);
  }
  const otherWrite = await gatewayRequest(f.request('/api/profile', { token, method: 'POST', headers: {
    Origin: origin, 'Content-Type': 'application/json',
  }, body: '{"action":"name","name":"Do not write"}' }), f.env);
  assert.equal(otherWrite.status, 403);
  assert.equal(otherWrite.headers.has('Access-Control-Allow-Origin'), false);
});

test('JSON Responses preserve structured output and use a fixed provider/model with server-owned auth and reasoning defaults', async () => {
  let sent;
  const format = { type: 'json_schema', name: 'answer', strict: true, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } };
  const response = await aiResponses(jsonRequest({ input: 'Hello', instructions: 'Reply as JSON', text: { format } }), config, async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    return Response.json(envelope, { headers: { 'cf-aig-log-id': 'safe-log-id', 'Set-Cookie': 'upstream=secret', 'Authorization': 'secret' } });
  });
  assert.deepEqual(await response.json(), envelope);
  assert.equal(sent.url, 'https://gateway.ai.cloudflare.com/v1/account/default/custom-codex/responses');
  assert.equal(sent.init.redirect, 'manual');
  assert.equal(sent.body.model, 'gpt-6-luna');
  assert.deepEqual(sent.body.text, { format });
  assert.deepEqual(sent.body.reasoning, { effort: 'xhigh', summary: 'auto', context: 'current_turn' });
  for (const key of ['store', 'max_output_tokens', 'previous_response_id']) assert.equal(key in sent.body, false);
  assert.equal(response.headers.get('cf-aig-log-id'), 'safe-log-id');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store, no-transform');
  assert.equal(response.headers.has('Set-Cookie'), false);
  assert.equal(response.headers.has('Authorization'), false);
});

test('SSE preserves native text/tool events across UTF-8/chunk boundaries and accepts stateless browser SDK defaults', async () => {
  const events = ': ping\r\n\r\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"中文"}\r\n\r\n' +
    'data: {"type":"response.function_call_arguments.done","arguments":"{}","call_id":"call_1"}\n\n' +
    `data: ${JSON.stringify({ type: 'response.completed', response: envelope })}\n\ndata: [DONE]\n\n`;
  const bytes = new TextEncoder().encode(events);
  const response = await aiResponses(jsonRequest({ model: 'gpt-6-luna', input: [
    { role: 'user', content: 'Hello' }, { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: '42' },
  ], stream: true, store: false, include: ['reasoning.encrypted_content'], reasoning: { effort: 'medium' },
  tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }, { type: 'web_search' }], parallel_tool_calls: false }), config, async (_, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.reasoning.effort, 'medium');
    assert.deepEqual(body.include, []);
    assert.equal('store' in body, false);
    assert.equal(body.input.at(-1).type, 'function_call_output');
    return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  assert.equal(await response.text(), events);
});

test('invalid, oversized and shared-account state requests are rejected before any provider call', async () => {
  let calls = 0;
  const send = request => aiResponses(request, config, async () => { calls++; throw new Error('must not call'); });
  for (const body of [null, [], {}, { input: 1 }, { input: 'x', model: 'other' }, { input: 'x', stream: 'yes' },
    { input: 'x', store: true }, { input: 'x', background: true }, { input: 'x', previous_response_id: 'resp_secret' },
    { input: 'x', conversation: 'conv_secret' }, { input: 'x', prompt: { id: 'pmpt_secret' } },
    { input: [{ type: 'item_reference', id: 'msg_secret' }] }, { input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'file_secret' }] }] },
    { input: 'x', tools: [{ type: 'file_search', vector_store_ids: ['private'] }] }, { input: 'x', max_output_tokens: 1 },
  ]) assert.equal((await send(jsonRequest(body))).status, 400, JSON.stringify(body));
  assert.equal((await send(jsonRequest({ input: 'x' }, { headers: {} }))).status, 415);
  assert.equal((await send(new Request('https://eastmoney.hasbai.xyz/api/ai/responses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }))).status, 400);
  assert.equal((await send(jsonRequest({ input: '中'.repeat(400_000) }))).status, 413);
  assert.equal(calls, 0);
  assert.equal((await aiResponses(jsonRequest({ input: 'hello' }), { ...config, CF_AIG_TOKEN: '' })).status, 503);
});

test('provider errors are safe, retain useful status/log ID, never redirect or retry, and redact JSON/SSE failure fields', async () => {
  for (const status of [302, 400, 401, 403, 429, 500]) {
    let calls = 0;
    const response = await aiResponses(jsonRequest({ input: 'hello' }), config, async () => {
      calls++;
      return new Response('provider-secret', { status, headers: { 'cf-aig-log-id': 'log', Location: 'https://evil.test', 'Set-Cookie': 'secret' } });
    });
    assert.equal(response.status, [302, 401, 403].includes(status) ? 502 : status);
    assert.equal(response.headers.get('cf-aig-log-id'), 'log');
    assert.equal(response.headers.has('Location'), false);
    assert.doesNotMatch(await response.text(), /provider-secret/);
    assert.equal(calls, 1);
  }
  const bad = { ...envelope, status: 'failed', error: { message: 'provider-secret', code: 'private-account' } };
  const json = await aiResponses(jsonRequest({ input: 'x' }), config, async () => Response.json(bad));
  assert.doesNotMatch(await json.text(), /provider-secret|private-account/);
  const stream = await aiResponses(jsonRequest({ input: 'x', stream: true }), config, async () => new Response(
    `event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: bad })}\n\ndata: {"type":"error","message":"provider-secret","code":"private-account"}\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } }));
  const text = await stream.text();
  assert.doesNotMatch(text, /provider-secret|private-account/);
  assert.match(text, /response.failed/);
  assert.match(text, /AI_UPSTREAM_ERROR/);
  for (const upstream of [Response.json({ unexpected: true }), new Response('html'), new Response('{', { headers: { 'Content-Type': 'application/json' } })]) {
    assert.equal((await aiResponses(jsonRequest({ input: 'x' }), config, async () => upstream)).status, 502);
  }
});

test('downstream cancellation aborts the provider and request abort/deadline cover the whole SSE lifetime', async t => {
  const pendingResponse = capture => async (_, init) => {
    capture.signal = init.signal;
    return new Response(new ReadableStream({ cancel() { capture.cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const capture = {};
  const response = await aiResponses(jsonRequest({ input: 'x', stream: true }), config, pendingResponse(capture));
  await response.body.cancel();
  assert.equal(capture.signal.aborted, true);
  assert.equal(capture.cancelled, true);

  const controller = new AbortController(), requestCapture = {};
  const aborted = await aiResponses(jsonRequest({ input: 'x', stream: true }, { signal: controller.signal }), config, pendingResponse(requestCapture));
  controller.abort();
  assert.equal(requestCapture.signal.aborted, true);
  await assert.rejects(aborted.text(), /aborted/);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timeoutCapture = {};
  const timed = await aiResponses(jsonRequest({ input: 'x', stream: true }), config, pendingResponse(timeoutCapture));
  t.mock.timers.tick(300_000);
  assert.equal(timeoutCapture.signal.aborted, true);
  await assert.rejects(timed.text(), /aborted/);
});

test('SSE event size is limited by UTF-8 bytes even when its character count is below 16 MiB', async () => {
  const event = `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '中'.repeat(6 * 1024 * 1024) })}\n\n`;
  assert.ok(event.length < 16 * 1024 * 1024);
  const response = await aiResponses(jsonRequest({ input: 'x', stream: true }), config, async () =>
    new Response(event, { headers: { 'Content-Type': 'text/event-stream' } }));
  await assert.rejects(response.text(), /interrupted/);
});
