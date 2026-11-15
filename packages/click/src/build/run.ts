// `pnpm build`
import { statSync } from 'node:fs';
import { bundle } from './bundle.js';

const { files } = await bundle();
for (const f of files) process.stdout.write(`${f}  ${(statSync(f).size / 1024).toFixed(1)} KB\n`);
