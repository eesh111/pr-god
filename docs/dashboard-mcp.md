# Dashboard MCP (Automations-eligible)

Cursor **IDE** MCP (`~/.cursor/mcp.json` stdio) and Cursor **Automations** MCP are different surfaces.

| Surface | Transport | Config | Can auto-review PRs? |
| --- | --- | --- | --- |
| IDE chat / `/review-pr` | stdio → `dist/mcpServer.js` | `~/.cursor/mcp.json` | No — human prompt only |
| Automations (cloud) | Streamable HTTP → `dist/httpServer.js` | [cursor.com](https://cursor.com) → Settings → MCP | Yes — with a PR trigger |

Automations only resolve MCPs registered on the **dashboard** (personal or team). A local stdio server never appears in the Automations MCP picker.

## 1. Run the HTTP server

Build, then start with the same GitHub auth you use for stdio:

```bash
npm run build
export GITHUB_TOKEN=…          # or GITHUB_APP_* (prefer App for shared bots)
export MCP_HTTP_BEARER=…       # long random secret
npm run start:http             # http://0.0.0.0:8787/mcp
```

Docker:

```bash
docker build -t pr-god-mcp .
docker run --rm -p 8787:8787 \
  -e GITHUB_TOKEN \
  -e MCP_HTTP_BEARER \
  pr-god-mcp
```

Health check: `GET /health` → `{ "ok": true, "name": "pr-god", ... }`.

## 2. Expose a public HTTPS URL

Cursor’s cloud must reach `/mcp` over HTTPS. Options:

- Deploy the Docker image (Fly, Railway, Cloud Run, ECS, etc.)
- Temporary: tunnel localhost (`cloudflared tunnel`, ngrok, etc.) pointing at `http://127.0.0.1:8787`

MCP endpoint URL shape: `https://<host>/mcp`

## 3. Register on cursor.com

1. Open [cursor.com](https://cursor.com) → **Settings → MCP** (or team MCP for shared use).
2. Add a new server:
   - **Name:** `pr-god` (keep this name — Automations drafts look for it)
   - **URL:** `https://<host>/mcp`
   - **Auth:** Bearer / header using the same value as `MCP_HTTP_BEARER`
3. Save and confirm it shows as connected.
4. In Cursor chat, if the server asks to authenticate, complete that **before** drafting Automations (OAuth mid-editor can discard unsaved drafts).

## 4. Confirm Automations eligibility

In **Automations → new automation → tools**, `pr-god` should appear in the MCP list. If it does not, the server is still IDE-only (stdio) or the dashboard entry is misnamed / disconnected.

## 5. Keep IDE stdio for manual reviews

Leave `~/.cursor/mcp.json` pointing at `dist/mcpServer.js` for `/review-pr` in the IDE. Do not remove it when adding the dashboard HTTP server — they coexist.
