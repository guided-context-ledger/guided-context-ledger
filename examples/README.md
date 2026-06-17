# Examples — MCP connector config

Drop one of these into your MCP client's config (e.g. Claude Desktop's `claude_desktop_config.json`),
edit the two paths, and **fully restart** the client. Then call `orient` to confirm you're connected.

- **`mcp-config.json`** — runs the connector via `npx` (no clone/build). Use this **once `@guided-context-ledger/connector` is published to npm**.
- **`mcp-config.local.json`** — runs the connector from a local checkout (`node …/packages/connector/dist/index.js`). Use this **today**: `git clone`, `npm install`, `npm run build`, then point `args` at the built `dist/index.js`.

In both, set `GCL_WORKSPACE` to the absolute path of the workspace you want the agent to read and write. It works on an empty folder — `orient` walks you through first-run setup.

See [Set up the connector](../README.md#set-up-the-connector) in the root README for the full walkthrough.
