import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite';

const shim = fileURLToPath(new URL('./src/shims/node.ts', import.meta.url));

/** In `vite dev`, serve api/**.ts the way Vercel does in production (Web Request -> Response handlers). */
function devApi(): Plugin {
  return {
    name: 'click-dev-api',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const m = /^\/api\/([a-z0-9/_-]+)$/i.exec(url.pathname);
        if (!m) return next();
        void (async () => {
          try {
            const mod = (await server.ssrLoadModule(`/api/${m[1]}.ts`)) as Record<string, (r: Request) => Response | Promise<Response>>;
            const handler = mod[req.method ?? 'GET'];
            if (!handler) {
              res.statusCode = 405;
              res.end();
              return;
            }
            const headers = new Headers();
            for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
            const out = await handler(new Request(url, { method: req.method, headers }));
            res.statusCode = out.status;
            out.headers.forEach((v, k) => {
              if (k !== 'set-cookie') res.setHeader(k, v);
            });
            const cookies = out.headers.getSetCookie();
            if (cookies.length) res.setHeader('set-cookie', cookies);
            res.end(Buffer.from(await out.arrayBuffer()));
          } catch (e) {
            res.statusCode = 500;
            res.end(e instanceof Error ? e.message : String(e));
          }
        })();
      });
    },
  };
}

// The in-browser demo reuses Click's own retrieval code; the few Node built-ins it imports but never runs point at a shim.
export default defineConfig(({ mode }) => {
  // server-side variables (GOOGLE_OAUTH_*, SESSION_SECRET) for the dev API; only VITE_* ever reach the browser bundle
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''));
  return {
    plugins: [react(), devApi()],
    resolve: { alias: { 'node:child_process': shim, 'node:fs/promises': shim, 'node:path': shim, 'node:crypto': shim } },
    build: { outDir: 'dist', target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 6_000 },
  };
});
