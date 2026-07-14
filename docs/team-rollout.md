# Team rollout: IDE MCP, Automations, and PR-God (GHA)

## Reality check (this project)

Cursor **Automations** only fire after GitHub is connected at [cursor.com/dashboard/integrations](https://cursor.com/dashboard/integrations) (install the [Cursor GitHub App](https://github.com/apps/cursor) on the repo). If that connect fails, use **PR-God via GitHub Actions** instead — [docs/pr-god.md](./pr-god.md). That is the finished path for `eesh111/bugbot-demo`.

## Two MCP surfaces (when you use IDE / Automations)

| Who / when | Use |
| --- | --- |
| Engineer in Cursor chat | Local **stdio** MCP `pr-reviewer` in `~/.cursor/mcp.json` + `/review-pr` |
| Cursor Automations (cloud) | **Dashboard** HTTP MCP — only if GitHub Integrations work; see [dashboard-mcp.md](./dashboard-mcp.md) |
| Every PR without Automations | **PR-God** GHA (`CURSOR_API_KEY` secret) + stdio MCP in CI |

## Auth for the bot (recommended)

1. Create a **GitHub App** or use Actions `GITHUB_TOKEN` (PR-God workflow already requests `pull-requests: write`).
2. For CI agent brain: team/shared **CURSOR_API_KEY** in each repo’s Actions secrets.
3. Engineers keep personal PAT only for local `/review-pr` if needed.

## Adding more repos

1. Copy `.github/workflows/pr-god.yml` from `bugbot-demo` (or `docs/pr-god.workflow.yml`).
2. Add secret `CURSOR_API_KEY`.
3. Commit `.github/REVIEW_INSTRUCTIONS.md`.
4. If `pr-checker` is private, make it public or add a read PAT for checkout.

## Optional: Cursor Automations later

Once GitHub Integrations connect successfully: register dashboard MCP, bind MCP to automation **PR-God**, same playbook with auto `post_review`. Until then, GHA is the supported “every PR” path.
