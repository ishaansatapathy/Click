# Codex integration notes

Verified against the live OpenAI Codex documentation on 2026-11-16.

- Codex reads personal settings from `~/.codex/config.toml` and trusted project settings from `.codex/config.toml`. Click uses the project layer so installing it in one repository does not alter every Codex session. The CLI, IDE extension, and desktop app share these layers.
- A stdio MCP server is a `[mcp_servers.<name>]` TOML table. Its launcher uses `command` plus an `args` array; `cwd` is optional.
- Current Codex releases support project-local lifecycle hooks in `.codex/config.toml` or `.codex/hooks.json`. `UserPromptSubmit` command hooks receive the prompt on stdin and accept `hookSpecificOutput.additionalContext`, the same output envelope Click's Claude hook already emits. Click therefore reuses the bundled prompt hook rather than adding an adapter.
- Repository instructions belong in a root `AGENTS.md`; nested `AGENTS.md` files can refine them for subdirectories.

Sources:

- [Codex config basics](https://developers.openai.com/codex/config-basic/)
- [Codex MCP configuration](https://developers.openai.com/codex/mcp/)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md/)

Implementation choice: `install/codex.ts` owns only explicitly delimited Click blocks. It refuses an existing user-owned `[mcp_servers.click]` table or malformed markers instead of rewriting TOML/Markdown it does not own.
