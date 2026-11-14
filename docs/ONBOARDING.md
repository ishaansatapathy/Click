# Click contributor onboarding

Click is a context layer for coding agents in Vue 3 + TypeScript repositories. Its product is one function:
`getContext(task, budget) -> packed text`. Keep adapters thin and optimise that path.

## Read first

Read in this order: `PLAN.md`, `ARCHITECTURE.md`, `SPEC.md`, then the one numbered prompt in
`PROMPTS.md` you are implementing. Contracts in SPEC win over other docs, architecture wins on design,
and PLAN wins on process and priority. Append choices between viable options to `DECISIONS.md`.

Work on exactly one numbered prompt at a time. Use strict TypeScript, ESM, deterministic output, bounded
network deadlines, and tests for every module. Never change `packages/core/src/types.ts` without Ishaan's
approval; it is frozen after Prompt 002. Hooks may write protocol output to stdout and nothing else.

## Lanes

- Lane A owns `bench/`: benchmark mining, metrics, stores and embeddings, evaluation, delivery and docs.
- Lane B owns `packages/`: indexer, graph runtime, retrieval, daemon, hooks and learning.
- `packages/core/src/types.ts` is the shared frozen boundary. Coordinate before editing another lane's files.

## Contract map

| SPEC | Responsibility | Code |
|---|---|---|
| §2 | Core types and stable IDs | `packages/core/src/types.ts`, `util/ids.ts` |
| §3 | Variant config and presets | `packages/core/src/config.ts` |
| §4 | Store and embeddings | `packages/core/src/store/` |
| §5 | Discovery, extraction and linking | `packages/core/src/indexer/` |
| §6 | CSR, lexical retrieval, fusion and PPR | `packages/core/src/graph/`, `retrieve/` |
| §7 | Versioned local snapshots | `packages/core/src/graph/snapshot.ts` |
| §8 | Jev/rerank/no-op pruning | `packages/core/src/prune/` |
| §9 | Budgeted deterministic packing | `packages/core/src/pack/` |
| §10–11 | HTTP API, daemon and client lifecycle | `packages/click/src/daemon/`, `client.ts` |
| §12 | Hooks and installers | `packages/click/src/hooks/`, `install/` |
| §13 | MCP tools | `packages/click/src/mcp/` |
| §14–15 | Append-only outcomes and learning | `packages/core/src/learn/` |
| §16 | Tasks, metrics and result rows | `bench/src/`, `bench/scripts/`, `bench/e2e/` |
| §17 | Environment, local files and stats | `packages/core/src/util/`, daemon |
| §18 | Performance budgets and failure drills | tests, `bench/`, drill scripts |

`packages/core/src/pipeline.ts` composes retrieval, graph expansion, pruning and packing into `getContext`.
`packages/click` exposes it through the daemon, CLI, hooks and MCP. The daemon's wait path may make at most
one semantic call and one pruning call; indexing, sync and learning remain asynchronous.

## Commands

```sh
pnpm install
pnpm check                         # typecheck + lint + all unit tests
pnpm test -- path/to/file.test.ts  # focused Vitest run while iterating
pnpm bench -- --variant V3 --budget 4000 --split train
pnpm click -- context "task text"
pnpm drill
```

Before committing, run `pnpm check` and fix the cause of every failure. Commit as `NNN: summary`. Never
weaken or remove a test to make the gate pass. Live API tests require `CLICK_LIVE=1`; secrets come only from
environment variables and must never reach logs, stdout or commits.
