import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { assertGatewayManagementClient, GATEWAY_MANAGEMENT_CLIENT_ID, GATEWAY_MANAGEMENT_CLIENT_NAME, GATEWAY_MANAGEMENT_SCOPES } from '../scripts/lib/gateway-management-client.mjs';
const client = { client_id: GATEWAY_MANAGEMENT_CLIENT_ID, name: GATEWAY_MANAGEMENT_CLIENT_NAME, app_type: 'non_interactive', client_secret: 'fixture', grant_types: ['client_credentials'] };
const grant = { audience: 'https://hasbai.eu.auth0.com/api/v2/', scope: GATEWAY_MANAGEMENT_SCOPES };
test('shared runtime application accepts only the exact six-scope Management API union', () => {
  assert.doesNotThrow(() => assertGatewayManagementClient(client, [{ ...grant, scope: [...grant.scope].reverse() }]));
  for (const grants of [[{ ...grant, scope: grant.scope.slice(1) }], [{ ...grant, scope: [...grant.scope, 'delete:users'] }], [grant, { audience: 'https://eastmoney.hasbai.xyz/', scope: ['data.choice:read'] }], [{ ...grant, audience: 'other' }]]) {
    assert.throws(() => assertGatewayManagementClient(client, grants));
  }
  for (const change of [{ client_id: 'old-login-reader' }, { grant_types: ['client_credentials', 'password'] }, { client_secret: '' }]) assert.throws(() => assertGatewayManagementClient({ ...client, ...change }, [grant]));
});
test('old organization migration stops before loading credentials or preparing obsolete applications', () => {
  const result = spawnSync(process.execPath, [new URL('../scripts/prepare-organization-migration.mjs', import.meta.url).pathname], { cwd: '/tmp', encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Historical organization migration is retired/);
});
