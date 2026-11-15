// A tiny flag parser for the Lane B commands: `--flag`, `--flag value`, `--flag=value`, positionals, `--` ends flags.

export type FlagKind = 'bool' | 'string' | 'number';

export interface Parsed<S extends Record<string, FlagKind>> {
  flags: { [K in keyof S]?: S[K] extends 'bool' ? boolean : S[K] extends 'number' ? number : string };
  positionals: string[];
  error?: string;
}

export function parseArgs<S extends Record<string, FlagKind>>(argv: readonly string[], spec: S): Parsed<S> {
  const flags: Record<string, boolean | number | string> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith('--') || a.length === 2) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = a.slice(2, eq < 0 ? undefined : eq);
    const kind = Object.hasOwn(spec, name) ? spec[name] : undefined;
    if (!kind) return { flags, positionals, error: `unknown option --${name}` } as Parsed<S>;
    if (kind === 'bool') {
      flags[name] = eq < 0 ? true : !['false', '0', 'no'].includes(a.slice(eq + 1));
      continue;
    }
    const raw = eq >= 0 ? a.slice(eq + 1) : argv[++i];
    if (raw === undefined) return { flags, positionals, error: `--${name} needs a value` } as Parsed<S>;
    if (kind === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { flags, positionals, error: `--${name} needs a number, got "${raw}"` } as Parsed<S>;
      flags[name] = n;
    } else flags[name] = raw;
  }
  return { flags, positionals } as Parsed<S>;
}
