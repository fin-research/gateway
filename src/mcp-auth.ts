/** OAuth discovery only. Auth0 owns login, authorization codes and tokens. */
export const mcpOAuthScopes = ['openid', 'profile', 'email', 'offline_access'];
export function mcpResourceMetadata(env: Pick<Env, 'SITE_ORIGIN' | 'AUTH0_LOGIN_DOMAIN'>) {
  return {
    resource: env.SITE_ORIGIN + '/',
    resource_name: 'Eastmoney',
    authorization_servers: [`https://${env.AUTH0_LOGIN_DOMAIN}/`],
    scopes_supported: mcpOAuthScopes,
    bearer_methods_supported: ['header'],
  };
}
export function mcpChallenge(env: Pick<Env, 'SITE_ORIGIN'>) {
  return `Bearer resource_metadata="${env.SITE_ORIGIN}/.well-known/oauth-protected-resource/api/mcp", scope="${mcpOAuthScopes.join(' ')}"`;
}
