// PROMPTS 051: `has_type` edges: a symbol → each type its signature mentions.
// The signature text is the source of truth (SPEC §5.3 already strips bodies), so a type counts when its
// identifier appears in the signature and it is either imported from a repo file (SymbolRef, resolved by link.ts,
// which keeps the edge only when the target really is a type) or declared in the same file (edge right away).
// Type-only imports are included here, unlike usages.ts, because types are exactly what they bring in.

import type { SymbolRef } from '../contracts.js';
import type { GraphEdge } from '../types.js';
import { edgeKey, symId } from '../util/ids.js';
import type { Resolver } from './resolve.js';
import type { RawImport } from './ts-imports.js';
import type { TsSymbol, TsSymbolKind } from './ts-symbols.js';

const IDENT = /[A-Za-z_$][\w$]*/g;
const TYPE_KINDS = new Set<TsSymbolKind>(['interface', 'type', 'enum', 'class']);

export interface TypeEdgeCtx {
  path: string;
  resolve: Resolver;
  imports: RawImport[];
  symbols: TsSymbol[];
  /** Owner node id for a symbol; defaults to symId(path, name). */
  ownerOf?: (s: TsSymbol) => string;
}

export interface TypeEdgeResult {
  refs: SymbolRef[];
  edges: GraphEdge[];
}

/** Every name this file imports from a repo file (value or type), by local name. */
function importedLocals(imports: RawImport[], resolve: Resolver, path: string): Map<string, { targetPath: string; targetName: string }> {
  const m = new Map<string, { targetPath: string; targetName: string }>();
  for (const imp of imports) {
    if (imp.kind !== 'static') continue;
    const r = resolve(imp.spec, path);
    if (r.kind !== 'local') continue;
    for (const n of imp.names) if (n.imported !== '*') m.set(n.local, { targetPath: r.path, targetName: n.imported });
  }
  return m;
}

export function extractTypeEdges(ctx: TypeEdgeCtx): TypeEdgeResult {
  const imported = importedLocals(ctx.imports, ctx.resolve, ctx.path);
  const localTypes = new Set(ctx.symbols.filter((s) => TYPE_KINDS.has(s.kind)).map((s) => s.name));
  const refs = new Map<string, SymbolRef>();
  const edges = new Map<string, GraphEdge>();

  for (const s of ctx.symbols) {
    const from = ctx.ownerOf ? ctx.ownerOf(s) : symId(ctx.path, s.name);
    const own = s.name.split('.').pop();
    const seen = new Set<string>();
    for (const m of s.signature.matchAll(IDENT)) {
      const id = m[0];
      if (seen.has(id) || id === own) continue;
      seen.add(id);
      const imp = imported.get(id);
      if (imp) {
        const key = `${from}|${imp.targetPath}#${imp.targetName}`;
        if (!refs.has(key)) refs.set(key, { from, kind: 'has_type', targetPath: imp.targetPath, targetName: imp.targetName, meta: { source: 'ast' } });
      } else if (localTypes.has(id)) {
        const to = symId(ctx.path, id);
        if (to === from) continue;
        const key = edgeKey(from, 'has_type', to);
        if (!edges.has(key)) edges.set(key, { key, from, to, kind: 'has_type', meta: { source: 'ast' } });
      }
    }
  }
  return { refs: [...refs.values()], edges: [...edges.values()] };
}
