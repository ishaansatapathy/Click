# Loom script (4-5 minutes)

Record at 1080p, full screen, Do Not Disturb on, terminal and editor font enlarged (Ctrl +). Close every tab that shows a secret:
`.env`, `.env.local`, the HydraDB token, Vercel environment variables, the Google Cloud console.

## Before you press record (5 minutes, not recorded)

```bash
# Docker Desktop running
cd C:\Users\IshaanSatapathy\Desktop\Cllick-wt\b
pnpm demo
```

Every line must be green, ending with `Everything is ready`. If one is red, its arrow says what to do. Then open:

1. A terminal in `Cllick-wt\b` (font large).
2. VS Code on `Desktop\Cllick\bench\repo`, Claude Code panel open.
3. A browser on https://click.ishaandev.co.in/ (signed in) and a second tab on the landing page.

Rehearse once without recording.

## The recording

| Time | Screen | Say (roughly) | Do |
| --- | --- | --- | --- |
| 0:00-0:30 | Landing page | "Coding agents spend most of their tokens finding code, not writing it. They grep and open whole files, and still miss the file that matters, because what connects it to the task is not in its text. Click fixes that with a code graph." | Scroll the landing slowly: hero, graph section, numbers. |
| 0:30-1:15 | VS Code, Claude Code panel | "This is a real Vue 3 app. I ask Claude for a change in plain words." | Paste: *When a user logs out, clear every piece of session state, remove open and cached tabs, reset access-controlled navigation, and then return them to the sign-in screen.* Show that the answer cites `useUserStore`, `resetRouter`, `useTagsViewStore`: the context arrived with the prompt. |
| 1:15-1:45 | Terminal | "Here is what Click handed the agent, and why each piece is there." | `node packages/click/dist/click.js context "When a user logs out, clear session state and open tabs" --root "C:\Users\IshaanSatapathy\Desktop\Cllick\bench\repo" --budget 4000`. Point at `tokens="…" budget="4000"`, a `seed:` reason and a `via uses_store` reason. |
| 1:45-2:30 | Terminal, then Docker Desktop | "The graph lives in HydraDB, self-hosted, and HydraDB does graph work on every request." | `docker ps` (two HydraDB containers). `node packages/click/dist/click.js status --root "C:\Users\IshaanSatapathy\Desktop\Cllick\bench\repo"`: `hydradb: ok`, 310 nodes, 709 edges. `node packages/click/dist/click.js probe --root "C:\Users\IshaanSatapathy\Desktop\Cllick\bench\repo"`: neighbourhood p50 ~85 ms, impact paths. |
| 2:30-3:00 | Site: Graph & impact | "Same graph, other question: what breaks if I change the user store? 27 files within three hops, each with the chain that links it." | Click `src/pinia/stores/user.ts` (preselected). Scroll the list. |
| 3:00-3:50 | Site: Benchmark | "We measured it on 233 tasks from this app's own git history, 75 held out. Strict file recall at a fixed budget. The graph adds 4 points at 4k tokens and 10.8 at 8k, both intervals clear of zero. Against plain vector search, file recall is a tie, but Click returns the function that matters three times as often. Learning: the loop works, the gain is not proven yet. We say that on the page." | Show the bar chart, then the interval plot. Hover one bar to show the run id. |
| 3:50-4:10 | Site: Playground | "And anyone can try the retrieval in the browser, no install." | Pick a chip, Get context, point at "files only the graph found". |
| 4:10-4:45 | Site: Go to market | "Who pays: small Vue teams and students paying per token. Free and local for one developer; a team plan with a shared learned graph, HydraDB deployed in the customer's own cloud, which is how HydraDB's licence wants it." | Scroll the GTM page. |
| 4:45-5:00 | README on GitHub | "Open source, MIT, one install command: `npm i -g @ishaan_satapathy/click-context`, then `click init`. Link below." | Show the README top. |

## If something goes wrong while recording

- **A request says `graph-replica`**: HydraDB was cold. Run the same command again (the second answer comes from HydraDB). Or say: "if HydraDB is slow, Click answers from its local copy and says so; it never blocks the agent."
- **Claude Code shows no context**: check `bench\repo\.click\logs\hook-*.jsonl` for a new `delivered` line. If there is none, the daemon was not running: run the `click context` command once, then ask Claude again.
- **Never show** the `.env` files, the token or the Google console.
