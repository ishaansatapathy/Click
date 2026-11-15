# V3 miss analysis 1 (Prompt 133)

Inputs: `bench:diff V2 V3`, `bench:diff V1 V3`, the 8k task-detail rows, cached V1/V2 seed replays, and `click map --path` for every ground-truth file. The 12 tasks below are ordered by V3 strict recall, then missing-file count and task id.

| Task | Type | Class | Evidence |
|---|---|---|---|
| `m-0fe9d60` | multi-hop | wrong seeds | Neither Admin nor Editor appears in V1/V2 seeds. Both files are indexed and imported by `src/pages/dashboard/index.vue`. |
| `m-1bd695d` | multi-hop | wrong seeds | Neither target appears in V1/V2 seeds; graph contains both files and their dashboard imports. |
| `m-74543de` | multi-hop | wrong seeds | V1 seeds `SearchMenu/Result.vue` and gets both files; hybrid fusion evicts it. Both components and their incoming component/prop edges exist. |
| `m-86ec976` | multi-hop | wrong seeds | Neither dashboard role component appears in V1/V2 seeds; both indexed files have incoming dashboard imports. |
| `m-05f8cc6` | single-file | wrong seeds | V1 ranks Settings fifth and succeeds; V2/V3 fusion evicts it. Settings has four imports plus store/composable/component edges. |
| `m-10eb743` | single-file | wrong seeds | V1 ranks LeftMode second and succeeds; hybrid fusion evicts it. LeftMode has five imports and component/store/composable edges. |
| `m-170269e` | single-file | wrong seeds | Router never appears in V1/V2 seeds despite the indexed link routes and 22 import relationships. |
| `m-19b1455` | single-file | packing | VxeTable is a V2 seed and candidate, but its 451-line body exceeds the body cap and is emitted as a 17-token signature. Route/import/call edges exist. |
| `m-24e9431` | single-file | packing | ElementPlus is a V2 seed and candidate, but its 275-line body is emitted as a 16-token signature. Route/import/call/composable edges exist. |
| `m-272642e` | single-file | wrong seeds | V1 ranks Login fourth and succeeds; hybrid fusion evicts it. Login's route, seven imports and UI/store edges exist. |
| `m-273065d` | single-file | wrong seeds | V1 ranks `file:src/main.ts` second and succeeds; hybrid fusion evicts it. Main has four imports and four calls. |
| `m-5a94ec4` | single-file | packing | Login is a V2 seed and candidate, but its 209-line body is emitted as a 12-token signature. |

## Counts

| Class | Count |
|---|---:|
| wrong seeds | 9 |
| missing edge | 0 |
| ranking | 0 |
| packing (body too large) | 3 |
| ground-truth noise | 0 |

No miss is explained by a missing graph edge: `click map --path` finds every target, with the expected route/import/component relationships. Three misses are unambiguously packing because the target is both seeded and returned, but only in `signature` mode; strict recall intentionally requires body/file mode.

## Highest-count fix

The actionable seed failure is hybrid fusion evicting semantic hits: five of the nine wrong-seed tasks succeed in V1, and their ground-truth nodes occur within V1's first five semantic seeds but disappear from V2/V3's eight fused seeds.

In `packages/core/src/retrieve/fuse.ts`, when `semantic` is enabled alongside another source, reserve the first five unique resolved semantic node ids in the final `cfg.count` seed set. Fill the remaining slots from the existing weighted-RRF order, excluding ids already reserved; preserve deterministic score/id ordering and source attribution. Apply no quota when semantic is disabled or is the only source. Add tests for deduplication, fewer than five semantic hits, and deterministic fill order.

Acceptance: the five fusion-eviction tasks above retain their ground-truth semantic seed under V2/V3, then rerun the 4k/8k test rows to check that the quota improves strict recall without a material per-type regression.
