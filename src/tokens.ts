import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from 'jose';
import { AccessError } from './lib/server/access.ts';

export const ROLES_CLAIM = 'https://eastmoney.hasbai.xyz/roles';
export const PROFILE_CLAIM = 'https://eastmoney.hasbai.xyz/profile';
export const EMAIL_CLAIM = 'https://eastmoney.hasbai.xyz/email';
const keySets = new Map<string, JWTVerifyGetKey>();
type TokenConfig = Pick<Env, 'AUTH0_LOGIN_DOMAIN' | 'AUTH0_AUDIENCE' | 'AUTH0_CLIENT_ID' | 'AUTH0_ORGANIZATION_ID' | 'AUTH0_MACHINE_CLIENT_IDS'>;

export function auth0Issuer(env: TokenConfig): string {
  if (!/^[a-z0-9.-]+$/.test(env.AUTH0_LOGIN_DOMAIN) || !env.AUTH0_AUDIENCE || !env.AUTH0_CLIENT_ID || !/^org_[A-Za-z0-9]+$/.test(env.AUTH0_ORGANIZATION_ID)) throw new AccessError(503, '身份服务尚未配置完成');
  return `https://${env.AUTH0_LOGIN_DOMAIN}/`;
}

export async function verifyToken(token: string, env: TokenConfig, kind: 'access' | 'id' = 'access', keys?: JWTVerifyGetKey): Promise<JWTPayload> {
  const issuer = auth0Issuer(env);
  if (!token || token.length > 16384) throw new AccessError(401, '请先登录');
  let keySet = keys ?? keySets.get(issuer);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL('.well-known/jwks.json', issuer), { timeoutDuration: 5000 });
    if (keySets.size >= 4) keySets.clear();
    keySets.set(issuer, keySet);
  }
  try {
    const { payload } = await jwtVerify(token, keySet, {
      issuer, audience: kind === 'access' ? env.AUTH0_AUDIENCE : env.AUTH0_CLIENT_ID,
      algorithms: ['RS256'], requiredClaims: ['iss', 'aud', 'sub', 'exp', 'iat'], clockTolerance: 5,
    });
    if (!Number.isInteger(payload.iat) || payload.iat! > Date.now() / 1000 + 5 || payload.exp! <= payload.iat!) throw new AccessError(401, '登录凭证无效');
    if (kind === 'access' && typeof payload.azp !== 'string') throw new AccessError(401, '登录凭证无效');
    // This tenant cannot issue organization M2M tokens. Only the configured
    // Quant client may omit org_id; authorizeData still enforces its Choice scope.
    const legacyMachine = kind === 'access' && payload.gty === 'client-credentials' && payload.org_id === undefined
      && env.AUTH0_MACHINE_CLIENT_IDS?.split(',').map(id => id.trim()).includes(String(payload.azp))
      && payload.sub === payload.azp + '@clients';
    if (!legacyMachine && payload.org_id !== env.AUTH0_ORGANIZATION_ID) throw new AccessError(401, '请通过东方财富组织重新登录', 'ORGANIZATION_REQUIRED');
    return payload;
  } catch (error) {
    if (error instanceof AccessError) throw error;
    const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
    if (['ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID'].includes(String(code)) || error instanceof TypeError) throw new AccessError(503, '身份服务暂时不可用');
    throw new AccessError(401, '登录已失效，请重新登录');
  }
}
