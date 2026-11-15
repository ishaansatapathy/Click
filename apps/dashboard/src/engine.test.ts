import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DemoRepo } from './data/types.js';
import { Engine } from './engine.js';

const repo = JSON.parse(readFileSync(new URL('../public/data/demo.json', import.meta.url), 'utf8')) as DemoRepo;
const engine = new Engine(repo);
const TASK = 'When a user logs out, clear every piece of session state, remove open and cached tabs, reset access-controlled navigation, and then return them to the sign-in screen.';

describe('the in-browser demo engine', () => {
  it('packs real code from the bundled files within the budget', async () => {
    const a = await engine.ask(TASK, 4000, 'graph');
    expect(a.tokens).toBeGreaterThan(0);
    expect(a.tokens).toBeLessThanOrEqual(4000);
    expect(a.items.length).toBeGreaterThan(0);
    expect(a.text).toContain('click_context');
    expect(a.seeds.length).toBeGreaterThan(0);
  });

  it('finds at least as many files with the graph walk as without it, and explains why each item is there', async () => {
    const graph = await engine.ask(TASK, 8000, 'graph');
    const plain = await engine.ask(TASK, 8000, 'plain');
    const files = (a: typeof graph): Set<string | null> => new Set(a.items.filter((i) => i.mode === 'body' || i.mode === 'file').map((i) => i.path));
    expect(files(graph).size).toBeGreaterThanOrEqual(files(plain).size);
    // the graph answer reaches files the seeds alone did not name
    expect([...files(graph)].some((p) => !files(plain).has(p))).toBe(true);
    // every code block was chosen as a candidate, so it has a reason (neighbour signatures are context, not choices)
    const blocks = graph.items.filter((i) => i.mode === 'body');
    expect(blocks.length).toBeGreaterThan(0);
    for (const item of blocks) expect(graph.why.has(item.nodeId)).toBe(true);
  });

  it('answers an unrelated question without throwing', async () => {
    const a = await engine.ask('zzzz qqqq', 2000, 'graph');
    expect(a.items.length).toBeGreaterThanOrEqual(0);
  });
});
