// Feature + latency probe for self-hosted HydraDB 0.4.0, shaped like Click's code graph.
// Answers: which Cypher shapes we can rely on, and how fast a hot-path neighbourhood fetch is.
import { createHash } from 'node:crypto';

const URL = 'http://127.0.0.1:8443/v1/graphs/default/query';
const TOKEN = 'local-development-token-32-bytes';
const results = [];

async function q(query, parameters = {}) {
  const t = performance.now();
  const res = await fetch(URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ cell_id: 'cell-0', query, parameters }),
  });
  const ms = performance.now() - t;
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && !body.error, status: res.status, body, ms };
}
async function check(name, query, params, show = (b) => JSON.stringify(b.rows?.slice(0, 3))) {
  const r = await q(query, params);
  const msg = r.ok ? show(r.body) : (r.body?.error?.message ?? r.body?.message ?? JSON.stringify(r.body)).slice(0, 160);
  results.push({ name, ok: r.ok, ms: Math.round(r.ms), detail: String(msg).slice(0, 170) });
  return r;
}

// Stable numeric vertex id from a string id: first 12 hex chars of sha1 → < 2^48 (JS-safe, non-negative).
const vid = (s) => parseInt(createHash('sha1').update(s).digest('hex').slice(0, 12), 16);

// ---- synthetic graph the size of the bench repo (~2k nodes, ~6k edges)
const KINDS = ['file', 'component', 'store', 'composable', 'function', 'type', 'route'];
const N = 2000;
const nodes = Array.from({ length: N }, (_, i) => ({ id: vid(`sym:src/f${i % 300}.ts#s${i}`), key: `sym:src/f${i % 300}.ts#s${i}`, kind: KINDS[i % KINDS.length], name: `s${i}` }));
const TYPES = ['IMPORTS', 'CALLS', 'USES_STORE', 'USES_COMPONENT', 'CONTAINS'];
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const edgesByType = Object.fromEntries(TYPES.map((t) => [t, []]));
for (let k = 0; k < 6000; k++) {
  const a = nodes[Math.floor(rnd() * N)], b = nodes[Math.floor(rnd() * N)];
  if (a.id !== b.id) edgesByType[TYPES[k % TYPES.length]].push({ src: a.id, dst: b.id, w: 1 });
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

let t0 = performance.now();
for (const rows of chunk(nodes, 1000)) {
  const r = await q('UNWIND $rows AS row MERGE (n {id: row.id}) SET n:Sym, n.key = row.key, n.kind = row.kind, n.name = row.name', { rows });
  if (!r.ok) { console.log('node batch failed', JSON.stringify(r.body).slice(0, 300)); break; }
}
const nodeMs = performance.now() - t0;
t0 = performance.now();
let edgeCount = 0;
for (const t of TYPES) for (const rows of chunk(edgesByType[t], 1000)) {
  const r = await q(`UNWIND $rows AS row CREATE (a {id: row.src})-[:${t}]->(b {id: row.dst})`, { rows });
  if (!r.ok) { console.log('edge batch failed', t, JSON.stringify(r.body).slice(0, 300)); break; }
  edgeCount += rows.length;
}
const edgeMs = performance.now() - t0;
results.push({ name: `bulk load ${N} nodes`, ok: true, ms: Math.round(nodeMs), detail: '2 node batches' });
results.push({ name: `bulk load ${edgeCount} edges`, ok: true, ms: Math.round(edgeMs), detail: `${TYPES.length} types, batches of 1000` });

const s = nodes[0], s2 = nodes[1];
// ---- feature checks
await check('48-bit id round trip', 'MATCH (n:Sym {id: $id}) RETURN n.key AS key, n.kind AS kind', { id: s.id });
await check('edge property in batch CREATE', 'UNWIND $rows AS row CREATE (a {id: row.src})-[:WEIGHTED {w: row.w}]->(b {id: row.dst})', { rows: [{ src: s.id, dst: s2.id, w: 2.5 }] }, () => 'accepted');
await check('read edge property', 'MATCH (a {id: $id})-[r:WEIGHTED]->(b) RETURN b.id AS id, r.w AS w', { id: s.id });
await check('per-edge SET weight', 'MATCH (a {id: $s})-[r:CALLS]->(b) SET r.w = 1.7', { s: s.id }, () => 'accepted');
await check('read SET weight back', 'MATCH (a {id: $s})-[r:CALLS]->(b) RETURN b.id AS id, r.w AS w', { s: s.id });
await check('multi-type pattern [:A|B]', 'MATCH (a {id: $id})-[r:CALLS|IMPORTS]->(b) RETURN b.id AS id', { id: s.id });
await check('IN $list filter', 'MATCH (a:Sym)-[r:CALLS]->(b) WHERE a.id IN $ids RETURN a.id AS src, b.id AS dst', { ids: nodes.slice(0, 8).map((n) => n.id) });
await check('UNION ALL of 2 types', 'MATCH (a {id: $id})-[:CALLS]->(b) RETURN b.id AS id UNION ALL MATCH (a {id: $id})-[:IMPORTS]->(b) RETURN b.id AS id', { id: s.id });
await check('incoming direction', 'MATCH (a {id: $id})<-[:CALLS]-(b) RETURN b.id AS id', { id: s.id });
await check('var-length *1..2', 'MATCH (a {id: $id})-[:CALLS*1..2]->(b) RETURN b.id AS id', { id: s.id }, (b) => `${b.rows?.length} rows`);
await check('batched read (UNWIND, 8 seeds, 1 type)', 'UNWIND $rows AS row MATCH (a {id: row.id})-[:CALLS]->(b) RETURN row.id AS src, b.id AS dst', { rows: nodes.slice(0, 8).map((n) => ({ id: n.id })) }, (b) => `${b.rows?.length} rows`);
await check('algo.SSpaths both dirs, all types, maxLen 2', `CALL algo.SSpaths({sourceNode: ${s.id}, relTypes: ['IMPORTS','CALLS','USES_STORE','USES_COMPONENT','CONTAINS'], relDirection: 'both', maxLen: 2, pathCount: 1}) YIELD path RETURN path`, {}, (b) => `${b.rows?.length} paths; first: ${JSON.stringify(b.rows?.[0]).slice(0, 110)}`);
await check('algo.degree top hubs', "CALL algo.degree({label: 'Sym', relTypes: ['CALLS','IMPORTS'], relDirection: 'both', limit: 5}) YIELD node, degree RETURN node.key AS key, degree", {});
await check('gds.graph.project', "CALL gds.graph.project('code', 'Sym', ['IMPORTS','CALLS','USES_STORE','USES_COMPONENT','CONTAINS'])", {}, (b) => JSON.stringify(b.rows?.[0] ?? b.columns).slice(0, 120));
await check('gds.pageRank.stream', "CALL gds.pageRank.stream('code', {maxIterations: 20, dampingFactor: 0.85}) YIELD nodeId, score", {}, (b) => `${b.rows?.length} rows; first ${JSON.stringify(b.rows?.[0])}`);

// ---- hot-path latency: 2-hop neighbourhood of 8 seeds via SSpaths (one call per seed, in parallel)
const seeds = nodes.slice(10, 18);
const lat = [];
for (let rep = 0; rep < 10; rep++) {
  const t = performance.now();
  await Promise.all(seeds.map((n) => q(`CALL algo.SSpaths({sourceNode: ${n.id}, relTypes: ['IMPORTS','CALLS','USES_STORE','USES_COMPONENT','CONTAINS'], relDirection: 'both', maxLen: 2, pathCount: 1}) YIELD path RETURN path`)));
  lat.push(performance.now() - t);
}
lat.sort((a, b) => a - b);
results.push({ name: '2-hop neighbourhood, 8 seeds (8 parallel SSpaths)', ok: true, ms: Math.round(lat[5]), detail: `p50 ${Math.round(lat[5])} ms, max ${Math.round(lat[9])} ms over 10 runs` });
const one = [];
for (let rep = 0; rep < 10; rep++) { const r = await q('MATCH (a {id: $id})-[:CALLS]->(b) RETURN b.id AS id', { id: seeds[rep % 8].id }); one.push(r.ms); }
one.sort((a, b) => a - b);
results.push({ name: 'single 1-hop MATCH', ok: true, ms: Math.round(one[5]), detail: `p50 ${Math.round(one[5])} ms` });

for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${String(r.ms).padStart(5)} ms  ${r.name.padEnd(46)} ${r.detail}`);
