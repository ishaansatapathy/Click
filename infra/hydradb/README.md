# Self-hosted HydraDB

Click uses the open-source HydraDB `v0.4.0` graph engine locally. Docker Compose starts two long-running services over one named volume:

- `graph-node` handles Cypher writes and queries on `127.0.0.1:7687`, `:8443`, and `:9090`.
- `graph-indexer` builds the indexes required by `gds.*` algorithms such as PageRank.

An init service creates the store/cache directories and token file inside the volume, then changes ownership to HydraDB's UID `10001`. Usage reporting is disabled with `GRAPH_USAGE_REPORT_ENABLED=false`.

## Commands

From the repository root:

```bash
pnpm hydra:up       # start and wait up to 30 seconds for /readyz
pnpm hydra:logs     # follow node and indexer logs
pnpm hydra:down     # stop containers, preserve graph data
pnpm hydra:reset    # destructive: remove the named volume, rotate the token, start empty
```

The lifecycle script creates a random local token at `.click/hydradb-token` by default and never prints it. Override the client-visible settings with `HYDRADB_URL` and `HYDRADB_TOKEN_FILE`; see `.env.example`. All published ports bind to `127.0.0.1`, not every network interface.

The script invokes Docker without a shell and sets `MSYS_NO_PATHCONV=1`. If you run `docker compose` commands manually from Git Bash on Windows, export that variable yourself so `/data/...` is not rewritten to a Git installation path.

## Troubleshooting

- `http://127.0.0.1:9090/readyz` must return HTTP 200 before querying.
- `gds.*` calls require `graph-indexer`; plain Cypher and `algo.*` do not.
- HydraDB allows one relationship type per `MATCH`; Click issues per-type queries.
- Global PageRank must use tolerance `0.0001`; the engine's tighter default may not converge.
- Batch relationship writes cannot set edge properties. Learned weights use individual `SET r.w` calls.
- `hydra:reset` permanently deletes the `click-hydradb` Docker volume.
