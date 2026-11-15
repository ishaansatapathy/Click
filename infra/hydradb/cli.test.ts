import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { composeArgs, ensureToken, runHydraCommand } from './cli.js';

describe('HydraDB lifecycle CLI', () => {
  it('builds Docker arguments without a shell and pins the compose file', () => {
    const args = composeArgs('up', '--detach');
    expect(args.slice(0, 2)).toEqual(['compose', '--project-directory']);
    expect(args).toContain('--file');
    expect(args.slice(-2)).toEqual(['up', '--detach']);
  });

  it('creates a persistent token without printing or replacing it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'click-hydra-token-'));
    const path = join(directory, 'nested', 'token');
    const first = await ensureToken(path);
    const second = await ensureToken(path);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect((await readFile(path, 'utf8')).trim()).toBe(first);
  });

  it('sets Git Bash path-conversion protection and reset removes volumes before restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'click-hydra-reset-'));
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    let readyChecks = 0;
    await runHydraCommand('reset', {
      tokenFile: join(directory, 'token'),
      async runDocker(args, env) { calls.push({ args, env }); },
      async waitUntilReady() { readyChecks++; },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['down', '--volumes']));
    expect(calls[1]!.args).toContain('up');
    expect(calls.every(({ env }) => env.MSYS_NO_PATHCONV === '1')).toBe(true);
    expect(calls[0]!.env.HYDRADB_TOKEN).not.toBe(calls[1]!.env.HYDRADB_TOKEN);
    expect(readyChecks).toBe(1);
  });
});
