# 75-second demo storyboard

For a live demo or a short clip. The full 4-5 minute walkthrough is [loom-script.md](loom-script.md).

**Reset first** (warms the daemon, checks HydraDB, one real request): `pnpm demo` (also available as `pnpm demo:reset`).

The sample repo's comments are in Chinese. `pnpm demo` turns on a per-repo switch (`.click/blank-cjk-comments` in the demo repo) so the daemon blanks the *text* of those comments in the code it returns; line numbers do not change and string literals stay. It is for the screen only: in-process runs (the benchmark) never honour it, and `DEMO_PLAIN=1 pnpm demo` removes it. A running daemon picks the switch up on its own (it checks it on every file load), so no restart is needed.

| Seconds | Show | Command or action |
| --- | --- | --- |
| 0-10 | The problem, one line | "Agents read whole files to find one function." |
| 10-30 | Click's answer for a real task | `node packages/click/dist/click.js context "When a user logs out, clear session state and open tabs" --root <bench repo> --budget 4000` |
| 30-45 | HydraDB doing the graph walk | `node packages/click/dist/click.js status --root <bench repo>` (`hydradb: ok`, 310 nodes, 709 edges) |
| 45-60 | Impact | Live site → Graph & impact → `src/pinia/stores/user.ts`: 27 dependents with the edge chain to each |
| 60-75 | The proof | Live site → Benchmark: +4.0 / +10.8 pp from the graph, intervals clear of zero |

If a request shows `graph-replica`, run it again: the first HydraDB queries after a restart are cold.
