// The sign-in screen, laid out like the Corsair app's (the story on the left, the card on the right), in Click's colours.

import { type CSSProperties } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { signInUrl, useAuth } from '../auth.js';
import { PixelLogo } from '../landing/art.js';
import { Scramble } from '../motion.js';
import './signin.css';

const KNOTS = [
  { x: 100, y: 64, label: 'Seeds', above: true },
  { x: 220, y: 156, label: 'HydraDB', above: false },
  { x: 340, y: 72, label: 'PageRank', above: true },
  { x: 460, y: 150, label: 'Pack', above: false },
  { x: 580, y: 88, label: 'Agent', above: true },
];
const LINE = 'M -40 112 C 20 112, 50 64, 100 64 S 170 156, 220 156 S 290 72, 340 72 S 410 150, 460 150 S 530 88, 580 88 S 650 112, 720 112';

function GraphLine() {
  return (
    <svg className="si-line" viewBox="0 0 660 220" aria-hidden>
      <path className="si-line-glow" d={LINE} pathLength={1} />
      <path className="si-line-path" d={LINE} pathLength={1} />
      {KNOTS.map((k, i) => (
        <g key={k.label} className="si-knot" style={{ '--i': i } as CSSProperties}>
          <rect x={k.x - 9} y={k.y - 9} width={18} height={18} className="si-knot-ring" />
          <rect x={k.x - 3.5} y={k.y - 3.5} width={7} height={7} className="si-knot-dot" />
          <text x={k.x} y={k.above ? k.y - 22 : k.y + 32} textAnchor="middle">
            {k.label.toUpperCase()}
          </text>
        </g>
      ))}
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" aria-hidden>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}

export default function SignIn() {
  const [params] = useSearchParams();
  const { loading, user, providers, offline } = useAuth();
  const next = params.get('next')?.startsWith('/app') ? params.get('next')! : '/app';
  const error = params.get('error');
  if (!loading && user) return <Navigate to={next} replace />;

  return (
    <div className="si">
      <div className="si-glow" aria-hidden />
      <header className="si-nav">
        <Link to="/" className="si-brand">
          <PixelLogo size={18} /> CLICK
        </Link>
        <Link to="/" className="si-back">
          ← Back to home
        </Link>
      </header>

      <main className="si-main">
        <section className="si-story" aria-hidden>
          <span className="si-eyebrow">Click · structure-aware context for coding agents</span>
          <h1 className="si-title">
            <span className="si-dim">
              <Scramble text="THE RIGHT CODE," start />
            </span>
            <span>
              <Scramble text="NOT THE WHOLE REPO." start delay={300} />
            </span>
          </h1>
          <p className="si-sub">Sign in to see the benchmark, walk the code graph, and try Click on a real Vue repository in your browser.</p>
          <GraphLine />
        </section>

        <div className="si-card-wrap">
          <div className="si-card">
            <h2>Sign in</h2>
            <p className="si-card-sub">New here? The same button creates your account.</p>
            {error && <p className="si-error">{error}</p>}
            {offline && <p className="si-error">The sign-in service is not reachable from this build. Run the app with `pnpm dev` or deploy it on Vercel.</p>}
            <a className={`si-btn si-google ${providers.google ? '' : 'off'}`} href={signInUrl('google', next)} aria-disabled={!providers.google}>
              <GoogleIcon /> Continue with Google
            </a>
            {!providers.google && !offline && !loading && <p className="si-note">Google sign-in is not configured yet on this deployment.</p>}
            {providers.guest && (
              <>
                <div className="si-or">
                  <span>or</span>
                </div>
                <a className="si-btn si-guest" href={signInUrl('guest', next)}>
                  Continue as guest
                </a>
              </>
            )}
            <p className="si-fine">We only read your name and email from Google. No code, no repo access.</p>
          </div>
          <p className="si-legal">Open source · MIT · self-hosted HydraDB</p>
        </div>
      </main>
    </div>
  );
}
