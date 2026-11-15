import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventLog, EventTooLargeError, LOG_VERSION, MAX_EVENT_BYTES, newEventId, readEvents } from './log.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'click-log-'));
  file = join(dir, 'sub', 'events.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Ev {
  v: number;
  id: string;
  n?: number;
}
const ev = (id: string, n = 0): Ev => ({ v: LOG_VERSION, id, n });

describe('EventLog (PROMPTS 150, SPEC §14)', () => {
  it('appends one JSON line per event (creating the directory) and reads them back in order', async () => {
    const log = new EventLog<Ev>(file);
    await log.append(ev('a'));
    await log.append(ev('b', 2));
    expect(readFileSync(file, 'utf8')).toBe('{"v":1,"id":"a","n":0}\n{"v":1,"id":"b","n":2}\n');
    const r = await log.read();
    expect(r.events.map((e) => e.id)).toEqual(['a', 'b']);
    expect(r).toMatchObject({ truncatedTail: false, corrupt: 0, skipped: 0 });
  });

  it('a missing file reads as empty', async () => {
    expect(await readEvents(join(dir, 'nope.jsonl'))).toEqual({ events: [], truncatedTail: false, corrupt: 0, skipped: 0 });
  });

  it('concurrent appends from one instance are all written, each whole, in call order', async () => {
    const log = new EventLog<Ev>(file);
    await Promise.all(Array.from({ length: 200 }, (_, i) => log.append(ev(`e${i}`, i))));
    const r = await log.read();
    expect(r.events.map((e) => e.n)).toEqual(Array.from({ length: 200 }, (_, i) => i));
  });

  it('skips a truncated last line (a crash mid-write) and says so; earlier events survive', async () => {
    const log = new EventLog<Ev>(file);
    await log.append(ev('a'));
    await log.append(ev('b'));
    appendFileSync(file, '{"v":1,"id":"c","n":');
    const r = await log.read();
    expect(r.events.map((e) => e.id)).toEqual(['a', 'b']);
    expect(r.truncatedTail).toBe(true);
    expect(r.corrupt).toBe(0);
    // a restarted process appends on a fresh line: the torn fragment stays one bad line and the new event is not lost
    await new EventLog<Ev>(file).append(ev('d'));
    const again = await log.read();
    expect(again.events.map((e) => e.id)).toEqual(['a', 'b', 'd']);
    expect(again.corrupt).toBe(1);
  });

  it('a bad line in the middle is counted as corrupt, not fatal', async () => {
    writeFileSync(file.replace('sub/', '').replace('sub\\', ''), '');
    const f = join(dir, 'mixed.jsonl');
    writeFileSync(f, ['{"v":1,"id":"a"}', 'not json', '[1,2]', '"str"', '', '{"v":1,"id":"b"}', ''].join('\n'));
    const r = await readEvents<Ev>(f);
    expect(r.events.map((e) => e.id)).toEqual(['a', 'b']);
    expect(r.corrupt).toBe(3);
    expect(r.truncatedTail).toBe(false);
  });

  it('checks the schema version: other versions are skipped and counted, never misread; writing one is refused', async () => {
    const f = join(dir, 'versions.jsonl');
    writeFileSync(f, ['{"v":2,"id":"future"}', '{"id":"nov"}', '{"v":1,"id":"ok"}', ''].join('\n'));
    const r = await readEvents<Ev>(f);
    expect(r.events.map((e) => e.id)).toEqual(['ok']);
    expect(r.skipped).toBe(2);
    await expect(new EventLog<Ev>(file).append({ v: 2, id: 'x' })).rejects.toThrow(/must have v: 1/);
  });

  it('a custom validator can reject events (counted as skipped)', async () => {
    const log = new EventLog<Ev>(file, { validate: (x): x is Ev => typeof (x as Ev).id === 'string' && (x as Ev).id.startsWith('ok') });
    await log.append(ev('ok1'));
    await log.append(ev('bad'));
    const r = await log.read();
    expect(r.events.map((e) => e.id)).toEqual(['ok1']);
    expect(r.skipped).toBe(1);
  });

  it('refuses an event too big to be one atomic append, and a failed append does not block the next', async () => {
    const log = new EventLog<Ev & { pad?: string }>(file);
    await expect(log.append({ v: 1, id: 'big', pad: 'x'.repeat(MAX_EVENT_BYTES) })).rejects.toBeInstanceOf(EventTooLargeError);
    await log.append(ev('after'));
    expect((await log.read()).events.map((e) => e.id)).toEqual(['after']);
  });

  it('unicode and newlines inside values survive (they are escaped in the JSON line)', async () => {
    const log = new EventLog<Ev & { text: string }>(file);
    await log.append({ v: 1, id: 'u', text: 'line one\nline two é世界 🚀' });
    expect((await log.read()).events[0]!.text).toBe('line one\nline two é世界 🚀');
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('two processes appending 300 long lines each at the same time: 600 intact lines, none torn or lost', async () => {
    const child = join(dirname(fileURLToPath(import.meta.url)), 'log.child.ts');
    const run = (tag: string) =>
      new Promise<number | null>((resolve, reject) => {
        const p = spawn(process.execPath, ['--import', 'tsx', child, file, tag, '300'], { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        p.stderr.on('data', (d: Buffer) => (err += d.toString()));
        p.on('error', reject);
        p.on('close', (code) => (code === 0 ? resolve(code) : reject(new Error(`child ${tag} failed: ${err.slice(0, 400)}`))));
      });
    await Promise.all([run('A'), run('B')]);
    const r = await readEvents<{ v: number; tag: string; n: number; pad: string }>(file);
    expect(r).toMatchObject({ corrupt: 0, skipped: 0, truncatedTail: false });
    expect(r.events).toHaveLength(600);
    for (const tag of ['A', 'B']) expect(new Set(r.events.filter((e) => e.tag === tag).map((e) => e.n)).size).toBe(300);
    expect(r.events.every((e) => e.pad.length === 2_000)).toBe(true);
  }, 60_000);
});

describe('newEventId', () => {
  it('sorts by time and is unique', () => {
    const a = newEventId(1_000, () => 'aaaaaa');
    const b = newEventId(2_000, () => 'aaaaaa');
    expect(a < b).toBe(true);
    expect(newEventId(5)).not.toBe(newEventId(5));
    expect(a).toMatch(/^evt_[0-9a-z]{9}_[0-9a-f]{6}$/);
  });
});
