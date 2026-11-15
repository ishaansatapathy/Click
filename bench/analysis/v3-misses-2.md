# V3 miss analysis 2 (Prompt 135)

Inputs: the post-`a1800cb` 8k test rows V1 `20261115T183925911Z-34e024`, V2 `20261115T183702220Z-208533`, V3 `20261115T183755417Z-9699b6`, and V3r `20261115T183841981Z-d358fc`; `bench:diff` for V2→V3 and V1→V3; cached V1/V3 seed replays; and `click map --path` checks for every missing file. The 12 tasks are ordered by V3 strict recall, missing-file count, then task id.

| Task | Type | Class | Evidence |
|---|---|---|---|
| `m-170269e` | single-file | packing | `src/router/index.ts#constantRoutes` reaches V3 but is emitted only as a 22-token signature; V3r also scores 0. The indexed file has 19 imports, three importers, routes, and calls. |
| `m-b02c8c6` | single-file | wrong seeds | V1 packs TagsView and scores 1; V3/V2 score 0. TagsView is semantic node 7 in V1 but is evicted from V3's eight fused seeds. The file is indexed with five imports and one importer. |
| `m-c35f0e7` | single-file | wrong seeds | V1 packs Login and scores 1; V3/V2 score 0. Login is present in V1's broader semantic candidates but not its first eight displayed seeds or V3's fused seeds. The router has a `routes_to` edge to Login. |
| `m-f46f9f5` | single-file | wrong seeds | V1 packs router/index and scores 1; its `constantRoutes` node is semantic rank 7, but V3 fusion evicts it. V3r happens to recover the file, showing the local graph can amplify it once present. |
| `m-0fe9d60` | multi-hop | wrong seeds | Neither dashboard role component appears in V1 or V3 seeds/candidates. Both files are indexed and imported by dashboard/index; V3 and V3r both score 0. |
| `m-1bd695d` | multi-hop | wrong seeds | Same two role components are absent from both seed sets while their incoming dashboard imports exist; V3 and V3r both score 0. |
| `m-86ec976` | multi-hop | wrong seeds | Same role-component miss: indexed nodes and import edges exist, but the query's role/illustration cluster never reaches the seeds; V3 and V3r both score 0. |
| `m-74543de` | multi-hop | wrong seeds | V1 packs both files and scores 1; V3 packs SearchMenu/Result but misses Screenfull. Screenfull is in V1's broad semantic candidates but not V3's seeds; it has two importers and component/prop edges. |
| `m-ff5dcd6` | multi-hop | ranking | `src/main.ts` is a V3 semantic seed and is packed, while directly imported `src/router/guard.ts` is absent. The guard has seven imports and is imported by router/index. V3r also misses it. |
| `m-6f87caf` | multi-hop | ranking | Settings is a V3 seed and Settings/User are packed, but graph-connected useResize and Permission are omitted. Map finds the expected import, composable, store, and call edges; V3r has the same 0.5 recall. |
| `m-75194e0` | multi-hop | ranking | NavigationBar, Sidebar, layout modes, Logo, and TagsView are packed, while sibling Breadcrumb and Hamburger are not. Both missing files are indexed and imported through `layouts/components/index.ts`; V3r is unchanged at 0.5. |
| `m-ea098a6` | multi-hop | wrong seeds | V3 covers the layout cluster but misses the unrelated axios change plus the shared component barrel. Axios has two imports and three importers; the barrel has ten imports and seven importers. The query needs a second semantic cluster that fusion does not retain; V3r is unchanged. |

## Counts

| Class | Count |
|---|---:|
| wrong seeds | 8 |
| missing edge | 0 |
| ranking | 3 |
| packing (body too large) | 1 |
| ground-truth noise | 0 |

Every missing target is indexed and has the expected graph relationships. Only one of the 12 improves under V3r, so HydraDB neighbourhood truncation is not the dominant failure. Four wrong-seed tasks are recovered by V1's broad semantic candidate stream; two targets are semantic ranks 7 and the other two occur beyond the eight displayed seeds. Raising seed count is unattractive: Prompt 136's `seeds=16` train run fell to 59.75% strict and produced 111/158 graph fallbacks.

## Highest-count fix

Preserve broad semantic evidence at the **candidate** stage instead of forcing every useful semantic hit through the eight-node PPR restart set. In `packages/core/src/pipeline.ts` / `retrieve/candidates.ts`, build resolved symbol candidates from the top semantic hits, then late-fuse them with the PPR candidates by deterministic reciprocal-rank fusion before the existing `cfg.candidates=40` cap. Deduplicate by resolved unit id, retain the winning contribution's attribution, and keep test/generated filtering unchanged. A semantic candidate that PPR also finds should combine ranks rather than consume two slots. This leaves `seeds.count=8` and the graph deadline unchanged.

Tests should cover: a semantic-only unit below the seed cutoff surviving late fusion, PPR/semantic deduplication, deterministic tie order, and the 40-candidate cap. Evaluate on train 4k first, then test 4k once; keep only if train strict improves and test does not drop. Report V1 alongside V2/V3.
