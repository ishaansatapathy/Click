// PROMPTS (user, overnight 2): several agents using ONE daemon at the same time. Click does not coordinate agents (no agent-to-agent
// messages, no hand-off); what it must guarantee is that they do not disturb each other:
//   - every request is answered, none fails (no 5xx), the context fits the budget
//   - the logs stay whole: contexts.jsonl and outcomes.jsonl hold exactly one valid JSON line per context / outcome, no interleaving
//   - sessions are isolated: an agent's first context for a task equals the one a lone agent gets, and an outcome only learns from
//     the contexts of ITS session, never from another agent's
//   - the daemon's own counters agree with what was sent

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuildResult } from '../../../core/src/indexer/build.js';
import type { PackedContext } from '../../../core/src/types.js';
import { cleanupTemps, reference, startWorld, type World } from './testkit.js';

let ref: BuildResult;
let world: World;
beforeAll(async () => {
  ref = await reference();
  world = await startWorld({ ref });
}, 120_000);
afterAll(async () => {
  await world?.close();
  await cleanupTemps();
});

const TASKS = [
  'submitting the order fails, look at useOrderStore and the checkout button',
  'the order total is wrong after removing an item from the cart',
  'checkout button stays disabled after the form is valid',
  'show an error message when the order request is rejected',
  'persist the cart between page reloads',
];
const AGENTS = ['claude-code-1', 'cursor-2', 'codex-3', 'vscode-4'];

const lines = (file: string): Record<string, unknown>[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>); // a torn or interleaved line would throw here

describe('several agents on one daemon', () => {
  it('answers every request, keeps the logs whole and keeps the sessions apart', async () => {
    const lone = await world.json<PackedContext>('/context', { task: TASKS[0], budgetTokens: 4000, source: 'cli' }); // what a lone caller (no session) gets
    expect(lone.status).toBe(200);
    await world.daemon.settled();

    type Run = { agent: string; contexts: { status: number; body: PackedContext }[]; outcome: { status: number; body: { contexts: number; eventId: string | null; skipped?: string } } };
    const runs: Run[] = await Promise.all(
      AGENTS.map(async (agent) => {
        // each agent: its own tasks, several contexts in a row, then it reports the outcome; all agents at the same time
        const contexts = await Promise.all(
          TASKS.map((task) => world.json<PackedContext>('/context', { task, budgetTokens: 4000, source: 'cli', sessionId: agent })),
        );
        const outcome = await world.json<Run['outcome']['body']>('/outcome', { sessionId: agent, taskText: TASKS[0], check: { kind: 'vitest', passed: true } });
        return { agent, contexts, outcome };
      }),
    );
    await world.daemon.settled();

    // 1) nothing failed, everything fits
    for (const run of runs) {
      for (const c of run.contexts) {
        expect(c.status).toBe(200);
        expect(c.body.tokens).toBeLessThanOrEqual(4000);
        expect(c.body.degraded).not.toContain('warming');
      }
      expect(run.outcome.status).toBe(200);
    }

    // 2) the logs are whole: one valid line per context, all ids different
    const total = 1 + AGENTS.length * TASKS.length;
    const ctxLines = lines(join(world.root, '.click', 'contexts.jsonl'));
    expect(ctxLines).toHaveLength(total);
    expect(new Set(ctxLines.map((l) => l.contextId)).size).toBe(total);

    // 3) sessions are isolated: an agent's first answer to a task is the lone caller's answer (same items), whoever else is asking
    const firstFor = (run: Run): PackedContext => run.contexts[0]!.body;
    for (const run of runs) expect(firstFor(run).items.map((i) => i.nodeId)).toEqual(lone.body.items.map((i) => i.nodeId));

    // 4) an outcome learns only from its own session's contexts
    const outLines = lines(join(world.root, '.click', 'outcomes.jsonl'));
    expect(outLines).toHaveLength(AGENTS.length);
    for (const run of runs) {
      const own = new Set(run.contexts.map((c) => c.body.contextId));
      const event = outLines.find((l) => l.sessionId === run.agent);
      expect(event, `outcome of ${run.agent}`).toBeDefined();
      const ids = (event!.contextIds as string[]).slice().sort();
      expect(ids).toEqual([...own].sort());
      expect(run.outcome.body.contexts).toBe(TASKS.length);
    }

    // 5) the daemon's counters agree
    const stats = await world.json<{ totals: { contexts: number } }>('/stats');
    expect(stats.body.totals.contexts).toBe(total);
  }, 180_000);
});
