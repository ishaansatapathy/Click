import { describe, expect, it } from 'vitest';
import { initialStatus } from './coord.js';
import { applyMark, parseMarkArgs } from './mark.js';
import { loadQueues, nextRunnable, parseDone, parseRequestName, renderStatus, type QueueEntry, type StatusModel } from './status.js';

describe('queues.json consistency', () => {
  const q = loadQueues();
  const emitted = new Map<string, string>();
  for (const seat of ['a', 'b'] as const) for (const e of q[seat]) for (const t of e.emits ?? []) emitted.set(t, `${seat}/${e.prompt}`);

  it('every awaited tag is emitted by some prompt (or exists before the split)', () => {
    const missing: string[] = [];
    for (const seat of ['a', 'b'] as const) {
      for (const e of q[seat]) for (const w of e.waits ?? []) if (!emitted.has(w) && !q.preSplitTags.includes(w)) missing.push(`${seat}/${e.prompt} waits ${w}`);
    }
    expect(missing).toEqual([]);
  });

  it('no tag is emitted twice (tags never move, so a second emit would fail)', () => {
    const seen: string[] = [];
    for (const seat of ['a', 'b'] as const) for (const e of q[seat]) seen.push(...(e.emits ?? []));
    expect(seen.length).toBe(new Set(seen).size);
  });

  it('no seat waits on a tag it emits later in its own queue (self-deadlock)', () => {
    for (const seat of ['a', 'b'] as const) {
      q[seat].forEach((e, i) => {
        for (const w of e.waits ?? []) {
          const laterSelf = q[seat].slice(i).some((x) => x.emits?.includes(w));
          expect(laterSelf, `${seat}/${e.prompt} waits on ${w}`).toBe(false);
        }
      });
    }
  });

  it('prompts are unique within each seat', () => {
    for (const seat of ['a', 'b'] as const) {
      const ps = q[seat].map((e) => e.prompt);
      expect(ps.length).toBe(new Set(ps).size);
    }
  });
});

describe('parseDone', () => {
  it('attributes prefixed subjects to a seat and legacy ones to both', () => {
    const d = parseDone(['A/135: analysis', 'B/094: pipeline', '021: fetch repo', '073a: ranges', 'pair: ignore coord', 'deps: zod']);
    expect([...d.a]).toEqual(['135']);
    expect([...d.b]).toEqual(['094']);
    expect([...d.any].sort()).toEqual(['021', '073a']);
  });
});

describe('nextRunnable', () => {
  const queue: QueueEntry[] = [
    { prompt: '070', waits: ['sync/build'] },
    { prompt: '071', waits: ['sync/build'] },
    { prompt: '100' },
    { prompt: '101' },
  ];

  it('skips a blocked block and offers the next independent prompt', () => {
    const n = nextRunnable(queue, new Set(), new Set());
    expect(n.next?.prompt).toBe('100');
    expect(n.head?.prompt).toBe('070');
    expect(n.headMissing).toEqual(['sync/build']);
    expect(n.remaining).toBe(4);
  });

  it('returns to the earlier block as soon as its tag exists (it preempts)', () => {
    expect(nextRunnable(queue, new Set(['100']), new Set(['sync/build'])).next?.prompt).toBe('070');
  });

  it('reports an empty queue', () => {
    expect(nextRunnable(queue, new Set(['070', '071', '100', '101']), new Set())).toMatchObject({ next: null, head: null, remaining: 0 });
  });
});

describe('requests', () => {
  it('parses request file names', () => {
    expect(parseRequestName('20261115-1402-a-to-b-v3-misses.md')).toEqual({ file: '20261115-1402-a-to-b-v3-misses.md', from: 'a', to: 'b', slug: 'v3-misses' });
    expect(parseRequestName('20261115-1402-b-to-ishaan-contract-field.md')?.to).toBe('ishaan');
    expect(parseRequestName('notes.md')).toBeNull();
  });
});

describe('pair:mark', () => {
  const now = new Date('2026-11-15T10:00:00Z');

  it('updates prompt, state, note and time; done prompts are remembered once', () => {
    let s = applyMark(initialStatus('a'), '020', 'done', 'repo picked', now);
    s = applyMark(s, '020', 'done', '', now);
    expect(s).toMatchObject({ prompt: '020', state: 'done', note: '', since: now.toISOString(), done: ['020'] });
    expect(applyMark(s, '070', 'waiting', 'sync/build', now).done).toEqual(['020']);
  });

  it('validates input', () => {
    expect(() => applyMark(initialStatus('a'), '94', 'done', '', now)).toThrow(/094/);
    expect(() => applyMark(initialStatus('a'), '094', 'sleeping' as never, '', now)).toThrow(/State/);
    expect(parseMarkArgs(['094', 'blocked', 'waiting', 'on', 'request', '--seat', 'b'])).toEqual({
      seat: 'b', prompt: '094', state: 'blocked', note: 'waiting on request',
    });
    expect(() => parseMarkArgs(['094'])).toThrow(/Usage/);
  });
});

describe('renderStatus', () => {
  it('shows each seat, the stop banner, tags and requests for you', () => {
    const status = { ...initialStatus('b'), prompt: '057', state: 'working' as const };
    const model: StatusModel = {
      main: '/m',
      me: 'b',
      stop: 'main red since B/090',
      agents: { a: 'codex', b: 'claude' },
      seats: {
        a: { status: initialStatus('a'), ahead: 2, next: { next: { prompt: '100' }, head: { prompt: '070', waits: ['sync/build'] }, headMissing: ['sync/build'], remaining: 40 } },
        b: { status, ahead: 0, next: { next: { prompt: '057', emits: ['sync/build'] }, head: { prompt: '057' }, headMissing: [], remaining: 50 } },
      },
      tags: ['sync/interfaces'],
      requests: [{ file: '20261115-1402-a-to-b-x.md', from: 'a', to: 'b', slug: 'x' }],
      now: new Date(),
    };
    const out = renderStatus(model);
    expect(out).toContain('STOP');
    expect(out).toContain('you are Seat B');
    expect(out).toContain('queue head 070 waits for: sync/build');
    expect(out).toContain('057 → emits sync/build');
    expect(out).toContain('← for you');
    expect(out).toContain('1 open request(s) for Seat B');
  });
});
