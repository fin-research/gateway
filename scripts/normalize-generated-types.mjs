import { readFile, writeFile } from 'node:fs/promises';
const path = new URL('../worker-configuration.d.ts', import.meta.url);
const source = await readFile(path, 'utf8');
await writeFile(path, source.split('\n').map(line => line.trimEnd()).join('\n'));
