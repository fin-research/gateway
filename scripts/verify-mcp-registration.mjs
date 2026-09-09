// HTTP-only probes; registration creates public clients but performs no login
// and obtains no user access tokens. Do not log complete DCR responses.
const team = 'https://hasbai.cloudflareaccess.com';
const metadataResponse = await fetch(team + '/.well-known/oauth-authorization-server', { redirect: 'error', signal: AbortSignal.timeout(30000) });
if (!metadataResponse.ok) throw new Error('OAuth metadata unavailable');
const metadata = await metadataResponse.json();
const registration = new URL(metadata.registration_endpoint);
if (registration.origin !== team || registration.pathname !== '/cdn-cgi/access/oauth/registration') throw new Error('Unexpected registration endpoint');
const probes = [
  ['https://chatgpt.com/connector/oauth/eastmoney-registration-check', true],
  ['https://chatgpt.com/connector_platform_oauth_redirect', true],
  ['https://untrusted.example/callback', false],
  ['https://chatgpt.com/unrelated/callback', false],
  ['https://chatgpt.com/connector/oauth-evil/callback', false],
  ['https://chatgpt.com.untrusted.example/connector/oauth/callback', false],
];
let failed = false;
for (const [redirect, allowed] of probes) {
  const response = await fetch(registration, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Eastmoney ChatGPT registration verification',
      redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
  const value = await response.json();
  const passed = allowed ? response.status === 201 && Boolean(value.client_id) && value.redirect_uris?.includes(redirect)
    : response.status === 400 && value.error === 'invalid_client_metadata';
  failed ||= !passed;
  console.log(JSON.stringify({ redirect, expected: allowed ? 'allowed' : 'rejected', status: response.status, passed }));
}
process.exitCode = failed ? 1 : 0;
