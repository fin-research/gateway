import { generateKeyPair, exportJWK, SignJWT } from 'jose';
export async function fixture(t) {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), alg: 'RS256', kid: crypto.randomUUID() };
  const env = { SITE_ORIGIN: 'https://eastmoney.hasbai.xyz', AUTH0_LOGIN_DOMAIN: `${crypto.randomUUID()}.auth0.com`, AUTH0_DOMAIN: 'unit.auth0.com',
    AUTH0_CLIENT_ID: 'login', AUTH0_CLIENT_SECRET: 'unit-secret', AUTH0_AUDIENCE: 'https://eastmoney.hasbai.xyz/',
    AUTH0_MANAGEMENT_CLIENT_ID: crypto.randomUUID(), AUTH0_MANAGEMENT_CLIENT_SECRET: 'unit-management', AUTHORIZATION_MODE: 'beta-open',
    AUTH0_MACHINE_CLIENT_IDS: 'quant', SESSION_SECRET: Buffer.alloc(32, 7).toString('base64url') };
  const calls = { dashboard: [], data: [], auth0: [] };
  env.DASHBOARD = { async fetch(request) { calls.dashboard.push(request); return Response.json({ reached: 'dashboard' }); } };
  env.DATA = { async fetch(request) { calls.data.push(request); return Response.json({ reached: 'data' }); } };
  let profile = { user_id: 'auth0|test', email: 'test@18.cn', name: '测试账号', email_verified: true, identities: [{ connection: 'eastmoney-email' }] };
  let customFetch;
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (customFetch) { const response = await customFetch(url, init); if (response) return response; }
    if (url.pathname.endsWith('/jwks.json')) return Response.json({ keys: [jwk] });
    calls.auth0.push(url.pathname);
    if (url.pathname === '/oauth/token') return Response.json({ access_token: 'unit-management', expires_in: 300 });
    if (url.pathname.endsWith('/roles')) return Response.json([]);
    if (url.pathname === '/api/v2/users/auth0%7Ctest') return Response.json(profile);
    throw new Error('Unexpected outbound request');
  };
  t.after(() => { globalThis.fetch = original; });
  async function signed(overrides = {}, kind = 'access') {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ iss: `https://${env.AUTH0_LOGIN_DOMAIN}/`, aud: kind === 'access' ? env.AUTH0_AUDIENCE : env.AUTH0_CLIENT_ID,
      sub: 'auth0|test', iat: now, exp: now + 300, azp: env.AUTH0_CLIENT_ID,
      'https://eastmoney.hasbai.xyz/roles': [], 'https://eastmoney.hasbai.xyz/profile': {name:'测试账号',department:'测试',picture:'',connection:'eastmoney-email',verified:true}, 'https://eastmoney.hasbai.xyz/email': 'test@18.cn', ...overrides }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).sign(privateKey);
  }
  const request = (path, { token, method = 'GET', headers = {}, body } = {}) => new Request(env.SITE_ORIGIN + path, {
    method, headers: { Origin: env.SITE_ORIGIN, ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, body,
  });
  return { env, calls, signed, jwk, request, updateProfile(value) { profile = { ...profile, ...value }; }, intercept(fn) { customFetch = fn; } };
}
