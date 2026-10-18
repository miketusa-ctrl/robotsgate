# RobotsGate

Generate, validate and check robots.txt rules for AI crawlers. Free; optional Pro key.

## Live service

- Web app and API: https://robotsgate.mike-tusa.workers.dev/
- Pricing and plans: https://robotsgate.mike-tusa.workers.dev/
- Support: digitalpromohub.support@gmail.com

## Use it from an AI assistant (MCP)

RobotsGate is a remote MCP server (Streamable HTTP) at `https://robotsgate.mike-tusa.workers.dev/mcp`. Tools: `list_crawlers`, `generate_robots`, `validate_robots`, `check_site`.

Cursor, Cline and Windsurf accept this config:

```json
{
  "mcpServers": {
    "robotsgate": {
      "type": "http",
      "url": "https://robotsgate.mike-tusa.workers.dev/mcp"
    }
  }
}
```

Claude Desktop: open Settings > Connectors, choose "Add custom connector" and paste `https://robotsgate.mike-tusa.workers.dev/mcp`. Or, for clients that only support local (stdio) servers, use the mcp-remote bridge: `npx mcp-remote https://robotsgate.mike-tusa.workers.dev/mcp`.

VS Code uses a `servers` key instead of `mcpServers`.

The `server.json` file is the [MCP Registry](https://registry.modelcontextprotocol.io) manifest for this server.

## Run your own copy

Requires Node.js 20+ and a Cloudflare account.

```bash
npm install
npx wrangler dev        # local dev server
```

`wrangler.toml` is a template: create your own KV namespaces / D1 databases / rate-limit namespaces and replace the `<PLACEHOLDER>` values before `npx wrangler deploy`. Any secrets the Worker reads go in `wrangler secret put` (or `.dev.vars` locally), never in the repo.

Optional Worker secrets (leave unset if you do not need them): `RAPIDAPI_PROXY_SECRET` (only needed if you sell the API through RapidAPI; it must match the X-RapidAPI-Proxy-Secret header RapidAPI adds).

## License

MIT (c) Digital Promo Hub. See [LICENSE](LICENSE).
