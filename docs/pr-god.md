# PR-God (auto-review every PR)

Cursor **Automations** need GitHub connected at [Integrations](https://cursor.com/dashboard/integrations). If that fails, use this **GitHub Actions** path — brand name **PR-God**.

## How it works

```
PR opened/synchronized → GitHub Action "PR-God"
  → build eesh111/pr-god (feature/pr-god)
  → if CURSOR_API_KEY set: Cursor SDK agent + MCP playbook
  → else: offline heuristics via same GitHub I/O layer
  → post_review COMMENT on the PR
```

Live on [`eesh111/bugbot-demo`](https://github.com/eesh111/bugbot-demo/pull/1) (check Actions + Conversation).

## Setup (once per repo)

1. Copy [pr-god.workflow.yml](./pr-god.workflow.yml) → `.github/workflows/pr-god.yml`.
2. Optional but better: add secret **`CURSOR_API_KEY`** from [Cursor Integrations](https://cursor.com/dashboard/integrations) for full agent reviews.
3. Without the key, offline heuristics still post a COMMENT review (`GITHUB_TOKEN` only).
4. Open/push a PR → see the **PR-God** check and review comments.

## Sharing with colleagues

| Share | Don’t |
| --- | --- |
| Workflow file + optional `CURSOR_API_KEY` instructions | Hoping Cursor Automations works without GitHub App |
| This doc / [team-rollout.md](./team-rollout.md) | Personal `~/.cursor/mcp.json` as the every-PR trigger |

IDE manual reviews still use local stdio MCP + `/review-pr` ([dashboard-mcp.md](./dashboard-mcp.md)).
