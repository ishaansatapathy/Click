import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuildResult } from '../../../core/src/indexer/build.js';
import type { PackedContext } from '../../../core/src/types.js';
import { Board, EDIT_TTL_MS, NOTE_TTL_MS } from './board.js';
import { cleanupTemps, reference, startWorld, type World } from './testkit.js';

const ROOT = join(tmpdir(), 'click-board-root');
const dirs: string[] = [];
const fresh = (now: () => number = Date.now): { board: Board; file: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'click-board-'));
  dirs.push(dir);
  const file = join(dir, 'board.jsonl');
  return { board: new Board(file, { root: ROOT, now }), file };
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  cleanupTemps();
});

describe('Board', () => {
  it('keeps notes newest first, filters by file and time, and hides an author\'s own notes on request', () => {
    let t = Date.parse('2026-11-16T12:00:00Z');
    const { board } = fresh(() => t);
    board.addNote({ author: 'codex', kind: 'note', text: 'first', files: ['src/a.ts'] });
    t += 60_000;
    board.addNote({ author: 'claude', kind: 'handoff', text: 'second', files: ['src/b.ts'] });
    expect(board.listNotes().map((n) => n.text)).toEqual(['second', 'first']);
    expect(board.listNotes({ files: ['src/a.ts'] }).map((n) => n.text)).toEqual(['first']);
    expect(board.listNotes({ excludeAuthor: 'claude' }).map((n) => n.text)).toEqual(['first']);
    expect(board.listNotes({ since: '2026-11-16T12:00:30Z' }).map((n) => n.text)).toEqual(['second']);
  });

  it('runs a task through add, claim and done, and refuses what would be a mistake', () => {
    const { board } = fresh();
    const task = board.addTask({ author: 'claude', title: 'add a test for the cart store' });
    expect(board.listTasks('open').map((x) => x.id)).toEqual([task.id]);
    expect(board.claim(task.id, 'codex').status).toBe('claimed');
    expect(() => board.claim(task.id, 'cursor')).toThrow(/already claimed/);
    expect(() => board.done(task.id, 'cursor')).toThrow(/claimed by codex/);
    expect(board.done(task.id, 'codex', 'added tests/cart.test.ts').summary).toBe('added tests/cart.test.ts');
    expect(() => board.done(task.id, 'codex')).toThrow(/already done/);
    expect(() => board.claim('t_nope', 'codex')).toThrow(/no task/);
  });

  it('survives a restart: a new Board over the same file has the same notes, tasks and edits', async () => {
    const { board, file } = fresh();
    board.addNote({ author: 'codex', kind: 'handoff', text: 'kept', files: ['src/a.ts'] });
    const task = board.addTask({ author: 'codex', title: 'kept too' });
    board.claim(task.id, 'claude');
    board.recordEdits('codex', ['src/a.ts']);
    await board.flush();
    const again = new Board(file, { root: ROOT });
    expect(again.listNotes().map((n) => n.text)).toEqual(['kept']);
    expect(again.listTasks('claimed').map((x) => x.by)).toEqual(['claude']);
    expect(again.contextBlock({ files: new Set(['src/a.ts']), agent: 'claude', maxTokens: 300 })).toContain('codex changed src/a.ts');
  });

  it('builds a context block only from OTHER agents\' recent notes and edits about the files asked for, never over its token limit', () => {
    let t = Date.parse('2026-11-16T12:00:00Z');
    const { board } = fresh(() => t);
    board.addNote({ author: 'codex', kind: 'handoff', text: 'The cart total is computed in useCart; the rounding bug is in toCents().', files: ['src/cart.ts'] });
    board.addNote({ author: 'claude', kind: 'note', text: 'my own note', files: ['src/cart.ts'] });
    board.addNote({ author: 'codex', kind: 'note', text: 'about another file', files: ['src/other.ts'] });
    board.recordEdits('codex', ['src/cart.ts']);
    t += 5 * 60_000;

    const block = board.contextBlock({ files: new Set(['src/cart.ts']), agent: 'claude', maxTokens: 300 });
    expect(block).toContain('## From other agents on this repo');
    expect(block).toContain('rounding bug');
    expect(block).toContain('⚠ codex changed src/cart.ts 5 min ago');
    expect(block).not.toContain('my own note');
    expect(block).not.toContain('another file');

    expect(board.contextBlock({ files: new Set(['src/nothing.ts']), agent: 'claude', maxTokens: 300 })).toBe('');
    const tiny = board.contextBlock({ files: new Set(['src/cart.ts']), agent: 'claude', maxTokens: 14 });
    expect(tiny.length).toBeLessThan(block.length);

    t += NOTE_TTL_MS;
    expect(board.contextBlock({ files: new Set(['src/cart.ts']), agent: 'claude', maxTokens: 300 })).toBe(''); // a day later: stale notes and edits are not pushed
    expect(EDIT_TTL_MS).toBeLessThan(NOTE_TTL_MS);
  });

  it('lists who has been active, with the task they last asked about', () => {
    let t = Date.parse('2026-11-16T12:00:00Z');
    const { board } = fresh(() => t);
    board.touchAgent('codex', { task: 'fix the cart' });
    t += 20 * 60_000;
    board.touchAgent('claude', { task: 'add a login test' });
    const agents = board.listAgents();
    expect(agents.map((a) => a.name)).toEqual(['claude', 'codex']);
    expect(agents.find((a) => a.name === 'claude')).toMatchObject({ active: true, lastTask: 'add a login test' });
    expect(agents.find((a) => a.name === 'codex')?.active).toBe(false);
  });
});

describe('two agents through one daemon', () => {
  let ref: BuildResult;
  let world: World;
  beforeAll(async () => {
    ref = await reference();
    world = await startWorld({ ref });
  }, 120_000);
  afterAll(() => world?.close());

  const TASK = 'submitting the order fails, look at useOrderStore and the checkout button';

  it('hands what one agent learned to the next one that asks about the same files, inside the budget, and warns about its edits', async () => {
    const first = await world.json<PackedContext>('/context', { task: TASK, budgetTokens: 4000, agent: 'claude-code', sessionId: 'sess-claude-1' });
    const files = [...new Set(first.body.items.flatMap((i) => (i.path ? [i.path] : [])))];
    expect(files.length).toBeGreaterThan(0);
    expect(first.body.text).not.toContain('From other agents'); // nothing on the board yet

    // Claude Code hands off what it found and reports that it edited a file
    const note = await world.json('/notes', { author: 'claude-code', kind: 'handoff', text: 'Order submit fails because useOrderStore.submit() never awaits the API call.', files });
    expect(note.status).toBe(200);
    const out = await world.json('/outcome', { sessionId: 'sess-claude-1', agent: 'claude-code', filesEdited: [files[0]!], check: { kind: 'vitest', passed: true } });
    expect(out.status).toBe(200);

    // Codex asks about the same thing, as a different agent
    const second = await world.json<PackedContext>('/context', { task: TASK, budgetTokens: 4000, agent: 'codex' });
    expect(second.body.text).toContain('## From other agents on this repo');
    expect(second.body.text).toContain('never awaits the API call');
    expect(second.body.text).toContain(`claude-code changed ${files[0]}`);
    expect(second.body.tokens).toBeLessThanOrEqual(4000);

    // Claude Code does not get its own note back
    const again = await world.json<PackedContext>('/context', { task: TASK, budgetTokens: 4000, agent: 'claude-code', sessionId: 'sess-claude-1' });
    expect(again.body.text).not.toContain('never awaits');
  }, 60_000);

  it('never exceeds the character cap the prompt hook asks for', async () => {
    const plain = await world.json<PackedContext>('/context', { task: TASK, budgetTokens: 4000, agent: 'cursor', maxChars: 200_000 });
    const cap = plain.body.text.length - 10;
    const capped = await world.json<PackedContext>('/context', { task: TASK, budgetTokens: 4000, agent: 'cursor', maxChars: Math.max(1_000, cap) });
    expect(capped.body.text.length).toBeLessThanOrEqual(Math.max(1_000, cap) + 0);
  }, 60_000);

  it('shares a task list and shows who is active', async () => {
    const added = await world.json<{ id: string }>('/tasks/add', { author: 'claude-code', title: 'write a test for useOrderStore.submit' });
    const open = await world.json<{ tasks: { id: string }[] }>('/tasks?status=open');
    expect(open.body.tasks.map((t) => t.id)).toContain(added.body.id);
    expect((await world.json('/tasks/claim', { id: added.body.id, author: 'codex' })).status).toBe(200);
    expect((await world.json('/tasks/claim', { id: added.body.id, author: 'cursor' })).status).toBe(409);
    expect((await world.json('/tasks/done', { id: added.body.id, author: 'codex', summary: 'added' })).status).toBe(200);
    const agents = await world.json<{ agents: { name: string }[] }>('/agents');
    expect(agents.body.agents.map((a) => a.name)).toEqual(expect.arrayContaining(['claude-code', 'codex']));
  }, 60_000);

  it('rejects a note without an author or text', async () => {
    expect((await world.json('/notes', { text: 'x' })).status).toBe(400);
    expect((await world.json('/notes', { author: 'codex' })).status).toBe(400);
  });
});
