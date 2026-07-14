# Agent-driven Bugbot (PR Review MCP)

Your own **Bugbot-style** PR reviewer for Cursor: a **stdio [MCP](https://modelcontextprotocol.io) server**
is the GitHub I/O layer; **Cursor's agent is the brain**. The server is deliberately
**data-in / data-out only** — it wraps GitHub reads/writes and context lookups.
It contains **no review logic, no scoring, and no LLM calls**.

Pair it with the included Cursor rule ([`.cursor/rules/pr-review.mdc`](.cursor/rules/pr-review.mdc))
and slash command [`/review-pr`](.cursor/commands/review-pr.md), which encode the
Bugbot-style multi-pass workflow (evidence bar, confidence filter, dry-run, one confirmed post).

| Layer | Owns | Must not own |
| --- | --- | --- |
| MCP server | GitHub reads/writes, diff math, validation, retries, honest errors | “Is this a bug?”, scoring, LLM |
| Cursor agent | Triage, multi-pass review, confidence, dedupe, preview, confirm, post | Raw GitHub HTTP |

**Triggers:**

| Mode | How |
| --- | --- |
| Manual (IDE) | `/review-pr owner/repo #N` — uses **stdio** MCP from `~/.cursor/mcp.json` |
| Auto (every PR) | Cursor **Automation** on pull request opened/synchronized — needs **dashboard** HTTP MCP; see [docs/dashboard-mcp.md](docs/dashboard-mcp.md) and [docs/team-rollout.md](docs/team-rollout.md) |

## Tools

| Tool | Purpose |
| --- | --- |
| `get_pull_request_diff` | PR title/body, head/base SHA, changed files + diff hunks (`patch_present`, `truncated`, `bytes_used`/`bytes_budget`, `omitted_files`, paging, `previous_filename`) |
| `get_file_content` | Full UTF-8 text at a ref (Contents API, with Git Blobs fallback for large files) |
| `get_file_context` | A window of lines centered on a line (rejects out-of-range lines) |
| `search_codebase` | GitHub code search scoped to the repo (strips foreign `repo:` qualifiers; rate-limited) |
| `get_existing_review_comments` | Review threads with resolved/outdated (GraphQL paginated; REST fallback uses `null` + note) |
| `get_review_rules` | Reads `.github/REVIEW_INSTRUCTIONS.md` from the **target** repo |
| `post_review` | Posts one review = summary + all inline comments (`dry_run` preview; locks to current head SHA) |
| `post_comment` | Posts a single inline comment |

### Reliability behavior worth knowing

- **Line validation (no opaque 422s):** invalid inline lines return `validation` with nearest valid lines.
- **Commit SHA lock:** stale `commit_sha` values are rejected; omit to use current head.
- **Large PRs / files:** omitted patches flagged; blob fallback for Contents >1MB files.
- **Standardized errors:** `not_found`, `unauthorized`, `forbidden`, `rate_limit`, `validation`, `network`, `unknown`.

## Prerequisites

- Node.js 18+
- A GitHub credential (PAT or GitHub App)

## Install & build

```bash
npm install
npm run build
```

Entrypoint: `dist/mcpServer.js`.

## Registering in Cursor (MCP)

### IDE (stdio) — manual `/review-pr`

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "pr-reviewer": {
      "command": "node",
      "args": ["/absolute/path/to/pr-checker/dist/mcpServer.js"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token_here"
      }
    }
  }
}
```

Restart Cursor or toggle the server in **Settings → MCP**.

### Automations (HTTP) — every PR

Local stdio is **not** Automations-eligible. Host Streamable HTTP and register on cursor.com:

```bash
npm run start:http   # listens on PORT (default 8787), path /mcp
```

Full steps (public URL, Bearer, dashboard name `pr-reviewer`, Docker): [docs/dashboard-mcp.md](docs/dashboard-mcp.md).

Any MCP-compatible client can host the tools the same way. The server is **client-agnostic**: it only exposes tools; the agent/LLM lives in the client.

## Using it

- `/review-pr eesh111/bugbot-demo #1` (or any `owner/repo #N`)
- Or: `review PR #1 on eesh111/bugbot-demo using our review rules`

The agent loads rules, diffs, verifies findings, dry-runs `post_review`, and posts only after you confirm.

## Auth

See [`.env.example`](.env.example). PAT needs Contents read + Pull requests read/write. GitHub App needs all three `GITHUB_APP_*` vars and optional `@octokit/auth-app`.

## Tests

```bash
npm test
```

Synthetic only — no real GitHub / no real token.

## License

MIT
