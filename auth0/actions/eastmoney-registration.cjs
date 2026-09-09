// Auth0 pre-user-registration Action for the existing email connection.
// The native signup collects credentials; the following hosted Form collects
// required profile details before the login / email-verification Action runs.
exports.onExecutePreUserRegistration = async (event, api) => {
  if (event.connection.name !== 'eastmoney-email') return;
  if (!/^[^@\s]+@18\.cn$/i.test(String(event.user.email || '').trim())) {
    return api.access.deny('email_domain_not_allowed', '仅支持使用 18.cn 邮箱注册');
  }
  api.user.setAppMetadata('eastmoney_signup_profile_pending', true);
};
