# V5 learned-weight rows (simulated evidence)

V5 is V3 with `expand.useLearned=true`. Weights version `5540c1136de0` was derived only from 158 temporally ordered train outcomes labelled `source: bench-sim`; no test outcome was used.

| Variant | Run | Budget | n | Strict | Any | Symbol | Precision | p50 ms | p95 ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| V1 | `20261115T183611846Z-6d101c` | 4000 | 75 | 77.01% | 79.13% | 23.78% | 18.09% | 326.0 | 494.1 |
| V3 | `20261115T183729476Z-f5748a` | 4000 | 75 | 76.97% | 80.64% | 77.83% | 14.89% | 773.0 | 1032.0 |
| V5 | `20261115T194252351Z-cd18d5` | 4000 | 75 | 77.97% | 81.97% | 79.32% | 15.50% | 661.0 | 845.5 |
| V1 | `20261115T183925911Z-34e024` | 8000 | 75 | 85.36% | 85.69% | 27.64% | 12.17% | 416.0 | 537.9 |
| V3 | `20261115T183755417Z-9699b6` | 8000 | 75 | 83.75% | 85.75% | 82.06% | 8.63% | 761.0 | 997.6 |
| V5 | `20261115T194305720Z-dcaa93` | 8000 | 75 | 84.42% | 86.42% | 82.43% | 8.70% | 689.0 | 888.5 |

## Paired bootstrap (V5 − V3 strict recall, 10k draws)

| Budget | Delta | 95% CI |
|---:|---:|---:|
| 4000 | 1.00% | [-1.33%, 4.33%] |
| 8000 | 0.67% | [0.00%, 1.67%] |

These are simulated-learning retrieval rows, not real-agent outcomes.
