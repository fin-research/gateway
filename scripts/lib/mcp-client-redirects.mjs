// OpenAI documents both the per-connector callback and the legacy/stable URI:
// https://developers.openai.com/plugins/build/auth#redirect-url
// Cloudflare accepts a trailing /* for subpaths. Restrict it to the dedicated
// ChatGPT OAuth callback path because each connection has its own callback ID.
export const CHATGPT_REDIRECT_URIS = [
  'https://chatgpt.com/connector/oauth/*',
  'https://chatgpt.com/connector_platform_oauth_redirect',
];

export function addChatGptRedirectUris(configuration) {
  if (configuration?.enabled !== true || configuration.dynamic_client_registration?.enabled !== true) {
    throw new Error('Managed OAuth and dynamic registration must already be enabled');
  }
  const registration = configuration.dynamic_client_registration;
  return { ...configuration, dynamic_client_registration: { ...registration,
    allowed_uris: [...new Set([...(registration.allowed_uris ?? []), ...CHATGPT_REDIRECT_URIS])],
  } };
}
