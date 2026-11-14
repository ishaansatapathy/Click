import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { profileRepo } from '../../packages/core/src/indexer/profile.js';

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(benchDir, 'data', 'repo-profile.json');
const profile = profileRepo(resolve(benchDir, 'repo'));
const portableProfile = { ...profile, root: 'bench/repo' };

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(portableProfile, null, 2)}\n`, 'utf8');
process.stdout.write(`Profiled ${Object.values(profile.counts).reduce((sum, count) => sum + count, 0)} files\n`);
process.stdout.write(`Wrote ${output}\n`);
