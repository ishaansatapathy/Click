import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './env.js';
import { clickDir } from './paths.js';

// SPEC §17.2: `.click/logs/<proc>-<yyyy-mm-dd>.jsonl`.
// Hard rules (PLAN §4.7): never write to stdout (hooks use it as their protocol channel),
// never throw, and never let a secret reach disk. CLICK_DEBUG=1 mirrors to STDERR only.

export type Level = 'debug' | 'info' | 'warn' | 'error';
const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

type Source = Record<string, string | undefined>;
type Fields = Record<string, unknown>;

export interface LoggerOptions {
  /** Directory for log files. Defaults to `<clickDir>/logs`. */
  dir?: string;
  env?: Source;
  now?: () => Date;
  /** Where the CLICK_DEBUG mirror goes. Defaults to process.stderr. */
  stderr?: (line: string) => void;
}

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}

const isTruthy = (v: string | undefined): boolean => v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';

const MAX_DEPTH = 6;

/** Deep copy with every string passed through redact(); Errors become plain objects. Depth-capped, so cycles are safe. */
function sanitize(v: unknown, env: Source, depth = 0): unknown {
  if (typeof v === 'string') return redact(v, env);
  if (v instanceof Error) {
    return { name: v.name, message: redact(v.message, env), stack: v.stack ? redact(v.stack, env) : undefined };
  }
  if (typeof v === 'bigint') return v.toString();
  if (v === null || typeof v !== 'object') return v;
  if (depth >= MAX_DEPTH) return '[max-depth]';
  if (Array.isArray(v)) return v.map((x) => sanitize(x, env, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sanitize(x, env, depth + 1)]));
}

export function createLogger(proc: string, opts: LoggerOptions = {}, base: Fields = {}): Logger {
  const env = opts.env ?? process.env;
  const dir = opts.dir ?? join(clickDir(undefined, env), 'logs');
  const now = opts.now ?? (() => new Date());
  const debugOn = isTruthy(env.CLICK_DEBUG);
  const minRank = debugOn ? RANK.debug : RANK.info;
  const stderr = opts.stderr ?? ((line: string) => void process.stderr.write(line));
  let dirReady = false;

  function write(level: Level, msg: string, fields?: Fields): void {
    if (RANK[level] < minRank) return;
    try {
      const d = now();
      const line =
        JSON.stringify({
          ...(sanitize({ ...base, ...fields }, env) as Fields),
          ts: d.toISOString(),
          level,
          proc,
          msg: redact(msg, env),
        }) + '\n';
      if (!dirReady) {
        mkdirSync(dir, { recursive: true });
        dirReady = true;
      }
      // Synchronous on purpose: short-lived hook processes must not lose their last line on exit.
      appendFileSync(join(dir, `${proc}-${d.toISOString().slice(0, 10)}.jsonl`), line, 'utf8');
      if (debugOn) stderr(line);
    } catch {
      // Logging must never break the caller.
    }
  }

  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (fields) => createLogger(proc, opts, { ...base, ...fields }),
  };
}
