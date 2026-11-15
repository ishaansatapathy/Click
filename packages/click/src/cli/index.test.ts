import { describe, expect, it } from 'vitest';
import { COMMANDS, USAGE, dispatch, type CliIo, type CommandRunner } from './index.js';

function capture(): { io: CliIo; out: () => string; err: () => string } {
  let o = '';
  let e = '';
  return { io: { out: (t) => (o += t), err: (t) => (e += t) }, out: () => o, err: () => e };
}

describe('click dispatcher', () => {
  it('registers every command and lists each in the usage text', () => {
    expect(Object.keys(COMMANDS)).toEqual(['map', 'push', 'pull', 'probe', 'serve', 'index', 'context', 'reindex', 'status']);
    for (const name of Object.keys(COMMANDS)) expect(USAGE).toMatch(new RegExp(`^  ${name} {1,7}\\S`, 'm'));
  });

  it('routes each command to its runner with the remaining argv, the shared io and the cwd', async () => {
    const calls: string[] = [];
    const fake = (name: string, code: number): CommandRunner => async (argv, _io, cwd) => {
      calls.push(`${name}:${argv.join(' ')}@${cwd}`);
      return code;
    };
    const commands = {
      map: { run: fake('map', 0), help: '' },
      push: { run: fake('push', 3), help: '' },
      pull: { run: fake('pull', 0), help: '' },
      probe: { run: fake('probe', 0), help: '' },
    };
    const { io } = capture();
    expect(await dispatch(['push', '--full', '--root', 'x'], io, '/repo', commands)).toBe(3); // the exit code is the runner's
    expect(await dispatch(['probe', '--runs', '5'], io, '/repo', commands)).toBe(0);
    expect(await dispatch(['map', '--stats'], io, '/repo', commands)).toBe(0);
    expect(await dispatch(['pull'], io, '/other', commands)).toBe(0);
    expect(calls).toEqual(['push:--full --root x@/repo', 'probe:--runs 5@/repo', 'map:--stats@/repo', 'pull:@/other']);
  });

  it('no command prints usage and exits 2; --help exits 0; an unknown command exits 2 on stderr', async () => {
    const a = capture();
    expect(await dispatch([], a.io)).toBe(2);
    expect(a.out()).toBe(USAGE);
    const b = capture();
    expect(await dispatch(['--help'], b.io)).toBe(0);
    expect(b.out()).toBe(USAGE);
    const c = capture();
    expect(await dispatch(['frobnicate'], c.io)).toBe(2);
    expect(c.err()).toContain('unknown command "frobnicate"');
    expect(c.out()).toBe('');
  });

  it('does not treat inherited object keys as commands', async () => {
    const { io, err } = capture();
    expect(await dispatch(['constructor'], io)).toBe(2);
    expect(await dispatch(['toString'], io)).toBe(2);
    expect(err()).toContain('unknown command');
  });

  it('importing the module does not run the CLI', () => {
    expect(typeof dispatch).toBe('function'); // reaching this line means no process.exit / output happened at import
  });
});
