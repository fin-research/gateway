import { z } from 'zod';
import { AccessError } from './access.ts';
import { createDirectory, roleSchema, type Auth0Role } from './auth0-directory.ts';
import { roleConfiguration } from './auth0-permissions.ts';
import { isPermissionCode } from '../permissions.ts';

export const CACHE_TTL_SECONDS = 3600;
export type PermissionSnapshot = { version: 1; updatedAt: number; roles: Auth0Role[]; configurations: Record<string, { permissions: string[] }> };
const snapshotSchema = z.object({ version: z.literal(1), updatedAt: z.number(), roles: z.array(roleSchema),
  configurations: z.record(z.string(), z.object({ permissions: z.array(z.string()) })) });
type JsonCache = Pick<Cache, 'match' | 'put'>;

export async function readAuth0Permissions(env: Env): Promise<PermissionSnapshot> {
  const roles = await createDirectory(env).roles();
  const configurations: PermissionSnapshot['configurations'] = {};
  for (const role of roles) configurations[role.id] = await roleConfiguration(env, role.id);
  return { version: 1, updatedAt: Date.now(), roles, configurations };
}

/** A JSON document in the current Cloudflare location's named Cache API cache. */
export class PermissionCacheStore {
  private cache: Promise<JsonCache>;
  private key: string;
  private readSource: () => Promise<PermissionSnapshot>;
  private now: () => number;
  constructor(cache: JsonCache | Promise<JsonCache>, key: string, readSource: () => Promise<PermissionSnapshot>, now = Date.now) {
    this.cache = Promise.resolve(cache); this.key = key; this.readSource = readSource; this.now = now;
  }
  async refresh(): Promise<PermissionSnapshot> {
    try {
      const snapshot = snapshotSchema.parse(await this.readSource());
      await (await this.cache).put(this.key, Response.json(snapshot, { headers: { 'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}` } }));
      return snapshot;
    } catch { throw new AccessError(503, '权限缓存更新失败，请稍后重试', 'PERMISSION_CACHE_UNAVAILABLE'); }
  }
  async snapshot(): Promise<PermissionSnapshot> {
    const response = await (await this.cache).match(this.key);
    if (response) {
      const parsed = snapshotSchema.safeParse(await response.json().catch(() => null));
      if (parsed.success && this.now() - parsed.data.updatedAt < CACHE_TTL_SECONDS * 1000
        && parsed.data.updatedAt <= this.now()) return parsed.data;
    }
    // Never authorize with expired, malformed, or partially fetched permissions.
    return this.refresh();
  }
  async permissions(roleIds: string[]) {
    const snapshot = await this.snapshot();
    const permissions = [...new Set(roleIds.flatMap(id => snapshot.configurations[id]?.permissions ?? []).filter(isPermissionCode))].sort();
    return { permissions, updatedAt: snapshot.updatedAt };
  }
}

export function permissionCache(env: Env) {
  if (!/^org_[A-Za-z0-9]+$/.test(env.AUTH0_ORGANIZATION_ID)) throw new AccessError(503, '权限缓存尚未配置');
  // Named cache + a fixed internal key: the public fetch path never exposes this document.
  const key = new URL(`/__gateway-permissions/v1/${env.AUTH0_ORGANIZATION_ID}`, env.SITE_ORIGIN);
  key.searchParams.set('audience', env.AUTH0_AUDIENCE);
  return new PermissionCacheStore(caches.open('eastmoney-permissions-v1'), key.href, () => readAuth0Permissions(env));
}
