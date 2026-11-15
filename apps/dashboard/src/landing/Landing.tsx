import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { parseResults, type ResultsData } from '../data/types.js';
import { diffOf, pct, pp, row } from '../format.js';
import { CountUp, Reveal, Scramble, scrollToId, useLenis, useScrollY } from '../motion.js';
import { BigPixelLogo, BlockField, Cross, IsoC, NodeGlyph, PixelGraph, PixelLogo, TubeC } from './art.js';
import './landing.css';

const GITHUB = 'https://github.com/ishaansatapathy/Click';

const NAV = [
  { id: 'how', label: 'How it works' },
  { id: 'graph', label: 'Graph' },
  { id: 'features', label: 'Features' },
  { id: 'bench', label: 'Benchmark' },
  { id: 'impact', label: 'Use cases' },
  { id: 'faq', label: 'Contact' },
];

function useResults(): ResultsData | null {
  const [r, setR] = useState<ResultsData | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/data/results.json')
      .then((x) => x.json())
      .then((x) => live && setR(parseResults(x)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return r;
}

function Nav() {
  const y = useScrollY();
  return (
    <header className={`lp-nav ${y > 40 ? 'solid' : ''}`}>
      <Link to="/" className="lp-cell lp-brand">
        <PixelLogo size={14} /> CLICK
      </Link>
      <nav className="lp-links" aria-label="Sections">
        {NAV.map((n) => (
          <button key={n.id} type="button" className="lp-cell" onClick={() => scrollToId(n.id)}>
            {n.label}
          </button>
        ))}
        <a className="lp-cell" href={GITHUB} target="_blank" rel="noreferrer">
          GitHub
        </a>
      </nav>
      <Link to="/sign-in" className="lp-cell lp-launch">
        Launch app
      </Link>
    </header>
  );
}

function Hero({ r }: { r: ResultsData | null }) {
  const y = useScrollY();
  const nodes = r?.repo.nodes ?? 310;
  const edges = r?.repo.edges ?? 709;
  const ticker = `HYDRADB GRAPH ONLINE · ${nodes} NODES · ${edges} EDGES · ONE CALL: GETCONTEXT(TASK, BUDGET) · `;
  return (
    <section className="lp-hero" id="top">
      <svg className="lp-frame" viewBox="0 0 1440 900" preserveAspectRatio="none" aria-hidden>
        <polyline points="110,880 110,110 190,110 190,145 360,145 360,110 540,110 540,145 1010,145 1010,72 1400,72 1400,145" />
        <polyline points="40,330 110,330" />
        <polyline points="40,330 40,470 110,470" />
        <polyline points="110,620 500,620 500,880" />
        <polyline points="1110,880 1110,440 1360,440 1360,145" />
      </svg>
      <Cross style={{ left: '12%', top: '19%' }} />
      <Cross style={{ left: '12%', top: '68%' }} />
      <Cross style={{ right: '4%', top: '14%' }} />

      <h1 className="lp-h1" aria-label="Structure-aware context for coding agents">
        <span className="l1">
          <Scramble text="STRUCTURE-AWARE" start delay={150} />
        </span>
        <span className="l2">
          <Scramble text="CONTEXT FOR" start delay={450} />
        </span>
        <span className="l3">
          <Scramble text="CODING" start delay={750} />
        </span>
        <span className="l4">
          <Scramble text="AGENTS" start delay={950} />
        </span>
      </h1>

      <div className="lp-art" style={{ transform: `translate3d(0, ${y * -0.12}px, 0)` }}>
        <TubeC />
        <div className="lp-ticks" aria-hidden>
          {Array.from({ length: 10 }).map((_, i) => (
            <i key={i} />
          ))}
        </div>
      </div>

      <div className="lp-hero-foot">
        <PixelLogo size={46} className="lp-foot-logo" />
        <Reveal as="p" delay={900} className="lp-mono">
          Context layer for coding agents on Vue 3. The code graph lives in a self-hosted HydraDB.
        </Reveal>
        <Reveal as="p" delay={1050} className="lp-mono">
          Give the agent the right functions, components and stores. Inside a token budget, in under a second.
        </Reveal>
      </div>

      <aside className="lp-card">
        <div className="lp-card-art">
          <IsoC />
        </div>
        <div className="lp-marquee lp-mono" aria-label={ticker}>
          <div>
            <span>{ticker}</span>
            <span>{ticker}</span>
          </div>
        </div>
        <Link to="/sign-in" className="lp-card-cta">
          Launch app
        </Link>
      </aside>

      <button type="button" className="lp-down" onClick={() => scrollToId('graph')} aria-label="Scroll down">
        ↓
      </button>
    </section>
  );
}

function GraphSection() {
  return (
    <section className="lp-graph" id="graph">
      <div className="lp-field">
        <BlockField />
      </div>
      <div className="lp-graph-copy">
        <h2 className="lp-h2 right">
          <Scramble text="GRAPH OF" />
          <br />
          <Scramble text="YOUR CODEBASE" delay={150} />
        </h2>
        <div className="lp-graph-row">
          <h2 className="lp-h2">
            <Scramble text="CONTEXT TO" delay={250} />
            <br />
            <span className="indent">
              <Scramble text="ANY AGENT" delay={400} />
            </span>
          </h2>
          <div className="lp-dotbox" aria-hidden>
            <i />
          </div>
          <Reveal as="p" className="lp-mono small">
            Click reads a Vue repo as a graph: components, stores, routes, composables, calls and tests. Then it walks that graph from
            your task to the code that matters.
          </Reveal>
        </div>
      </div>
    </section>
  );
}

function Stats({ r }: { r: ResultsData | null }) {
  const lift = r ? diffOf(r, 'V3 - V2', 8000) : null;
  const items = [
    { label: 'Benchmark tasks', value: r?.tasks.total ?? 233, dec: 0, prefix: '', suffix: '' },
    { label: 'Held-out tasks', value: r?.tasks.test ?? 75, dec: 0, prefix: '', suffix: '' },
    { label: 'Graph lift @ 8k tokens', value: lift ? lift.delta * 100 : 10.8, dec: 1, prefix: '+', suffix: 'pp' },
    { label: 'Graph nodes in HydraDB', value: r?.repo.nodes ?? 310, dec: 0, prefix: '', suffix: '' },
  ];
  return (
    <section className="lp-stats" aria-label="Numbers">
      {items.map((it, i) => (
        <Reveal key={it.label} className="lp-stat" delay={i * 90}>
          <span className="lp-label">{it.label}</span>
          <span className="lp-rule" aria-hidden>
            {Array.from({ length: 6 }).map((_, k) => (
              <i key={k} />
            ))}
          </span>
          <span className="lp-num">
            <CountUp value={it.value} decimals={it.dec} prefix={it.prefix} suffix={it.suffix} />
          </span>
        </Reveal>
      ))}
    </section>
  );
}

const STEPS = [
  { key: 'SEEDS', title: 'SEEDS', body: 'Symbol names, BM25 and code embeddings run at once over the indexed repo. Rank fusion turns them into a few starting points.' },
  { key: 'HYDRADB', title: 'HYDRADB', body: 'From the seeds, Click asks HydraDB for the two-hop neighbourhood: the store a component uses, the route that mounts a page, the test that covers it.' },
  { key: 'PAGERANK', title: 'PAGERANK', body: 'Personalised PageRank from the seeds ranks that neighbourhood. Edge types carry weights, and learned multipliers adjust them.' },
  { key: 'PACK', title: 'PACK', body: 'The best functions are read fresh from disk and packed into the budget. An oversized function is cut to its most relevant chunks.' },
];

function How() {
  const [i, setI] = useState(1);
  useEffect(() => {
    const t = setInterval(() => setI((x) => (x + 1) % STEPS.length), 4200);
    return () => clearInterval(t);
  }, []);
  const s = STEPS[i]!;
  return (
    <section className="lp-how" id="how">
      <span className="lp-tag-plain">How it works</span>
      <div className="lp-how-grid">
        <div className="lp-how-main">
          <div className="lp-how-tabs" role="tablist">
            {STEPS.map((x, k) => (
              <button key={x.key} type="button" role="tab" aria-selected={k === i} className={k === i ? 'on' : ''} onClick={() => setI(k)}>
                0{k + 1} {x.key}
              </button>
            ))}
          </div>
          <h3 className="lp-how-title" key={s.key}>
            <Scramble text={s.title} start duration={600} />
          </h3>
          <p className="lp-mono small lp-how-body" key={`${s.key}b`}>
            {s.body}
          </p>
          <span className="lp-orange-tag">getContext(task, budget)</span>
        </div>
        <div className="lp-how-art">
          <PixelGraph />
        </div>
        <div className="lp-how-white" aria-hidden />
      </div>
    </section>
  );
}

function Integrations() {
  const words = ['getContext', 'impact', 'conventions', 'learn'];
  return (
    <section className="lp-int" aria-label="Integrations">
      <span className="lp-tag-plain">Integrations</span>
      <div className="lp-band">
        <div className="lp-band-track">
          {[0, 1].map((k) => (
            <span key={k}>
              {words.map((w) => (
                <span key={w}>
                  <b>·</b> {w.toUpperCase()}&nbsp;
                </span>
              ))}
            </span>
          ))}
        </div>
      </div>
      <div className="lp-int-rows">
        <div className="lp-int-list">
          {['Any MCP client', 'Claude Code hook', 'CLI'].map((w, i) => (
            <Reveal key={w} className="lp-int-word" delay={i * 120}>
              {w.toUpperCase()}
            </Reveal>
          ))}
        </div>
        <Reveal className="lp-int-note">
          <span className="lp-orange-tag">Install</span>
          <p className="lp-mono small">
            Works with the agent you already use: Claude Code, Codex, Cursor or any MCP client. The MCP server answers on demand; in
            Claude Code a prompt hook also adds context to every message and a Stop hook learns from what the agent actually read.
          </p>
          <code className="lp-code">npm i -g click-context</code>
        </Reveal>
      </div>
    </section>
  );
}

const FEATURES = [
  { n: '01', t: 'STRUCTURE-AWARE', d: 'Follows imports, store use, routes and calls, so it finds code that never mentions your words.', lit: [0, 4, 6] },
  { n: '02', t: 'BUDGET-STRICT', d: 'Every answer fits the token budget you give it. Big functions are sliced, not dropped.', lit: [4, 5] },
  { n: '03', t: 'SELF-LEARNING', d: 'Edges that led to code the agent used get stronger; edges that led to noise decay.', lit: [0, 1, 4, 5] },
  { n: '04', t: 'FAIL-SOFT', d: 'HydraDB slow? A local replica answers. Daemon down? The agent carries on, never blocked.', lit: [3, 6, 7] },
];

function Features() {
  return (
    <section className="lp-features" id="features">
      <span className="lp-tag-plain">Features</span>
      <div className="lp-feat-grid">
        {FEATURES.map((f, i) => (
          <Reveal key={f.n} className="lp-feat" delay={i * 110}>
            <NodeGlyph lit={f.lit} />
            <div className="lp-feat-body">
              <span className="lp-mono small dim">{f.n}</span>
              <h3>
                <Scramble text={f.t} delay={i * 110} />
              </h3>
              <p className="lp-mono small">{f.d}</p>
            </div>
            <Cross style={{ left: 20, bottom: 20 }} />
          </Reveal>
        ))}
      </div>
    </section>
  );
}

function Bench({ r }: { r: ResultsData | null }) {
  const variants: [string, string][] = [
    ['V1', 'Vector search over chunks'],
    ['V2', 'Click seeds, no graph'],
    ['V3', 'Click + HydraDB graph'],
    ['V5', 'V3 + learned weights'],
    ['oracle', 'Ceiling: the true files'],
  ];
  const g4 = r ? diffOf(r, 'V3 - V2', 4000) : null;
  const g8 = r ? diffOf(r, 'V3 - V2', 8000) : null;
  return (
    <section className="lp-bench" id="bench">
      <h2 className="lp-h2 bench-title">
        <span className="i1">
          <Scramble text="THE MOST HONEST" />
        </span>
        <span className="i2">
          <Scramble text="CONTEXT" delay={150} />
        </span>
        <span className="i3">
          <Scramble text="BENCHMARK" delay={300} />
        </span>
      </h2>
      <div className="lp-bench-intro">
        <span className="lp-orange-tag">{r ? `${r.tasks.test} held-out` : 'held-out'}</span>
        <Reveal as="p" className="lp-mono small">
          {r ? `${r.tasks.total} tasks mined from the git history of ${r.repo.name}, a real Vue 3 + Pinia + Router app. ` : ''}
          A file only counts if its code is inside the packed context, at a fixed budget. Intervals are paired bootstraps; nothing is
          tuned on the held-out split.
        </Reveal>
      </div>
      <div className="lp-setup">
        <span className="lp-tag-plain">Setup</span>
        <div>
          <p className="lp-mono">BENCH REPO: V3-ADMIN-VITE @ {r?.repo.sha.slice(0, 7) ?? '…'}</p>
          <p className="lp-mono">{r ? `${r.repo.files} FILES · ${r.repo.nodes} NODES · ${r.repo.edges} EDGES` : '…'}</p>
        </div>
        <div>
          <p className="lp-mono">HYDRADB OSS · SELF-HOSTED IN DOCKER</p>
          <p className="lp-mono">BUDGETS: 4,000 AND 8,000 TOKENS</p>
        </div>
      </div>
      <div className="lp-table-wrap">
        <table className="lp-table">
          <thead>
            <tr>
              <th>Variant</th>
              <th>What it is</th>
              <th className="num">Strict @4k</th>
              <th className="num">Strict @8k</th>
              <th className="num">Symbol @4k</th>
              <th className="num">p50</th>
            </tr>
          </thead>
          <tbody>
            {r &&
              variants.map(([v, what]) => {
                const a = row(r, v, 4000);
                const b = row(r, v, 8000);
                return (
                  <tr key={v} className={v === 'V3' ? 'hl' : ''}>
                    <td>{v.toUpperCase()}</td>
                    <td className="dim">{what}</td>
                    <td className="num">{pct(a.strict)}%</td>
                    <td className="num">{pct(b.strict)}%</td>
                    <td className="num">{a.symbol === null ? '–' : `${pct(a.symbol)}%`}</td>
                    <td className="num">{a.p50ms ? `${Math.round(a.p50ms)} ms` : '–'}</td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
      {g4 && g8 && (
        <p className="lp-mono small dim lp-foot-note">
          The graph adds {pp(g4.delta)} pp at 4k [{pp(g4.lo)}, {pp(g4.hi)}] and {pp(g8.delta)} pp at 8k [{pp(g8.lo)}, {pp(g8.hi)}] over the
          same pipeline without it. Against plain vector search, file recall is a tie; symbol recall is about three times higher. Learning
          is not yet shown to help. <Link to="/sign-in">Every number, with its run id →</Link>
        </p>
      )}
    </section>
  );
}

const USES = [
  { k: 'IMPACT()', tag: 'Use case 01', body: 'What breaks if I change useUserStore? Click walks incoming edges up to three hops and returns every dependent with the chain that links it, plus the tests that cover them.', lines: ['useUserStore → 27 files within 3 hops', 'router/guard.ts · 1 hop · imports', 'layouts/NavigationBar · 1 hop · uses_store'] },
  { k: 'CONTEXT()', tag: 'Use case 02', body: 'Ask for a change in plain words. Click returns the functions, components and stores that change needs, ranked by the graph and packed to the budget.', lines: ['"clear session on logout"', '→ useUserStore, resetRouter, useTagsViewStore', '→ +8 files only the graph found'] },
  { k: 'CONVENTIONS()', tag: 'Use case 03', body: 'The project rules the agent should follow, mined from the repo and kept with the graph, so every answer comes with how this team writes code.', lines: ['stores live in src/pinia/stores', 'aliases: @ → src, @@ → src/common', 'tests: tests/**/*.test.ts'] },
];

function UseCases() {
  const [i, setI] = useState(0);
  const u = USES[i]!;
  return (
    <section className="lp-uses" id="impact">
      <span className="lp-tag-plain">Use cases</span>
      <div className="lp-uses-bar">
        {USES.map((x, k) => (
          <button key={x.k} type="button" className={k === i ? 'on' : ''} onClick={() => setI(k)}>
            {x.tag}
          </button>
        ))}
      </div>
      <div className="lp-uses-main">
        <h3 className="lp-uses-title" key={u.k}>
          <Scramble text={u.k} start duration={700} />
        </h3>
        <div className="lp-uses-icon" aria-hidden>
          <NodeGlyph lit={[0, 1, 2, 3]} />
        </div>
        <p className="lp-mono small lp-uses-body">{u.body}</p>
      </div>
      <ul className="lp-uses-lines">
        {u.lines.map((l) => (
          <li key={l} className="lp-mono small">
            {l}
          </li>
        ))}
      </ul>
    </section>
  );
}

function BuiltOn() {
  const items = ['HYDRADB', 'VUE 3', 'ANY AGENT', 'MCP'];
  return (
    <section className="lp-built" aria-label="Built on">
      <div className="lp-built-row">
        {items.map((x, i) => (
          <Reveal key={x} className="lp-built-cell" delay={i * 90}>
            {x}
          </Reveal>
        ))}
        <div className="lp-built-cell note lp-mono">WE BUILD ON THE BEST</div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="lp-footer" id="faq">
      <h2 className="lp-h2 footer-title">
        <span>
          <Scramble text="HERE" />
        </span>
        <span className="i2">
          <Scramble text="TO ANSWER" delay={150} />
        </span>
        <span>
          <Scramble text="YOUR QUESTIONS" delay={300} />
        </span>
      </h2>
      <div className="lp-footer-grid">
        <div className="lp-footer-logo">
          <BigPixelLogo />
        </div>
        <div className="lp-footer-cols">
          <div>
            <span className="lp-mono small dim">Product</span>
            <Link to="/sign-in">Launch app</Link>
            <button type="button" onClick={() => scrollToId('bench')}>
              Benchmark
            </button>
            <button type="button" onClick={() => scrollToId('how')}>
              How it works
            </button>
          </div>
          <div>
            <span className="lp-mono small dim">Resources</span>
            <a href={GITHUB} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a href="https://github.com/hydra-db/hydradb" target="_blank" rel="noreferrer">
              HydraDB
            </a>
            <a href={`${GITHUB}#readme`} target="_blank" rel="noreferrer">
              Docs
            </a>
          </div>
          <div>
            <span className="lp-mono small dim">Contact</span>
            <a href={`${GITHUB}/issues`} target="_blank" rel="noreferrer">
              Open an issue
            </a>
          </div>
        </div>
      </div>
      <div className="lp-footer-bar lp-mono small">
        <span>© 2026 CLICK · OPEN SOURCE (MIT)</span>
        <span>BUILT FOR THE HYDRADB HACKATHON</span>
      </div>
    </footer>
  );
}

export default function Landing() {
  useLenis();
  const r = useResults();
  return (
    <div className="lp">
      <Nav />
      <main>
        <Hero r={r} />
        <GraphSection />
        <Stats r={r} />
        <How />
        <Integrations />
        <Features />
        <Bench r={r} />
        <UseCases />
        <BuiltOn />
      </main>
      <Footer />
    </div>
  );
}
