# HydraDB v2 integration notes

Checked against the live HydraDB v2 documentation and OpenAPI document on 2026-11-15. These notes describe the hosted v2 API at `https://api.hydradb.com`; they do not assume behavior that is absent from the published contract.

## Recommendation

Use the official TypeScript SDK, `@hydradb/sdk@^2.1.7`, for the first adapter. It wraps every documented endpoint, supplies `API-Version: 2`, and maps request/response fields to camelCase. Keep the adapter behind Click's `Store` interface so REST remains a fallback if SDK cancellation or multipart behavior is insufficient. Raw REST uses snake_case and requires both `Authorization: Bearer <key>` and `API-Version: 2`.

Create one HydraDB database for Click and one collection per `repoId`. This makes HydraDB's database/collection isolation enforce the repository namespace instead of relying only on a filter. Still put `repoId`, `indexVersion`, and `recordKind` in each record's metadata so exports can validate their scope.

## Authentication and request lifecycle

- Read `HYDRADB_API_KEY` and pass it as the SDK client's `token`; never log it.
- Ingestion is asynchronous. `POST /context/ingest` returns `202` and IDs, then `GET /context/status` must be polled until every ID is `completed` or `errored` (`graph_creation` is already searchable).
- The SDK exposes `client.context.ingest`, `.status`, `.list`, `.inspect`, `.delete`, and `client.query`.
- HydraDB response envelopes include `meta.request_id` and `meta.latency_ms`; retain the request ID in errors, but not credentials or source bodies.

## Records, IDs, metadata, and batches

Use `type: "knowledge"` and `appKnowledge` for Click records because the content is already extracted. Each item should be a `kind: "custom"` app source with:

```ts
{
  id: storageId,
  title: `${recordKind}:${logicalId}`,
  kind: 'custom',
  provider: 'click',
  external_id: logicalId,
  fields: { kind: 'custom', data: JSON.stringify(record) },
  metadata: { repoId, indexVersion, recordKind },
  additional_metadata: { logicalId }
}
```

The caller-supplied `id` is the upsert key. Ingest's documented `overwrite` default is `true`; the same ID replaces the prior source. IDs cannot contain commas, so derive `storageId` from a collision-resistant encoding/hash rather than concatenating unrestricted logical IDs. `metadata` fields must first exist in the database metadata schema and have a 16 KiB total cap. Free-form `additional_metadata` has a 1 KiB cap.

The docs publish a 50 MB limit per uploaded document, but no maximum number of `app_knowledge` items/documents per ingest request. Keep Click's SPEC default of 100 records per request as a conservative application limit, not a HydraDB claim. Treat partial success in `data.results` as an error for the failed IDs and retry only those IDs.

## Query APIs and filters

`POST /query` is the only public search endpoint:

- Hybrid: `queryBy: "hybrid"` combines meaning and keywords. `alpha` ranges from keyword-heavy `0.0` to semantic-heavy `1.0` (default `0.8`). `mode: "fast"` is one retrieval pass; `thinking` expands/reranks; `auto` chooses.
- Keyword: `queryBy: "text"`, with `operator: "and" | "phrase"` where needed.
- Vector-only: no public v2 request field accepts a caller-provided query vector, and `query_by` only permits `hybrid` or `text`. Therefore Click cannot faithfully execute `hybridQuery({ vector })` as raw-vector search through the documented API. The adapter should query by `text`; it must not silently claim the supplied vector was used.
- `maxResults` defaults to 10 and has a documented maximum of 250.
- Scope by collection plus `metadataFilters: { repoId, indexVersion?, recordKind? }`. Filter keys are ANDed; operators are `equals`, `contains`, and `contains_any`. A list may contain at most 500 values and the complete filter object at most 64 KiB.
- Query results are ranked `data.chunks`; map each chunk's source `id` to Click's logical ID and use `relevancyScore` as the score. Dedupe multiple chunks from the same source, keeping the highest score, before truncating to `k`.

HydraDB parses, chunks, embeds, graphs, and searches ingested text server-side. The current public docs do not name the hosted embedding model. They mention bring-your-own embeddings at product level, but v2's published ingest/query schemas expose neither a custom vector upload nor a query-vector field. `HydraEmbedder` therefore cannot implement Click's `Embedder` contract from the documented hosted v2 API alone.

## Pagination and full export

`POST /context/list` accepts `page` (1-based) and `pageSize` (default 50, range 1-100). Its response supplies `pagination.hasNext`, `page`, `pageSize`, `total`, and `totalPages`. A full export must loop until `hasNext` is false. Listing returns source rows and metadata, not a guaranteed lossless copy of the original JSON body, so `loadAll` may need `context.inspect` for every listed source unless the list response proves it includes the app source `fields` in a live contract test.

This is an API-call-heavy export (one list call per 100 rows, potentially one inspect call per record). Do not promise efficient disaster recovery until this is live-tested.

## Store method mapping

| `Store` method | HydraDB v2 call and representation |
|---|---|
| `upsert(batch, indexVersion)` | Flatten nodes, edges, and chunks to `appKnowledge`; IDs are stable storage IDs; set `overwrite: true`; ingest in application batches of 100; poll `context.status`. |
| `remove(ids)` | Convert each category's IDs to storage IDs and call `context.delete({ type: "knowledge", database, collection: repoId, ids })`. Use strict delete status over REST if the SDK cannot send `X-HydraDB-Delete-Status: strict`. |
| `hybridQuery(q, signal)` | `client.query({ database, collection: repoId, type: "knowledge", query: q.text, queryBy: "hybrid", mode: "fast", maxResults: min(250, overfetch), metadataFilters })`; dedupe source IDs and return top `k`. `q.kinds` maps to a `recordKind` filter. A supplied `q.vector` is unsupported by the published v2 contract. Verify whether the SDK accepts `AbortSignal`; otherwise use REST `fetch` for this method. |
| `loadAll()` | Page through `context.list({ type: "knowledge", pageSize: 100 })`; inspect each source if list omits its serialized payload; decode by `recordKind`; yield bounded pages. |
| `getWeights()` | Inspect the reserved source ID `click-weights`; return decoded body, or `null` on a confirmed 404. |
| `putWeights(doc)` | Upsert one reserved `appKnowledge` source `click-weights` with `recordKind: "weights"`; poll status. |
| `getConventions()` | Inspect reserved source `click-conventions`; return decoded array, or `[]` on a confirmed 404. |
| `putConventions(items)` | Upsert reserved source `click-conventions` with `recordKind: "conventions"`; poll status. |

For `getWeights` and `getConventions`, an ID-specific `context.inspect` is preferable to semantic query because these are exact state documents. Confirm its response returns the full original app-source payload before implementation.

## Limits and performance

- Published retrieval claim: sub-200 ms. The query guide nevertheless recommends client timeouts up to 500 ms for `fast` and 3-5 s for `thinking`; Click should use `fast` and obey its own deadline.
- Published query cap: 250 chunks; up to 100 collections per query.
- Published list cap: 100 rows/page.
- Published metadata caps: 16 KiB schema metadata, 1 KiB additional metadata, 64 KiB filter object, 500 values per filter list.
- The live v2 docs/OpenAPI do not publish request-per-second, concurrent-request, or ingest item-count rate limits. Implement bounded concurrency, retry `429`/retryable `5xx` with jitter and `Retry-After`, and make the live probe authoritative.

## Unknowns to resolve before or during prompts 103-107

1. Does the TypeScript SDK pass an `AbortSignal` through `query`? If not, use the REST query endpoint through Click's deadline-aware HTTP helper.
2. Does `context.inspect` return the exact original `app_knowledge.fields.data`, and can it inspect several IDs per call? This determines whether `loadAll` is practical.
3. What are the hosted service's actual request, concurrency, and ingest-item limits? None are published in the current v2 docs.
4. Does replacing an ID make the new version immediately authoritative while it is re-indexing, and what consistency window does a read-after-upsert have?
5. Can the hosted account expose a supported custom-vector/embedding-only API that is absent from the public v2 OpenAPI? If not, `HydraEmbedder` is unavailable and Click must use Voyage/local vectors.
6. What server-side embedding model and dimensions back hosted hybrid search? The public docs do not identify them.
7. Does deleting an absent ID remain idempotent under the SDK's default legacy status behavior? The adapter should normalize confirmed absence to success.
8. What is the real p50/p95 for ingest-status completion, `fast` hybrid query, list, and inspect on the Click corpus? Measure in prompt 107.

## Sources

- [HydraDB v2 Quickstart](https://docs.hydradb.com/get-started/v2/quickstart)
- [API reference overview](https://docs.hydradb.com/api-reference/v2)
- [TypeScript and Python SDKs](https://docs.hydradb.com/api-reference/v2/sdks)
- [Ingest Context](https://docs.hydradb.com/api-reference/v2/endpoint/ingest-context)
- [Query guide](https://docs.hydradb.com/essentials/v2/query)
- [Metadata and filters](https://docs.hydradb.com/essentials/v2/metadata)
- [Delete Context](https://docs.hydradb.com/api-reference/v2/endpoint/delete-source)
- [v2 OpenAPI document](https://docs.hydradb.com/api-reference/v2/openapi.json)
