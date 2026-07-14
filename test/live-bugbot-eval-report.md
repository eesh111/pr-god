# Live Bugbot MCP evaluation

Target: https://github.com/eesh111/bugbot-demo/pull/1
When: 2026-07-14T06:26:48.833Z

## Auth / connectivity

- OK — authenticated as `eesh111`
- `GITHUB_TOKEN` present: true
- `DOTENV_CONFIG_PATH`: `/tmp/pr-checker-live-eval-nonexistent.env` (nonexistent → ignore local .env)

## Tool-by-tool results

### 1. getReviewRules — PASS (514ms)
- found: true
- path: `.github/REVIEW_INSTRUCTIONS.md`
- note: Treat these rules as HARD overrides: never flag anything the rules say to ignore.

### 2. getPullRequestDiff — PASS (1146ms)
- title: Add coupon checkout, receipts, and profile updates
- head_sha: `6c5f998928eba07600366a8f905edb68c041602d`
- base_sha: `a1bc7c1002e7eccff81389c69a4c1ceb4402d42d`
- changed_files_count: 4
- returned_files_count: 4
- truncated: false
- bytes_used / budget: 4956 / 500000
- omitted_files: []
- files:
  - `src/checkout.js` (modified, +4/-9, patch_present=true)
  - `src/pricing.js` (modified, +6/-11, patch_present=true)
  - `src/server.js` (modified, +40/-2, patch_present=true)
  - `src/users.js` (modified, +4/-23, patch_present=true)

### getFileAroundLine(pricing VIP) — PASS (371ms)
- slice: 1-16 (center 8, total 39)
- snippet preview: 1	/** | 2	 * Pricing helpers for the checkout service. | 3	 */ | 4	 | 5	const COUPONS = { | 6	  SAVE10: 0.1,

### getFileContent(users.js) — PASS (367ms)
- path: `src/users.js` ref=`6c5f998928eba07600366a8f905edb68c041602d` lines=36 source=contents
- contains Object.assign: true
- contains ALLOWED_ROLES: false

### getExistingReviewThreads — PASS (480ms)
- source: graphql
- incomplete: false
- thread_count: 0
- note: Resolved/outdated status is authoritative from GraphQL.

### searchCode("refundOrder") — PASS (413ms)
- total_count: 0
- incomplete_results: false
- matches: (none)

### searchCode("Object.assign updateProfile") — PASS (1976ms)
- total_count: 0
- matches: (none)

## Accuracy — planted bugs visible to a PR-God agent?

| Bug | Locatable from tool data? | Evidence (path:line) |
| --- | --- | --- |
| VIP coupon free | YES | `src/pricing.js:8` — `VIP: 1.0,`; free-path at src/pricing.js:23 |
| no authz on refund | YES | `src/checkout.js:36` — `export function refundOrder(orderId) {` (staff check removed) |
| path traversal loadReceipt | YES | `src/checkout.js:50` — `const receiptPath = path.join(process.cwd(), "receipts", orderId);` |
| open role on createUser | YES | `src/users.js` — role allowlist removed; comment at line near createUser (`* Create a new user (accepts any role).`) |
| Object.assign updateProfile | YES | `src/users.js:33` — `Object.assign(user, parsed);` |
| missing tests for new endpoints | YES | New endpoints in diff (src/server.js:67, src/server.js:77, src/server.js:90); test file changes in PR: **none** — agent can flag missing tests from diff triage alone |

**Score: 6/6 planted bugs have locatable evidence in returned tool data.**

## postReview dry_run validation

### Valid comments (preview)
- `src/pricing.js:23` (RIGHT)
- `src/checkout.js:36` (RIGHT)
- `src/users.js:33` (RIGHT)
### postReview dry_run (valid) — PASS (1166ms)
- posted: false (must be false)
- dry_run: true
- commit_sha: `6c5f998928eba07600366a8f905edb68c041602d`
- comment_count: 3

### postReview dry_run (1 invalid line 99999) — expected validation ToolError
- caught ToolError in 1279ms
- kind: `validation` (OK)
- message: 1 comment(s) target lines that are not part of the diff. GitHub would reject these. Fix the lines or move them to the summary.
- has invalid_comments: true
- nearest_valid_lines: [34,35,36,37,38,39]
- first invalid: path=src/pricing.js line=99999 reason=Line 99999 is not part of the diff on the RIGHT side, so GitHub would reject an inline comment there. Move the comment to a changed/context line, or put the observation in the review summary.
- commentable_lines: 5-26, 32-39
- validation shape assert: PASS

## Safety

- All `postReview` calls used `dry_run: true` only.
- No real review was posted to GitHub.

## Efficiency

- Approximate tool call count: **9**
- Total wall time: **8332ms**
- Per-step latency:
  - getReviewRules: 514ms — ok
  - getPullRequestDiff: 1146ms — ok
  - getFileAroundLine(pricing VIP): 371ms — ok
  - getFileContent(users.js): 367ms — ok
  - getExistingReviewThreads: 480ms — ok
  - searchCode(refundOrder): 413ms — ok
  - searchCode(Object.assign): 1976ms — ok
  - postReview(dry_run, valid): 1166ms — ok
  - postReview(dry_run, invalid line): 1279ms — expected-fail(validation)

## Breakage

- None observed (no crashes, no 422s to GitHub, validation errors were structured ToolErrors).

## Verdict

**ready** — Live Bugbot MCP client tools succeeded against the real PR; planted bugs are visible in diffs/context; dry_run preview works; invalid lines return structured `validation` ToolErrors with `invalid_comments` / `nearest_valid_lines`; nothing was posted to GitHub.

