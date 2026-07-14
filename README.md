# PR-God

PR-God reviews GitHub pull requests from Cursor. You run `/pr-god` in chat; Cursor’s agent does the judgment; a local MCP server talks to the GitHub API and posts the review.

This repo is the **MCP + playbook** package. There is **no LLM inside the server**.

```
You  →  /pr-god owner/repo #N  →  Cursor agent  →  pr-god MCP (stdio)  →  GitHub PR review
```

## What it does

1. Loads `.github/REVIEW_INSTRUCTIONS.md` from the target repo (hard overrides).
2. Fetches the PR diff and related context.
3. Walks a multi-pass review (logic, security, tests).
4. Drops low-confidence / duplicate findings.
5. Posts one GitHub review (`COMMENT`) with a summary and inline notes.

**Manual only (default):** you start it with `/pr-god`. It does not auto-run on every PR unless you add something else (Actions / Automations).

## Requirements

- Node.js 18+
- Cursor with MCP enabled
- A GitHub token (or GitHub App) with **Contents: read** and **Pull requests: read/write** on repos you review

## Install

```bash
git clone https://github.com/eesh111/pr-god.git
cd pr-god
npm install
npm run build
```

## Configure Cursor MCP

Add to `~/.cursor/mcp.json` (use your absolute path and token):

```json
{
  "mcpServers": {
    "pr-god": {
      "command": "node",
      "args": ["/absolute/path/to/pr-god/dist/mcpServer.js"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token_here"
      }
    }
  }
}
```

Restart Cursor or toggle the server under **Settings → MCP**.

Auth options and limits: see [`.env.example`](.env.example).

## Usage

In Cursor chat:

```text
/pr-god owner/repo #42
```

That run uses the PR-God playbook and **posts** the review (no second confirm).

For dry-run then confirm:

```text
/review-pr owner/repo #42
```

Playbook sources:

- [`.cursor/commands/pr-god.md`](.cursor/commands/pr-god.md)
- [`.cursor/commands/review-pr.md`](.cursor/commands/review-pr.md)
- [`.cursor/rules/pr-review.mdc`](.cursor/rules/pr-review.mdc)

Optional per-repo overrides: commit `.github/REVIEW_INSTRUCTIONS.md` in the app under review.

## MCP tools

| Tool | Role |
| --- | --- |
| `get_review_rules` | Repo review instructions |
| `get_pull_request_diff` | PR metadata + hunks |
| `get_file_content` / `get_file_context` | File text / line window |
| `search_codebase` | Scoped code search (rate-limited) |
| `get_existing_review_comments` | Existing threads (dedupe) |
| `post_review` | One summary + all inlines (`dry_run` supported) |
| `post_comment` | Single inline (prefer `post_review`) |

Built-in safeguards: diff line validation, head SHA lock, large-file blob fallback, structured errors (`unauthorized`, `forbidden`, `rate_limit`, `validation`, …).

## Scripts

```bash
npm run build          # compile TypeScript → dist/
npm start              # stdio MCP (what Cursor launches)
npm test               # offline unit + integration suite
npm run pr-god         # optional CI agent runner (needs CURSOR_API_KEY)
npm run pr-god:offline # optional CI heuristics (GITHUB_TOKEN only)
```

## Sharing with teammates

Each person:

1. Clones this repo and builds it.
2. Points Cursor MCP `pr-god` at their `dist/mcpServer.js` with **their** GitHub token.
3. Runs `/pr-god their-org/their-repo #N` on PRs they can access.

Reviews are posted as the token’s GitHub identity. No hosted MCP and no Cursor API key required for the chat path.

## License

MIT
