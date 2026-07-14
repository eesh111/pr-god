import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { config } from "../config.js";
import { ToolError } from "../errors.js";
import {
  commentableLinesSummary,
  isPatchPresent,
  validateCommentLine,
  type DiffSide,
} from "./diffUtils.js";

/**
 * Plain async GitHub wrapper functions. No MCP types here - the MCP layer in
 * mcpServer.ts calls these and shapes the results. Errors are thrown (as
 * ToolError or raw Octokit errors) and normalized by withToolError upstream.
 */

const ThrottledOctokit = Octokit.plugin(retry, throttling);

let octokitPromise: Promise<Octokit> | null = null;

/**
 * Lazily construct a single Octokit instance with retry + throttling plugins.
 * Shared by client wrappers and the review-rules loader.
 */
export async function getOctokit(): Promise<Octokit> {
  if (octokitPromise) return octokitPromise;

  octokitPromise = (async (): Promise<Octokit> => {
    const throttle = {
      onRateLimit(
        retryAfter: number,
        options: { method?: string; url?: string },
        _octokit: unknown,
        retryCount: number,
      ): boolean {
        console.error(
          `[pr-review-mcp] rate limit on ${options.method} ${options.url}; ` +
            `retry #${retryCount + 1} in ${retryAfter}s`,
        );
        return retryCount < 3;
      },
      onSecondaryRateLimit(
        retryAfter: number,
        options: { method?: string; url?: string },
        _octokit: unknown,
        retryCount: number,
      ): boolean {
        console.error(
          `[pr-review-mcp] secondary rate limit on ${options.method} ${options.url}; ` +
            `retry #${retryCount + 1} in ${retryAfter}s`,
        );
        return retryCount < 2;
      },
    };

    const common = {
      ...(config.apiBaseUrl ? { baseUrl: config.apiBaseUrl } : {}),
      throttle,
    };

    if (config.authMode === "app") {
      // GitHub App auth is wired but optional: it needs @octokit/auth-app.
      // Kept as a guarded dynamic import so PAT users don't need the package.
      let createAppAuth: unknown;
      try {
        // Non-literal specifier: keep '@octokit/auth-app' an optional runtime
        // dependency so PAT users don't need it installed (or type-checked).
        const authAppSpecifier = "@octokit/auth-app";
        const mod = (await import(authAppSpecifier)) as { createAppAuth: unknown };
        createAppAuth = mod.createAppAuth;
      } catch {
        throw new ToolError(
          "unauthorized",
          "GitHub App auth is configured but the '@octokit/auth-app' package is not installed. " +
            "Run `npm install @octokit/auth-app`, or use GITHUB_TOKEN (PAT) instead.",
        );
      }
      const app = config.app!;
      return new ThrottledOctokit({
        ...common,
        authStrategy: createAppAuth as never,
        auth: {
          appId: app.appId,
          privateKey: app.privateKey,
          installationId: app.installationId,
        },
      }) as unknown as Octokit;
    }

    return new ThrottledOctokit({
      ...common,
      auth: config.githubToken,
    }) as unknown as Octokit;
  })();

  return octokitPromise;
}

/**
 * Test-only hook: inject a fake Octokit so the wrappers can be exercised
 * without network access. Not used in production code paths.
 */
export function __setOctokitForTest(instance: unknown): void {
  octokitPromise = Promise.resolve(instance as Octokit);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiffFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  previous_filename?: string;
  patch: string | null;
  patch_present: boolean;
  patch_omitted_reason?: "patch_unavailable_from_github" | "diff_truncated_by_size_limit";
}

export interface OmittedDiffFile {
  filename: string;
  reason: DiffFile["patch_omitted_reason"];
}

export interface PullRequestDiff {
  title: string;
  body: string | null;
  head_sha: string;
  base_sha: string;
  changed_files_count: number;
  returned_files_count: number;
  truncated: boolean;
  bytes_used: number;
  bytes_budget: number;
  omitted_files: OmittedDiffFile[];
  page?: number;
  per_page?: number;
  note: string;
  files: DiffFile[];
}

export interface DiffOptions {
  /** 1-based page for single-page fetch. Omit to fetch all files (capped). */
  page?: number;
  /** Files per page (max 100). Only used with `page`. */
  per_page?: number;
}

export interface InlineComment {
  path: string;
  line: number;
  body: string;
  side?: DiffSide;
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * PR metadata + changed files with diff hunks.
 *
 * Handles large-diff gotchas:
 *  - Files where GitHub omits `patch` (too large / binary) are flagged
 *    `patch_present: false` with a reason; agent should fall back to
 *    get_file_content for those.
 *  - Total patch bytes are capped; overflow files have their patch dropped and
 *    `truncated` is set so the agent can page.
 *  - Optional `page`/`per_page` allow pulling a huge PR in slices.
 */
export async function getPullRequestDiff(
  owner: string,
  repo: string,
  pr_number: number,
  opts: DiffOptions = {},
): Promise<PullRequestDiff> {
  const octokit = await getOctokit();

  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: pr_number });

  const paged = typeof opts.page === "number";
  const per_page = Math.min(opts.per_page ?? (paged ? 30 : 100), 100);

  let rawFiles: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
    previous_filename?: string;
    patch?: string;
  }>;

  if (paged) {
    const { data } = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: pr_number,
      per_page,
      page: opts.page,
    });
    rawFiles = data;
  } else {
    // Fetch all pages, but never balloon unboundedly: GitHub itself caps
    // patch-bearing files around 300 on big PRs.
    rawFiles = await octokit.paginate(octokit.pulls.listFiles, {
      owner,
      repo,
      pull_number: pr_number,
      per_page: 100,
    });
  }

  const maxBytes = config.maxDiffPatchBytes;
  let usedBytes = 0;
  let truncated = false;
  const omitted_files: OmittedDiffFile[] = [];

  const files: DiffFile[] = rawFiles.map((f) => {
    const base = {
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      ...(f.previous_filename ? { previous_filename: f.previous_filename } : {}),
    };

    const present = isPatchPresent({ patch: f.patch });
    if (!present) {
      const reason = "patch_unavailable_from_github" as const;
      omitted_files.push({ filename: f.filename, reason });
      return {
        ...base,
        patch: null,
        patch_present: false,
        patch_omitted_reason: reason,
      };
    }

    const patchBytes = Buffer.byteLength(f.patch as string, "utf8");
    if (usedBytes + patchBytes > maxBytes) {
      truncated = true;
      const reason = "diff_truncated_by_size_limit" as const;
      omitted_files.push({ filename: f.filename, reason });
      return {
        ...base,
        patch: null,
        patch_present: false,
        patch_omitted_reason: reason,
      };
    }

    usedBytes += patchBytes;
    return {
      ...base,
      patch: f.patch as string,
      patch_present: true,
    };
  });

  const noteParts = [
    "For any file with patch_present=false (too large/binary or truncated), call get_file_content to inspect it.",
  ];
  if (truncated) {
    noteParts.push(
      paged
        ? `This page hit the ${maxBytes}-byte patch budget; try another page or a smaller per_page.`
        : `Patch budget (${maxBytes} bytes) was exceeded. Re-fetch with page/per_page (e.g. page=1, per_page=30) so each slice gets a fresh budget, or raise MAX_DIFF_PATCH_BYTES.`,
    );
  }

  return {
    title: pr.title,
    body: pr.body ?? null,
    head_sha: pr.head.sha,
    base_sha: pr.base.sha,
    changed_files_count: pr.changed_files,
    returned_files_count: files.length,
    truncated,
    bytes_used: usedBytes,
    bytes_budget: maxBytes,
    omitted_files,
    ...(paged ? { page: opts.page, per_page } : {}),
    note: noteParts.join(" "),
    files,
  };
}

export interface FileContent {
  path: string;
  ref: string;
  size: number;
  encoding: string;
  line_count: number;
  content: string;
  source: "contents" | "blob";
}

function decodeUtf8Text(path: string, decoded: Buffer, size: number, ref: string, source: FileContent["source"]): FileContent {
  if (decoded.subarray(0, 8000).includes(0)) {
    throw new ToolError("validation", `File '${path}' appears to be binary; not returning content.`);
  }
  const content = decoded.toString("utf8");
  return {
    path,
    ref,
    size,
    encoding: "utf8",
    line_count: content.split("\n").length,
    content,
    source,
  };
}

/**
 * Resolve a path at ref to a git blob SHA via the Git Trees API (recursive).
 * Used when the Contents API omits inline content for large files.
 */
async function resolveBlobSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<{ sha: string; size: number }> {
  const { data: treeData } = await octokit.git.getTree({
    owner,
    repo,
    tree_sha: ref,
    recursive: "true",
  });

  const entry = treeData.tree.find((t) => t.path === path && t.type === "blob");
  if (!entry?.sha) {
    throw new ToolError(
      "not_found",
      `Could not resolve blob SHA for '${path}' at ref '${ref}'.`,
    );
  }
  if (treeData.truncated) {
    console.error(
      `[pr-review-mcp] git tree for ${owner}/${repo}@${ref} was truncated; ` +
        `blob lookup for '${path}' may miss nested paths in very large repos.`,
    );
  }
  return { sha: entry.sha, size: entry.size ?? 0 };
}

async function fetchViaBlob(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
  knownSize?: number,
): Promise<FileContent> {
  const maxBytes = config.maxFileContentBytes;
  const sizeHint = knownSize ?? 0;
  if (sizeHint > maxBytes) {
    throw new ToolError(
      "validation",
      `File '${path}' is ${sizeHint} bytes, which exceeds MAX_FILE_CONTENT_BYTES (${maxBytes}). ` +
        `Raise the limit or inspect the file outside this tool.`,
      { size: sizeHint, max_bytes: maxBytes },
    );
  }

  const { sha, size: treeSize } = await resolveBlobSha(octokit, owner, repo, path, ref);
  const effectiveSize = knownSize && knownSize > 0 ? knownSize : treeSize;
  if (effectiveSize > maxBytes) {
    throw new ToolError(
      "validation",
      `File '${path}' is ${effectiveSize} bytes, which exceeds MAX_FILE_CONTENT_BYTES (${maxBytes}).`,
      { size: effectiveSize, max_bytes: maxBytes },
    );
  }

  const { data: blob } = await octokit.git.getBlob({ owner, repo, file_sha: sha });
  if (blob.encoding !== "base64" || typeof blob.content !== "string") {
    throw new ToolError(
      "validation",
      `Blob for '${path}' did not return base64 content (encoding: ${blob.encoding}).`,
    );
  }

  const decoded = Buffer.from(blob.content.replace(/\n/g, ""), "base64");
  if (decoded.length > maxBytes) {
    throw new ToolError(
      "validation",
      `Decoded blob for '${path}' is ${decoded.length} bytes, exceeding MAX_FILE_CONTENT_BYTES (${maxBytes}).`,
      { size: decoded.length, max_bytes: maxBytes },
    );
  }

  return decodeUtf8Text(path, decoded, blob.size ?? decoded.length, ref, "blob");
}

/** Full text of a file at a ref. Guards binary / oversized blobs; falls back to Git Blobs API. */
export async function getFileContent(
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<FileContent> {
  const octokit = await getOctokit();
  const { data } = await octokit.repos.getContent({ owner, repo, path, ref });

  if (Array.isArray(data)) {
    throw new ToolError("validation", `Path '${path}' is a directory, not a file.`);
  }
  if (data.type !== "file") {
    throw new ToolError("validation", `Path '${path}' is not a file (type: ${data.type}).`);
  }

  if (typeof data.content === "string" && data.encoding === "base64") {
    const decoded = Buffer.from(data.content, "base64");
    return decodeUtf8Text(path, decoded, data.size, ref, "contents");
  }

  // Contents API omits bodies for large blobs (~>1MB). Fall back to Git Blobs.
  return fetchViaBlob(octokit, owner, repo, path, ref, data.size);
}

export interface FileContextSlice {
  path: string;
  ref: string;
  center_line: number;
  window: number;
  start_line: number;
  end_line: number;
  total_lines: number;
  snippet: string;
}

/** A window of lines centered on `line`, for quick context without the whole file. */
export async function getFileAroundLine(
  owner: string,
  repo: string,
  path: string,
  ref: string,
  line: number,
  window = 20,
): Promise<FileContextSlice> {
  const file = await getFileContent(owner, repo, path, ref);
  const lines = file.content.split("\n");
  // Trailing empty string from a final newline is not a real last line for bounds.
  const total_lines =
    file.content.length === 0
      ? 0
      : file.content.endsWith("\n")
        ? lines.length - 1
        : lines.length;

  if (total_lines === 0) {
    throw new ToolError("validation", `File '${path}' is empty; cannot fetch context around line ${line}.`, {
      total_lines: 0,
    });
  }
  if (line < 1 || line > total_lines) {
    throw new ToolError(
      "validation",
      `Line ${line} is out of range for '${path}' (total_lines=${total_lines}).`,
      { total_lines, line },
    );
  }

  const start = Math.max(1, line - window);
  const end = Math.min(total_lines, line + window);

  const numbered = lines
    .slice(start - 1, end)
    .map((text, i) => `${start + i}\t${text}`)
    .join("\n");

  return {
    path,
    ref,
    center_line: line,
    window,
    start_line: start,
    end_line: end,
    total_lines,
    snippet: numbered,
  };
}

export interface CodeSearchMatch {
  path: string;
  repository: string;
  html_url: string;
  score: number;
}

export interface CodeSearchResult {
  query: string;
  total_count: number;
  incomplete_results: boolean;
  note: string;
  matches: CodeSearchMatch[];
}

/**
 * GitHub code search scoped to a single repo. The code-search endpoint has a
 * much tighter limit (~10 req/min); the throttling plugin backs off, but the
 * workflow rule also tells the agent to use this sparingly.
 */
export async function searchCode(
  owner: string,
  repo: string,
  query: string,
): Promise<CodeSearchResult> {
  const octokit = await getOctokit();

  // Strip embedded repo:/org:/user: qualifiers so the agent cannot widen scope.
  const cleaned = query
    .replace(/\b(?:repo|org|user)\s*:\s*\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    throw new ToolError(
      "validation",
      "search_codebase query is empty after removing repo/org/user qualifiers. " +
        "Pass a plain text/symbol query; the server scopes it to the given owner/repo.",
    );
  }

  const q = `${cleaned} repo:${owner}/${repo}`;
  const { data } = await octokit.search.code({ q, per_page: 20 });

  return {
    query: q,
    total_count: data.total_count,
    incomplete_results: data.incomplete_results,
    note:
      "Code search is rate-limited (~10 req/min). Batch or skip queries rather " +
      "than searching per finding. Embedded repo:/org:/user: qualifiers are stripped.",
    matches: data.items.map((item) => ({
      path: item.path,
      repository: item.repository.full_name,
      html_url: item.html_url,
      score: item.score ?? 0,
    })),
  };
}

export interface ReviewThreadComment {
  path: string | null;
  line: number | null;
  original_line: number | null;
  body: string;
  author: string | null;
}

export interface ReviewThread {
  /** True/false from GraphQL; null when REST fallback cannot determine status. */
  resolved: boolean | null;
  outdated: boolean | null;
  comments: ReviewThreadComment[];
}

export interface ExistingReviewComments {
  source: "graphql" | "rest";
  thread_count: number;
  incomplete: boolean;
  note: string;
  threads: ReviewThread[];
}

const MAX_REVIEW_THREADS = 500;
const THREADS_PAGE_SIZE = 100;
const COMMENTS_PAGE_SIZE = 50;

type GqlThreadNode = {
  isResolved: boolean;
  isOutdated: boolean;
  comments: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{
      path: string | null;
      line: number | null;
      originalLine: number | null;
      body: string;
      author: { login: string } | null;
    }>;
  };
};

/**
 * Existing review threads with their resolved status, so the agent can drop
 * duplicate / already-resolved findings. Uses GraphQL (which exposes
 * isResolved) with pagination, and falls back to the REST review-comments list.
 */
export async function getExistingReviewThreads(
  owner: string,
  repo: string,
  pr_number: number,
): Promise<ExistingReviewComments> {
  const octokit = await getOctokit();

  const gqlQuery = `
    query ($owner: String!, $repo: String!, $number: Int!, $threadCursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: ${THREADS_PAGE_SIZE}, after: $threadCursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              isResolved
              isOutdated
              comments(first: ${COMMENTS_PAGE_SIZE}) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  path
                  line
                  originalLine
                  body
                  author { login }
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const allNodes: GqlThreadNode[] = [];
    let threadCursor: string | null = null;
    let incomplete = false;

    for (;;) {
      const res: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
              nodes: GqlThreadNode[];
            };
          } | null;
        } | null;
      } = await octokit.graphql(gqlQuery, {
        owner,
        repo,
        number: pr_number,
        threadCursor,
      });

      const pr = res.repository?.pullRequest;
      if (!pr) {
        throw new ToolError(
          "not_found",
          `Pull request #${pr_number} not found via GraphQL in ${owner}/${repo}.`,
        );
      }

      const threadPage = pr.reviewThreads.pageInfo ?? {
        hasNextPage: false,
        endCursor: null,
      };

      for (const node of pr.reviewThreads.nodes) {
        if (node.comments?.pageInfo?.hasNextPage) {
          incomplete = true;
        }
        allNodes.push(node);
      }

      if (allNodes.length >= MAX_REVIEW_THREADS) {
        incomplete = true;
        break;
      }

      if (!threadPage.hasNextPage) break;
      threadCursor = threadPage.endCursor;
      if (!threadCursor) break;
    }

    const threads: ReviewThread[] = allNodes.map((t) => ({
      resolved: t.isResolved,
      outdated: t.isOutdated,
      comments: t.comments.nodes.map((c) => ({
        path: c.path,
        line: c.line,
        original_line: c.originalLine,
        body: c.body,
        author: c.author?.login ?? null,
      })),
    }));

    return {
      source: "graphql",
      thread_count: threads.length,
      incomplete,
      note: incomplete
        ? "Some review threads or comments were truncated (pagination/max cap). Treat the list as partial when deduplicating."
        : "Resolved/outdated status is authoritative from GraphQL.",
      threads,
    };
  } catch (gqlErr) {
    if (gqlErr instanceof ToolError && gqlErr.kind === "not_found") throw gqlErr;

    // Fall back to REST (no resolved status available there).
    console.error(
      `[pr-review-mcp] GraphQL reviewThreads failed, falling back to REST: ` +
        `${(gqlErr as Error).message}`,
    );
    const comments = await octokit.paginate(octokit.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: pr_number,
      per_page: 100,
    });

    const threads: ReviewThread[] = comments.map((c) => ({
      resolved: null,
      outdated: null,
      comments: [
        {
          path: c.path,
          line: c.line ?? null,
          original_line: c.original_line ?? null,
          body: c.body,
          author: c.user?.login ?? null,
        },
      ],
    }));

    return {
      source: "rest",
      thread_count: threads.length,
      incomplete: false,
      note:
        "REST fallback: resolved and outdated status are unknown (null). " +
        "Do not treat threads as unresolved; warn the user and still drop clear text duplicates.",
      threads,
    };
  }
}

// ---------------------------------------------------------------------------
// Write operations (with pre-flight line validation)
// ---------------------------------------------------------------------------

async function buildPatchMap(
  octokit: Octokit,
  owner: string,
  repo: string,
  pr_number: number,
): Promise<Map<string, string | undefined>> {
  const files = await octokit.paginate(octokit.pulls.listFiles, {
    owner,
    repo,
    pull_number: pr_number,
    per_page: 100,
  });
  const map = new Map<string, string | undefined>();
  for (const f of files) {
    map.set(f.filename, f.patch);
    if (f.previous_filename) {
      // Allow looking up renames by old path for clearer validation errors.
      if (!map.has(f.previous_filename)) map.set(f.previous_filename, f.patch);
    }
  }
  return map;
}

interface InvalidComment {
  path: string;
  line: number;
  side: DiffSide;
  reason: string;
  nearest_valid_lines?: number[];
  commentable_lines?: string;
}

function validateComments(
  comments: InlineComment[],
  patchMap: Map<string, string | undefined>,
): InvalidComment[] {
  const invalid: InvalidComment[] = [];
  for (const c of comments) {
    const side: DiffSide = c.side ?? "RIGHT";
    const patch = patchMap.get(c.path);
    if (patch === undefined && !patchMap.has(c.path)) {
      invalid.push({
        path: c.path,
        line: c.line,
        side,
        reason: `File '${c.path}' is not part of this PR's changed files.`,
      });
      continue;
    }
    const check = validateCommentLine(patch, c.line, side);
    if (!check.ok) {
      invalid.push({
        path: c.path,
        line: c.line,
        side,
        reason: check.reason ?? "Line not commentable.",
        nearest_valid_lines: check.nearest,
        commentable_lines: commentableLinesSummary(patch, side),
      });
    }
  }
  return invalid;
}

export interface PostReviewResult {
  posted: boolean;
  dry_run: boolean;
  review_id?: number;
  html_url?: string;
  commit_sha: string;
  summary: string;
  comment_count: number;
  comments: InlineComment[];
}

/**
 * Resolve the commit SHA to post against. Always locks to current PR head unless
 * the caller passes the current head explicitly. Stale SHAs are rejected so
 * line validation (current diff) cannot diverge from createReview(commit_id).
 */
async function resolveCommitShaForPost(
  octokit: Octokit,
  owner: string,
  repo: string,
  pr_number: number,
  commitSha: string | undefined,
): Promise<string> {
  const head = await resolveHeadSha(octokit, owner, repo, pr_number);
  if (!commitSha || commitSha === head) return head;
  throw new ToolError(
    "validation",
    `commit_sha '${commitSha}' is not the current PR head ('${head}'). ` +
      `Re-fetch get_pull_request_diff and use the returned head_sha, or omit commit_sha ` +
      `to post against the current head.`,
    { provided: commitSha, current_head: head },
  );
}

/**
 * Post a single GitHub review = top-level summary + all inline comments in one
 * call. Validates every inline line against the diff BEFORE hitting the API so
 * a bad line yields an actionable validation error, not a raw 422.
 *
 * When `dry_run` is true, returns the exact payload WITHOUT posting (preview).
 */
export async function postReview(
  owner: string,
  repo: string,
  pr_number: number,
  commitSha: string | undefined,
  summary: string,
  comments: InlineComment[],
  dry_run = false,
): Promise<PostReviewResult> {
  const octokit = await getOctokit();

  const commit_sha = await resolveCommitShaForPost(
    octokit,
    owner,
    repo,
    pr_number,
    commitSha,
  );

  if (comments.length > 0) {
    const patchMap = await buildPatchMap(octokit, owner, repo, pr_number);
    const invalid = validateComments(comments, patchMap);
    if (invalid.length > 0) {
      throw new ToolError(
        "validation",
        `${invalid.length} comment(s) target lines that are not part of the diff. ` +
          `GitHub would reject these. Fix the lines or move them to the summary.`,
        { invalid_comments: invalid },
      );
    }
  }

  const base: PostReviewResult = {
    posted: false,
    dry_run,
    commit_sha,
    summary,
    comment_count: comments.length,
    comments,
  };

  if (dry_run) {
    return base;
  }

  const { data: review } = await octokit.pulls.createReview({
    owner,
    repo,
    pull_number: pr_number,
    commit_id: commit_sha,
    body: summary,
    event: "COMMENT",
    comments: comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side ?? "RIGHT",
      body: c.body,
    })),
  });

  return {
    ...base,
    posted: true,
    review_id: review.id,
    html_url: review.html_url,
  };
}

export interface PostCommentResult {
  posted: boolean;
  comment_id: number;
  html_url: string;
  path: string;
  line: number;
  side: DiffSide;
  commit_sha: string;
}

/** Post a single inline review comment (with the same pre-flight validation). */
export async function postSingleComment(
  owner: string,
  repo: string,
  pr_number: number,
  path: string,
  line: number,
  body: string,
  side: DiffSide = "RIGHT",
): Promise<PostCommentResult> {
  const octokit = await getOctokit();

  const commit_sha = await resolveCommitShaForPost(
    octokit,
    owner,
    repo,
    pr_number,
    undefined,
  );

  const patchMap = await buildPatchMap(octokit, owner, repo, pr_number);
  const invalid = validateComments([{ path, line, body, side }], patchMap);
  if (invalid.length > 0) {
    throw new ToolError(
      "validation",
      `Comment targets a line that is not part of the diff; GitHub would reject it.`,
      { invalid_comments: invalid },
    );
  }

  const { data } = await octokit.pulls.createReviewComment({
    owner,
    repo,
    pull_number: pr_number,
    commit_id: commit_sha,
    path,
    line,
    side,
    body,
  });

  return {
    posted: true,
    comment_id: data.id,
    html_url: data.html_url,
    path,
    line,
    side,
    commit_sha,
  };
}

async function resolveHeadSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  pr_number: number,
): Promise<string> {
  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: pr_number });
  return pr.head.sha;
}
