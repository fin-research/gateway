import { z } from 'zod';
import { AccessError } from './access.ts';
import type { AccountProfile } from '../profile.ts';
import { createAuth0ManagementClient } from './auth0-management.js';
import { PERMISSION_DEFINITIONS } from '../permissions.ts';
import type { SiteAuthorization } from '../identity.ts';

type Identity = { email: string; auth0Id: string | null; authorization?: SiteAuthorization };
type Config = Pick<Env, 'AUTH0_DOMAIN' | 'AUTH0_CLIENT_ID' | 'AUTH0_MANAGEMENT_CLIENT_ID' | 'AUTH0_MANAGEMENT_CLIENT_SECRET'>;

export class ProfileError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export const profileChange = z.discriminatedUnion('action', [
  z.object({ action: z.literal('name'), name: z.string().trim().min(1).max(50) }).strict(),
  z.object({ action: z.literal('email'), email: z.email().max(254).transform((value) => value.trim().toLowerCase())
    .refine((value) => /^[^@\s]+@18\.cn$/.test(value)), confirmed: z.literal(true) }).strict(),
  z.object({ action: z.literal('password') }).strict(),
]);

export async function readProfileJson(source: Request | Response, maxBytes: number): Promise<unknown> {
  const reader = source.body?.getReader();
  if (!reader) throw new ProfileError(400, '请求内容不能为空');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new ProfileError(413, '请求内容过大'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new ProfileError(400, '请求内容无效'); }
  } finally { reader.releaseLock(); }
}

// Credentials are deployment configuration. Identity and token requests stay within this request.
export function createProfileService(config: Config, identity: Identity | null, fetcher: typeof fetch = fetch) {
  if (!identity) throw new AccessError(401, '请先登录');
  if (!identity.auth0Id) throw new ProfileError(503, '账号身份尚未配置完成，请联系管理员');
  if (!/^[a-z0-9.-]+\.auth0\.com$/.test(config.AUTH0_DOMAIN) || !config.AUTH0_MANAGEMENT_CLIENT_ID || !config.AUTH0_MANAGEMENT_CLIENT_SECRET) {
    throw new ProfileError(503, '个人信息服务尚未配置完成，请联系管理员');
  }
  const userId = identity.auth0Id;
  const email = identity.email;
  const origin = `https://${config.AUTH0_DOMAIN}`;
  const userPath = `users/${encodeURIComponent(userId)}`;
  const manager = createAuth0ManagementClient({ domain: config.AUTH0_DOMAIN, clientId: config.AUTH0_MANAGEMENT_CLIENT_ID, clientSecret: config.AUTH0_MANAGEMENT_CLIENT_SECRET, fetchImpl: fetcher });

  async function send(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try { response = await fetcher(`${origin}${path}`, { ...init, redirect: 'manual', signal: AbortSignal.timeout(10000) }); }
    catch { throw new ProfileError(503, '账号服务暂时不可用，请稍后重试'); }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 409) throw new ProfileError(409, '该邮箱已被使用，请更换邮箱');
      if (response.status === 400) throw new ProfileError(400, '账号信息不符合要求，请检查后重试');
      // An upstream service credential failure is not the user's expired session.
      throw new ProfileError(503, '账号服务暂时不可用，请稍后重试');
    }
    return response;
  }

  async function json(response: Response): Promise<unknown> {
    try { return await readProfileJson(response, 512 * 1024); }
    catch { throw new ProfileError(503, '账号服务响应无效，请稍后重试'); }
  }

  async function request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    try { return await manager.request(path, method, body); }
    catch (cause) {
      const status = cause && typeof cause === 'object' && 'status' in cause ? cause.status : 503;
      throw new ProfileError(status === 409 || status === 400 ? status : 503, status === 409 ? '该邮箱已被使用，请更换邮箱' : '账号服务暂时不可用，请稍后重试');
    }
  }

  async function currentUser() {
    const parsed = z.object({ user_id: z.string(), email: z.string(), email_verified: z.boolean().optional(),
      name: z.string().optional(), blocked: z.boolean().optional(),
      identities: z.array(z.object({ connection: z.string() })) }).safeParse(await request(`${userPath}?fields=user_id,email,email_verified,name,blocked,identities&include_fields=true`));
    if (!parsed.success) throw new ProfileError(503, '账号信息暂时无法读取');
    const user = parsed.data;
    if (user.user_id !== userId || user.email.toLowerCase() !== email.toLowerCase()) throw new AccessError(401, '账号信息已变更，请重新登录');
    if (user.blocked || !user.identities.some((item) => item.connection === 'eastmoney-email')) throw new AccessError(403, '该账号不可修改个人信息');
    return user;
  }

  async function list(suffix: string): Promise<unknown[]> {
    const result: unknown[] = [];
    for (let page = 0; page < 10; page++) {
      const rows = await request(`${userPath}/${suffix}?per_page=100&page=${page}`);
      if (!Array.isArray(rows)) throw new ProfileError(503, '账号权限暂时无法读取');
      result.push(...rows);
      if (rows.length < 100) return result;
    }
    throw new ProfileError(503, '账号权限超出读取范围，请联系管理员');
  }

  return {
    async read(): Promise<AccountProfile> {
      const user = await currentUser();
      const roles = identity.authorization?.roles ?? z.array(z.object({ name: z.string(), description: z.string().optional().default('') })).parse(await list('roles'));
      const permissions = identity.authorization?.permissions ?? [];
      return { name: user.name ?? '', email: user.email, emailVerified: user.email_verified === true,
        roles, permissions: PERMISSION_DEFINITIONS.filter(([code]) => permissions.includes(code)).map(([code, label, description]) => ({ name: code, description: `${label}：${description}`, resource: code.split('.')[0]! })) };

    },
    async update(input: unknown) {
      const parsed = profileChange.safeParse(input);
      if (!parsed.success) throw new ProfileError(400, '请检查姓名、18.cn 邮箱及修改确认，勿提交其他账号字段');
      const change = parsed.data;
      const user = await currentUser();
      if (change.action === 'password') {
        const response = await send('/dbconnections/change_password', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: config.AUTH0_CLIENT_ID, email: user.email, connection: 'eastmoney-email' }) });
        await response.body?.cancel();
        return { message: '密码重置邮件已请求发送，请在登录邮箱中完成修改' };
      }
      if (change.action === 'email') {
        if (change.email === user.email.toLowerCase()) throw new ProfileError(400, '新邮箱与当前邮箱相同');
        await request(userPath, 'PATCH', { email: change.email, email_verified: false, verify_email: true, connection: 'eastmoney-email', client_id: config.AUTH0_CLIENT_ID });
        return { message: '登录邮箱已更新，请验证新邮箱并重新登录', logout: true };
      }
      const updated = z.object({ name: z.string() }).safeParse(await request(userPath, 'PATCH', { name: change.name }));
      if (!updated.success) throw new ProfileError(503, '个人资料响应无效，请重新读取确认');
      return { message: '个人资料已保存', name: updated.data.name };
    },
  };
}
