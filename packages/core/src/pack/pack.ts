// PROMPTS 092 / SPEC §9: turn ranked candidates into the text the agent receives, within a token budget that is never exceeded.
//
//   1. frame (header + intro + footer) is reserved first; the prefix (conventions ≤ 8%, skeleton ≤ 12% of the budget) next;
//      whatever is left, including unused prefix budget, goes to task items.
//   2. candidates by final score (ties by node id): already sent this session → ref; body if it fits; else signature; else skip.
//      Bodies come from the working tree (graph/bodies.ts); a stale or unreadable file falls back to the signature.
//   3. ≥ 2 bodies from one small file become the whole file (when that still fits).
//   4. optional neighbour signatures: for each body, its strongest 1-hop neighbours.
//   5. guarantee: the final text is counted; blocks are dropped from the end until it fits. Same input → same text.
// Item sizes are estimated from the index-time token counts (same tokenizer as the final count), then the real count decides.

import type { BodyResult } from '../graph/bodies.js';
import type { VariantConfig } from '../config.js';
import type { Candidate, ChunkRecord, GraphNode, PackedItem } from '../types.js';
import { countTokens } from '../util/tokens.js';

export interface BodySource {
  readMany(nodes: readonly Pick<GraphNode, 'id' | 'path' | 'range' | 'fileHash'>[]): Promise<Map<string, BodyResult>>;
}

export type ChunkMeta = Pick<ChunkRecord, 'id' | 'nodeId' | 'path' | 'range'>;

export interface Neighbour {
  nodeId: string;
  weight: number;
}

export interface PackOptions {
  budget: number;
  pack: VariantConfig['pack'];
  header: { graph: string; ms: number; degraded: readonly string[] };
  nodes: ReadonlyMap<string, GraphNode>;
  /** Chunk units (V1): candidate ids that are chunk ids resolve through this map. */
  chunks?: ReadonlyMap<string, ChunkMeta>;
  bodies: BodySource;
  /** Node ids already sent in this session (used when `pack.sessionDedupe`). */
  sent?: ReadonlySet<string>;
  /** 1-hop neighbours of a node with their effective weight (used when `pack.neighbourSignatures`). */
  neighbours?: (nodeId: string) => readonly Neighbour[];
  prefix?: { conventions: readonly string[]; skeleton: readonly string[] };
}

export interface PackResult {
  text: string;
  tokens: number;
  items: PackedItem[];
  /** Extra degraded flags found while packing (`stale-body`). */
  degraded: string[];
}

export const INTRO = 'Context selected by Click for this task. Bodies are the current code on disk. Prefer these over searching the repo.';
const FOOTER = '</click_context>';
const SECTIONS = [
  ['conventions', 'Conventions'],
  ['skeleton', 'Skeleton'],
  ['code', 'Code'],
  ['signatures', 'Related signatures'],
  ['sent', 'Already sent this session'],
] as const;
type Section = (typeof SECTIONS)[number][0];

const CONVENTIONS_SHARE = 0.08;
const SKELETON_SHARE = 0.12;
const NEIGHBOURS_PER_BODY = 3;
const BLOCK_OVERHEAD = 2; // separators between blocks
const SECTION_OVERHEAD = 6; // "\n\n## Title\n"

interface Block {
  section: Section;
  text: string;
  item?: PackedItem;
}

interface Unit {
  node: Pick<GraphNode, 'id' | 'kind' | 'path' | 'name' | 'range' | 'fileHash' | 'tokens' | 'sigTokens'> & { signature?: string | undefined };
  cand: Candidate;
  /** For chunk units the tokens are counted from the text, not taken from the index. */
  chunk: boolean;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const LANG: Record<string, string> = { vue: 'vue', ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js', json: 'json', css: 'css', scss: 'scss', md: 'md' };

function fence(text: string, path: string | null): { open: string; close: string } {
  const ext = path?.slice(path.lastIndexOf('.') + 1).toLowerCase() ?? '';
  let ticks = 3;
  for (const m of text.matchAll(/`{3,}/g)) ticks = Math.max(ticks, m[0].length + 1); // a body that contains ``` gets a longer fence
  const f = '`'.repeat(ticks);
  return { open: `${f}${LANG[ext] ?? ''}`, close: f };
}

const range = (r?: { startLine: number; endLine: number }): string => (r ? ` L${r.startLine}-${r.endLine}` : '');
const reasonOf = (c: Candidate): string => c.reasons[0] ?? 'candidate';
const sigLine = (n: Unit['node']): string => `- ${n.path ?? n.name}${n.range ? ` L${n.range.startLine}` : ''}: ${(n.signature ?? n.name).replace(/\s+/g, ' ').trim()}`;
const refLine = (n: Unit['node']): string => `- ${n.path ?? n.kind}#${n.name}`;

function codeBlock(heading: string, body: string, path: string | null): string {
  const f = fence(body, path);
  return `### ${heading}\n${f.open}\n${body}\n${f.close}`;
}

function header(o: PackOptions, tokens: number, items: number): string {
  return `<click_context version="1" tokens="${tokens}" budget="${o.budget}" items="${items}" graph="${o.header.graph.slice(0, 7)}" ms="${Math.round(o.header.ms)}" degraded="${o.header.degraded.join(',')}">`;
}

function render(o: PackOptions, blocks: readonly Block[], tokens: number): { header: string; rest: string } {
  const parts: string[] = [];
  for (const [section, title] of SECTIONS) {
    const bs = blocks.filter((b) => b.section === section);
    if (bs.length) parts.push(`## ${title}\n${bs.map((b) => b.text).join(section === 'code' ? '\n\n' : '\n')}`);
  }
  const body = parts.length ? `${INTRO}\n\n${parts.join('\n\n')}\n${FOOTER}` : `${INTRO}\n${FOOTER}`;
  return { header: header(o, tokens, blocks.filter((b) => b.item).length), rest: body };
}

export async function pack(candidates: readonly Candidate[], o: PackOptions): Promise<PackResult> {
  const degraded: string[] = [];
  const empty = (): PackResult => ({ text: '', tokens: 0, items: [], degraded });

  const frameTokens = countTokens(render(o, [], 99_999).header) + countTokens(INTRO) + countTokens(FOOTER) + 2;
  if (frameTokens > o.budget) return empty();

  const blocks: Block[] = [];
  const opened = new Set<Section>();
  let remaining = o.budget - Math.max(frameTokens, 60);
  const add = (b: Block, cost: number): void => {
    blocks.push(b);
    remaining -= cost + BLOCK_OVERHEAD + (opened.has(b.section) ? 0 : SECTION_OVERHEAD);
    opened.add(b.section);
  };

  // ---- prefix: conventions ≤ 8%, skeleton ≤ 12% of the budget; unused budget flows to task items
  if (o.pack.prefix && o.prefix) {
    for (const [section, lines, share] of [
      ['conventions', o.prefix.conventions, CONVENTIONS_SHARE],
      ['skeleton', o.prefix.skeleton, SKELETON_SHARE],
    ] as const) {
      let used = 0;
      const cap = Math.floor(o.budget * share);
      for (const line of lines) {
        const cost = countTokens(line) + 1;
        if (used + cost > cap || cost + (opened.has(section) ? 0 : SECTION_OVERHEAD) > remaining) break;
        used += cost;
        add({ section, text: line }, cost);
      }
    }
  }

  // ---- units, best first
  const units: Unit[] = [];
  const seenUnit = new Set<string>();
  for (const cand of [...candidates].sort((a, b) => b.score - a.score || cmp(a.nodeId, b.nodeId))) {
    if (seenUnit.has(cand.nodeId)) continue;
    seenUnit.add(cand.nodeId);
    const node = o.nodes.get(cand.nodeId);
    if (node) {
      units.push({ node, cand, chunk: false });
      continue;
    }
    const ch = o.chunks?.get(cand.nodeId);
    const parent = ch && o.nodes.get(ch.nodeId);
    if (ch && parent) {
      const symbol = parent.name;
      units.push({ node: { id: ch.id, kind: 'chunk', path: ch.path, name: symbol, range: ch.range, fileHash: parent.fileHash, tokens: 0, sigTokens: 0, signature: parent.signature }, cand, chunk: true });
    }
  }

  const fresh = units.filter((u) => !(o.pack.sessionDedupe && o.sent?.has(u.node.id)));
  const reads = await o.bodies.readMany(fresh.filter((u) => u.chunk || u.node.tokens <= o.pack.maxBodyTokens).map((u) => u.node));

  // ---- selection
  interface Chosen {
    unit: Unit;
    text: string;
    cost: number;
  }
  const bodies: Chosen[] = [];
  const signatures: Block[] = [];
  const refs: Block[] = [];
  const chosenIds = new Set<string>();
  const sigCost = new Map<string, number>();
  let staleSeen = false;

  const blockCost = (b: Block, cost: number): number => cost + BLOCK_OVERHEAD + (opened.has(b.section) ? 0 : SECTION_OVERHEAD);

  for (const u of units) {
    const { node, cand } = u;
    if (o.pack.sessionDedupe && o.sent?.has(node.id)) {
      const text = refLine(node);
      const b: Block = { section: 'sent', text, item: { nodeId: node.id, path: node.path, name: node.name, mode: 'ref', tokens: countTokens(text) + 1, ...(node.range ? { range: node.range } : {}) } };
      const c = blockCost(b, b.item!.tokens);
      if (c <= remaining) {
        refs.push(b);
        add(b, b.item!.tokens);
        chosenIds.add(node.id);
      }
      continue;
    }

    const read = reads.get(node.id);
    if (read && !read.ok && read.reason === 'stale') staleSeen = true;
    if (read?.ok) {
      const tokens = u.chunk ? countTokens(read.text) : node.tokens;
      const mode = node.kind === 'file' ? 'file' : 'body';
      const heading = `${node.path ?? node.name}${range(node.range)} · ${node.kind === 'chunk' ? 'chunk of' : node.kind} ${node.name} · ${reasonOf(cand)}`;
      const text = codeBlock(heading, read.text, node.path);
      const cost = countTokens(codeBlock(heading, '', node.path)) + tokens;
      if (tokens <= o.pack.maxBodyTokens && blockCost({ section: 'code', text }, cost) <= remaining) {
        const b: Block = { section: 'code', text, item: { nodeId: node.id, path: node.path, name: node.name, mode, tokens: cost, ...(node.range ? { range: node.range } : {}) } };
        add(b, cost);
        bodies.push({ unit: u, text: read.text, cost });
        chosenIds.add(node.id);
        continue;
      }
    }

    const text = sigLine(node);
    const cost = countTokens(text) + 1;
    sigCost.set(node.id, cost);
    const b: Block = { section: 'signatures', text, item: { nodeId: node.id, path: node.path, name: node.name, mode: 'signature', tokens: cost, ...(node.range ? { range: node.range } : {}) } };
    if (blockCost(b, cost) <= remaining) {
      signatures.push(b);
      add(b, cost);
      chosenIds.add(node.id);
    }
  }
  if (staleSeen) degraded.push('stale-body');

  // ---- small-file merge: ≥ 2 bodies from one small file → the whole file
  const byPath = new Map<string, Chosen[]>();
  for (const c of bodies) if (c.unit.node.path && c.unit.node.kind !== 'file') (byPath.get(c.unit.node.path) ?? byPath.set(c.unit.node.path, []).get(c.unit.node.path)!).push(c);
  for (const [path, group] of [...byPath].sort((a, b) => cmp(a[0], b[0]))) {
    if (group.length < 2) continue;
    const fileNode = o.nodes.get(`file:${path}`);
    if (!fileNode || fileNode.tokens > o.pack.smallFileTokens || chosenIds.has(fileNode.id)) continue;
    const read = (await o.bodies.readMany([fileNode])).get(fileNode.id);
    if (!read?.ok) continue;
    const first = group[0]!;
    const heading = `${path}${range(fileNode.range)} · file ${fileNode.name} · ${reasonOf(first.unit.cand)}`;
    const text = codeBlock(heading, read.text, path);
    const cost = countTokens(codeBlock(heading, '', path)) + fileNode.tokens;
    const freed = group.reduce((s, g) => s + g.cost + BLOCK_OVERHEAD, 0);
    if (cost + BLOCK_OVERHEAD - freed > remaining) continue; // would not fit: keep the separate bodies
    const at = blocks.findIndex((b) => b.item?.nodeId === first.unit.node.id);
    const gone = new Set(group.map((g) => g.unit.node.id));
    const merged: Block = { section: 'code', text, item: { nodeId: fileNode.id, path, name: fileNode.name, mode: 'file', tokens: cost, ...(fileNode.range ? { range: fileNode.range } : {}) } };
    blocks.splice(at, 1, merged);
    for (let i = blocks.length - 1; i >= 0; i--) if (i !== at && blocks[i]!.item && gone.has(blocks[i]!.item!.nodeId)) blocks.splice(i, 1);
    remaining -= cost + BLOCK_OVERHEAD - freed;
    for (const g of group) {
      chosenIds.delete(g.unit.node.id);
      g.cost = 0;
    }
    chosenIds.add(fileNode.id);
    // the merged members still count as bodies for neighbour signatures
  }

  // ---- neighbour signatures: strongest 1-hop neighbours of each body, in body order
  if (o.pack.neighbourSignatures && o.neighbours) {
    for (const { unit } of bodies) {
      const ns = [...o.neighbours(unit.node.id)].sort((a, b) => b.weight - a.weight || cmp(a.nodeId, b.nodeId));
      let added = 0;
      for (const nb of ns) {
        if (added >= NEIGHBOURS_PER_BODY) break;
        const n = o.nodes.get(nb.nodeId);
        if (!n || !n.signature || chosenIds.has(n.id) || n.kind === 'file' || n.kind === 'route') continue;
        const text = sigLine(n);
        const cost = countTokens(text) + 1;
        const b: Block = { section: 'signatures', text, item: { nodeId: n.id, path: n.path, name: n.name, mode: 'signature', tokens: cost, ...(n.range ? { range: n.range } : {}) } };
        if (blockCost(b, cost) > remaining) continue;
        add(b, cost);
        chosenIds.add(n.id);
        added++;
      }
    }
  }

  // ---- order by section, keep selection order inside a section; then render and guarantee the budget
  const order = new Map(SECTIONS.map(([s], i) => [s, i]));
  const sorted = blocks.map((b, i) => ({ b, i })).sort((x, y) => order.get(x.b.section)! - order.get(y.b.section)! || x.i - y.i).map((x) => x.b);
  return finish(o, sorted, degraded);
}

function finish(o: PackOptions, blocks: Block[], degraded: string[]): PackResult {
  for (;;) {
    // the header holds its own token count: iterate on the (small) header only, the rest is counted once
    const probe = render(o, blocks, o.budget);
    const restTokens = countTokens('\n' + probe.rest);
    let t = o.budget;
    let text = '';
    let total = Infinity;
    for (let i = 0; i < 4; i++) {
      const r = render(o, blocks, t);
      text = `${r.header}\n${r.rest}`;
      total = countTokens(r.header) + restTokens;
      if (total === t) break;
      t = total;
    }
    // the additive count can be off by a token at the seams; close to the limit only a real count is trusted
    const near = total > o.budget - 3;
    if (near) total = countTokens(text);
    if (total <= o.budget) {
      const r = render(o, blocks, total);
      const final = `${r.header}\n${r.rest}`;
      const exact = !near || final === text ? total : countTokens(final);
      if (exact <= o.budget) return { text: final, tokens: exact, items: blocks.flatMap((b) => (b.item ? [b.item] : [])), degraded };
    }
    if (blocks.length === 0) return { text: '', tokens: 0, items: [], degraded };
    blocks.pop(); // drop from the end until it fits
  }
}
