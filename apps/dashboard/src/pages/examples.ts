import { h } from '../dom.js';
import { pct } from '../format.js';
import type { Page } from '../app.js';

export const examples: Page = ({ data }) => {
  if (!data.examples.length) return h('div', { class: 'callout' }, 'No worked examples in this build.');
  return h(
    'div',
    {},
    h('h1', {}, 'Worked examples'),
    h('p', { class: 'lead muted' }, 'Real held-out tasks, each answered at an 8,000-token budget. The target files are the ones the real commit changed; Click never saw them. The same task is shown without the graph for comparison. The last example is a miss, kept in on purpose.'),
    data.examples.map((e) => {
      const total = e.groundTruthFiles.length;
      const got = e.filesFound.length;
      const base = e.baseline;
      return h(
        'div',
        { class: 'card', style: 'margin-bottom:18px' },
        h('div', { class: 'q' }, `${e.taskId} · ${e.type}`),
        h('h3', {}, `“${e.text}”`),
        h(
          'div',
          { class: 'cols' },
          h(
            'div',
            {},
            h('p', { class: 'small muted' }, 'Files the real change touched'),
            h(
              'ul',
              { class: 'files' },
              e.groundTruthFiles.map((f) => {
                const hit = e.filesFound.includes(f);
                const baseHit = base?.filesFound.includes(f);
                return h('li', {}, h('code', { class: 'small' }, f), h('span', {}, h('span', { class: `tag ${hit ? 'hit' : 'miss'}` }, hit ? 'Click: in context' : 'Click: missed'), base ? h('span', { class: `tag ${baseHit ? 'hit' : 'miss'}` }, baseHit ? `${base.variant}: in` : `${base.variant}: missed`) : null));
              }),
            ),
            h('p', { class: 'small' }, `Click found ${got} of ${total} (${pct(e.strict, 0)}%)${base ? `; without the graph: ${base.filesFound.length} of ${total} (${pct(base.strict, 0)}%)` : ''}.`),
          ),
          h(
            'div',
            {},
            h('p', { class: 'small muted' }, `What Click packed (${e.items.reduce((s, i) => s + i.tokens, 0).toLocaleString()} tokens)`),
            h(
              'ul',
              { class: 'files' },
              e.items.slice(0, 14).map((i) => h('li', {}, h('span', {}, h('code', { class: 'small' }, i.name), ' ', h('span', { class: 'muted small' }, i.path ?? '')), h('span', {}, h('span', { class: 'tag' }, i.mode), h('span', { class: 'muted small' }, `${i.tokens} tok`)))),
            ),
            e.items.length > 14 ? h('p', { class: 'small muted' }, `+ ${e.items.length - 14} more`) : null,
          ),
        ),
        h('p', { class: 'small muted' }, `Run ${e.rowId}${base ? ` · baseline run ${base.rowId}` : ''}`),
      );
    }),
  );
};
