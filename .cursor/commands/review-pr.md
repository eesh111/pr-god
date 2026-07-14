Review a GitHub pull request using the `pr-god` MCP server tools
(PR-God: MCP = I/O, you = judgment).

Arguments (free-form after the command): the target repo and PR, e.g.
`/review-pr owner/repo #42` or `/review-pr PR 42 on owner/repo`.

Follow the full workflow defined in the `pr-review` project rule
(`.cursor/rules/pr-review.mdc`), in order:

1. `get_review_rules` first; treat results as hard overrides.
2. `get_pull_request_diff`, remember `head_sha`, triage (skip
   generated/lockfiles/formatting; fall back to `get_file_content` for
   missing/truncated patches; use `page`/`per_page` when `truncated`).
3. Three focused passes: logic, security, test coverage.
4. Verify each candidate with `get_file_context`/`get_file_content`; require
   path + diff-valid line + one-sentence evidence. Use `search_codebase`
   sparingly (plain queries only).
5. Confidence filter (drop low); drop style-only / preference nits.
6. `get_existing_review_comments`; drop duplicates; if `source` is `rest` or
   `resolved` is null, warn that resolved status is unknown.
7. Only comment on lines that are part of the diff.
8. Preview findings with severity/category/path/line/side/evidence/(optional fix).
9. `post_review` with `dry_run: true`, show findings, and post with
   `dry_run: false` only after the user confirms (use the same `head_sha`).
10. On tool `isError`, follow the kind→action table in the rule; do not blindly retry.
11. Never post the review as a plain chat message.
