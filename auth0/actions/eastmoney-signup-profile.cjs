const needsProfile = (event) => event.client.client_id === event.secrets.EASTMONEY_CLIENT_ID
  && event.connection.name === 'eastmoney-email'
  && event.user.app_metadata?.eastmoney_signup_profile_pending === true;
const clean = (value, limit) => typeof value === 'string' && value.trim().length > 0
  && value.trim().length <= limit && !/[\u0000-\u001f\u007f<>]/.test(value) ? value.trim() : null;

// A separate Action lets the existing email-verification Action redirect after
// this hosted Form resumes. Existing accounts and completed profiles are skipped.
exports.onExecutePostLogin = async (event, api) => {
  if (!needsProfile(event)) return;
  if (!api.redirect.canRedirect()) return api.access.deny('请在浏览器中登录并填写姓名、部门');
  api.prompt.render(event.secrets.PROFILE_FORM_ID, { fields: {
    name: clean(event.user.user_metadata?.name, 50) || '',
    department: clean(event.user.user_metadata?.department, 100) || '',
  } });
};

exports.onContinuePostLogin = async (event, api) => {
  if (!needsProfile(event)) return;
  if (event.prompt?.id !== event.secrets.PROFILE_FORM_ID) return api.access.deny('注册资料表单无效，请重新登录');
  const name = clean(event.prompt.fields?.name, 50);
  const department = clean(event.prompt.fields?.department, 100);
  if (!name || !department) return api.access.deny('请填写有效的姓名和部门后重新登录');
  const origin = 'https://hasbai.eu.auth0.com';
  try {
    const tokenResponse = await fetch(`${origin}/oauth/token`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: event.secrets.PROFILE_CLIENT_ID,
        client_secret: event.secrets.PROFILE_CLIENT_SECRET, audience: `${origin}/api/v2/` }),
    });
    if (!tokenResponse.ok) throw new Error('token');
    const token = await tokenResponse.json();
    if (typeof token.access_token !== 'string' || !token.access_token) throw new Error('token');
    const response = await fetch(`${origin}/api/v2/users/${encodeURIComponent(event.user.user_id)}`, {
      method: 'PATCH', redirect: 'manual', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, nickname: name, user_metadata: { name, department } }),
    });
    if (!response.ok) throw new Error('profile');
    const profile = await response.json();
    if (profile.name !== name || profile.nickname !== name || profile.user_metadata?.department !== department) throw new Error('profile');
    api.user.setAppMetadata('eastmoney_signup_profile_pending', false);
  } catch {
    // Keep the server-side pending marker, so a later login offers the Form again.
    api.access.deny('暂时无法保存注册资料，请稍后重新登录');
  }
};
