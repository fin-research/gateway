import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AUTH0_DOMAIN, LOGIN_ACTION_ID, management } from './lib/auth0-management.mjs';

const apply = process.argv.includes('--apply');
const code = await readFile(new URL('../auth0/actions/eastmoney-login.cjs', import.meta.url), 'utf8');
const path = `actions/actions/${LOGIN_ACTION_ID}`;
const action = management('get', path);
const expectedPreviousHash = '0a7688538b71ccd7c4bc0ebc5c2259182be8ce926d456d829bf1302f0fe66e3e';
if (createHash('sha256').update(action.deployed_version?.code ?? '').digest('hex') !== expectedPreviousHash && action.code !== code) throw new Error('The deployed Action changed since this fix was prepared; review it before publishing');
if (action.name !== 'eastmoney login claims' || action.runtime !== 'node22') throw new Error('Unexpected login Action');
if (!action.all_changes_deployed && action.code !== code) throw new Error('The Action has an unrelated unpublished draft; preserve it before publishing');
console.log(JSON.stringify({ mode: apply ? 'apply' : 'plan', tenant: AUTH0_DOMAIN, actionId: LOGIN_ACTION_ID, changed: action.code !== code }));
if (!apply) process.exit(0);

// Do not redirect new registrations until the public notice page is online.
const page = await fetch('https://eastmoney.hasbai.xyz/auth/verify-email', { redirect: 'manual', signal: AbortSignal.timeout(15000) });
if (page.status !== 200 || !(await page.text()).includes('我已验证，继续登录')) throw new Error('Deploy and verify the email notice page before publishing the Action');
if (action.code !== code) management('patch', path, { code });
const version = management('post', `${path}/deploy`);
const updated = management('get', path);
const bindings = management('get', 'actions/triggers/post-login/bindings');
const bound = bindings.bindings.find((binding) => binding.action?.id === LOGIN_ACTION_ID);
if (updated.deployed_version?.code !== code || bound?.action?.deployed_version?.code !== code) throw new Error('Login Action deployment verification failed');
console.log(JSON.stringify({ published: true, actionId: LOGIN_ACTION_ID, versionId: version.id, bound: true }));
