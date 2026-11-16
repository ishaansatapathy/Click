# Pitch: five slides

Every number below is a row of `bench/results.jsonl` (run ids on the live site's Benchmark page).

## 1. Problem

Coding agents are good at writing code and expensive at finding it. They grep, open whole files, follow imports, and still miss
the code that matters, because what links it to the task (a component that uses a store, a route that mounts a page) is a
**relation**, not text. Every miss costs tokens and minutes, and the bill is paid per token.

## 2. Insight

**Structure beats similarity.** Read the repository as a graph and walk it from the task.
- Seeds from symbols, BM25 and embeddings; a 2-hop walk in **HydraDB**; personalised PageRank; pack to a hard token budget.
- **Reads local, writes async**: the hot path runs on the developer's machine in well under a second; indexing and learning
  write to HydraDB in the background, and a local replica means HydraDB being slow never blocks an answer.

## 3. Numbers (75 held-out tasks from a real Vue app's history)

| Claim | Number |
| --- | --- |
| The graph does real work | +4.0 pp strict file recall at 4k tokens [+1.7, +6.7], **+10.8 pp at 8k** [+5.9, +16.4] vs the same pipeline without it |
| Impact questions ("what else must change?") | +31 pp (4 tasks: small n, wide interval) |
| The right function, not a slice of a file | symbol recall 78% vs 24% for plain vector search |
| Honest tie | whole-file recall vs plain vector search: −0.0 pp [−6.2, +6.0] |
| Cost | about +780 ms p95 for the HydraDB walk; the hook answers in p50 405 ms / p95 550 ms end to end |
| Never blocks | 9 of 10 failure drills pass, 1 not applicable; slowest hook 1.5 s of its 3 s timeout |

## 4. Learning

The agent's own behaviour (what it used, what it ignored, what it needed and did not get) reweights the graph edges, stored in
HydraDB. The loop works end to end; on simulated outcomes the held-out gain is **+1.0 pp [−1.3, +4.3]**: small and not proven.
Real sessions are the next evidence.

## 5. Go to market and scale

- **For** small Vue/frontend teams and students who pay per token.
- **Free and local** for one developer (MIT, HydraDB in Docker). **Team plan**: shared learned graph, CI indexing, usage reports.
- **HydraDB licence (ELv2)**: the team plan runs HydraDB **in the customer's own cloud**, so their code graph never leaves
  their account, and nobody resells HydraDB as a service.
- **Distribution**: MCP listings, Claude Code / Codex communities, Vue Land, the open benchmark as content.
- **Scales cheaply**: requests run on the developer's machine; servers only index and learn, so cost grows with commits, not
  prompts.
