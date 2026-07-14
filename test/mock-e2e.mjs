/**
 * Mock end-to-end test (no real GitHub access).
 *
 * Sets a dummy token so config validation passes, injects a fake Octokit into
 * the client, and exercises the tool logic against canned data:
 *   - get_pull_request_diff: real data shape + large-diff handling (gap 2)
 *   - post_review dry_run: preview without posting
 *   - post_review real: posts via the (mock) API
 *   - line validation: off-diff comment is rejected before the API (gap 1)
 *   - standardized error shape: bad PR number -> { isError, kind } (gap 5)
 *   - diffUtils + mapOctokitError unit checks
 *
 * Run after `npm run build`:  node test/mock-e2e.mjs
 */

// Must be set BEFORE importing anything that pulls in config.ts.
process.env.GITHUB_TOKEN = "test-token-not-used";
process.env.MAX_DIFF_PATCH_BYTES = "120"; // small, to trigger truncation

const { __setOctokitForTest, getPullRequestDiff, postReview, postSingleComment } =
  await import("../dist/github/client.js");
const { withToolError, mapOctokitError, ToolError } = await import("../dist/errors.js");
const { parseHunks, validateCommentLine, commentableLinesSummary } = await import(
  "../dist/github/diffUtils.js"
);

// --- tiny assertion helpers ------------------------------------------------

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ""}`);
  }
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}

// --- canned data + fake Octokit -------------------------------------------

// Hunk math for file1 patch below:
//   @@ -10,3 +10,4 @@
//     " line10"  context -> RIGHT 10, LEFT 10
//     "-old11"   removed -> LEFT 11
//     "+new11"   added   -> RIGHT 11
//     "+new12"   added   -> RIGHT 12
//     " line13"  context -> RIGHT 13, LEFT 12
//   => RIGHT commentable: {10,11,12,13}  LEFT: {10,11,12}
const file1Patch = "@@ -10,3 +10,4 @@\n line10\n-old11\n+new11\n+new12\n line13";
const bigPatch = "@@ -1,1 +1,2 @@\n line1\n+" + "x".repeat(300); // > cap after file1

const sampleFiles = [
  {
    filename: "src/app.ts",
    status: "modified",
    additions: 2,
    deletions: 1,
    changes: 3,
    patch: file1Patch,
  },
  {
    filename: "src/huge.ts",
    status: "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: bigPatch, // present, but should be dropped by size cap -> truncated
  },
  {
    filename: "assets/logo.png",
    status: "added",
    additions: 0,
    deletions: 0,
    changes: 0,
    // no patch field -> GitHub omitted it (binary/too large)
  },
];

function makeMockOctokit() {
  const calls = { createReview: 0, createReviewComment: 0 };
  const octokit = {
    calls,
    pulls: {
      async get({ pull_number }) {
        if (pull_number === 999) {
          const err = new Error("Not Found");
          err.status = 404;
          throw err;
        }
        return {
          data: {
            title: "Add feature X",
            body: "This PR adds feature X.",
            head: { sha: "headsha123" },
            base: { sha: "basesha456" },
            changed_files: sampleFiles.length,
          },
        };
      },
      async listFiles() {
        return { data: sampleFiles };
      },
      async createReview({ comments }) {
        calls.createReview++;
        return { data: { id: 5001, html_url: "https://example.test/review/5001", comments } };
      },
      async createReviewComment() {
        calls.createReviewComment++;
        return { data: { id: 6001, html_url: "https://example.test/comment/6001" } };
      },
    },
    // paginate(method, params) -> flatten .data
    async paginate(method, params) {
      const res = await method(params);
      return res.data;
    },
    async graphql() {
      return { repository: { pullRequest: { reviewThreads: { nodes: [] } } } };
    },
    search: {
      async code() {
        return { data: { total_count: 0, incomplete_results: false, items: [] } };
      },
    },
  };
  return octokit;
}

// --- run -------------------------------------------------------------------

const mock = makeMockOctokit();
__setOctokitForTest(mock);

section("diffUtils: hunk parsing + line validation (gap 1)");
{
  const { rightLines, leftLines } = parseHunks(file1Patch);
  check("RIGHT lines are {10,11,12,13}", [...rightLines].sort((a, b) => a - b).join(",") === "10,11,12,13", [...rightLines]);
  check("LEFT lines are {10,11,12}", [...leftLines].sort((a, b) => a - b).join(",") === "10,11,12", [...leftLines]);
  check("line 11 valid on RIGHT", validateCommentLine(file1Patch, 11, "RIGHT").ok === true);
  const bad = validateCommentLine(file1Patch, 99, "RIGHT");
  check("line 99 invalid on RIGHT", bad.ok === false);
  check("invalid result suggests nearest lines", Array.isArray(bad.nearest) && bad.nearest.length > 0, bad.nearest);
  check("commentableLinesSummary is a range string", commentableLinesSummary(file1Patch, "RIGHT") === "10-13", commentableLinesSummary(file1Patch, "RIGHT"));
  check("missing patch => not commentable", validateCommentLine(undefined, 5).ok === false);
}

section("get_pull_request_diff: data + large-diff handling (gap 2)");
{
  const diff = await getPullRequestDiff("o", "r", 42);
  check("title returned", diff.title === "Add feature X");
  check("head_sha returned", diff.head_sha === "headsha123");
  check("changed_files_count = 3", diff.changed_files_count === 3);
  const f1 = diff.files.find((f) => f.filename === "src/app.ts");
  const f2 = diff.files.find((f) => f.filename === "src/huge.ts");
  const f3 = diff.files.find((f) => f.filename === "assets/logo.png");
  check("file1 patch present", f1?.patch_present === true && typeof f1.patch === "string");
  check("file2 truncated by size cap", f2?.patch_present === false && f2?.patch_omitted_reason === "diff_truncated_by_size_limit", f2);
  check("file3 patch unavailable (binary)", f3?.patch_present === false && f3?.patch_omitted_reason === "patch_unavailable_from_github", f3);
  check("truncated flag set", diff.truncated === true);
}

section("get_pull_request_diff: paging passthrough");
{
  const diff = await getPullRequestDiff("o", "r", 42, { page: 1, per_page: 30 });
  check("page echoed", diff.page === 1 && diff.per_page === 30, { page: diff.page, per_page: diff.per_page });
}

section("post_review: dry_run preview (no API call)");
{
  const before = mock.calls.createReview;
  const res = await postReview(
    "o",
    "r",
    42,
    "headsha123",
    "Overall looks good, a couple of notes.",
    [{ path: "src/app.ts", line: 11, body: "Consider null-checking here.", side: "RIGHT" }],
    true, // dry_run
  );
  check("dry_run posted=false", res.posted === false && res.dry_run === true);
  check("dry_run did NOT call createReview", mock.calls.createReview === before);
  check("dry_run echoes comment count", res.comment_count === 1);
}

section("post_review: real post (mock API)");
{
  const before = mock.calls.createReview;
  const res = await postReview(
    "o",
    "r",
    42,
    "headsha123",
    "LGTM with one note.",
    [{ path: "src/app.ts", line: 12, body: "Nit: rename this variable.", side: "RIGHT" }],
    false,
  );
  check("posted=true", res.posted === true);
  check("review_id returned", res.review_id === 5001);
  check("createReview called once", mock.calls.createReview === before + 1);
}

section("post_review: off-diff line rejected before API (gap 1)");
{
  const before = mock.calls.createReview;
  const wrapped = withToolError((args) =>
    postReview(args.owner, args.repo, args.pr, args.sha, args.summary, args.comments, false),
  );
  const out = await wrapped({
    owner: "o",
    repo: "r",
    pr: 42,
    sha: "headsha123",
    summary: "Has a bad line.",
    comments: [{ path: "src/app.ts", line: 999, body: "This line is not in the diff.", side: "RIGHT" }],
  });
  check("returns isError=true", out.isError === true);
  const payload = JSON.parse(out.content[0].text);
  check("kind = validation", payload.error?.kind === "validation", payload.error);
  check("did NOT call createReview", mock.calls.createReview === before);
  check("error details list the invalid comment", Array.isArray(payload.error?.details?.invalid_comments), payload.error?.details);
}

section("post_comment: off-diff line rejected (gap 1)");
{
  const before = mock.calls.createReviewComment;
  const wrapped = withToolError((a) => postSingleComment(a.owner, a.repo, a.pr, a.path, a.line, a.body, a.side));
  const out = await wrapped({ owner: "o", repo: "r", pr: 42, path: "src/app.ts", line: 1, body: "x", side: "RIGHT" });
  check("returns isError=true", out.isError === true);
  check("did NOT call createReviewComment", mock.calls.createReviewComment === before);
}

section("standardized error shape: bad PR number => not_found (gap 5)");
{
  const wrapped = withToolError((a) => getPullRequestDiff(a.owner, a.repo, a.pr));
  const out = await wrapped({ owner: "o", repo: "r", pr: 999 });
  check("returns isError=true", out.isError === true);
  const payload = JSON.parse(out.content[0].text);
  check("kind = not_found", payload.error?.kind === "not_found", payload.error);
}

section("mapOctokitError classification (gap 5)");
{
  check("401 -> unauthorized", mapOctokitError({ status: 401, message: "bad creds" }).kind === "unauthorized");
  check("404 -> not_found", mapOctokitError({ status: 404, message: "missing" }).kind === "not_found");
  check(
    "403 + rate headers -> rate_limit",
    mapOctokitError({ status: 403, message: "rate limit", response: { headers: { "x-ratelimit-remaining": "0" } } }).kind ===
      "rate_limit",
  );
  check("403 plain -> forbidden", mapOctokitError({ status: 403, message: "forbidden" }).kind === "forbidden");
  check("422 -> validation", mapOctokitError({ status: 422, message: "invalid" }).kind === "validation");
  check("network code -> network", mapOctokitError({ code: "ENOTFOUND", message: "dns" }).kind === "network");
  check("ToolError passthrough", mapOctokitError(new ToolError("validation", "x")).kind === "validation");
}

// --- summary ---------------------------------------------------------------

console.log(`\n----------------------------------------`);
console.log(`Mock e2e: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
console.log("All mock e2e checks passed.");
