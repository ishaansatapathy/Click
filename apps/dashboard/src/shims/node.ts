// The core modules the in-browser demo reuses (candidates, config, tokens) import a few Node built-ins for code paths the
// demo never runs (reading a disk, spawning git). vite.config.ts points those imports here. The one thing that does run is
// `createHash`, for cache keys and the config hash: a small non-cryptographic hash is enough there.

const unsupported = (name: string) => () => {
  throw new Error(`${name} is not available in the browser`);
};

export const spawn = unsupported('child_process.spawn');
export const readFile = unsupported('fs.readFile');
export const readdir = unsupported('fs.readdir');
export const stat = unsupported('fs.stat');
export const join = (...parts: string[]): string => parts.join('/').replace(/\/+/g, '/');
export const posix = { join, sep: '/' };

function fnv(text: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function createHash(_algorithm: string) {
  let data = '';
  const api = {
    update(chunk: string | Uint8Array) {
      data += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      return api;
    },
    digest(_encoding?: string): string {
      return [fnv(data, 0x811c9dc5), fnv(data, 0x01000193), fnv(data, 0xdeadbeef), fnv(data, 0x9e3779b1), fnv(data, 0x85ebca6b)].join('');
    },
  };
  return api;
}
