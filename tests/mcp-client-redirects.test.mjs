import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addChatGptRedirectUris } from '../scripts/lib/mcp-client-redirects.mjs';

test('adding ChatGPT callbacks preserves existing clients, restrictions and grant lifetimes without mutating input', () => {
  const before = { enabled: true, grant: { access_token_lifetime: '5m', session_duration: '24h' },
    dynamic_client_registration: { enabled: true, allow_any_on_localhost: false, allow_any_on_loopback: false,
      allowed_uris: ['https://existing.example/callback'] } };
  const original = structuredClone(before);
  const after = addChatGptRedirectUris(before);
  assert.deepEqual(before, original);
  assert.deepEqual(after.grant, before.grant);
  assert.deepEqual(after.dynamic_client_registration, { ...before.dynamic_client_registration,
    allowed_uris: ['https://existing.example/callback', 'https://chatgpt.com/connector/oauth/*', 'https://chatgpt.com/connector_platform_oauth_redirect'] });
  assert.deepEqual(addChatGptRedirectUris(after), after);
});

test('a callback-only update cannot implicitly enable a disabled OAuth or registration service', () => {
  for (const value of [undefined, { enabled: false, dynamic_client_registration: { enabled: true } },
    { enabled: true, dynamic_client_registration: { enabled: false } }]) {
    assert.throws(() => addChatGptRedirectUris(value), /must already be enabled/);
  }
});
