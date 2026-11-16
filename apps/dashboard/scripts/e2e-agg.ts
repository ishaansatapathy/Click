// The real-agent figures on the landing page: every graded run in docs/e2e/<runId>.jsonl, summed per variant. A run whose check never ran
// (gradeError) is left out, exactly as the harness leaves it out of its own summary. Nothing is typed in by hand.

import type { E2eData } from '../src/data/types.js';

export interface RawE2eRow {
  runId: string;
  taskId: string;
  variant: string;
  usage: { input: number; output: number; cacheRead: number; cacheCreation: number };
  turns: number;
  costUsd: number;
  wallMs: number;
  solved: boolean;
  gradeError?: boolean;
}

export function aggregateE2e(rows: readonly RawE2eRow[], ts: string): E2eData | null {
  const graded = rows.filter((r) => !r.gradeError);
  const runs = [...new Set(graded.map((r) => r.runId))].sort();
  const variants = ['V0', 'delivery'];
  if (!variants.every((v) => graded.some((r) => r.variant === v))) return null;
  const id = runs.join(' + ');
  return {
    ts,
    runs,
    rows: variants.map((variant) => {
      const mine = graded.filter((r) => r.variant === variant);
      const solved = mine.filter((r) => r.solved).length;
      const sum = (f: (r: RawE2eRow) => number): number => mine.reduce((a, r) => a + f(r), 0);
      const spent = sum((r) => r.usage.input + r.usage.output + r.usage.cacheCreation);
      return {
        id,
        variant,
        n: mine.length,
        solved,
        tokensPerSolved: solved ? spent / solved : null,
        totals: {
          inputTokens: sum((r) => r.usage.input),
          outputTokens: sum((r) => r.usage.output),
          cacheReadTokens: sum((r) => r.usage.cacheRead),
          cacheCreationTokens: sum((r) => r.usage.cacheCreation),
          turns: sum((r) => r.turns),
          wallMs: sum((r) => r.wallMs),
          costUsd: sum((r) => r.costUsd),
        },
      };
    }),
  };
}
