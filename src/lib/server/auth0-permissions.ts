import { z } from 'zod';
import { createAuth0ManagementClient } from './auth0-management.js';
import { isPermissionCode } from '../permissions.ts';

/** Read-only management view; authorization itself consumes verified JWT claims. */
export async function roleConfiguration(env: Env, roleId: string) {
  const manager = createAuth0ManagementClient({ domain: env.AUTH0_DOMAIN, clientId: env.AUTH0_MANAGEMENT_CLIENT_ID,
    clientSecret: env.AUTH0_MANAGEMENT_CLIENT_SECRET });
  const rows = z.array(z.object({ permission_name: z.string(), resource_server_identifier: z.string() }))
    .parse(await manager.list(`roles/${encodeURIComponent(roleId)}/permissions`));
  return { permissions: [...new Set(rows.filter(row => row.resource_server_identifier === env.AUTH0_AUDIENCE)
    .map(row => row.permission_name).filter(isPermissionCode))].sort() };
}
