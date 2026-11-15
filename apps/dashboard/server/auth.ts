// Google sign-in for the dashboard, the same flow as the Corsair app (state nonce cookie -> Google -> callback checks the
// nonce -> session cookie -> redirect), without a database: the session is a signed JWT in an httpOnly cookie.
// Runs as Vercel functions (api/auth/*.ts) and, in `vite dev`, through the dev middleware in vite.config.ts.
//
// Environment:
//   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET   from Google Cloud console (OAuth client, type "Web application")
//   SESSION_SECRET                                        32+ random characters; signs the session cookie
//   APP_URL (optional)                                    public origin, e.g. https://click.vercel.app (else the request's)
//   ALLOW_GUEST (optional)                                "0" turns off "Continue as guest"

import { SignJWT, jwtVerify } from 'jose';

export interface SessionUser {
  sub: string;
  email: string | null;
  name: string;
  picture: string | null;
  guest: boolean;
}

const SESSION_COOKIE = 'click_session';
const STATE_COOKIE = 'click_oauth_state';
const SESSION_DAYS = 7;
const enc = new TextEncoder();

const env = (k: string): string | undefined => process.env[k]?.trim() || undefined;
const isProd = (): boolean => process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

function secret(): Uint8Array {
  const s = env('SESSION_SECRET') ?? (isProd() ? undefined : 'click-dev-only-secret-change-me-0123456789');
  if (!s || s.length < 32) throw new Error('SESSION_SECRET must be set (32+ characters)');
  return enc.encode(s);
}

export function googleConfigured(): boolean {
  return !!env('GOOGLE_OAUTH_CLIENT_ID') && !!env('GOOGLE_OAUTH_CLIENT_SECRET');
}
export const guestAllowed = (): boolean => env('ALLOW_GUEST') !== '0';

function origin(req: Request): string {
  return env('APP_URL')?.replace(/\/$/, '') ?? new URL(req.url).origin;
}

/** Only same-site paths, so the redirect after sign-in can never send the user to another site. */
export function safePath(p: string | null | undefined, fallback = '/app'): string {
  if (!p || !p.startsWith('/') || p.startsWith('//') || p.startsWith('/\\')) return fallback;
  return p;
}

function cookie(name: string, value: string, maxAgeSec: number): string {
  return [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`, ...(isProd() ? ['Secure'] : [])].join('; ');
}

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.get('cookie') ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status: 302, headers });
}

const signInError = (req: Request, message: string): Response => redirect(`${origin(req)}/sign-in?error=${encodeURIComponent(message)}`, [cookie(STATE_COOKIE, '', 0)]);

async function sessionCookie(user: SessionUser): Promise<string> {
  const jwt = await new SignJWT({ ...user })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.sub)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(secret());
  return cookie(SESSION_COOKIE, jwt, SESSION_DAYS * 86_400);
}

export async function readSession(req: Request): Promise<SessionUser | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'] });
    return { sub: String(payload.sub), email: (payload.email as string) ?? null, name: String(payload.name ?? 'User'), picture: (payload.picture as string) ?? null, guest: payload.guest === true };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ handlers

/** GET /api/auth/google?next=/app → Google's consent screen. */
export async function startGoogle(req: Request): Promise<Response> {
  if (!googleConfigured()) return signInError(req, 'Google sign-in is not configured yet. Add GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.');
  const next = safePath(new URL(req.url).searchParams.get('next'));
  const nonce = crypto.randomUUID();
  const state = Buffer.from(JSON.stringify({ nonce, next }), 'utf8').toString('base64url');
  const params = new URLSearchParams({
    client_id: env('GOOGLE_OAUTH_CLIENT_ID')!,
    redirect_uri: `${origin(req)}/api/auth/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
    access_type: 'online',
    state,
  });
  return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, [cookie(STATE_COOKIE, nonce, 600)]);
}

/** GET /api/auth/callback?code=…&state=… → session cookie → back into the app. */
export async function googleCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const oauthError = url.searchParams.get('error');
  if (oauthError) return signInError(req, oauthError === 'access_denied' ? 'Sign-in was cancelled.' : oauthError.replace(/_/g, ' '));
  const code = url.searchParams.get('code');
  if (!code) return signInError(req, 'Start sign-in from the sign-in page.');

  let state: { nonce?: string; next?: string } = {};
  try {
    state = JSON.parse(Buffer.from(url.searchParams.get('state') ?? '', 'base64url').toString('utf8')) as typeof state;
  } catch {
    // handled below
  }
  const expected = readCookie(req, STATE_COOKIE);
  if (!state.nonce || !expected || state.nonce !== expected) return signInError(req, 'Your sign-in session expired. Please try again.');

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env('GOOGLE_OAUTH_CLIENT_ID')!,
        client_secret: env('GOOGLE_OAUTH_CLIENT_SECRET')!,
        redirect_uri: `${origin(req)}/api/auth/callback`,
        grant_type: 'authorization_code',
      }),
    });
    const body = (await res.json()) as { id_token?: string; error_description?: string };
    if (!res.ok || !body.id_token) throw new Error(body.error_description ?? 'Google did not return an identity token');
    // The id_token came straight from Google's token endpoint over TLS, so its claims can be read without re-checking the
    // signature (OpenID Connect Core §3.1.3.7); audience and issuer are still checked.
    const claims = JSON.parse(Buffer.from(body.id_token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub: string; email?: string; name?: string; picture?: string; aud: string; iss: string };
    if (claims.aud !== env('GOOGLE_OAUTH_CLIENT_ID') || !/^(https:\/\/)?accounts\.google\.com$/.test(claims.iss)) throw new Error('Unexpected identity token');
    const user: SessionUser = { sub: `google:${claims.sub}`, email: claims.email ?? null, name: claims.name ?? claims.email ?? 'User', picture: claims.picture ?? null, guest: false };
    return redirect(`${origin(req)}${safePath(state.next)}`, [await sessionCookie(user), cookie(STATE_COOKIE, '', 0)]);
  } catch (e) {
    return signInError(req, e instanceof Error ? e.message : 'Google sign-in failed. Please try again.');
  }
}

/** GET /api/auth/guest → a guest session, for judges and demos (turn off with ALLOW_GUEST=0). */
export async function guest(req: Request): Promise<Response> {
  if (!guestAllowed()) return signInError(req, 'Guest access is turned off.');
  const next = safePath(new URL(req.url).searchParams.get('next'));
  return redirect(`${origin(req)}${next}`, [await sessionCookie({ sub: `guest:${crypto.randomUUID()}`, email: null, name: 'Guest', picture: null, guest: true })]);
}

/** GET /api/auth/me → { user, providers }. */
export async function me(req: Request): Promise<Response> {
  const user = await readSession(req);
  return Response.json({ user, providers: { google: googleConfigured(), guest: guestAllowed() } }, { headers: { 'cache-control': 'no-store' } });
}

/** GET /api/auth/logout → clears the session. */
export function logout(req: Request): Response {
  return redirect(`${origin(req)}/`, [cookie(SESSION_COOKIE, '', 0)]);
}
