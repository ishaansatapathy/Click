import { z } from 'zod';

// SPEC §17.1. Every key is optional; features turn off when a key is missing.
const optional = z.string().optional().transform((v) => (v === undefined || v === '' ? undefined : v));

export const envSchema = z.object({
  HYDRA_DB_API_KEY: optional,
  HYDRA_DB_URL: optional,
  VOYAGE_API_KEY: optional,
  TYPESAFE_API_KEY: optional,
  ANTHROPIC_API_KEY: optional,
  OPENAI_API_KEY: optional,
  CLICK_DEBUG: optional,
  CLICK_LIVE: optional,
  CLICK_CACHE_ONLY: optional,
  CLICK_HOME: optional,
});

export type Env = z.infer<typeof envSchema>;
export type EnvName = keyof Env;
type Source = Record<string, string | undefined>;

/** Names whose values must never appear in logs, output or commits. */
export const SECRET_NAMES = [
  'HYDRA_DB_API_KEY',
  'VOYAGE_API_KEY',
  'TYPESAFE_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
] as const satisfies readonly EnvName[];

// Too-short values would turn redact() into noise (e.g. a key set to "1").
const MIN_SECRET_LENGTH = 8;

export function loadEnv(source: Source = process.env): Env {
  return envSchema.parse(source);
}

export function hasKey(name: EnvName, source: Source = process.env): boolean {
  return loadEnv(source)[name] !== undefined;
}

/** Replace every loaded secret value found in `text` with `***`. */
export function redact(text: string, source: Source = process.env): string {
  const env = loadEnv(source);
  const secrets = SECRET_NAMES.map((n) => env[n])
    .filter((v): v is string => v !== undefined && v.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length); // longest first so a prefix secret can't leave a tail
  let out = text;
  for (const s of secrets) out = out.split(s).join('***');
  return out;
}
