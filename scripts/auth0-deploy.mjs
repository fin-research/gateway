import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auth0DeployCredentials } from './lib/auth0-deploy-config.mjs';

export function deploymentArguments(argv, cwd = process.cwd()) {
  const [mode, ...raw] = argv.filter(value => value !== '--');
  if (!['export', 'plan', 'apply'].includes(mode)) throw new Error('Expected export, plan, or apply');
  const options = new Map();
  for (const arg of raw) {
    const match = /^--(include|input|output)=(.+)$/.exec(arg);
    if (!match || options.has(match[1])) throw new Error('Use unique --include=, --input=, and --output= arguments');
    options.set(match[1], match[2]);
  }
  const included = options.get('include')?.split(',') ?? [];
  if (!included.length || included.some(type => !/^[a-zA-Z]+$/.test(type))) throw new Error('Explicit --include=resourceTypes is required');
  if (mode !== 'export' && (!options.has('input') || options.has('output'))) throw new Error('plan/apply require --input= and do not accept --output=');
  if (mode === 'export' && options.has('input')) throw new Error('export does not accept --input=');
  const output = resolve(cwd, options.get('output') ?? '.auth0-deploy/export');
  const command = mode === 'export'
    ? ['export', '--format=yaml', '--output_folder=' + output]
    : ['import', '--input_file=' + resolve(cwd, options.get('input')), '--dry-run', ...(mode === 'apply' ? ['--apply'] : [])];
  return { mode, included, output, command };
}

async function main() {
  const plan = deploymentArguments(process.argv.slice(2));
  const credentials = await auth0DeployCredentials();
  if (plan.mode === 'export') await mkdir(plan.output, { recursive: true, mode: 0o700 });
  // Use a clean Auth0 configuration so an inherited access token, deletion flag,
  // or dry-run override cannot change this explicit invocation.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AUTH0_')));
  Object.assign(env, credentials, { AUTH0_INCLUDED_ONLY: JSON.stringify(plan.included),
    AUTH0_ALLOW_DELETE: 'false', AUTH0_EXPORT_SECRETS: 'false' });
  const bin = fileURLToPath(new URL('../node_modules/auth0-deploy-cli/lib/index.js', import.meta.url));
  const child = spawn(process.execPath, [bin, ...plan.command], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  // Buffer logs so secrets split across stdout chunks are still redacted.
  const chunks = []; let size = 0;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
    size += bytes.length;
    if (size > 4 * 1024 * 1024) child.kill(); else chunks.push(bytes);
  });
  const exit = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', code => resolveExit(code)); });
  let log = Buffer.concat(chunks).toString('utf8').replaceAll(credentials.AUTH0_CLIENT_SECRET, '[redacted]');
  log = log.replace(/(?:Bearer\s+)[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]');
  process.stdout.write(log);
  console.log(JSON.stringify({ mode: plan.mode, tenant: credentials.AUTH0_DOMAIN, resources: plan.included, deletionAllowed: false, success: exit === 0 }));
  if (exit !== 0) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => {
  console.error('Auth0 Deploy CLI failed; check root credentials, resource scope and sanitized output'); process.exitCode = 1;
});
