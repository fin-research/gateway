import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { LOGIN_ACTION_ID, management as m } from './lib/auth0-management.mjs';
const apply = process.argv.includes('--apply');
const code = await readFile(new URL('../auth0/actions/eastmoney-login.cjs', import.meta.url), 'utf8');
const path = `actions/actions/${LOGIN_ACTION_ID}`;
const before = m('get', path);
const hash = text => createHash('sha256').update(text ?? '').digest('hex');
const base = 'edae3dcc46e10632ae3f13a07d7dd8da9033613da6af0a389281888cc75c3dca';
if (before.name !== 'eastmoney login claims' || before.runtime !== 'node22'
  || ![base, hash(code)].includes(hash(before.deployed_version?.code))
  || before.code !== before.deployed_version?.code && before.code !== code) throw new Error('Login Action changed or has an unrelated draft; review before publishing');
const bindings = m('get', 'actions/triggers/post-login/bindings').bindings.map(b => ({ id: b.action.id, display_name: b.display_name }));
console.log(JSON.stringify({ mode: apply ? 'apply' : 'plan', action: before.name, codeChanged: before.code !== code, secretChanges: false, bindingChanges: false }));
if (apply) {
  m('patch', path, { code });
  const version = m('post', `${path}/deploy`);
  const after = m('get', path);
  const afterBindings = m('get', 'actions/triggers/post-login/bindings').bindings;
  if (after.deployed_version?.code !== code || !isDeepStrictEqual(before.dependencies, after.dependencies)
    || !isDeepStrictEqual(before.secrets, after.secrets)
    || !isDeepStrictEqual(bindings, afterBindings.map(b => ({ id: b.action.id, display_name: b.display_name })))
    || afterBindings.find(b => b.action.id === LOGIN_ACTION_ID)?.action.deployed_version?.code !== code) throw new Error('Action deployment readback mismatch');
  console.log(JSON.stringify({ published: true, version: version.id }));
}
