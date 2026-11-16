# Agents working together

Click gives every coding agent attached to one repository a small shared board. Claude Code, Codex, Cursor, VS Code and any other MCP client use the same per-repository daemon, so a finding made in one client can reach the next client without asking it to explore the same code again.

The board is agent-agnostic. Agents identify themselves with a short stable name such as `Claude Code`, `Codex` or `Cursor`; Click does not depend on a vendor session identifier.

## The workflow

At the start of a task, an agent should:

1. Call `read_notes` for recent findings and handoffs.
2. Call `list_tasks` to check the shared queue.
3. Call `claim_task` before taking an open task.
4. Call `get_context` with its agent name before changing code.

While working, `leave_note` records a discovery that another agent should not have to rediscover. When work finishes or pauses, `handoff` records what changed, what remains and which files matter. `done_task` closes a claimed task, and `who_is_working` shows recently active agents, their latest task and the files associated with them.

`click init` puts these rules in Click's marked block in `CLAUDE.md` and `AGENTS.md`. The MCP server repeats them in its host-neutral instructions and in the individual tool descriptions. Running init twice is idempotent; `click uninstall` removes only Click's marked blocks and restores pre-existing files byte-for-byte.

## What reaches the next agent

Notes and handoffs are durable entries on the board. Click also records the files an agent reports editing through `report_outcome`. When another agent asks for context involving the same files, the daemon can add a bounded section named `From other agents on this repo` containing relevant recent handoffs and edit warnings. It remains inside the request's token budget and the Claude Code hook's character cap, and an agent does not receive its own notes.

The board lives in `.click/board.jsonl`. It is append-only local repository state and survives daemon restarts. It is not uploaded by the board feature.

## MCP tools

| Tool | When to use it |
|---|---|
| `read_notes(since?, files?)` | At the start of a task, before exploring. |
| `list_tasks(status?)` | At the start of a task and whenever idle. |
| `claim_task(id, author)` | Immediately before starting a listed task. |
| `leave_note(author, text, files?)` | When a reusable finding should outlive the current session. |
| `handoff(author, text, files?)` | When finishing or pausing work. |
| `add_task(author, title, details?, files?)` | When another agent can take a concrete independent task. |
| `done_task(id, author, summary?)` | After completing a claimed task. |
| `who_is_working()` | Before touching shared or high-conflict files. |

The existing `get_context` and `report_outcome` tools accept an optional `agent` name. Supplying the same name lets Click hide the caller's own notes and attribute edit warnings correctly.

## CLI

The same board is available without an MCP client:

```powershell
click notes
click notes --add "The auth refresh path is in src/auth/session.ts" --as Codex
click notes --add "Refresh is fixed; tests pass" --as Codex --handoff

click tasks
click tasks --add "Add the refresh regression test" --as "Claude Code"
click tasks --claim t_123 --as Codex
click tasks --done t_123 --as Codex --summary "Regression test added"

click agents
```

`click notes --json`, `click tasks --json` and `click agents --json` provide machine-readable output. For the short `click tasks --done <id>` form, Click uses `CLICK_AGENT`, then the operating-system username; `--as` always overrides it.

## What this does not do

Click is not live agent chat and it does not stream one model's conversation into another model. It does not launch agents, choose a planner, assign work automatically, merge branches or resolve edit conflicts. Agents still run in their own clients and worktrees.

The shared board provides durable coordination primitives: notes, handoffs, a claimable task list, presence and relevant edit warnings. The agents—or the human supervising them—decide how to use those primitives.
