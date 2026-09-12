import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentArguments } from '../scripts/auth0-deploy.mjs';

test('organization apply previews in a separate process and reloads pristine assets for import', () => {
  const plan = deploymentArguments(['apply', '--include=organizations', '--input=tenant.yaml'], '/task');
  assert.deepEqual(plan.commands, [
    ['import', '--input_file=/task/tenant.yaml', '--dry-run'],
    ['import', '--input_file=/task/tenant.yaml'],
  ]);
  assert.deepEqual(deploymentArguments(['plan', '--include=organizations', '--input=tenant.yaml'], '/task').commands,
    [['import', '--input_file=/task/tenant.yaml', '--dry-run']]);
  for (const args of [['apply', '--input=x'], ['apply', '--include=clients', '--allow-delete=true'], ['export', '--include=clients', '--input=x']]) {
    assert.throws(() => deploymentArguments(args));
  }
});
