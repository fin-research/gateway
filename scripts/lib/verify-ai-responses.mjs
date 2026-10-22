import { AuthTestError, SITE_ORIGIN, boundedText } from './programmatic-login.mjs';

// Opt-in: three small real generations; no external tool or business write.
export async function verifyAiResponses(session) {
  const endpoint = SITE_ORIGIN + '/api/ai/responses';
  const origin = 'https://client.example';
  const send = (body, headers = session.bearerHeaders()) => fetch(endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(300_000),
    headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const require = (condition, message) => { if (!condition) throw new AuthTestError('AI_VERIFICATION_FAILED', message); };
  const checkCors = response => {
    require(response.headers.get('Access-Control-Allow-Origin') === origin && response.headers.get('Access-Control-Allow-Credentials') === 'true', 'AI CORS headers missing');
  };
  const preflight = await fetch(endpoint, { method: 'OPTIONS', headers: { Origin: origin,
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,priority' } });
  require(preflight.status === 204, `AI preflight returned ${preflight.status}`);
  checkCors(preflight);
  const allowedHeaders = preflight.headers.get('Access-Control-Allow-Headers')?.toLowerCase().split(',').map(value => value.trim());
  require(['authorization', 'content-type', 'priority'].every(value => allowedHeaders?.includes(value)), 'AI preflight headers missing');
  console.log(JSON.stringify({ ai: 'cors-preflight', status: preflight.status, passed: true }));
  for (const [identity, headers, status] of [
    ['anonymous', {}, 401], ['invalid-token', { Authorization: 'Bearer invalid' }, 401],
    ['text-plain', { ...session.bearerHeaders(), 'Content-Type': 'text/plain;charset=UTF-8' }, 415],
  ]) {
    const response = await send({ input: 'Do not run' }, headers);
    checkCors(response);
    await response.body?.cancel();
    require(response.status === status, `${identity} AI boundary returned ${response.status}`);
    console.log(JSON.stringify({ ai: identity, status: response.status, passed: true }));
  }
  const response = await send({ input: 'Return {"ok":true}.', reasoning: { effort: 'low' }, text: {
    format: { type: 'json_schema', name: 'gateway_probe', strict: true,
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } },
  } });
  require(response.status === 200, `JSON AI request returned ${response.status}`);
  checkCors(response);
  const json = JSON.parse(await boundedText(response));
  const outputText = value => value.output?.filter(item => item.type === 'message' && (!item.phase || item.phase === 'final_answer'))
    .flatMap(item => item.content ?? []).filter(item => item.type === 'output_text').map(item => item.text).join('') ?? '';
  require(json.object === 'response' && json.status === 'completed' && JSON.parse(outputText(json)).ok === true, 'Structured JSON generation failed');
  console.log(JSON.stringify({ ai: 'json-schema', status: response.status, model: json.model, passed: true, gatewayLogId: response.headers.get('cf-aig-log-id') }));

  const stream = async body => {
    const response = await send({ ...body, stream: true, reasoning: { effort: 'low' }, store: false, include: ['reasoning.encrypted_content'] });
    require(response.status === 200 && response.headers.get('Content-Type')?.includes('text/event-stream'), `SSE AI request returned ${response.status}`);
    checkCors(response);
    const text = await boundedText(response);
    const events = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(line => line && line !== '[DONE]').map(line => JSON.parse(line));
    const completed = events.find(event => event.type === 'response.completed')?.response;
    require(completed?.status === 'completed' && !events.some(event => event.type === 'error' || event.type === 'response.failed'), 'SSE did not complete');
    return completed;
  };
  const input = [{ role: 'user', content: 'Call gateway_probe once, then reply with exactly the value the tool returns.' }];
  const tools = [{ type: 'function', name: 'gateway_probe', description: 'Get the test value.', strict: true,
    parameters: { type: 'object', properties: {}, additionalProperties: false } }];
  const first = await stream({ input, tools, tool_choice: { type: 'function', name: 'gateway_probe' }, parallel_tool_calls: false });
  const call = first.output.find(item => item.type === 'function_call' && item.name === 'gateway_probe');
  require(!!call?.call_id, 'SSE function call missing');
  const final = await stream({ input: [...input, ...first.output, { type: 'function_call_output', call_id: call.call_id, output: '42' }], tools, tool_choice: 'none' });
  require(outputText(final).includes('42'), 'SSE tool result was not used');
  console.log(JSON.stringify({ ai: 'native-sse-tool-loop', calls: 2, passed: true, browserUsed: false }));
}
