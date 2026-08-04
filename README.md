# mcp-gnews

GNews MCP — Global news search via GNews API (gnews.io)

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `search_news` | Search global news articles by keyword (e.g., "climate change", "AI regulation"). Returns title, description, content snippet, source, and publication date. Supports language and country filters. |
| `top_headlines` | Fetch current top news headlines from GNews (requires BYO API key). Optionally filter by category (general, world, nation, business, technology, entertainment, sports, science, health), country code, and language. Returns up to 100 articles with title, description, source, and publication date. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "gnews": {
      "url": "https://gateway.pipeworx.io/gnews/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Gnews data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
