// Access token claims

const EM_ORGANIZATION_ID = 'org_6yvoRRCkzk3eGkBS';
exports.onExecutePostLogin = async (event, api) => {
  if (event.user.blocked) return api.access.deny('用户被封禁');

  let dbRole = "authenticated";
  let roles = event.authorization?.roles ?? [];
  if (event.resource_server?.identifier === "https://financial.hasbai.xyz/api" && roles.includes("superadmin")) {
    dbRole = "superadmin";
  }
  api.accessToken.setCustomClaim("role", dbRole);
  api.accessToken.setCustomClaim("_roles", roles);
  api.accessToken.setCustomClaim("email", event.user.email);
  api.accessToken.setCustomClaim("username", profileName(event.user));

  if (event.organization?.id === EM_ORGANIZATION_ID) {
    api.accessToken.setCustomClaim('department', event.user.user_metadata?.department);
    api.accessToken.setCustomClaim('picture', event.user.picture);
  };

  if (event.connection?.name?.includes('email') && !event.user.email_verified) {
    return api.access.deny('请先验证注册邮箱，再返回登录');
  };
  if (['tpc_a7WD9gnnwfLwzjTcG3aN8m', 'tpc_2WkMuCZoYq49waTvQZjJHK', 'tpc_mJaDePAHohZSgFrpLBfWny'].includes(event.client.client_id)) {
    if (event.organization?.id !== EM_ORGANIZATION_ID || event.connection?.name !== 'eastmoney-email'
      || !event.user.email_verified || !/^[^@\s]+@18\.cn$/i.test(event.user.email ?? '')) {
      return api.access.deny('请使用东方财富组织的已验证 18.cn 账号登录');
    }
    api.accessToken.setCustomClaim('https://eastmoney.hasbai.xyz/identity', {
      username: profileName(event.user) || event.user.email,
      email: event.user.email,
      role: dbRole,
      _roles: roles,
      department: event.user.user_metadata?.department || '',
      picture: event.user.picture || '',
    });
  }

};

const profileName = (user) => [user.name, user.username, user.nickname].map(v => v?.trim()).find(Boolean);




