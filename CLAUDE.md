# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

This is an **MCP (Model Context Protocol) server** that exposes OpenAI embedding tools to Claude Code and other MCP clients. It is used as the `embedding-server` MCP in the Messenger × Supabase orchestrator workflow.

## Running the server

```bash
OPENAI_API_KEY=<your_key> node index.js
# or with hot reload during development:
OPENAI_API_KEY=<your_key> pnpm tsx index.js
```

The server communicates over **stdio** (StdioServerTransport) — it is not an HTTP server.

## MCP tools exposed

| Tool | Description |
|---|---|
| `embed_text` | Vectorise a single text string via OpenAI |
| `embed_batch` | Vectorise up to 100 strings in one call |

Default model: `text-embedding-3-small` (1536 dimensions). Also supports `text-embedding-3-large`.

## MCP configuration (for Claude Code)

```json
{
  "embedding-server": {
    "command": "node",
    "args": ["/home/rxg/bot/index.js"],
    "env": {
      "OPENAI_API_KEY": "<your_key>"
    }
  }
}
```

## Architecture

Single-file project (`index.js`). Uses:
- `@modelcontextprotocol/sdk` — MCP server + stdio transport
- `openai` — OpenAI embeddings API
- `zod` — input schema validation for tool parameters

## Supabase integration

This server is used alongside a Supabase project (`ymdngagxbpjqanczloyv`) that has a `ve-products` table with a `embedding` vector column and a `match_images` RPC function for cosine similarity search.

After getting a vector from `embed_text`, call `match_images` via **POST** (not SQL):

```bash
# Write payload to file first (vector is 1536 floats — never inline in curl)
python3 -c "
import json
payload = {'query_embedding': [...], 'match_threshold': 0.2, 'match_count': 5}
json.dump(payload, open('/tmp/match_payload.json', 'w'))
"

curl -s -X POST "https://ymdngagxbpjqanczloyv.supabase.co/rest/v1/rpc/match_images" \
  -H "apikey: <ANON_KEY>" \
  -H "Authorization: Bearer <ANON_KEY>" \
  -H "Content-Type: application/json" \
  -d @/tmp/match_payload.json
```

Use `mcp__supabase__get_project_url` and `mcp__supabase__get_publishable_keys` to retrieve the URL and anon key dynamically.
