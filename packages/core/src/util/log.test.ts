import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from './log.js';

const SECRET = 'sk-ant-super-secret-123456';
const ENV = { ANTHROPIC_API_KEY: SECRET };
const FIXED = () => new Date('2026-11-15T10:20:30.000Z');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'click-log-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function lines(): Array<Record<string, unknown>> {
  const files = readdirSync(dir);
  return files.flatMap((f) =>
    readFileSync(join(dir, f), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>),
  );
}

describe('logger', () => {
  it('writes JSON lines to <proc>-<date>.jsonl', () => {
    const log = createLogger('daemon', { dir, env: {}, now: FIXED });
    log.info('booted', { nodes: 42 });
    expect(readdirSync(dir)).toEqual(['daemon-2026-11-15.jsonl']);
    expect(lines()).toEqual([{ ts: '2026-11-15T10:20:30.000Z', level: 'info', proc: 'daemon', msg: 'booted', nodes: 42 }]);
  });

  it('drops debug unless CLICK_DEBUG is set', () => {
    createLogger('p', { dir, env: {}, now: FIXED }).debug('quiet');
    expect(lines()).toEqual([]);
    createLogger('p', { dir, env: { CLICK_DEBUG: '1' }, now: FIXED, stderr: () => {} }).debug('loud');
    expect(lines().map((l) => l.msg)).toEqual(['loud']);
  });

  it('redacts secrets in the message, in fields at any depth, and in errors', () => {
    const log = createLogger('p', { dir, env: ENV, now: FIXED });
    log.error(`request failed with ${SECRET}`, {
      header: `Bearer ${SECRET}`,
      nested: { deep: [{ token: SECRET }] },
      err: new Error(`bad key ${SECRET}`),
    });
    const raw = readdirSync(dir)
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('');
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain('***');
    expect(lines()[0]?.msg).toBe('request failed with ***');
  });

  it('never writes to stdout, even with CLICK_DEBUG on', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errLines: string[] = [];
    const log = createLogger('hook', { dir, env: { CLICK_DEBUG: '1' }, now: FIXED, stderr: (l) => errLines.push(l) });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(out).not.toHaveBeenCalled();
    expect(errLines).toHaveLength(4); // the mirror goes to stderr
  });

  it('does not touch stdout or stderr by default', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    createLogger('p', { dir, env: {}, now: FIXED }).error('x');
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });

  it('child loggers add fields; core keys cannot be overridden by fields', () => {
    const log = createLogger('p', { dir, env: {}, now: FIXED }).child({ sessionId: 's1' });
    log.info('hello', { level: 'spoofed', msg: 'spoofed' });
    expect(lines()[0]).toMatchObject({ sessionId: 's1', level: 'info', msg: 'hello' });
  });

  it('survives cycles, bigint and exotic values', () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    const log = createLogger('p', { dir, env: {}, now: FIXED });
    expect(() => log.info('weird', { cyc, big: 10n, fn: () => 1, u: undefined })).not.toThrow();
    expect(lines()).toHaveLength(1);
  });

  it('never throws when the log directory is unusable', () => {
    const blocker = join(dir, 'a-file');
    writeFileSync(blocker, 'x');
    const log = createLogger('p', { dir: join(blocker, 'logs'), env: {}, now: FIXED });
    expect(() => log.error('cannot write')).not.toThrow();
  });
});
