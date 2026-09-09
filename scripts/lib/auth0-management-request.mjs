import { createAuth0ManagementClient } from '../../src/lib/server/auth0-management.js';
import { auth0DeployCredentials } from './auth0-deploy-config.mjs';

// Private transport for synchronous maintenance scripts. Credentials stay in
// the root environment file; stdout is consumed in memory by the parent.
try {
  const [method, path] = process.argv.slice(2);
  if (!['get', 'post', 'put', 'patch', 'delete'].includes(method) || !path || path.startsWith('/') || path.includes('://')) throw new Error('Invalid Management API operation');
  let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 4 * 1024 * 1024) throw new Error('Input too large'); }
  const payload = input.trim() ? JSON.parse(input) : {};
  const credentials = await auth0DeployCredentials();
  let cachedToken = payload.cachedToken?.clientId === credentials.AUTH0_CLIENT_ID && payload.cachedToken?.expiresAt > Date.now() ? payload.cachedToken : undefined;
  const fetchImpl = async (url, options) => {
    if (String(url).endsWith('/oauth/token') && cachedToken) return Response.json({ access_token: cachedToken.value, expires_in: 300 });
    const response = await fetch(url, options);
    if (String(url).endsWith('/oauth/token') && response.ok) {
      const token = await response.clone().json();
      cachedToken = { value: token.access_token, clientId: credentials.AUTH0_CLIENT_ID, expiresAt: Date.now() + Math.min(300, Number(token.expires_in) - 60) * 1000 };
    }
    return response;
  };
  const client = createAuth0ManagementClient({ domain: credentials.AUTH0_DOMAIN, clientId: credentials.AUTH0_CLIENT_ID, clientSecret: credentials.AUTH0_CLIENT_SECRET, fetchImpl });
  const result = await client.request(path, method.toUpperCase(), payload.body);
  process.stdout.write(JSON.stringify({ data: result, cachedToken }));
} catch (error) {
  process.stdout.write(JSON.stringify({ statusCode: error.status ?? 503, error: 'AUTH0_MANAGEMENT_FAILED' }));
  process.exitCode = 1;
}
