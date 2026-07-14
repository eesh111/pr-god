# Team rollout: IDE vs dashboard MCP + multi-repo

## Two MCP registrations (intentional)

| Who / when | Use |
| --- | --- |
| Engineer in Cursor chat | Local **stdio** MCP named `pr-reviewer` in `~/.cursor/mcp.json` + `/review-pr` (dry-run → confirm → post) |
| Every PR automatically | **Dashboard** HTTP MCP (same tool surface) + Cursor Automation on `pull_request` opened/synchronized |

Automations **cannot** call the laptop stdio server. See [dashboard-mcp.md](./dashboard-mcp.md).

## Auth for the bot (recommended)

1. Create a **GitHub App** (not a personal PAT) with Contents read + Pull requests read/write on target repos.
2. Install the App on the org / selected repos.
3. Configure the **hosted** HTTP MCP with `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID` (see `.env.example`).
4. Store App credentials in the host’s secrets manager — never in repo git history.
5. Engineers keep their own PAT/App install only for personal IDE stdio if needed; production Automations should use the shared App.

## Automation playbook (auto-post)

Unlike chat `/review-pr`, the Automation path **skips human confirm** and calls `post_review` with `dry_run: false`, event type `COMMENT` only. Stop on `unauthorized` / `forbidden` / `rate_limit`.

Scope v1 example: repo `eesh111/bugbot-demo`. Expand by editing the Automation trigger’s repo list (or one Automation per team).

## Adding more repos

1. Install the GitHub App on each new repo (or org-wide).
2. In the Automations editor, add the repo to the PR trigger scope.
3. Commit `.github/REVIEW_INSTRUCTIONS.md` in that repo (hard overrides for the agent).
4. Share the Bugbot playbook as a **team Cursor rule** so chat `/review-pr` matches Automation behavior (Automations carry instructions in the workflow prompt; they do not auto-load another repo’s `.cursor/rules`).

## Optional later

- Tighten Automation instructions to “security findings only” if COMMENT noise is high.
- Fallback if dashboard hosting is blocked: GitHub Action on `pull_request` that runs a cloud agent / script with the same GitHub posting path (different product surface).
