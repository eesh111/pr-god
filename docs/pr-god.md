# PR-God (auto-review every PR)

Cursor **Automations** need a GitHub connection in [Integrations](https://cursor.com/dashboard/integrations). If that connect fails (common without the [Cursor GitHub App](https://github.com/apps/cursor) installed), use this **GitHub Actions** path instead — same Bugbot playbook + `pr-reviewer` MCP, auto-post `COMMENT` reviews.

## How it works

```
PR opened/synchronized → GitHub Action "PR-God"
  → build pr-checker MCP (stdio)
  → Cursor SDK local agent + playbook
  → post_review (dry_run=false, COMMENT)
```

## Setup (once per repo)

1. Ensure [`eesh111/pr-checker`](https://github.com/eesh111/pr-checker) is reachable by Actions (private: grant access / use a PAT with `contents: read`).
2. In the target repo (e.g. `bugbot-demo`), add workflow [`.github/workflows/pr-god.yml`](../.github/workflows/pr-god.yml) (copy from this repo’s template under `docs/pr-god.workflow.yml`).
3. Create a [Cursor API key](https://cursor.com/dashboard/integrations) and add repo secret **`CURSOR_API_KEY`**.
4. Open or push to a PR → check the **PR-God** check run and the PR’s Conversation tab for the review.

## Manual local run

```bash
export CURSOR_API_KEY=…
export GITHUB_TOKEN=…   # needs PR write
export OWNER=eesh111 REPO=bugbot-demo PR_NUMBER=1
npm run build
npm run pr-god
```

## Sharing with colleagues

| Share | Don’t |
| --- | --- |
| Workflow file + “add `CURSOR_API_KEY` secret” | Personal laptop `mcp.json` |
| Link to this doc | Expecting Cursor Automations without GitHub App |

For IDE manual reviews, keep local stdio MCP + `/review-pr` (see [dashboard-mcp.md](./dashboard-mcp.md)). Automations+HTTP MCP remain optional once GitHub Integrations work.
