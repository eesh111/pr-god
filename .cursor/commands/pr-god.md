Run **PR-God** on a GitHub pull request using the `pr-god` MCP
(agent in this chat = judgment; MCP = GitHub I/O only).

**Manual trigger:** invoking this command is the go-ahead to review and post.
Do **not** wait for a second confirmation. Do **not** require a Cursor API key
or GitHub Actions.

Arguments (free-form): the target repo and PR, e.g.
`/pr-god eesh111/bugbot-demo #1` or `/pr-god PR 1 on eesh111/bugbot-demo`.
If omitted and this repo is the checkout, infer `owner/repo` from `git remote`
and ask only for the PR number if still unclear.

Workflow (same order as `.cursor/rules/pr-review.mdc`, with auto-post):

1. `get_review_rules` first; treat results as hard overrides.
2. `get_pull_request_diff`, remember `head_sha`, triage (skip
   generated/lockfiles/formatting; `get_file_content` for missing/truncated
   patches; `page`/`per_page` when truncated).
3. Three focused passes: logic, security, test coverage.
4. Verify each candidate with `get_file_context`/`get_file_content`; require
   path + diff-valid line + one-sentence evidence. `search_codebase` sparingly.
5. Confidence filter (drop low); drop style-only / preference nits.
6. `get_existing_review_comments`; drop duplicates; if `source` is `rest` or
   `resolved` is null, note that resolved status is unknown.
7. Only comment on diff-valid lines.
8. Call `post_review` **once** with `dry_run: false`, `event: COMMENT` only
   (never REQUEST_CHANGES / APPROVE), same `head_sha` (or omit `commit_sha`).
   Skip dry-run preview-and-wait. You may briefly summarize in chat *after*
   the tool returns what was posted.
9. On tool `isError`, follow the kind→action table in the pr-review rule;
   stop on unauthorized / forbidden / rate_limit.
10. Never pretend a chat message is the GitHub review — posting is via
    `post_review` only.

If there are zero high/medium findings, still `post_review` with a short
COMMENT summary stating that.
