# Claude Code MCP notes

Verified against the live Claude Code documentation on 2026-11-16.

- Shared project servers live in `.mcp.json` at the repository root under the top-level `mcpServers` object.
- A local stdio entry uses `command` and `args`. Omitting `type` selects stdio; a URL entry must declare a remote transport type.
- Claude Code supplies `CLAUDE_PROJECT_DIR` to the spawned server. Project servers still require workspace trust and an explicit first-use approval.
- `CLAUDE.md` remains the fallback instruction surface when hook context is absent.

Source: [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp).

The installer keeps a one-time byte-exact backup of a pre-existing `.mcp.json`. Uninstall restores it when no non-Click semantics changed; otherwise it removes only `mcpServers.click` from the current file so later user edits survive.
