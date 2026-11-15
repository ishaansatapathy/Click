# Graph impact: plain store vs HydraDB vs full replica (Prompt 143)

Held-out test split. V2, V3 and V3r share hybrid seeds and symbol packing: V2 stops at seeds, V3 expands through the self-hosted HydraDB two-hop neighbourhood, and V3r expands over the full local replica. V1 is shown as the required semantic-vector reference.

## Strict recall by task type

| Budget | Variant | Run | Overall | Single-file | Multi-file | Multi-hop | Impact | Symbol |
|---:|---|---|---:|---:|---:|---:|---:|---:|
| 4000 | V1 | `20261115T183611846Z-6d101c` | 77.01% | 87.80% | 60.00% | 64.03% | 68.75% | 23.78% |
| 4000 | V2 | `20261115T183647313Z-029719` | 72.93% | 82.93% | 70.00% | 59.79% | 56.25% | 72.76% |
| 4000 | V3 | `20261115T183729476Z-f5748a` | 76.97% | 82.93% | 80.00% | 64.92% | 87.50% | 77.83% |
| 4000 | V3r | `20261115T183818865Z-0e56d6` | 79.64% | 87.80% | 80.00% | 64.92% | 87.50% | 77.83% |
| 8000 | V1 | `20261115T183925911Z-34e024` | 85.36% | 92.68% | 80.00% | 73.07% | 93.75% | 27.64% |
| 8000 | V2 | `20261115T183702220Z-208533` | 72.93% | 82.93% | 70.00% | 59.79% | 56.25% | 72.76% |
| 8000 | V3 | `20261115T183755417Z-9699b6` | 83.75% | 90.24% | 100.00% | 69.26% | 87.50% | 82.06% |
| 8000 | V3r | `20261115T183841981Z-d358fc` | 84.86% | 92.68% | 90.00% | 70.59% | 87.50% | 80.82% |

## Paired bootstrap strict-recall differences (10k draws)

| Budget | Comparison | Task group | n | Delta | 95% CI |
|---:|---|---|---:|---:|---:|
| 4000 | V3 − V2 | all | 75 | +4.04 pp | [+1.71 pp, +6.71 pp] |
| 4000 | V3 − V2 | single-file | 41 | +0.00 pp | [+0.00 pp, +0.00 pp] |
| 4000 | V3 − V2 | multi-file | 5 | +10.00 pp | [+0.00 pp, +30.00 pp] |
| 4000 | V3 − V2 | multi-hop | 25 | +5.13 pp | [+1.33 pp, +9.47 pp] |
| 4000 | V3 − V2 | impact | 4 | +31.25 pp | [+25.00 pp, +43.75 pp] |
| 4000 | V3r − V2 | all | 75 | +6.71 pp | [+2.87 pp, +11.31 pp] |
| 4000 | V3r − V2 | single-file | 41 | +4.88 pp | [+0.00 pp, +12.20 pp] |
| 4000 | V3r − V2 | multi-file | 5 | +10.00 pp | [+0.00 pp, +30.00 pp] |
| 4000 | V3r − V2 | multi-hop | 25 | +5.13 pp | [+1.33 pp, +9.60 pp] |
| 4000 | V3r − V2 | impact | 4 | +31.25 pp | [+25.00 pp, +43.75 pp] |
| 4000 | V3 − V3r | all | 75 | -2.67 pp | [-6.67 pp, +0.33 pp] |
| 4000 | V3 − V3r | single-file | 41 | -4.88 pp | [-12.20 pp, +0.00 pp] |
| 4000 | V3 − V3r | multi-file | 5 | +0.00 pp | [+0.00 pp, +0.00 pp] |
| 4000 | V3 − V3r | multi-hop | 25 | +0.00 pp | [-3.00 pp, +3.00 pp] |
| 4000 | V3 − V3r | impact | 4 | +0.00 pp | [+0.00 pp, +0.00 pp] |
| 8000 | V3 − V2 | all | 75 | +10.82 pp | [+6.00 pp, +16.38 pp] |
| 8000 | V3 − V2 | single-file | 41 | +7.32 pp | [+0.00 pp, +17.07 pp] |
| 8000 | V3 − V2 | multi-file | 5 | +30.00 pp | [+10.00 pp, +50.00 pp] |
| 8000 | V3 − V2 | multi-hop | 25 | +9.47 pp | [+4.00 pp, +15.47 pp] |
| 8000 | V3 − V2 | impact | 4 | +31.25 pp | [+25.00 pp, +43.75 pp] |
| 8000 | V3r − V2 | all | 75 | +11.93 pp | [+6.64 pp, +18.11 pp] |
| 8000 | V3r − V2 | single-file | 41 | +9.76 pp | [+2.44 pp, +19.51 pp] |
| 8000 | V3r − V2 | multi-file | 5 | +20.00 pp | [+0.00 pp, +40.00 pp] |
| 8000 | V3r − V2 | multi-hop | 25 | +10.80 pp | [+5.13 pp, +16.93 pp] |
| 8000 | V3r − V2 | impact | 4 | +31.25 pp | [+25.00 pp, +43.75 pp] |
| 8000 | V3 − V3r | all | 75 | -1.11 pp | [-4.44 pp, +1.33 pp] |
| 8000 | V3 − V3r | single-file | 41 | -2.44 pp | [-7.32 pp, +0.00 pp] |
| 8000 | V3 − V3r | multi-file | 5 | +10.00 pp | [+0.00 pp, +30.00 pp] |
| 8000 | V3 − V3r | multi-hop | 25 | -1.33 pp | [-4.00 pp, +0.00 pp] |
| 8000 | V3 − V3r | impact | 4 | +0.00 pp | [+0.00 pp, +0.00 pp] |

## Retrieval latency and graph-source cost

Deltas are relative to V2, the no-expansion plain-store baseline, and therefore include graph fetch plus PPR work.

| Budget | Variant | p50 ms | p95 ms | Added p50 vs V2 | Added p95 vs V2 |
|---:|---|---:|---:|---:|---:|
| 4000 | V2 | 166.0 | 254.3 | baseline | baseline |
| 4000 | V3 | 773.0 | 1032.0 | +607.0 | +777.7 |
| 4000 | V3r | 618.0 | 862.0 | +452.0 | +607.7 |
| 8000 | V2 | 187.0 | 282.5 | baseline | baseline |
| 8000 | V3 | 761.0 | 997.6 | +574.0 | +715.1 |
| 8000 | V3r | 603.0 | 793.5 | +416.0 | +511.0 |

## Verdict

HydraDB-backed V3 improves overall strict recall over V2 at both budgets. The clearest gain is on impact tasks (+31.25 pp); multi-hop also improves (+5.13 pp at 4k and +9.47 pp at 8k), with both paired intervals above zero. V3r shows that the full graph can recover a little more overall recall, but its V3r−V3 intervals overlap zero. Both graph paths add substantial retrieval latency versus V2, and HydraDB IPC/query cost is higher than the in-process full replica.
