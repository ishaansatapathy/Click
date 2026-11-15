import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

export interface User {
  sub: string;
  email: string | null;
  name: string;
  picture: string | null;
  guest: boolean;
}
interface AuthState {
  loading: boolean;
  user: User | null;
  providers: { google: boolean; guest: boolean };
  /** The auth API could not be reached (e.g. a static preview without functions). */
  offline: boolean;
}

const Ctx = createContext<AuthState>({ loading: true, user: null, providers: { google: false, guest: false }, offline: false });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [s, setS] = useState<AuthState>({ loading: true, user: null, providers: { google: false, guest: false }, offline: false });
  useEffect(() => {
    let live = true;
    fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) throw new Error(`auth ${r.status}`);
        return (await r.json()) as { user: User | null; providers: AuthState['providers'] };
      })
      .then((b) => live && setS({ loading: false, user: b.user, providers: b.providers, offline: false }))
      .catch(() => live && setS({ loading: false, user: null, providers: { google: false, guest: false }, offline: true }));
    return () => {
      live = false;
    };
  }, []);
  return <Ctx.Provider value={s}>{children}</Ctx.Provider>;
}

export const useAuth = (): AuthState => useContext(Ctx);

export function RequireAuth({ children }: { children: ReactNode }) {
  const { loading, user } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="boot">Loading…</div>;
  if (!user) return <Navigate to={`/sign-in?next=${encodeURIComponent(loc.pathname)}`} replace />;
  return <>{children}</>;
}

export const signInUrl = (provider: 'google' | 'guest', next: string): string => `/api/auth/${provider}?next=${encodeURIComponent(next)}`;
