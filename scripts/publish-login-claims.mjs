import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AUTH0_DOMAIN, LOGIN_ACTION_ID, management } from './lib/auth0-management.mjs';

const apply = process.argv.includes('--apply');
const code = await readFile(new URL('../auth0/actions/eastmoney-login.cjs', import.meta.url), 'utf8');
const path = `actions/actions/${LOGIN_ACTION_ID}`;
const action = management('get', path);
const expectedPreviousHash = '22910cd9bda1b473955170a33618ced78878bab887072a8afdff6c1ef8057846';
if (createHash('sha256').update(action.deployed_version?.code ?? '').digest('hex') !== expectedPreviousHash && action.code !== code) throw new Error('The deployed Action changed since this fix was prepared; review it before publishing');
if (action.name !== 'eastmoney login claims' || action.runtime !== 'node22') throw new Error('Unexpected login Action');
if (!action.all_changes_deployed && action.code !== code) throw new Error('The Action has an unrelated unpublished draft; preserve it before publishing');
const roleClientId = 'Ja1Jra2z1ifOKOUnA9M2qu3JzUudgW4j';
const client = management('get', `clients/${roleClientId}`);
const grants = management('get', `client-grants?client_id=${roleClientId}`);
if (client.name !== 'eastmoney-login-roles' || !client.client_secret || grants.length !== 1
  || grants[0].audience !== `https://${AUTH0_DOMAIN}/api/v2/`
  || JSON.stringify(grants[0].scope) !== JSON.stringify(['read:roles', 'create:organization_member_roles'])) throw new Error('Unexpected login role client or grant');
const secrets = [
  { name: 'EASTMONEY_CLIENT_ID', value: '16vMxoYpr5AdPRiW1PkwIiHuRWszii6m' },
  { name: 'ROLES_DOMAIN', value: AUTH0_DOMAIN },
  { name: 'ROLES_CLIENT_ID', value: roleClientId },
  { name: 'ROLES_CLIENT_SECRET', value: client.client_secret },
];
if (action.secrets?.some(secret => !secrets.some(next => next.name === secret.name))) throw new Error('Preserve unexpected Action secrets before publishing');
console.log(JSON.stringify({ mode: apply ? 'apply' : 'plan', tenant: AUTH0_DOMAIN, actionId: LOGIN_ACTION_ID, changed: action.code !== code }));
if (!apply) process.exit(0);

// Do not redirect new registrations until the public notice page is online.
const page = await fetch('https://eastmoney.hasbai.xyz/auth/verify-email', { redirect: 'manual', signal: AbortSignal.timeout(15000) });
if (page.status !== 200 || !(await page.text()).includes('我已验证，继续登录')) throw new Error('Deploy and verify the email notice page before publishing the Action');
// This rollout changes claim names only; leave all existing Action secrets untouched.
management('patch', path, { code });
const version = management('post', `${path}/deploy`);
const updated = management('get', path);
const bindings = management('get', 'actions/triggers/post-login/bindings');
const bound = bindings.bindings.find((binding) => binding.action?.id === LOGIN_ACTION_ID);
if (updated.deployed_version?.code !== code || bound?.action?.deployed_version?.code !== code) throw new Error('Login Action deployment verification failed');
console.log(JSON.stringify({ published: true, actionId: LOGIN_ACTION_ID, versionId: version.id, bound: true }));
