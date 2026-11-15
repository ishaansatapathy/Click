# HydraDB on/off drill (Prompt 144)

A V3 run started against live self-hosted HydraDB. After the first request returned, HydraDB was stopped; the remaining 74 requests continued through the local replica. HydraDB was restored after the drill.

- All 75 requests returned.
- First live request degraded flags: none.
- Every post-stop request reported `degraded: graph-replica`.
- Every post-stop task matched a same-process V3r control exactly on strict recall and missing strict-GT files (historical reference row: `20261115T183818865Z-0e56d6`).
- Offline strict recall: 79.37%.
- Offline latency: p50 414.5 ms / p95 491.7 ms.
- Latency row: `20261115T211845509Z-2d19a5` (clearly labelled `V3-hydra-offline`).

The drill proves failure safety, not HydraDB speed: after the connection failure, local replica PPR is the measured path.
