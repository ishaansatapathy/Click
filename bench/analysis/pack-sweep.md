# Prompt 137: pack strategy and prefix ablation

All selection uses the train split at 4k. Prefix tokens count against the same 4k budget.

## V1 companion

| Variant | Strategy | Prefix | n | Strict | Any | Symbol | Precision | p95 ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| V1 | chunk bodies | off | 158 | 83.80% | 87.33% | 24.06% | 23.25% | 485.0 |

## V3 ablation

| Strategy | Prefix | n | Strict | Any | Symbol | Precision | p50 ms | p95 ms | Graph fallback |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| body-signature | off | 158 | 85.91% | 89.92% | 81.27% | 15.29% | 735.0 | 893.1 | 0/158 |
| body-signature | on | 158 | 80.95% | 86.86% | 77.53% | 17.31% | 786.0 | 943.3 | 2/158 |
| body-only | off | 158 | 85.91% | 85.91% | 81.27% | 15.41% | 658.5 | 814.6 | 0/158 |
| body-only | on | 158 | 81.90% | 81.90% | 78.26% | 17.48% | 684.0 | 850.0 | 0/158 |
| whole-file | off | 158 | 57.25% | 57.25% | 59.66% | 21.83% | 322.0 | 421.0 | 1/158 |
| whole-file | on | 158 | 53.66% | 53.66% | 53.92% | 22.83% | 335.0 | 439.3 | 8/158 |

Delivery pack defaults selected on train: **strategy=body-only, prefix=off** (strict 85.91%, p95 814.6 ms).
