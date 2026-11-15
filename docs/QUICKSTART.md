# Try Click on your own machine

Click runs locally: your code never leaves your computer. You need **Node 20+**. Docker is only needed for the HydraDB graph store (step 4); steps 1-3 work without it.

## 1. Install

```bash
npm install -g click-context        # gives you the `click` command
click --version                     # 0.1.0
```

(or run any command below as `npx click-context <command>` without installing)

## 2. Index a Vue 3 repository

```bash
cd path/to/your-vue-project
click index                         # builds the code graph: files, components, stores, routes, calls
```

For a 100-file project this takes a few seconds.

## 3. Ask for context

```bash
click context "when a user logs out, clear the session and the open tabs" --budget 4000
```

You get the functions, components and stores the task needs, with the reason each one is there, packed to the token budget. Add `--json` for a machine-readable answer, `--budget 8000` for more.

## 4. Use the HydraDB graph (the full setup)

Without HydraDB, Click walks the graph from a local copy and says so (`degraded="graph-replica"`). With it, the graph lives in a self-hosted HydraDB (open source, Docker):

```bash
git clone https://github.com/ishaansatapathy/Click && cd Click
pnpm install
pnpm hydra:up                       # starts graph-node + graph-indexer in Docker, waits until ready
```

`hydra:up` writes a local access token to `.click/hydradb-token` inside the clone. Tell Click where it is, then push your project's graph from your project directory:

```bash
export HYDRADB_TOKEN_FILE=/path/to/Click/.click/hydradb-token     # Windows PowerShell: $env:HYDRADB_TOKEN_FILE="C:\path\to\Click\.click\hydradb-token"
cd path/to/your-vue-project
click push                          # uploads the repo's graph to HydraDB
click status                        # the daemon now reads its graph neighbourhoods from HydraDB
```

`pnpm hydra:down` (in the clone) stops it; `pnpm hydra:reset` wipes it.

## 5. Plug it into your agent

```bash
click hooks install                 # Claude Code: every prompt gets Click's context automatically
click hooks status
```

The hook never blocks you: if the daemon is down or slow, the prompt goes through unchanged. To remove it: `click hooks uninstall`.

## Useful commands

| Command | What it does |
| --- | --- |
| `click index [--full]` | build or refresh the code graph |
| `click context "<task>" [--budget N] [--json]` | the context for a task |
| `click map --stats` | what is in the graph |
| `click status` | is the daemon up, what it served last |
| `click weights --show` | what Click has learned from your sessions |

## Run the benchmark or the dashboard

```bash
pnpm bench                          # the retrieval benchmark (see bench/)
pnpm --filter @click/dashboard dev  # the website, on http://localhost:5174
```
