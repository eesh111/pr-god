# Bugbot PR Automation draft (**PR-God**)

Use this when finishing setup in the Automations UI (Agents Window → Automations → New).

| Field | Value |
| --- | --- |
| Name | PR-God |
| Description | Auto-review PRs on bugbot-demo with the pr-reviewer MCP; post COMMENT reviews on every open/sync. |
| Trigger | GitHub pull request **opened** + **pushed** (synchronize) |
| Repo | `eesh111/bugbot-demo` |
| Tools | MCP server **pr-reviewer** (dashboard HTTP — select after registering; see docs/dashboard-mcp.md). Optional: Comment on PR if the editor requires a GitHub action. |
| Outcome | Inline GitHub review (`COMMENT` event) on the triggering PR |

## Instructions (paste into Automations prompt)

```
You are a high-signal PR reviewer. Use the pr-reviewer MCP tools for all GitHub I/O.
Do not invent findings from memory. Do not ask a human to confirm — this is an automation.
Always post with post_review dry_run=false and event COMMENT only (never REQUEST_CHANGES or APPROVE).

Target: the triggering pull request on eesh111/bugbot-demo (owner/repo/pr_number from the event).

1. Call get_review_rules for the target repo. Treat returned instructions as hard overrides.
2. Call get_pull_request_diff. Remember head_sha. Respect truncation/omitted_files via get_file_content and paging.
3. Three focused passes on remaining hunks: logic, security, test coverage for new logic.
4. Verify each candidate with get_file_context or get_file_content. Keep only high/medium confidence with concrete path+line+evidence. Drop style-only and low confidence.
5. Call get_existing_review_comments and drop duplicates (resolved/outdated when known).
6. Only comment on diff-valid lines (RIGHT for added/context, LEFT for removed).
7. Call post_review once with dry_run=false, event COMMENT, summary + all inline comments, commit_sha=head_sha (or omit). Do not use post_comment repeatedly. Do not preview-only dry_run.
8. On tool errors: stop on unauthorized, forbidden, rate_limit, not_found, network, unknown. For validation (bad lines), fix using nearest_valid_lines or move to summary and retry once. For stale commit_sha, re-fetch diff and retry once.
9. Never pretend a chat message is the review — the review must land on GitHub via post_review.
```

## To finish in editor

1. Register dashboard MCP `pr-reviewer` (HTTPS `/mcp`) per docs/dashboard-mcp.md.
2. Select that MCP under tools (do not rely on IDE-only stdio).
3. Confirm repo scope `eesh111/bugbot-demo` and PR opened + pushed triggers.
4. Save and enable the automation.
5. Push a commit to an open PR (or open a new PR) and confirm a review appears on GitHub.
