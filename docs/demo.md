# 75-second demo storyboard

For a live demo or a short clip. The full 4-5 minute walkthrough is [loom-script.md](loom-script.md).

**Reset first** (warms the daemon, checks HydraDB, one real request): `pnpm demo` (also available as `pnpm demo:reset`).

| Seconds | Show | Command or action |
| --- | --- | --- |
| 0-10 | The problem, one line | "Agents read whole files to find one function." |
| 10-30 | Click's answer for a real task | `node packages/click/dist/click.js context "When a user logs out, clear session state and open tabs" --root <bench repo> --budget 4000` |
| 30-45 | HydraDB doing the graph walk | `node packages/click/dist/click.js status --root <bench repo>` (`hydradb: ok`, 310 nodes, 709 edges) |
| 45-60 | Impact | Live site → Graph & impact → `src/pinia/stores/user.ts`: 27 dependents with the edge chain to each |
| 60-75 | The proof | Live site → Benchmark: +4.0 / +10.8 pp from the graph, intervals clear of zero |

If a request shows `graph-replica`, run it again: the first HydraDB queries after a restart are cold.
