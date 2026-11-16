# Go to market

The live site's **Go to market** page is the short version of this document.

## Who it is for

**Small Vue / frontend teams (2-15 developers) and students** who already use Claude Code, Codex or Cursor and pay per token.
They feel the pain most: their agents read whole files to find one function, and every wasted read is on their bill.
Vue 3 + Pinia + Vue Router repositories have unusually explicit structure (a component uses a store, a route mounts a page),
which is exactly where a graph beats search.

## The pain, measured

- Click packs the code a task needs into a fixed budget: on 75 held-out tasks it finds 77-84% of the files the real change
  touched within 4,000-8,000 tokens, and the right *function* 78% of the time, against 24% for plain vector search.
- What we have **not** measured yet is the agent-level saving (tokens and minutes per solved task). The end-to-end harness
  exists (`pnpm e2e`); its runs are the next evidence and the number we will lead with once it exists.

## Why they switch

1. **One command** in the agent they already use: `npm i -g @ishaan_satapathy/click-context`, then `click init`.
2. **Visible**: the statusline shows what was sent (`Click ▸ 3.1k ctx · 7 files · 240 ms`); every item says why it is there.
3. **Never in the way**: if anything is slow or down, the prompt goes through unchanged (tested by ten drills).
4. **Teams of agents**: the moment a second agent (Codex next to Claude Code, Cursor next to both) works on the same repo, they share a board: handoffs, a task list, edit warnings. The second agent does not re-read what the first already worked out.

## Model

| Tier | What | Price (hypothesis, to test with design partners) |
| --- | --- | --- |
| Open source | daemon, hooks, MCP server, benchmark, local HydraDB in Docker | free (MIT) |
| Team | shared learned graph, CI indexing (developers never index locally), conventions memory, usage and savings reports | per seat per month |

## The licence question

HydraDB is under the **Elastic License 2.0**: self-hosting and building on it is allowed; offering HydraDB itself as a managed
service is not. Click never does that. The team plan deploys HydraDB **in the customer's own cloud** (the same images, their
object storage) and sells Click's service on top, or partners with the HydraDB team. For teams that care where their code goes,
"your graph never leaves your account" is a selling point.

## Distribution

- **MCP directories** and the Claude Code / Codex / Cursor user communities: people who already install MCP servers.
- **Vue communities** (Vue Land, Discord, dev.to): a write-up of the benchmark, "what agents miss in a Vue codebase".
- **The benchmark itself**: public, reproducible numbers with intervals are rarer than demo videos, and invite others to beat them.

## Why it scales cheaply

The hot path runs on the developer's machine against a local or team HydraDB. Our servers only index and learn, so cost grows
with commits, not prompts.

## Risks

- **One repository** of evidence. Next: more repositories in the open benchmark.
- **Learning is not proven** to pay off with real agents; design-partner sessions are how that becomes evidence.
- **Agents improve at search on their own.** Our edge is the relations search cannot see and a hard budget discipline; both have
  to keep winning in the benchmark.
- **Vue-first is a wedge**, not a ceiling: React or Svelte is a new extractor, not a new product.
