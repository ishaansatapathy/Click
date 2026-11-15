# HydraDB OSS: verified notes (self-hosted, v0.4.0)

> Hackathon rule: use the open-source engine (github.com/hydra-db/hydradb), self-hosted, as our graph DB. Not the hosted platform.
> Everything below was **run and measured** on Ishaan's machine (Windows + Docker Desktop 29.9, 2026-11-15) with the probes in
> `docs/hydradb-oss/`. Synthetic graph the size of the bench repo: 2,000 nodes, ~6,000 edges, 5 relationship types.
> `docs/hydradb-notes.md` covers the *hosted* v2 API and no longer drives the design.

## What it is
Rust graph database. OpenCypher subset, Neo4j Bolt 5 (`neo4j-driver` works), HTTP JSON query API, SlateDB storage on an
object store (S3 or a local directory), GraphBLAS traversal, path procedures, global graph algorithms. License **ELv2**.
Images: `ghcr.io/hydra-db/hydradb:0.4.0` and `:latest` (674 MB). Binaries in the image: `graph-node`, `graph-indexer`.

## Run it locally (verified)
Two containers sharing one volume: `graph-node` (queries + writes) and `graph-indexer` (builds per-type CSC index
generations; **required for `gds.*`**, not for plain Cypher or `algo.*`).

```bash
export MSYS_NO_PATHCONV=1   # Git Bash on Windows rewrites /data/... into C:/Program Files/Git/data/... otherwise
docker volume create click-hydradb
docker run --rm -v click-hydradb:/data --entrypoint sh --user 0 ghcr.io/hydra-db/hydradb:0.4.0 \
  -c 'mkdir -p /data/store /data/cache /data/cache-indexer && printf "%s\n" "$TOKEN" > /data/auth-token && chown -R 10001:10001 /data'
COMMON="-e CLOUD_PROVIDER=local -e LOCAL_PATH=/data/store -e GRAPH_NAMESPACE=default -e GRAPH_ID=default
  -e GRAPH_CELL_ID=cell-0 -e GRAPH_CELLS=cell-0 -e GRAPH_AUTH_TOKEN_FILE=/data/auth-token -e GRAPH_ALLOW_PLAINTEXT=true
  -e RUST_MIN_STACK=33554432 -e GRAPH_USAGE_REPORT_ENABLED=false"
# node: listens on 0.0.0.0 inside the container, published on 127.0.0.1 only
docker run -d --name click-hydradb-node -v click-hydradb:/data -p 127.0.0.1:7687:7687 -p 127.0.0.1:8443:8443 -p 127.0.0.1:9090:9090 $COMMON \
  -e GRAPH_NODE_ID=node-0 -e GRAPH_BOLT_NODE_ADDRESSES=node-0=127.0.0.1:7687 -e GRAPH_ADVERTISED_BOLT_ADDR=127.0.0.1:7687 \
  -e GRAPH_BOLT_ADDR=0.0.0.0:7687 -e GRAPH_HTTP_ADDR=0.0.0.0:8443 -e GRAPH_ADMIN_ADDR=0.0.0.0:9090 -e GRAPH_DATA_CACHE_DIR=/data/cache \
  ghcr.io/hydra-db/hydradb:0.4.0
# indexer
docker run -d --name click-hydradb-indexer -v click-hydradb:/data --entrypoint /usr/local/bin/graph-indexer $COMMON \
  -e GRAPH_NODE_ID=indexer-0 -e GRAPH_DATA_CACHE_DIR=/data/cache-indexer -e GRAPH_INDEXER_ADMIN_ADDR=0.0.0.0:9095 \
  ghcr.io/hydra-db/hydradb:0.4.0
```
- Ready in ~2 s: `GET http://127.0.0.1:9090/readyz` → 200.
- Query: `POST http://127.0.0.1:8443/v1/graphs/default/query`, `Authorization: Bearer <token>`, body `{"cell_id":"cell-0","query":…,"parameters":{…}}`.
  Rows come back typed: `{"type":"vertex_id"|"string"|"float"|"integer"|"null"|"path"|"record", "value": …}`.
- **Privacy:** the node logs an install id and has a usage reporter; set `GRAPH_USAGE_REPORT_ENABLED=false`.

## Feature matrix (verified)

| Need | Result | How |
|---|---|---|
| Bulk load 2k nodes | ✅ 227 ms | `UNWIND $rows AS row MERGE (n {id: row.id}) SET n:CodeNode, n.key = row.key, …` (exactly one label per batch; ≤ 1024 rows) |
| Bulk load 6k edges | ✅ 618 ms | `UNWIND $rows AS row CREATE (a {id: row.src})-[:CALLS]->(b {id: row.dst})` per type; idempotent on (src, dst, type) |
| Edge properties in a batch | ❌ | "UNWIND batch requires one fixed relationship type without properties" |
| Set one edge's weight | ✅ ~5–19 ms | `MATCH (a {id: $s})-[r:CALLS]->(b {id: $d}) SET r.w = $w`; unset reads back as `null` |
| Vertex ids | ✅ | non-negative integers; 48-bit hashes of our string ids round-trip; keep the string id in a `key` property |
| `[:A\|B]` multi-type pattern | ❌ | one type per pattern; use one query per type, or `UNION ALL`, or the `algo.*` procedures |
| `WHERE a.id IN $ids` | ✅ 7 ms | list parameter in WHERE works (the MSpaths value lists are the exception: inline those) |
| Incoming direction, `UNION ALL`, `*1..2` | ✅ ~3–8 ms | undirected `-[]-` and unbounded `*` are rejected |
| **2-hop typed neighbourhood, 8 seeds, both directions, with weights** | ✅ **p50 37 ms**, max 61 ms (311 edges) | 2 rounds × (types × 2 directions) parallel `IN` queries returning `a.key, b.key, r.w` |
| Bounded paths, many types, both directions | ✅ 9–16 ms | `CALL algo.SSpaths({sourceNode, relTypes: […], relDirection: 'both', maxLen: 2, pathCount: 500}) YIELD path` |
| Degree ranking | ✅ 15–23 ms | `CALL algo.degree({label, relTypes, relDirection, limit}) YIELD node, degree` |
| Global PageRank | ✅ 76 ms (indexer running) | `CALL gds.graph.project('code', 'CodeNode', [types])` then `gds.pageRank.stream('code', {maxIterations: 100, dampingFactor: 0.85, tolerance: 0.0001}) YIELD nodeId, score`; default tolerance 1e-7 fails to converge |
| Betweenness | ✅ 207 ms | `gds.betweenness.stream('code', {})` |
| **Personalised PageRank** | ❌ | "sourceNodes is not supported; personalised PageRank is not implemented" |
| **Weighted PageRank** | ❌ | "relationshipWeightProperty is not supported; graphs are unweighted" |
| Vector / full-text search | ❌ | not in the engine |
| Result size | ⚠️ | ≤ 1024 rows per response (pagination via `next_cursor`); for top-k by PageRank use `gds.pageRank.write` + `ORDER BY … LIMIT` |

## Consequences for Click (see ARCHITECTURE.md)
1. HydraDB is the code graph's system of record **and** its traversal engine: the hot path fetches the weighted 2-hop
   neighbourhood of the seeds from HydraDB on every request; `impact_of` is `algo.SSpaths` over incoming edges; the skeleton
   hubs come from `gds.pageRank`; learned weights live on HydraDB edges as `r.w`.
2. Personalised, weighted PageRank runs in Click over the fetched subgraph (HydraDB has neither).
3. Semantic seeds need our own embeddings (OpenAI), stored locally with the chunks.
4. One label (`CodeNode`) with a `kind` property keeps projections and procedures simple.
