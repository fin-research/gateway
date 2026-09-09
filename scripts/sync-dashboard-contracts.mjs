import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const dashboard = resolve(process.env.DASHBOARD_CHECKOUT || '../dashboard');
const check = process.argv.includes('--check');
const files = ['permissions.ts', 'route-permissions.ts'];
const hashes = {};
for (const file of files) {
  const source = await readFile(new URL('../src/lib/' + file, import.meta.url), 'utf8');
  const generated = '// Generated from eastmoney-gateway src/lib/' + file + '. Edit the Gateway source and sync contracts.\n' + source;
  const target = resolve(dashboard, 'src/lib/' + file);
  if (check) { if (await readFile(target, 'utf8') !== generated) throw new Error('Gateway contract drift: ' + file); }
  else await writeFile(target, generated);
  hashes[file] = createHash('sha256').update(generated).digest('hex');
}
const manifest = JSON.stringify({ owner: 'eastmoney-gateway', version: 1, files: hashes }, null, 2) + '\n';
const target = resolve(dashboard, 'src/lib/gateway-contracts.json');
if (check) { if (await readFile(target, 'utf8') !== manifest) throw new Error('Gateway contract manifest drift'); }
else await writeFile(target, manifest);
console.log(JSON.stringify({ contract: true, check, files }));
