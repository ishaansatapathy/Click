import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const shim = fileURLToPath(new URL('./src/shims/node.ts', import.meta.url));

// A static site with no backend. `base: './'` makes every asset URL relative, so it works from a GitHub Pages project path
// (https://<user>.github.io/Click/) as well as from a local `vite preview`. Routing uses the URL hash for the same reason.
// The in-browser demo reuses Click's own retrieval code; the few Node built-ins it imports but never runs point at a shim.
export default defineConfig({
  base: './',
  resolve: { alias: { 'node:child_process': shim, 'node:fs/promises': shim, 'node:path': shim, 'node:crypto': shim } },
  build: { outDir: 'dist', target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 2_500 },
});
