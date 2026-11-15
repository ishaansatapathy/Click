import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ROUTES, type Page } from '../app.js';
import { useAuth } from '../auth.js';
import { loadData, type DashboardData } from '../data/types.js';
import { PixelLogo } from '../landing/art.js';
import { IsoStack } from './art.js';
import { Icon, type IconName } from './icons.js';
import '../legacy.css';
import './app.css';

// ---------------------------------------------------------------- setup progress (per browser)

const STEPS = ['signed-in', 'explored', 'connected'] as const;
type Step = (typeof STEPS)[number];
const KEY = 'click-setup';
function readSteps(): Set<Step> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as Step[]);
  } catch {
    return new Set();
  }
}
function useSetup(): [Set<Step>, (s: Step) => void] {
  const [steps, setSteps] = useState<Set<Step>>(() => new Set([...readSteps(), 'signed-in']));
  const mark = (s: Step): void =>
    setSteps((prev) => {
      if (prev.has(s)) return prev;
      const next = new Set(prev).add(s);
      try {
        localStorage.setItem(KEY, JSON.stringify([...next]));
      } catch {
        // storage may be blocked; progress then lasts for this visit
      }
      return next;
    });
  return [steps, mark];
}

// ---------------------------------------------------------------- data shared by the pages

const DataCtx = createContext<{ data: DashboardData | null; error: string | null }>({ data: null, error: null });

function DataProvider({ children }: { children: ReactNode }) {
  const [s, setS] = useState<{ data: DashboardData | null; error: string | null }>({ data: null, error: null });
  useEffect(() => {
    loadData('/')
      .then((data) => setS({ data, error: null }))
      .catch((e: unknown) => setS({ data: null, error: e instanceof Error ? e.message : String(e) }));
  }, []);
  return <DataCtx.Provider value={s}>{children}</DataCtx.Provider>;
}

/** Mounts one of the original (framework-free) pages inside React, and turns its "#/x" links into app routes. */
function Legacy({ path }: { path: string }) {
  const { data, error } = useContext(DataCtx);
  const host = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    const el = host.current;
    if (!el || !data) return;
    let live = true;
    const route = ROUTES.find((r) => r.path === path) ?? ROUTES[0]!;
    route
      .load()
      .then((page: Page) => page({ data }))
      .then((node) => {
        if (!live) return;
        el.replaceChildren(node);
      })
      .catch((e: unknown) => live && setFailed(e instanceof Error ? e.message : String(e)));
    const onClick = (ev: MouseEvent): void => {
      const a = (ev.target as HTMLElement).closest('a');
      const href = a?.getAttribute('href');
      if (href?.startsWith('#/')) {
        ev.preventDefault();
        const to = href.slice(1);
        navigate(to === '/' ? '/app' : `/app${to}`);
      }
    };
    el.addEventListener('click', onClick);
    return () => {
      live = false;
      el.removeEventListener('click', onClick);
    };
  }, [data, path, navigate]);
  if (error || failed) return <div className="callout">Could not load this page: {error ?? failed}</div>;
  return (
    <div className="legacy" ref={host}>
      {!data && <div className="app-loading">Loading data…</div>}
    </div>
  );
}

// ---------------------------------------------------------------- pages that are native to the app

function Connect({ onDone }: { onDone: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (t: string): void => {
    void navigator.clipboard?.writeText(t).then(() => {
      setCopied(t);
      setTimeout(() => setCopied(null), 1400);
    });
  };
  const cmds = ['npx click init', 'click index', 'click status'];
  return (
    <div className="empty">
      <IsoStack />
      <h1>Connect your first agent</h1>
      <p>Install Click in a Vue repository. It indexes the code into HydraDB and wires itself into Claude Code (a prompt hook) or any MCP client.</p>
      <div className="empty-actions">
        <button type="button" className="btn primary" onClick={() => copy(cmds[0]!)}>
          <Icon name="plus" /> {copied === cmds[0] ? 'Copied' : 'Install Click'}
        </button>
        <a className="btn" href="https://github.com/ishaansatapathy/Click#readme" target="_blank" rel="noreferrer">
          <Icon name="doc" /> Docs
        </a>
      </div>
      <ol className="steps">
        {cmds.map((c, i) => (
          <li key={c}>
            <span className="steps-n">{i + 1}</span>
            <code>{c}</code>
            <button type="button" className="btn ghost small" onClick={() => copy(c)}>
              {copied === c ? 'Copied' : 'Copy'}
            </button>
          </li>
        ))}
      </ol>
      <p className="empty-fine">
        The daemon runs on your machine (127.0.0.1) and never sends your code here. When `click status` shows the graph, mark this step done.
      </p>
      <button type="button" className="btn ghost" onClick={onDone}>
        <Icon name="check" /> I have connected an agent
      </button>
    </div>
  );
}

function Settings() {
  const { user } = useAuth();
  return (
    <div className="settings">
      <h1>Settings</h1>
      <div className="set-card">
        <div className="set-row">
          {user?.picture ? <img src={user.picture} alt="" width={44} height={44} referrerPolicy="no-referrer" /> : <span className="avatar big">{(user?.name ?? 'G')[0]}</span>}
          <div>
            <b>{user?.name}</b>
            <div className="muted">{user?.email ?? (user?.guest ? 'Guest session' : '')}</div>
          </div>
        </div>
        <a className="btn" href="/api/auth/logout">
          <Icon name="out" /> Sign out
        </a>
      </div>
      <div className="set-card">
        <b>Session</b>
        <p className="muted">A signed, httpOnly cookie that lasts 7 days. Click stores no account data on a server.</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- shell

const NAV: { group: string; items: { to: string; label: string; icon: IconName; legacy?: string }[] }[] = [
  { group: 'a', items: [{ to: '/app', label: 'Overview', icon: 'home', legacy: '/' }, { to: '/app/connect', label: 'Connect agent', icon: 'plug' }] },
  { group: 'b', items: [{ to: '/app/benchmark', label: 'Benchmark', icon: 'chart', legacy: '/benchmark' }, { to: '/app/learning', label: 'Learning', icon: 'learn', legacy: '/learning' }, { to: '/app/examples', label: 'Examples', icon: 'list', legacy: '/examples' }] },
  { group: 'c', items: [{ to: '/app/try', label: 'Playground', icon: 'play', legacy: '/try' }, { to: '/app/graph', label: 'Graph & impact', icon: 'graph', legacy: '/graph' }] },
  { group: 'd', items: [{ to: '/app/how', label: 'How it works', icon: 'book', legacy: '/how' }, { to: '/app/gtm', label: 'Go to market', icon: 'flag', legacy: '/gtm' }] },
];

export default function Shell() {
  const { user } = useAuth();
  const loc = useLocation();
  const navigate = useNavigate();
  const [steps, mark] = useSetup();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (loc.pathname.startsWith('/app/benchmark')) mark('explored');
    setOpen(false);
  }, [loc.pathname]); // only the path matters here

  const done = STEPS.filter((s) => steps.has(s)).length;
  const next = !steps.has('explored') ? { text: 'Explore the benchmark to see what Click finds', to: '/app/benchmark' } : !steps.has('connected') ? { text: 'Connect your agent to see your first call', to: '/app/connect' } : null;
  const all = NAV.flatMap((g) => g.items);
  const hits = q ? all.filter((i) => i.label.toLowerCase().includes(q.toLowerCase())) : [];

  return (
    <DataProvider>
      <div className={`app ${open ? 'nav-open' : ''}`}>
        <aside className="side">
          <div className="side-top">
            <Link to="/app" className="ws">
              <span className="ws-mark">
                <PixelLogo size={12} color="#050505" />
              </span>
              <span className="ws-name">click</span>
              <Icon name="chev" size={13} />
            </Link>
            <button type="button" className="icon-btn only-mobile" onClick={() => setOpen(false)} aria-label="Close menu">
              <Icon name="close" />
            </button>
            <button type="button" className="icon-btn" onClick={() => setSearching((s) => !s)} aria-label="Search pages">
              <Icon name="search" />
            </button>
          </div>
          {searching && (
            <div className="side-search">
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Jump to…" aria-label="Jump to a page" onKeyDown={(e) => e.key === 'Enter' && hits[0] && (navigate(hits[0].to), setSearching(false), setQ(''))} />
              {hits.map((h) => (
                <button key={h.to} type="button" onClick={() => (navigate(h.to), setSearching(false), setQ(''))}>
                  <Icon name={h.icon} /> {h.label}
                </button>
              ))}
            </div>
          )}

          {next && (
            <Link to={next.to} className="setup">
              <div className="setup-head">
                <span>Finish setup</span>
                <span className="muted">
                  {done} of {STEPS.length}
                </span>
              </div>
              <div className="setup-bar">
                <i style={{ width: `${(done / STEPS.length) * 100}%` }} />
              </div>
              <div className="setup-next">
                <span>{next.text}</span>
                <Icon name="arrow" />
              </div>
            </Link>
          )}

          <nav className="side-nav" aria-label="App">
            {NAV.map((g) => (
              <div key={g.group} className="side-group">
                {g.items.map((it) => (
                  <NavLink key={it.to} to={it.to} end={it.to === '/app'} className={({ isActive }) => `side-link ${isActive ? 'on' : ''}`}>
                    <Icon name={it.icon} /> {it.label}
                  </NavLink>
                ))}
              </div>
            ))}
            <div className="side-group">
              <NavLink to="/app/settings" className={({ isActive }) => `side-link ${isActive ? 'on' : ''}`}>
                <Icon name="gear" /> Settings
              </NavLink>
            </div>
          </nav>

          <div className="side-user">
            {user?.picture ? <img src={user.picture} alt="" width={26} height={26} referrerPolicy="no-referrer" /> : <span className="avatar">{(user?.name ?? 'G')[0]}</span>}
            <span className="side-user-name">{user?.name}</span>
            <a href="/api/auth/logout" className="icon-btn" aria-label="Sign out" title="Sign out">
              <Icon name="out" />
            </a>
          </div>
        </aside>

        <div className="main">
          <header className="main-bar only-mobile">
            <button type="button" className="icon-btn" onClick={() => setOpen(true)} aria-label="Open menu">
              <Icon name="menu" />
            </button>
            <span className="ws-name">click</span>
          </header>
          <div className="main-inner">
            <Routes>
              <Route index element={<Legacy path="/" />} />
              {all
                .filter((i) => i.legacy && i.to !== '/app')
                .map((i) => (
                  <Route key={i.to} path={i.to.replace('/app/', '')} element={<Legacy path={i.legacy!} />} />
                ))}
              <Route path="connect" element={<Connect onDone={() => (mark('connected'), navigate('/app'))} />} />
              <Route path="settings" element={<Settings />} />
              <Route path="*" element={<Legacy path="/" />} />
            </Routes>
          </div>
        </div>
        <div className="scrim" onClick={() => setOpen(false)} aria-hidden />
      </div>
    </DataProvider>
  );
}
