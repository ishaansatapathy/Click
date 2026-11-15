// `pnpm drill [n ...]`: run the "never block the developer" drills (SPEC §18.2) against the built hook. Exit 1 if any fails.
import { runDrills } from './drills.js';

const only = process.argv.slice(2).map(Number).filter(Number.isInteger);
const results = await runDrills(only.length ? only : undefined);
const icon = { pass: '✅', fail: '❌', skip: '⏭ ' } as const;
console.log('');
for (const r of results) console.log(`${icon[r.status]} ${String(r.n).padStart(2)}. ${r.name}\n      ${r.detail}`);
const failed = results.filter((r) => r.status === 'fail').length;
const skipped = results.filter((r) => r.status === 'skip').length;
const worst = Math.max(0, ...results.map((r) => r.hookMs ?? 0));
console.log(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped · slowest hook run ${worst} ms (timeout 3000 ms)\n`);
process.exit(failed ? 1 : 0);
