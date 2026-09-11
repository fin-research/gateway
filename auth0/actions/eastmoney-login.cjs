// Auth0 post-login Action: eastmoney login claims (node22).
const MCP_CLIENT_ID = 'M1a5PF3UJaFIZv1k4HO4IV06Z5fXQBHV';
exports.onExecutePostLogin = async (event, api) => {
  if (![event.secrets.EASTMONEY_CLIENT_ID, MCP_CLIENT_ID].includes(event.client.client_id)) return;
  if (event.connection?.name !== 'eastmoney-email' || event.user.blocked) return api.access.deny('账号不可用于本站登录');
  const metadata = event.user.app_metadata || {};
  const legacy = metadata.migrated_from === 'neon'
    && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(metadata.neon_auth_user_id || '')
    && event.user.user_id === `auth0|${metadata.neon_auth_user_id}`
    && metadata.neon_email === String(event.user.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@18\.cn$/i.test(event.user.email || '')) return api.access.deny('仅允许使用 18.cn 邮箱登录');
  if (!event.user.email_verified && !legacy) {
    if (!api.redirect.canRedirect()) return api.access.deny('请先验证注册邮箱，再返回登录');
    // No token or account identifiers are sent to this public informational page.
    return api.redirect.sendUserTo('https://eastmoney.hasbai.xyz/auth/verify-email');
  }
  let roles;
  try { roles = await roleClaims(event, api); }
  catch { return api.access.deny('登录角色读取失败，请稍后重试'); }
  api.accessToken.setCustomClaim('https://eastmoney.hasbai.xyz/roles', roles);
  api.accessToken.setCustomClaim('https://eastmoney.hasbai.xyz/profile', {
    name: String(event.user.name || event.user.email).slice(0, 200),
    department: String(event.user.user_metadata?.department || '').trim().slice(0, 100),
    picture: String(event.user.picture || '').slice(0, 2048),
    connection: 'eastmoney-email', verified: true,
  });
  api.idToken.setCustomClaim('eastmoney_user_id', event.user.user_id);
  api.accessToken.setCustomClaim('https://eastmoney.hasbai.xyz/email', String(event.user.email).trim().toLowerCase());
};

exports.onContinuePostLogin = async (event, api) => {
  if (![event.secrets.EASTMONEY_CLIENT_ID, MCP_CLIENT_ID].includes(event.client.client_id)) return;
  // The page starts a fresh login after verification. A direct /continue request
  // must never turn the suspended, unverified transaction into an authenticated one.
  api.access.deny('请完成邮箱验证后重新登录');
};

// Auth0's login event supplies role names; the permission table uses stable role
// IDs. Resolve the catalogue only during login/token issuance, using a dedicated
// read:roles client. Business requests never call this API.
async function roleClaims(event, api) {
  const names = event.authorization?.roles || [];
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) throw new Error('roles');
  if (!names.length) return [];
  const domain = event.secrets.ROLES_DOMAIN;
  const clientId = event.secrets.ROLES_CLIENT_ID;
  const secret = event.secrets.ROLES_CLIENT_SECRET;
  if (domain !== 'hasbai.eu.auth0.com' || !clientId || !secret) throw new Error('configuration');
  const origin = `https://${domain}`;
  async function json(url, init = {}) {
    const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('service'); }
    return response.json();
  }
  const cacheKey = `roles-token:${clientId}`;
  let token = api.cache?.get(cacheKey)?.value;
  if (!token) {
    const result = await json(origin + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: secret, audience: origin + '/api/v2/', grant_type: 'client_credentials' }) });
    if (typeof result.access_token !== 'string') throw new Error('token');
    token = result.access_token;
    const ttl = Math.min(3600000, (Number(result.expires_in) - 60) * 1000);
    if (ttl > 0) api.cache?.set(cacheKey, token, { ttl });
  }
  const matched = [];
  for (let page = 0; page < 10; page++) {
    const rows = await json(`${origin}/api/v2/roles?per_page=100&page=${page}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!Array.isArray(rows)) throw new Error('catalogue');
    for (const role of rows) if (names.includes(role.name)) {
      if (!/^rol_[A-Za-z0-9]+$/.test(role.id) || typeof role.name !== 'string') throw new Error('role');
      matched.push({ id: role.id, name: role.name });
    }
    if (rows.length < 100) break;
  }
  if (matched.length !== new Set(names).size || matched.length > 50) throw new Error('unresolved role');
  return matched;
}
