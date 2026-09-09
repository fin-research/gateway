import { createHash } from 'node:crypto';
type DatabaseClient = { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, any>[] }> };
import { PERMISSION_CODES, isPermissionCode } from '../permissions.ts';
export class PermissionConfigurationError extends Error {
  status: 400 | 409;
  constructor(status: 400 | 409, message: string) { super(message); this.status = status; }
}

export async function rolePermissions(db: DatabaseClient, roleIds: string[]): Promise<string[]> {
  const result = await db.query(`SELECT DISTINCT rp.permission_code FROM "authorization".role_permission rp
    JOIN "authorization".permission p ON p.code = rp.permission_code WHERE rp.auth0_role_id = ANY($1::text[]) AND rp.granted`, [roleIds]);
  return result.rows.map((row) => row.permission_code).filter(isPermissionCode).sort();
}

export async function roleConfiguration(db: DatabaseClient, roleId: string) {
  const result = await db.query(`SELECT permission_code, granted, updated_at::text FROM "authorization".role_permission WHERE auth0_role_id = $1 ORDER BY permission_code`, [roleId]);
  return { permissions: result.rows.filter((row) => row.granted && isPermissionCode(row.permission_code)).map((row) => row.permission_code as string),
    version: createHash('sha256').update(JSON.stringify(result.rows)).digest('hex') };
}

/** Caller starts a transaction; the role lock serializes edits including an empty role. */
export async function saveRoleConfiguration(db: DatabaseClient, roleId: string, permissions: string[], version: string, actorId: string) {
  if (!/^rol_[A-Za-z0-9]+$/.test(roleId) || permissions.some((code) => !isPermissionCode(code)) || new Set(permissions).size !== permissions.length) throw new PermissionConfigurationError(400, '角色或权限格式无效');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('\"authorization\".role_permission:' || $1, 0))", [roleId]);
  if ((await roleConfiguration(db, roleId)).version !== version) throw new PermissionConfigurationError(409, '权限已被其他操作更新，请刷新后重新配置');
  await db.query(`INSERT INTO "authorization".role_permission (auth0_role_id, permission_code, granted, updated_by)
    SELECT $1, code, code = ANY($2::text[]), $3 FROM "authorization".permission WHERE code = ANY($4::text[])
    ON CONFLICT (auth0_role_id, permission_code) DO UPDATE SET granted = EXCLUDED.granted, updated_by = EXCLUDED.updated_by, updated_at = clock_timestamp()`,
  [roleId, permissions, actorId, PERMISSION_CODES]);
  return roleConfiguration(db, roleId);
}
