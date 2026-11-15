import { h } from '../dom.js';
import { budgetLabel, ci, diffOf, ms, row } from '../format.js';
import type { Page } from '../app.js';

export const gtm: Page = ({ data }) => {
  const r = data.results;
  const g8 = diffOf(r, 'V3 - V2', 8000);
  const lat = row(r, 'V3', 4000).p95ms - row(r, 'V2', 4000).p95ms;
  return h(
    'div',
    {},
    h('h1', {}, 'Go to market'),
    h('p', { class: 'lead muted' }, 'Agents are good at writing code and expensive at finding it. Click sells the finding, measured: the right code inside a fixed budget.'),

    h(
      'div',
      { class: 'grid two' },
      h('div', { class: 'card' }, h('div', { class: 'q' }, 'Who it is for'), h('h3', {}, 'Small frontend teams and solo developers on Vue 3'), h('p', { class: 'small' }, 'They already use Claude Code, Cursor or Codex, they pay per token, and they lose minutes each task watching an agent grep and open the wrong files. Vue, Pinia and Vue Router give the graph unusually clean structure (a component uses a store, a route mounts a page), which is where a graph beats search.')),
      h('div', { class: 'card' }, h('div', { class: 'q' }, 'Why they switch'), h('h3', {}, 'One command, visible result'), h('p', { class: 'small' }, `It installs into the agent they already use. The answer shows what was sent and why, so the benefit is visible per request, not taken on trust. On our benchmark it puts ${ci(g8)} more of the needed files in context at ${budgetLabel(8000)} than the same retrieval without the graph.`)),
    ),

    h('h2', {}, 'Business model'),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Tier'), h('th', {}, 'What you get'), h('th', {}, 'Who pays'))),
        h(
          'tbody',
          {},
          h('tr', {}, h('td', {}, h('b', {}, 'Open source')), h('td', {}, 'Daemon, hooks, MCP server, benchmark, a local HydraDB in Docker. Everything on this site is reproducible from it.'), h('td', {}, 'Free (MIT)')),
          h('tr', {}, h('td', {}, h('b', {}, 'Team')), h('td', {}, 'A shared learned graph, CI indexing so developers never index locally, conventions memory, usage and savings reports.'), h('td', {}, 'Per seat, billed monthly')),
        ),
      ),
    ),
    h('p', { class: 'small muted' }, 'Pricing is a hypothesis to test with the first design partners, not a measured fact.'),

    h('h2', {}, 'The licence question, answered'),
    h('p', {}, 'HydraDB is open source under the Elastic License 2.0: anyone may self-host and build on it, but nobody may sell HydraDB itself as a managed service. Click never does. The team plan runs HydraDB ', h('b', {}, 'in the customer\'s own cloud'), ' (the same images against their storage) and Click sells the service on top, so a customer\'s code graph never leaves their account. That is the licence-safe design and, for teams that care where their code goes, a selling point.'),

    h('h2', {}, 'How people find it'),
    h(
      'ul',
      {},
      h('li', {}, h('b', {}, 'The benchmark is the marketing. '), 'A public, reproducible number ("the right files in context, with an interval") is rarer than a demo video and invites others to beat it.'),
      h('li', {}, h('b', {}, 'MCP directories and agent communities. '), 'Claude Code, Codex and Cursor users who already install MCP servers.'),
      h('li', {}, h('b', {}, 'Vue and Pinia communities. '), 'A write-up of the benchmark for Vue Land and dev.to: "what agents miss in a Vue codebase".'),
    ),

    h('h2', {}, 'Why it scales cheaply'),
    h('p', {}, `The hot path (one request, a few hundred milliseconds) runs on the developer's machine against a local or team HydraDB. Servers only index and learn, so cost grows with commits, not prompts. The honest trade-off: the graph walk adds about ${ms(lat)} at p95 per request, which is small next to an agent turn but is the price of the extra recall.`),

    h('h2', {}, 'Risks we see'),
    h(
      'ul',
      {},
      h('li', {}, 'Evidence is on one repository. The benchmark is open so teams can run it on theirs; a multi-repo result is the first thing to add.'),
      h('li', {}, 'Learning is shown to work as a mechanism, not yet to pay off with real agents. Design-partner sessions are how that becomes evidence.'),
      h('li', {}, 'Agents are getting better at searching on their own. Our edge is the structural relations search cannot see, and the measured budget discipline; both need to keep winning in the benchmark.'),
      h('li', {}, 'Vue-first is a wedge, not a ceiling. The graph builder is per framework, so React or Svelte is a new extractor, not a new product.'),
    ),
  );
};
