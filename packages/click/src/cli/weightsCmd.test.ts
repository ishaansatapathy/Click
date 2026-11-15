import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WeightsFile } from '../../../core/src/learn/weights.js';
import type { WeightsDoc } from '../../../core/src/types.js';
import { ClickClient } from '../client.js';
import { writeInfo } from '../daemon/lifecycle.js';
import { startHttp, type HttpHandle } from '../daemon/server.js';
import { runWeights } from './weightsCmd.js';

let root: string;
let file: WeightsFile;
const handles: HttpHandle[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'click-wcmd-'));
  mkdirSync(join(root, '.click'));
  file = new WeightsFile(join(root, '.click'));
});
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close()));
  rmSync(root, { recursive: true, force: true });
});

const doc = (version: string, events: number, multipliers: Record<string, number>): WeightsDoc => ({ v: 1, version, derivedFrom: null, events, params: { alpha: 0.2, beta: 0.1, min: 0.1, max: 5 }, multipliers, addedEdges: [] });
function cap() {
  let o = '';
  let e = '';
  return { io: { out: (t: string) => (o += `${t}\n`), err: (t: string) => (e += `${t}\n`) }, out: () => o, err: () => e };
}

describe('click weights (PROMPTS 155)', () => {
  it('--show: nothing learned yet, then a readable summary with the edges trusted more and less; --json is machine readable', async () => {
    const a = cap();
    expect(await runWeights(['--show'], a.io, root)).toBe(0);
    expect(a.out()).toContain('no learned weights yet');
    await file.save(doc('v1', 3, { 'a|calls|b': 1.44, 'c|uses_store|d': 0.81, 'e|imports|f': 1 }));
    const b = cap();
    await runWeights(['--show'], b.io, root);
    expect(b.out()).toContain('weights v1: learned from 3 outcomes, 3 edge multipliers');
    expect(b.out()).toContain('×1.44  a|calls|b');
    expect(b.out()).toContain('×0.81  c|uses_store|d');
    expect(b.out()).not.toContain('e|imports|f'); // 1.0 is neither more nor less
    const j = cap();
    await runWeights(['--show', '--json'], j.io, root);
    expect(JSON.parse(j.out())).toMatchObject({ version: 'v1', events: 3, multipliers: 3, previous: null });
  });

  it('--rollback: the previous version becomes current, and doing it again undoes it', async () => {
    await file.save(doc('v1', 1, { 'a|calls|b': 1.2 }));
    await file.save(doc('v2', 2, { 'a|calls|b': 1.44 }));
    const a = cap();
    expect(await runWeights(['--rollback'], a.io, root, { client: new ClickClient({ root }) })).toBe(0);
    expect(a.out()).toContain('v2 -> v1');
    expect(a.out()).toContain('no daemon is running');
    expect((await file.load())?.version).toBe('v1');
    await runWeights(['--rollback'], cap().io, root, { client: new ClickClient({ root }) });
    expect((await file.load())?.version).toBe('v2');
  });

  it('--rollback with nothing before: says so and exits 1', async () => {
    await file.save(doc('v1', 1, {}));
    const a = cap();
    expect(await runWeights(['--rollback'], a.io, root)).toBe(1);
    expect(a.err()).toContain('nothing to roll back');
  });

  it('--rollback tells a running daemon to reload, and reports it if the daemon cannot be reached', async () => {
    await file.save(doc('v1', 1, {}));
    await file.save(doc('v2', 2, { x: 2 }));
    let reloads = 0;
    const h = await startHttp({ token: 't', routes: [{ method: 'POST', path: '/weights/reload', handle: () => (reloads++, { ok: true, version: 'v1' }) }] });
    handles.push(h);
    await writeInfo(join(root, '.click'), { v: 1, pid: process.pid, port: h.port, token: 't', startedAt: 'x', version: '0', root });
    const a = cap();
    await runWeights(['--rollback'], a.io, root, { client: new ClickClient({ root }) });
    expect(reloads).toBe(1);
    expect(a.out()).toContain('the running daemon is using them now');

    await writeInfo(join(root, '.click'), { v: 1, pid: process.pid, port: h.port, token: 'wrong', startedAt: 'x', version: '0', root });
    const b = cap();
    expect(await runWeights(['--rollback'], b.io, root, { client: new ClickClient({ root }) })).toBe(0); // the file change stands
    expect(b.err()).toContain('could not tell the running daemon');
  });

  it('needs exactly one of --show / --rollback', async () => {
    for (const argv of [[], ['--show', '--rollback'], ['--nope'], ['--show', 'extra']]) expect(await runWeights(argv, cap().io, root), argv.join(' ')).toBe(2);
  });
});
