# Prompt 134: semantic seed reservation A/B

> The reserve A/B verdict remains historical evidence, but its absolute V2/V3 numbers predate the `a1800cb` packer change. Use [`matrix-20261116.md`](matrix-20261116.md) for current headline retrieval numbers.

All runs use cached public benchmark embeddings and the in-process retriever. `reserve=5` is compared with the explicit off switch `reserve=0`; V1 is shown alongside every split/budget comparison. V2 is also retained in the test tables for continuity with the retrieval matrix.

## Train, 4k

| Variant | Reserve | Run | n | Strict | Any | p95 ms | Degraded |
|---|---:|---|---:|---:|---:|---:|---:|
| V1 | n/a | `20261115T181402338Z-fc8554` | 158 | 83.80% | 87.33% | 529.2 | 0 |
| V3 | 0 | `20261115T180825189Z-bb5ba8` | 158 | 57.72% | 82.75% | 562.2 | 11 graph fallbacks |
| V3 | 5 | `20261115T180854268Z-f4c4e5` | 158 | 62.03% | 90.45% | 530.4 | 10 graph fallbacks |

`reserve=5 - reserve=0`: **+4.31 pp** strict, paired-bootstrap 95% CI **[+0.05, +8.78] pp**.

## Test, 4k

| Variant | Reserve | Run | n | Strict | Any | p95 ms | Degraded |
|---|---:|---|---:|---:|---:|---:|---:|
| V1 | n/a | `20261115T181423935Z-f519ff` | 75 | 77.01% | 79.13% | 605.0 | 0 |
| V2 | 5 | `20261115T173520184Z-caec62` | 75 | 57.95% | 72.93% | 156.1 | 0 |
| V3 | 0 | `20261115T180918907Z-5ddcf1` | 75 | 54.43% | 71.75% | 556.5 | 5 graph fallbacks |
| V3 | 5 | `20261115T180950526Z-8f70bb` | 75 | 63.43% | 79.97% | 561.9 | 6 graph fallbacks |

`reserve=5 - reserve=0`: **+9.00 pp** strict, paired-bootstrap 95% CI **[+3.33, +15.44] pp**. V1 remains **13.58 pp** above V3 reserve=5.

## Test, 8k

| Variant | Reserve | Run | n | Strict | Any | p95 ms | Degraded |
|---|---:|---|---:|---:|---:|---:|---:|
| V1 | n/a | `20261115T181443824Z-a09bd0` | 75 | 85.36% | 85.69% | 528.3 | 0 |
| V2 | 5 | `20261115T173535314Z-545b55` | 75 | 60.95% | 72.93% | 173.6 | 0 |
| V3 | 0 | `20261115T181014939Z-f8795c` | 75 | 62.21% | 76.42% | 769.0 | 17 graph fallbacks |
| V3 | 5 | `20261115T181039721Z-b504a9` | 75 | 70.55% | 86.09% | 734.2 | 15 graph fallbacks |

`reserve=5 - reserve=0`: **+8.33 pp** strict, paired-bootstrap 95% CI **[+2.33, +15.11] pp**. V1 remains **14.81 pp** above V3 reserve=5.

## Verdict

Keep the default `seeds.reserve=5`. It improves strict recall on train and both frozen test budgets, and all three paired intervals exclude zero. The remaining V1 gap is material and stays visible in subsequent analysis.
