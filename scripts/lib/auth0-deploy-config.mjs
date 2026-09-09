import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

export async function auth0DeployCredentials() {
  const file = process.env.EASTMONEY_ENV_FILE ?? process.env.AUTH_TEST_ENV_FILE ?? new URL('../../../eastmoney/.env', import.meta.url);
  let values;
  try { values = parseEnv(await readFile(file, 'utf8')); }
  catch { throw new Error('Cannot read the project-root .env; set AUTH_TEST_ENV_FILE for a worktree'); }
  if (values.AUTH0_DOMAIN !== 'hasbai.eu.auth0.com' || !values.AUTH0_CLIENT_ID || !values.AUTH0_CLIENT_SECRET) {
    throw new Error('Root .env must configure the dedicated Auth0 Deploy CLI machine application');
  }
  return { AUTH0_DOMAIN: values.AUTH0_DOMAIN, AUTH0_CLIENT_ID: values.AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET: values.AUTH0_CLIENT_SECRET };
}
