#!/usr/bin/env node
/**
 * Shared MCP server factory: registers all pr-reviewer tools.
 * Used by both stdio (IDE) and HTTP (dashboard / Automations) entrypoints.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withToolError } from "./errors.js";
import {
  getPullRequestDiff,
  getFileContent,
  getFileAroundLine,
  searchCode,
  getExistingReviewThreads,
  postReview,
  postSingleComment,
  type InlineComment,
} from "./github/client.js";
import { getReviewRules } from "./rules/loader.js";

const sideSchema = z.enum(["RIGHT", "LEFT"]);
const readOnly = { readOnlyHint: true, openWorldHint: true } as const;
const writeHints = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

export function createPrReviewerServer(): McpServer {
  const server = new McpServer({ name: "pr-reviewer", version: "1.1.0" });

  server.registerTool(
    "get_pull_request_diff",
    {
      title: "Get Pull Request Diff",
      description:
        "Fetch a PR's title/body, head/base SHAs, and changed files with diff hunks. " +
        "Files whose patch GitHub omits (too large/binary) or that exceed the size cap " +
        "are returned with patch_present=false; fetch those via get_file_content. Use " +
        "page/per_page to slice very large PRs.",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        pr_number: z.number().int().positive(),
        page: z.number().int().positive().optional(),
        per_page: z.number().int().min(1).max(100).optional(),
      },
      annotations: readOnly,
    },
    withToolError(({ owner, repo, pr_number, page, per_page }) =>
      getPullRequestDiff(owner, repo, pr_number, { page, per_page }),
    ),
  );

  server.registerTool(
    "get_file_content",
    {
      title: "Get File Content",
      description:
        "Return the full UTF-8 text of a file at a given ref, for context beyond the " +
        "diff hunk. Use the PR head SHA as ref to see the proposed state. Large files " +
        "(>1MB) are fetched via the Git Blobs API up to MAX_FILE_CONTENT_BYTES.",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        path: z.string().min(1),
        ref: z.string().min(1),
      },
      annotations: readOnly,
    },
    withToolError(({ owner, repo, path, ref }) => getFileContent(owner, repo, path, ref)),
  );

  server.registerTool(
    "get_file_context",
    {
      title: "Get File Context Around Line",
      description:
        "Return a window of lines centered on a specific line of a file at a ref, for a " +
        "quick context check without pulling the whole file. Numbered lines are returned.",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        path: z.string().min(1),
        ref: z.string().min(1),
        line: z.number().int().positive(),
        window: z.number().int().min(1).max(200).optional(),
      },
      annotations: readOnly,
    },
    withToolError(({ owner, repo, path, ref, line, window }) =>
      getFileAroundLine(owner, repo, path, ref, line, window ?? 20),
    ),
  );

  server.registerTool(
    "search_codebase",
    {
      title: "Search Codebase",
      description:
        "GitHub code search scoped to owner/repo, to check whether a pattern/handling " +
        "exists elsewhere before flagging something as inconsistent or missing. " +
        "Rate-limited (~10 req/min): use sparingly, do not call it per finding.",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        query: z.string().min(1),
      },
      annotations: readOnly,
    },
    withToolError(({ owner, repo, query }) => searchCode(owner, repo, query)),
  );

  server.registerTool(
    "get_existing_review_comments",
    {
      title: "Get Existing Review Comments",
      description:
        "Return current review threads on the PR and their resolved/outdated status, so " +
        "you can drop findings that duplicate or were already resolved. GraphQL is " +
        "paginated; REST fallback sets resolved/outdated to null with a warning note.",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        pr_number: z.number().int().positive(),
      },
      annotations: readOnly,
    },
    withToolError(({ owner, repo, pr_number }) =>
      getExistingReviewThreads(owner, repo, pr_number),
    ),
  );

  server.registerTool(
    "get_review_rules",
    {
      title: "Get Review Rules",
      description:
        "Fetch .github/REVIEW_INSTRUCTIONS.md from the TARGET repo. Call this FIRST and " +
        "treat the rules as hard overrides: never flag anything the rules say to ignore. " +
        "Returns found=false with guidance if the file does not exist.",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        ref: z.string().min(1).optional(),
      },
      annotations: readOnly,
    },
    withToolError(({ owner, repo, ref }) => getReviewRules(owner, repo, ref)),
  );

  server.registerTool(
    "post_review",
    {
      title: "Post Review",
      description:
        "Post ONE GitHub review = a top-level summary plus all inline comments in a single " +
        "call (preferred over repeated post_comment). Inline comment lines are validated " +
        "against the diff first; invalid lines return a validation error instead of a raw " +
        "GitHub 422. Set dry_run=true to return the exact payload WITHOUT posting (preview).",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        pr_number: z.number().int().positive(),
        commit_sha: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Must be the current PR head SHA (from get_pull_request_diff). " +
              "If omitted, the current head is resolved automatically. Stale SHAs are rejected.",
          ),
        summary: z.string().min(1).describe("Top-level review summary (markdown)."),
        comments: z
          .array(
            z.object({
              path: z.string().min(1),
              line: z.number().int().positive(),
              body: z.string().min(1),
              side: sideSchema.optional(),
            }),
          )
          .default([]),
        dry_run: z
          .boolean()
          .optional()
          .describe("If true, return the payload without posting to GitHub (preview mode)."),
      },
      annotations: writeHints,
    },
    withToolError(({ owner, repo, pr_number, commit_sha, summary, comments, dry_run }) =>
      postReview(
        owner,
        repo,
        pr_number,
        commit_sha,
        summary,
        (comments ?? []) as InlineComment[],
        dry_run ?? false,
      ),
    ),
  );

  server.registerTool(
    "post_comment",
    {
      title: "Post Single Comment",
      description:
        "Post a single inline review comment. Prefer post_review to batch all findings; " +
        "use this only for one-off comments. The line is validated against the diff first.",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        pr_number: z.number().int().positive(),
        path: z.string().min(1),
        line: z.number().int().positive(),
        body: z.string().min(1),
        side: sideSchema.optional(),
      },
      annotations: writeHints,
    },
    withToolError(({ owner, repo, pr_number, path, line, body, side }) =>
      postSingleComment(owner, repo, pr_number, path, line, body, side ?? "RIGHT"),
    ),
  );

  return server;
}
