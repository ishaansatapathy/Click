# MCP TypeScript SDK notes

Verified against the official TypeScript SDK v2 documentation on 2026-11-16:

- Server package: `@modelcontextprotocol/server`; client package: `@modelcontextprotocol/client`.
- A server registers tools with `McpServer.registerTool(name, { description, inputSchema }, handler)`.
- Stdio servers use `serveStdio(() => server)` from `@modelcontextprotocol/server/stdio`.
- Tests can connect a real `Client` and `McpServer` with `InMemoryTransport.createLinkedPair()`.
- The v2 examples use Zod 4 schemas from `zod/v4`.

Sources:

- <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/index.md>
- <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md>
- <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/client.md>
