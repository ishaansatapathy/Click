import { h } from '../dom.js';
import type { Page } from '../app.js';

export const how: Page = ({ data }) => {
  const r = data.results.repo;
  return h(
    'div',
    {},
    h('h1', {}, 'How it works'),
    h('p', { class: 'lead muted' }, 'A coding agent asks "what do I need to read for this task?" and Click answers with code, inside a token budget, in well under a second. Nothing leaves your machine except the graph you chose to keep in HydraDB.'),

    h('h2', {}, 'One request, step by step'),
    h(
      'div',
      { class: 'flow' },
      h('div', { class: 'step' }, h('b', {}, 'Find the seeds'), 'Three searches run at once over the indexed repo: exact symbol names in the prompt, BM25 over names and docs, and embeddings of code chunks. Reciprocal-rank fusion merges them into a few starting points.'),
      h('div', { class: 'step hydra' }, h('b', {}, 'Walk the graph in HydraDB'), 'From the seeds, ask HydraDB for the two-hop neighbourhood: components that use a store, the route that mounts a page, the composable a component calls, the tests that cover it.'),
      h('div', { class: 'step' }, h('b', {}, 'Rank by personalised PageRank'), 'Run PageRank from the seeds over that neighbourhood. Edge types carry prior weights (a store import matters more than a type import); learned multipliers adjust them.'),
      h('div', { class: 'step' }, h('b', {}, 'Pack to the budget'), 'Take the best functions and components, read their current code from disk, and pack as many as fit. An oversized function is cut to its most relevant chunks. Neighbours the budget cannot hold appear as one-line signatures.'),
      h('div', { class: 'step' }, h('b', {}, 'Say what happened'), 'The answer lists what was included and why (the edge chain from a seed), how long each stage took, and any part that degraded.'),
    ),

    h('h2', {}, 'Why a graph, and why HydraDB'),
    h(
      'p',
      {},
      'Vector search finds code that reads like the task. A Vue change is rarely like that: renaming a store action means the component that calls it, the route guard that depends on it and the test that mocks it, and none of them mention the store by name. Those relations are edges, so Click keeps the project as a graph (',
      `${r.nodes} nodes and ${r.edges} edges for ${r.name}`,
      ') and stores it in HydraDB. The benchmark page shows what the walk adds over the same retrieval without it.',
    ),
    h(
      'div',
      { class: 'grid two' },
      h('div', { class: 'card' }, h('h3', {}, 'What lives in HydraDB'), h('ul', {}, h('li', {}, 'Nodes: files, components, composables, stores, routes, functions, types, tests.'), h('li', {}, 'Edges: imports, uses_component, uses_store, calls, routes_to, tested_by, plus co_changed edges mined from git and learned from usage.'), h('li', {}, 'The learned weights document, so a team can share what the agent learned.'))),
      h('div', { class: 'card' }, h('h3', {}, 'What stays on your machine'), h('ul', {}, h('li', {}, 'Your source code. Bodies are read from disk at request time, so they are never stale.'), h('li', {}, 'The daemon: it answers from an in-memory replica and talks to HydraDB only to walk the graph.'), h('li', {}, 'HydraDB itself, self-hosted in Docker (open source).'))),
    ),

    h('h2', {}, 'Designed to fail soft'),
    h(
      'ul',
      {},
      h('li', {}, 'HydraDB slower than its deadline? The request is served from the local replica and flagged.'),
      h('li', {}, 'Embeddings unavailable? Symbol and BM25 seeds still work.'),
      h('li', {}, 'Daemon not running? The hook does nothing and the agent continues as it would have, never blocked.'),
      h('li', {}, 'Hook output is capped under Claude Code\'s 10,000-character limit; the MCP path has no such cap.'),
    ),

    h('h2', {}, 'Ways to use it'),
    h(
      'div',
      { class: 'grid three' },
      h('div', { class: 'card' }, h('h3', {}, 'Claude Code hook'), h('p', { class: 'small' }, 'A UserPromptSubmit hook adds the packed context to every prompt automatically; a Stop hook learns from what the agent did.')),
      h('div', { class: 'card' }, h('h3', {}, 'MCP server'), h('p', { class: 'small' }, 'Any MCP client can call the context, impact and conventions tools on demand.')),
      h('div', { class: 'card' }, h('h3', {}, 'CLI'), h('pre', { class: 'ctx' }, 'click index\nclick context "rename the user store action"\nclick status')),
    ),

    h('h2', {}, 'Ask: what breaks if I change this?'),
    h('p', {}, 'The same graph answers impact questions. ', h('code', {}, 'GET /impact?symbol=useUserStore'), ' walks incoming dependency edges up to three hops and returns the dependents grouped by kind with the edge chain that links each one, plus the tests that cover them. Open the ', h('a', { href: '#/graph' }, 'graph explorer'), ' to try it on this repo.'),
  );
};
