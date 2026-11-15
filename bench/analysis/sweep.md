# Prompt 136: one-knob V3 tuning sweep

Selection used only the train split at 4k. The test split was evaluated once, after the winner was frozen.

| Case | Knob | Value | Train strict | Train any | p50 ms | p95 ms | Graph fallback |
|---|---|---|---:|---:|---:|---:|---:|
| default | default | alpha=.15 S=8 reverse=1 priors=on symbol=1.5 | 61.87% | 90.45% | 345.0 | 471.0 | 8/158 |
| alpha=0.3 | alpha | 0.3 | 65.20% | 91.55% | 338.0 | 435.8 | 2/158 |
| alpha=0.5 | alpha | 0.5 | 65.57% | 90.29% | 346.0 | 440.6 | 9/158 |
| seeds=4 | seeds | 4 | 67.04% | 89.87% | 259.0 | 354.0 | 0/158 |
| seeds=16 | seeds | 16 | 59.75% | 89.17% | 471.0 | 579.5 | 111/158 |
| reverseScale=0.5 | reverseScale | 0.5 | 61.66% | 87.18% | 336.5 | 451.3 | 4/158 |
| reverseScale=2 | reverseScale | 2 | 63.93% | 90.76% | 334.5 | 439.0 | 4/158 |
| usePriors=off | usePriors | off | 60.71% | 90.50% | 331.0 | 447.6 | 5/158 |
| symbolWeight=1 | symbolWeight | 1 | 62.19% | 90.55% | 338.0 | 452.5 | 2/158 |
| symbolWeight=2 | symbolWeight | 2 | 62.19% | 90.66% | 251.0 | 321.3 | 0/158 |

Winner: **seeds=4**, train strict 67.04%.

| Frozen evaluation | Strict | Any | Symbol | Precision | p50 ms | p95 ms | Graph fallback |
|---|---:|---:|---:|---:|---:|---:|---:|
| test, 4k | 62.02% | 79.23% | 52.46% | 14.17% | 260.0 | 354.9 | 0/75 |

For context after selection, the post-fix default V3 test row `20261115T173556851Z-db21c3` scored 63.43% strict. The frozen `seeds=4` winner is 1.41 percentage points lower on test; this comparison did not alter the train-only selection.
