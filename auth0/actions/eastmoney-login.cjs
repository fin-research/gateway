// Auth0 post-login Action: eastmoney login claims (node22).
const MCP_CLIENT_ID = 'M1a5PF3UJaFIZv1k4HO4IV06Z5fXQBHV';
exports.onExecutePostLogin = async (event, api) => {
  if (![event.secrets.EASTMONEY_CLIENT_ID, MCP_CLIENT_ID].includes(event.client.client_id)) return;
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
  api.idToken.setCustomClaim('eastmoney_user_id', event.user.user_id);
  api.accessToken.setCustomClaim('https://eastmoney.hasbai.xyz/email', String(event.user.email).trim().toLowerCase());
};

exports.onContinuePostLogin = async (event, api) => {
  if (![event.secrets.EASTMONEY_CLIENT_ID, MCP_CLIENT_ID].includes(event.client.client_id)) return;
  // The page starts a fresh login after verification. A direct /continue request
  // must never turn the suspended, unverified transaction into an authenticated one.
  api.access.deny('请完成邮箱验证后重新登录');
};
