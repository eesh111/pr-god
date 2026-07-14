// Config runs at import time; provide a synthetic token and isolate from .env.
process.env.DOTENV_CONFIG_PATH = "definitely-nonexistent.env";
process.env.GITHUB_TOKEN = "synthetic-token-not-used";
process.env.MAX_DIFF_PATCH_BYTES = "120";

import { harness, expectThrows } from "./helpers/assert.mjs";
import { ToolError } from "../dist/errors.js";
// Dynamic import AFTER env is set: client.js -> config.js reads env at load time,
// and static imports are hoisted above the process.env assignments above.
const {
  __setOctokitForTest,
  getPullRequestDiff,
  getFileContent,
  getFileAroundLine,
  searchCode,
  getExistingReviewThreads,
  postReview,
  postSingleComment,
} = await import("../dist/github/client.js");

const { check, section, done } = harness("unit-client");

const file1Patch = "@@ -10,3 +10,4 @@\n line10\n-old11\n+new11\n+new12\n line13";
const bigPatch = "@@ -1,1 +1,2 @@\n line1\n+" + "x".repeat(300);

const FILES_MIXED = [
  { filename: "src/app.ts", status: "modified", additions: 2, deletions: 1, changes: 3, patch: file1Patch },
  { filename: "src/huge.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: bigPatch },
  { filename: "assets/logo.png", status: "added", additions: 0, deletions: 0, changes: 0 },
];
const FILES_APP_ONLY = [
  { filename: "src/app.ts", status: "modified", additions: 2, deletions: 1, changes: 3, patch: file1Patch },
];

const fileText = "line1\nline2\nline3\nline4\nline5";
const fileContentB64 = Buffer.from(fileText, "utf8").toString("base64");

function makeOctokit(o = {}) {
  const calls = { createReview: 0, createReviewComment: 0, graphql: 0, listReviewComments: 0, get: 0, getTree: 0, getBlob: 0 };
  const files = o.files ?? FILES_MIXED;
  return {
    calls,
    pulls: {
      get:
        o.get ??
        (async () => {
          calls.get++;
          return { data: { title: "T", body: "B", head: { sha: "HEADSHA" }, base: { sha: "BASESHA" }, changed_files: files.length } };
        }),
      listFiles: o.listFiles ?? (async () => ({ data: files })),
      createReview:
        o.createReview ??
        (async () => {
          calls.createReview++;
          return { data: { id: 5001, html_url: "https://x/review/5001" } };
        }),
      createReviewComment:
        o.createReviewComment ??
        (async () => {
          calls.createReviewComment++;
          return { data: { id: 6001, html_url: "https://x/comment/6001" } };
        }),
      listReviewComments:
        o.listReviewComments ??
        (async () => {
          calls.listReviewComments++;
          return { data: o.reviewComments ?? [] };
        }),
    },
    repos: {
      getContent:
        o.getContent ??
        (async () => ({ data: { type: "file", encoding: "base64", content: fileContentB64, size: fileText.length } })),
    },
    git: {
      getTree:
        o.getTree ??
        (async () => {
          calls.getTree++;
          return {
            data: {
              truncated: false,
              tree: [{ path: "src/big.ts", type: "blob", sha: "blobsha1", size: fileText.length }],
            },
          };
        }),
      getBlob:
        o.getBlob ??
        (async () => {
          calls.getBlob++;
          return { data: { encoding: "base64", content: fileContentB64, size: fileText.length } };
        }),
    },
    search: {
      code: o.searchCode ?? (async () => ({ data: { total_count: 0, incomplete_results: false, items: [] } })),
    },
    graphql:
      o.graphql ??
      (async () => {
        calls.graphql++;
        return {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        };
      }),
    async paginate(method, params) {
      const r = await method(params);
      return r.data;
    },
  };
}

section("getPullRequestDiff: metadata + large-diff handling");
{
  __setOctokitForTest(makeOctokit());
  const diff = await getPullRequestDiff("o", "r", 42);
  check("title", diff.title === "T");
  check("head_sha", diff.head_sha === "HEADSHA");
  check("base_sha", diff.base_sha === "BASESHA");
  check("changed_files_count = 3", diff.changed_files_count === 3);
  check("returned_files_count = 3", diff.returned_files_count === 3);
  const f1 = diff.files.find((f) => f.filename === "src/app.ts");
  const f2 = diff.files.find((f) => f.filename === "src/huge.ts");
  const f3 = diff.files.find((f) => f.filename === "assets/logo.png");
  check("app.ts present", f1.patch_present === true && typeof f1.patch === "string");
  check("huge.ts truncated by size", f2.patch_present === false && f2.patch_omitted_reason === "diff_truncated_by_size_limit", f2);
  check("logo.png unavailable", f3.patch_present === false && f3.patch_omitted_reason === "patch_unavailable_from_github", f3);
  check("truncated true", diff.truncated === true);
  check("note present", typeof diff.note === "string" && diff.note.length > 0);
  check("bytes_budget set", diff.bytes_budget === 120, diff.bytes_budget);
  check("bytes_used under budget", typeof diff.bytes_used === "number" && diff.bytes_used <= 120, diff.bytes_used);
  check("omitted_files lists truncated + missing", Array.isArray(diff.omitted_files) && diff.omitted_files.length >= 2, diff.omitted_files);
}

section("getPullRequestDiff: rename previous_filename passthrough");
{
  __setOctokitForTest(
    makeOctokit({
      files: [
        {
          filename: "src/new.ts",
          previous_filename: "src/old.ts",
          status: "renamed",
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: "@@ -0,0 +1,1 @@\n+x",
        },
      ],
    }),
  );
  const diff = await getPullRequestDiff("o", "r", 42);
  check("previous_filename present", diff.files[0].previous_filename === "src/old.ts", diff.files[0]);
}

section("getPullRequestDiff: no truncation when under cap");
{
  __setOctokitForTest(makeOctokit({ files: FILES_APP_ONLY }));
  const diff = await getPullRequestDiff("o", "r", 42);
  check("not truncated", diff.truncated === false);
  check("single file present", diff.files.length === 1 && diff.files[0].patch_present === true);
}

section("getPullRequestDiff: paging passthrough");
{
  __setOctokitForTest(makeOctokit({ files: FILES_APP_ONLY }));
  const diff = await getPullRequestDiff("o", "r", 42, { page: 2, per_page: 25 });
  check("page echoed", diff.page === 2, diff.page);
  check("per_page echoed", diff.per_page === 25, diff.per_page);
}

section("getFileContent: success + guards");
{
  __setOctokitForTest(makeOctokit());
  const fc = await getFileContent("o", "r", "src/app.ts", "ref");
  check("content decoded", fc.content === fileText);
  check("line_count = 5", fc.line_count === 5, fc.line_count);
  check("encoding utf8", fc.encoding === "utf8");

  __setOctokitForTest(makeOctokit({ getContent: async () => ({ data: [{ type: "file", name: "a" }] }) }));
  const dirErr = await expectThrows(() => getFileContent("o", "r", "src", "ref"));
  check("directory => ToolError validation", dirErr instanceof ToolError && dirErr.kind === "validation", dirErr?.kind);

  __setOctokitForTest(makeOctokit({ getContent: async () => ({ data: { type: "submodule" } }) }));
  const subErr = await expectThrows(() => getFileContent("o", "r", "x", "ref"));
  check("non-file => validation", subErr instanceof ToolError && subErr.kind === "validation");

  __setOctokitForTest(
    makeOctokit({
      getContent: async () => ({ data: { type: "file", encoding: "none", size: fileText.length, path: "src/big.ts" } }),
      getTree: async () => ({
        data: { truncated: false, tree: [{ path: "src/big.ts", type: "blob", sha: "blobsha1", size: fileText.length }] },
      }),
    }),
  );
  const viaBlob = await getFileContent("o", "r", "src/big.ts", "ref");
  check("large/no-inline falls back to blob", viaBlob.source === "blob" && viaBlob.content === fileText, viaBlob);

  __setOctokitForTest(
    makeOctokit({
      getContent: async () => ({ data: { type: "file", encoding: "none", size: 50_000_000 } }),
    }),
  );
  const oversizeErr = await expectThrows(() => getFileContent("o", "r", "src/big.ts", "ref"));
  check("oversize blob => validation", oversizeErr instanceof ToolError && oversizeErr.kind === "validation", oversizeErr?.kind);

  const binaryB64 = Buffer.from([104, 105, 0, 110]).toString("base64");
  __setOctokitForTest(makeOctokit({ getContent: async () => ({ data: { type: "file", encoding: "base64", content: binaryB64, size: 4 } }) }));
  const binErr = await expectThrows(() => getFileContent("o", "r", "x", "ref"));
  check("binary (NUL) => validation", binErr instanceof ToolError && binErr.kind === "validation");
}

section("getFileAroundLine: window clamping");
{
  __setOctokitForTest(makeOctokit());
  const mid = await getFileAroundLine("o", "r", "src/app.ts", "ref", 3, 1);
  check("center 3 w1 => start 2", mid.start_line === 2, mid.start_line);
  check("center 3 w1 => end 4", mid.end_line === 4, mid.end_line);
  check("snippet numbered from start", mid.snippet.startsWith("2\t"), mid.snippet.split("\n")[0]);
  check("total_lines = 5", mid.total_lines === 5);

  __setOctokitForTest(makeOctokit());
  const low = await getFileAroundLine("o", "r", "src/app.ts", "ref", 1, 5);
  check("clamps start to 1", low.start_line === 1, low.start_line);

  __setOctokitForTest(makeOctokit());
  const high = await getFileAroundLine("o", "r", "src/app.ts", "ref", 5, 10);
  check("clamps end to total (5)", high.end_line === 5, high.end_line);

  __setOctokitForTest(makeOctokit());
  const oor = await expectThrows(() => getFileAroundLine("o", "r", "src/app.ts", "ref", 99, 1));
  check("line past EOF => validation", oor instanceof ToolError && oor.kind === "validation", oor?.kind);
}

section("searchCode: mapping");
{
  __setOctokitForTest(
    makeOctokit({
      searchCode: async () => ({
        data: {
          total_count: 1,
          incomplete_results: false,
          items: [{ path: "src/app.ts", repository: { full_name: "o/r" }, html_url: "https://x/app", score: 3.2 }],
        },
      }),
    }),
  );
  const res = await searchCode("o", "r", "TODO");
  check("query scoped to repo", res.query === "TODO repo:o/r", res.query);
  check("total_count = 1", res.total_count === 1);
  check("one match", res.matches.length === 1 && res.matches[0].path === "src/app.ts");
  check("note about rate limit", /rate-limit/i.test(res.note));
}

section("searchCode: strips embedded repo qualifiers");
{
  let seenQ = null;
  __setOctokitForTest(
    makeOctokit({
      searchCode: async ({ q }) => {
        seenQ = q;
        return { data: { total_count: 0, incomplete_results: false, items: [] } };
      },
    }),
  );
  const res = await searchCode("o", "r", "foo repo:evil/other");
  check("stripped foreign repo qualifier", res.query === "foo repo:o/r" && seenQ === "foo repo:o/r", { query: res.query, seenQ });
}

section("getExistingReviewThreads: graphql success");
{
  __setOctokitForTest(
    makeOctokit({
      graphql: async () => ({
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  isResolved: true,
                  isOutdated: false,
                  comments: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [{ path: "src/app.ts", line: 11, originalLine: 11, body: "old note", author: { login: "bot" } }],
                  },
                },
              ],
            },
          },
        },
      }),
    }),
  );
  const res = await getExistingReviewThreads("o", "r", 42);
  check("source graphql", res.source === "graphql", res.source);
  check("thread_count 1", res.thread_count === 1);
  check("incomplete false", res.incomplete === false);
  check("resolved true", res.threads[0].resolved === true);
  check("comment mapped", res.threads[0].comments[0].path === "src/app.ts" && res.threads[0].comments[0].author === "bot");
}

section("getExistingReviewThreads: graphql fails => REST fallback");
{
  __setOctokitForTest(
    makeOctokit({
      graphql: async () => {
        throw new Error("graphql down");
      },
      reviewComments: [{ path: "src/app.ts", line: 12, original_line: 12, body: "rest note", user: { login: "dev" } }],
    }),
  );
  const res = await getExistingReviewThreads("o", "r", 42);
  check("source rest", res.source === "rest", res.source);
  check("thread_count 1", res.thread_count === 1);
  check("resolved null in rest fallback", res.threads[0].resolved === null);
  check("outdated null in rest fallback", res.threads[0].outdated === null);
  check("note warns about unknown resolved", /unknown/i.test(res.note), res.note);
  check("author mapped from user.login", res.threads[0].comments[0].author === "dev");
}

section("postReview: dry_run preview (no API call)");
{
  const octo = makeOctokit({ files: FILES_APP_ONLY });
  __setOctokitForTest(octo);
  const res = await postReview("o", "r", 42, "HEADSHA", "summary", [{ path: "src/app.ts", line: 11, body: "note", side: "RIGHT" }], true);
  check("posted false", res.posted === false);
  check("dry_run true", res.dry_run === true);
  check("comment_count 1", res.comment_count === 1);
  check("createReview NOT called", octo.calls.createReview === 0);
}

section("postReview: real post");
{
  const octo = makeOctokit({ files: FILES_APP_ONLY });
  __setOctokitForTest(octo);
  const res = await postReview("o", "r", 42, "HEADSHA", "summary", [{ path: "src/app.ts", line: 12, body: "nit" }], false);
  check("posted true", res.posted === true);
  check("review_id 5001", res.review_id === 5001);
  check("createReview called once", octo.calls.createReview === 1);
}

section("postReview: LEFT side valid line");
{
  const octo = makeOctokit({ files: FILES_APP_ONLY });
  __setOctokitForTest(octo);
  const res = await postReview("o", "r", 42, "HEADSHA", "summary", [{ path: "src/app.ts", line: 11, body: "left note", side: "LEFT" }], false);
  check("LEFT 11 posts", res.posted === true);
}

section("postReview: resolves head sha when commit omitted");
{
  const octo = makeOctokit({ files: FILES_APP_ONLY });
  __setOctokitForTest(octo);
  const res = await postReview("o", "r", 42, undefined, "summary", [], false);
  check("commit_sha resolved to head", res.commit_sha === "HEADSHA", res.commit_sha);
  check("empty comments still posts", res.posted === true && res.comment_count === 0);
}

section("postReview: rejects stale commit_sha");
{
  const octo = makeOctokit({ files: FILES_APP_ONLY });
  __setOctokitForTest(octo);
  const err = await expectThrows(() =>
    postReview("o", "r", 42, "STALESHA", "summary", [{ path: "src/app.ts", line: 11, body: "x" }], false),
  );
  check("stale sha => validation", err instanceof ToolError && err.kind === "validation", err?.kind);
  check("details include current_head", err.details?.current_head === "HEADSHA", err?.details);
  check("createReview NOT called for stale sha", octo.calls.createReview === 0);
}

section("postReview: invalid line rejected before API");
{
  const octo = makeOctokit({ files: FILES_APP_ONLY });
  __setOctokitForTest(octo);
  const err = await expectThrows(() =>
    postReview("o", "r", 42, "HEADSHA", "summary", [{ path: "src/app.ts", line: 999, body: "bad", side: "RIGHT" }], false),
  );
  check("throws ToolError validation", err instanceof ToolError && err.kind === "validation", err?.kind);
  check("details list invalid comment", Array.isArray(err.details?.invalid_comments) && err.details.invalid_comments[0].line === 999, err?.details);
  check("createReview NOT called on invalid", octo.calls.createReview === 0);
}

section("postReview: comment on file not in PR rejected");
{
  const octo = makeOctokit({ files: FILES_APP_ONLY });
  __setOctokitForTest(octo);
  const err = await expectThrows(() =>
    postReview("o", "r", 42, "HEADSHA", "summary", [{ path: "not/in/pr.ts", line: 1, body: "x" }], false),
  );
  check("throws validation for unknown file", err instanceof ToolError && err.kind === "validation");
  check("createReview NOT called", octo.calls.createReview === 0);
}

section("postSingleComment: valid + invalid");
{
  const octoOk = makeOctokit({ files: FILES_APP_ONLY });
  __setOctokitForTest(octoOk);
  const ok = await postSingleComment("o", "r", 42, "src/app.ts", 11, "note", "RIGHT");
  check("valid comment posts", ok.posted === true && ok.comment_id === 6001);
  check("createReviewComment called once", octoOk.calls.createReviewComment === 1);

  const octoBad = makeOctokit({ files: FILES_APP_ONLY });
  __setOctokitForTest(octoBad);
  const err = await expectThrows(() => postSingleComment("o", "r", 42, "src/app.ts", 999, "note", "RIGHT"));
  check("invalid line throws validation", err instanceof ToolError && err.kind === "validation");
  check("createReviewComment NOT called", octoBad.calls.createReviewComment === 0);
}

done();
