import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { management as m, AUTH0_DOMAIN } from './lib/auth0-management.mjs';
import { auth0DeployCredentials } from './lib/auth0-deploy-config.mjs';
import { GATEWAY_MANAGEMENT_CLIENT_ID as clientId, GATEWAY_MANAGEMENT_CLIENT_NAME as clientName, assertGatewayManagementClient } from './lib/gateway-management-client.mjs';
const yaml = createRequire(import.meta.resolve('auth0-deploy-cli'))('js-yaml');
const audience = `https://${AUTH0_DOMAIN}/api/v2/`;
const directory = '.auth0-deploy/m2m';
const retired = [
  { id: 'Ja1Jra2z1ifOKOUnA9M2qu3JzUudgW4j', name: 'eastmoney-login-roles' },
  { id: 'rpBS8lgdzn7LXhImz8BGiKLPSTjztcwz', name: 'eastmoney signup profile' },
];
const targets = [
  { id: '0b72438c-33ff-4321-b6c7-74b7d021e6a3', name: 'eastmoney login claims', prefix: 'ROLES', file: 'eastmoney-login.cjs' },
  { id: '91736f7a-024c-406d-905b-7d2daa20ec8f', name: 'eastmoney signup profile', prefix: 'PROFILE', file: 'eastmoney-signup-profile.cjs' },
];
const mode = process.argv[2];
const apply = process.argv.includes('--apply');
if (!['plan', 'switch', 'disable', 'delete'].includes(mode)) throw new Error('Expected plan, switch, disable, or delete; mutations require --apply');
async function save(name, data) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(`${directory}/${name}`, JSON.stringify(data, null, 2), { mode: 0o600 });
}
function bindings() { return m('get', 'actions/triggers/post-login/bindings').bindings.map(b => ({ id: b.action.id, display_name: b.display_name })); }
async function actions() {
  const result = [];
  for (const target of targets) {
    const action = m('get', `actions/actions/${target.id}`);
    const code = await readFile(new URL(`../auth0/actions/${target.file}`, import.meta.url), 'utf8');
    assert.equal(action.name, target.name);
    assert.equal(action.runtime, 'node22');
    assert.equal(action.code, code, 'Unrelated Action draft or code change');
    assert.equal(action.deployed_version?.code, code, 'Unexpected deployed Action code');
    assert.equal(action.all_changes_deployed, true, 'Preserve unpublished Action changes');
    const names = ['EASTMONEY_CLIENT_ID', `${target.prefix}_CLIENT_ID`, `${target.prefix}_CLIENT_SECRET`, target.prefix === 'ROLES' ? 'ROLES_DOMAIN' : 'PROFILE_FORM_ID'];
    assert.deepEqual(action.secrets.map(s => s.name).sort(), names.sort(), 'Unexpected Action secrets');
    result.push(action);
  }
  return result;
}
async function importActions(input, manager) {
  const credentials = await auth0DeployCredentials();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AUTH0_')));
  Object.assign(env, credentials, { AUTH0_INCLUDED_ONLY: '["actions"]', AUTH0_ALLOW_DELETE: 'false', AUTH0_EXPORT_SECRETS: 'false',
    AUTH0_KEYWORD_REPLACE_MAPPINGS: JSON.stringify({ GATEWAY_MANAGEMENT_SECRET: manager.client_secret }) });
  const args = ['--use-env-proxy', 'node_modules/auth0-deploy-cli/lib/index.js', 'import', `--input_file=${resolve(input)}`];
  for (const flags of apply ? [['--dry-run'], []] : [['--dry-run']]) {
    const result = spawnSync(process.execPath, [...args, ...flags], { env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    let log = (result.stdout ?? '') + (result.stderr ?? '');
    for (const secret of [credentials.AUTH0_CLIENT_SECRET, manager.client_secret]) log = log.replaceAll(secret, '[redacted]');
    log = log.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]');
    process.stdout.write(log);
    if (result.status !== 0) throw new Error('Explicit Action import failed; read back tenant state before retrying');
  }
}
if (mode === 'plan') {
  const before = yaml.load(await readFile('.auth0-deploy/m2m-before/tenant.yaml', 'utf8'));
  const snapshot = { bindings: bindings(), actions: await actions(), clients: [], grants: [], forms: m('get', 'forms') };
  assert.equal(before.flows.length, 0, 'Review Flow consumers');
  assert.equal(before.flowVaultConnections.length, 0, 'Review Vault consumers');
  for (const old of retired) {
    const client = m('get', `clients/${old.id}`);
    assert.equal(client.name, old.name);
    delete client.client_secret; delete client.signing_keys;
    snapshot.clients.push(client);
    const grants = m('get', `client-grants?client_id=${old.id}`);
    assert.equal(grants.length, 1); assert.equal(grants[0].audience, audience);
    snapshot.grants.push(...grants);
  }
  await save('before.json', snapshot);
  await writeFile(`${directory}/disable.yaml`, yaml.dump({ clients: snapshot.clients.map(c => ({ client_id: c.client_id, name: c.name, grant_types: [],
    client_metadata: { ...c.client_metadata, lifecycle: 'retired', replaced_by: clientId } })),
    clientGrants: snapshot.grants.map(g => ({ client_id: g.client_id, audience: g.audience, scope: [] })) }), { mode: 0o600 });
  console.log(JSON.stringify({ mode, retained: clientName, clientId, switchActions: targets.map(t => t.name), retireAfterVerification: retired.map(c => c.name), gatewaySecretRotated: false }));
} else if (mode === 'switch') {
  const before = JSON.parse(await readFile(`${directory}/before.json`, 'utf8'));
  assert.deepEqual(bindings(), before.bindings);
  const manager = m('get', `clients/${clientId}`);
  assertGatewayManagementClient(manager, m('get', `client-grants?client_id=${clientId}`));
  const liveActions = await actions();
  const forms = m('get', 'forms').filter(f => f.name === 'eastmoney signup profile');
  assert.equal(forms.length, 1);
  for (let index = 0; index < liveActions.length; index++) {
    await writeFile(`${directory}/${targets[index].file}`, liveActions[index].code, { mode: 0o600 });
  }
  const definitions = liveActions.map((a, index) => {
    const prefix = targets[index].prefix;
    return { id: a.id, name: a.name, runtime: a.runtime, code: `./${targets[index].file}`, dependencies: a.dependencies,
      supported_triggers: a.supported_triggers, deployed: true, secrets: [
        { name: 'EASTMONEY_CLIENT_ID', value: '16vMxoYpr5AdPRiW1PkwIiHuRWszii6m' },
        { name: `${prefix}_CLIENT_ID`, value: clientId },
        { name: `${prefix}_CLIENT_SECRET`, value: '##GATEWAY_MANAGEMENT_SECRET##' },
        prefix === 'ROLES' ? { name: 'ROLES_DOMAIN', value: AUTH0_DOMAIN } : { name: 'PROFILE_FORM_ID', value: forms[0].id },
      ] };
  });
  await writeFile(`${directory}/actions.yaml`, yaml.dump({ actions: definitions }), { mode: 0o600 });
  await importActions(`${directory}/actions.yaml`, manager);
  if (apply) {
    const after = await actions();
    assert.deepEqual(bindings(), before.bindings);
    assert.deepEqual(m('get', 'forms'), before.forms);
    for (let i = 0; i < after.length; i++) assert.deepEqual(after[i].dependencies, liveActions[i].dependencies);
    await save('switched.json', { clientId, versions: after.map(a => ({ id: a.id, version: a.deployed_version.id })) });
    console.log(JSON.stringify({ switched: true, clientId, actionVersions: after.map(a => a.deployed_version.id), bindingOrderPreserved: true, formPreserved: true }));
  }
} else {
  const verified = JSON.parse(await readFile(`${directory}/verified.json`, 'utf8'));
  assert.equal(verified.clientId, clientId); assert.equal(verified.passed, true);
  const switched = JSON.parse(await readFile(`${directory}/switched.json`, 'utf8'));
  for (const action of await actions()) assert.equal(action.deployed_version.id, switched.versions.find(v => v.id === action.id)?.version);
  const manager = m('get', `clients/${clientId}`);
  assertGatewayManagementClient(manager, m('get', `client-grants?client_id=${clientId}`));
  // Never enable tenant-wide deletion. Only the two named, disabled clients can be removed.
  if (mode === 'disable') {
    console.log(JSON.stringify({ next: 'Use auth0:plan/apply --include=clients,clientGrants', input: `${directory}/disable.yaml` }));
  } else {
    const retiredVerification = JSON.parse(await readFile(`${directory}/retired-verified.json`, 'utf8'));
    assert.equal(retiredVerification.clientId, clientId);
    assert.equal(retiredVerification.oldTokensRejected, true);
    assert.equal(retiredVerification.freshLogin, true);
    for (const old of retired) {
      const all = m('get', 'clients?per_page=100');
      const found = all.find(c => c.client_id === old.id);
      if (!found) continue;
      assert.equal(found.name, old.name); assert.deepEqual(found.grant_types, []);
      const grants = m('get', `client-grants?client_id=${old.id}`);
      assert.ok(grants.every(g => g.scope.length === 0));
      console.log(JSON.stringify({ mode: apply ? 'delete' : 'delete-plan', clientId: old.id, name: old.name }));
      if (apply) m('delete', `clients/${old.id}`);
    }
    if (apply) {
      assert.ok(!m('get', 'clients?per_page=100').some(c => retired.some(old => old.id === c.client_id)));
      console.log(JSON.stringify({ deleted: retired.length, remainingManagementClient: clientName }));
    }
  }
}
