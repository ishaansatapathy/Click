// Probe 2: weights on real edges, neighbourhood strategies, GDS with the indexer running.
const URL = 'http://127.0.0.1:8443/v1/graphs/default/query';
const TOKEN = 'local-development-token-32-bytes';
async function q(query, parameters = {}) {
  const t = performance.now();
  const res = await fetch(URL, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ cell_id: 'cell-0', query, parameters }) });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && !body.error, body, ms: performance.now() - t };
}
const show = (label, r, f = (b) => JSON.stringify(b.rows?.slice(0, 3))) =>
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${String(Math.round(r.ms)).padStart(5)} ms  ${label.padEnd(50)} ${(r.ok ? f(r.body) : r.body?.error?.message ?? JSON.stringify(r.body)).toString().slice(0, 150)}`);
const val = (c) => c?.value;

// a node that really has outgoing CALLS edges
const src = val((await q('MATCH (a:Sym)-[:CALLS]->(b) RETURN a.id AS id LIMIT 1')).body.rows[0][0]);
const dst = val((await q('MATCH (a {id: $id})-[:CALLS]->(b) RETURN b.id AS id LIMIT 1', { id: src })).body.rows[0][0]);

show('SET weight on one real edge', await q('MATCH (a {id: $s})-[r:CALLS]->(b {id: $d}) SET r.w = 1.7', { s: src, d: dst }), () => 'accepted');
show('read weight back', await q('MATCH (a {id: $s})-[r:CALLS]->(b {id: $d}) RETURN b.id AS id, r.w AS w', { s: src, d: dst }));
show('edge with no weight returns null', await q('MATCH (a {id: $s})-[r:CALLS]->(b) RETURN b.id AS id, r.w AS w', { s: src }));
show('var-length *1..2 from real src', await q('MATCH (a {id: $id})-[:CALLS*1..2]->(b) RETURN b.id AS id', { id: src }), (b) => `${b.rows.length} rows`);
show('SSpaths pathCount 0 maxLen 2', await q(`CALL algo.SSpaths({sourceNode: ${src}, relTypes: ['IMPORTS','CALLS','USES_STORE','USES_COMPONENT','CONTAINS'], relDirection: 'both', maxLen: 2, pathCount: 0}) YIELD path RETURN path`), (b) => `${b.rows.length} paths`);
show('SSpaths pathCount 500 maxLen 2', await q(`CALL algo.SSpaths({sourceNode: ${src}, relTypes: ['IMPORTS','CALLS','USES_STORE','USES_COMPONENT','CONTAINS'], relDirection: 'both', maxLen: 2, pathCount: 500}) YIELD path RETURN path`), (b) => `${b.rows.length} paths`);

// Neighbourhood strategy A: one IN-query per (type, direction), all in parallel. Returns typed edge lists with weights.
const TYPES = ['IMPORTS', 'CALLS', 'USES_STORE', 'USES_COMPONENT', 'CONTAINS'];
const seeds = (await q('MATCH (a:Sym)-[:IMPORTS]->(b) RETURN a.id AS id LIMIT 8')).body.rows.map((r) => val(r[0]));
async function hop(frontier) {
  const parts = await Promise.all(TYPES.flatMap((t) => [
    q(`MATCH (a:Sym)-[r:${t}]->(b) WHERE a.id IN $ids RETURN a.id AS src, b.id AS dst, r.w AS w`, { ids: frontier }),
    q(`MATCH (a:Sym)<-[r:${t}]-(b) WHERE a.id IN $ids RETURN b.id AS src, a.id AS dst, r.w AS w`, { ids: frontier }),
  ]));
  return parts.flatMap((p) => (p.ok ? p.body.rows : []));
}
const lat = [];
let edges = 0;
for (let rep = 0; rep < 10; rep++) {
  const t = performance.now();
  const h1 = await hop(seeds);
  const frontier = [...new Set(h1.flatMap((r) => [val(r[0]), val(r[1])]))].slice(0, 200);
  const h2 = await hop(frontier);
  lat.push(performance.now() - t);
  edges = h1.length + h2.length;
}
lat.sort((a, b) => a - b);
console.log(`OK   ${String(Math.round(lat[5])).padStart(5)} ms  2-hop typed neighbourhood, 8 seeds (2 x 10 parallel IN-queries)  p50 ${Math.round(lat[5])} ms, max ${Math.round(lat[9])} ms, ${edges} edges`);

// GDS with the indexer running
show('gds.graph.project', await q("CALL gds.graph.project('code', 'Sym', ['IMPORTS','CALLS','USES_STORE','USES_COMPONENT','CONTAINS'])"), (b) => JSON.stringify(b.rows?.[0]).slice(0, 120));
show('gds.pageRank.stream', await q("CALL gds.pageRank.stream('code', {maxIterations: 20, dampingFactor: 0.85}) YIELD nodeId, score"), (b) => `${b.rows.length} rows; first ${JSON.stringify(b.rows[0])}`);
show('gds.betweenness.stream', await q("CALL gds.betweenness.stream('code', {}) YIELD nodeId, score"), (b) => `${b.rows.length} rows`);
show('algo.degree after indexing', await q("CALL algo.degree({label: 'Sym', relTypes: ['CALLS','IMPORTS'], relDirection: 'both', limit: 3}) YIELD node, degree RETURN node.key AS key, degree"));
