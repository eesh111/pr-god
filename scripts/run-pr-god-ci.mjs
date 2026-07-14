#!/usr/bin/env node
/**
 * PR-God CI runner — Cursor SDK local agent + stdio pr-god MCP.
 *
 * Env:
 *   CURSOR_API_KEY   required
 *   GITHUB_TOKEN     required (Actions token or PAT with PR write)
 *   OWNER / REPO / PR_NUMBER  required
 *   MCP_SERVER_PATH  optional (default: <repo>/dist/mcpServer.js next to this script)
 *   GITHUB_WORKSPACE optional local cwd for the agent (default: process.cwd())
 *   CURSOR_MODEL     optional (default: composer-2.5)
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function reqEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`[pr-god] missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

const apiKey = reqEnv("CURSOR_API_KEY");
const githubToken = reqEnv("GITHUB_TOKEN");
const owner = reqEnv("OWNER");
const repo = reqEnv("REPO");
const prNumber = Number(reqEnv("PR_NUMBER"));
if (!Number.isInteger(prNumber) || prNumber < 1) {
  console.error(`[pr-god] PR_NUMBER must be a positive integer, got: ${process.env.PR_NUMBER}`);
  process.exit(1);
}

const mcpServerPath =
  process.env.MCP_SERVER_PATH?.trim() ||
  path.resolve(__dirname, "../dist/mcpServer.js");
const cwd = process.env.GITHUB_WORKSPACE?.trim() || process.cwd();
const modelId = process.env.CURSOR_MODEL?.trim() || "composer-2.5";

const playbook = `You are PR-God, a high-signal GitHub PR reviewer running in CI (no human in the loop).

Use ONLY the pr-god MCP tools for GitHub I/O. Do not invent findings from memory.
Target: ${owner}/${repo} pull request #${prNumber}.

Always finish by calling post_review with dry_run=false and event COMMENT only
(never REQUEST_CHANGES or APPROVE). Do not ask for confirmation. Do not use post_comment repeatedly.

Playbook (in order):
1. get_review_rules for ${owner}/${repo}. Hard overrides.
2. get_pull_request_diff for PR #${prNumber}. Remember head_sha. Handle truncation via get_file_content / paging.
3. Three passes on remaining hunks: logic, security, test coverage for new logic. Skip generated/lockfiles/vendor/pure formatting.
4. Verify each candidate with get_file_context or get_file_content. Keep only high/medium confidence with concrete path + line + evidence. Drop style-only and low confidence.
5. get_existing_review_comments — drop duplicates (resolved/outdated when known).
6. Only comment on diff-valid lines (RIGHT for added/context, LEFT for removed).
7. post_review once: dry_run=false, event=COMMENT, summary + all inline comments, commit_sha=head_sha (or omit).
8. On tool errors: stop on unauthorized, forbidden, rate_limit, not_found, network, unknown.
   For validation (bad lines): fix using nearest_valid_lines or move to summary; retry once.
   For stale commit_sha: re-fetch diff; retry once.
9. The review must land on GitHub via post_review — never pretend chat text is the review.

If there are zero findings after filters, still call post_review with a short COMMENT summary saying no high/medium issues were found.
`;

async function main() {
  let Agent;
  let CursorAgentError;
  try {
    ({ Agent, CursorAgentError } = await import("@cursor/sdk"));
  } catch (err) {
    console.error(
      "[pr-god] @cursor/sdk is required. Run: npm install @cursor/sdk",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }

  console.error(
    `[pr-god] reviewing ${owner}/${repo}#${prNumber} model=${modelId} mcp=${mcpServerPath}`,
  );

  try {
    const result = await Agent.prompt(playbook, {
      apiKey,
      model: { id: modelId },
      local: { cwd },
      mcpServers: {
        "pr-god": {
          type: "stdio",
          command: process.execPath,
          args: [mcpServerPath],
          env: {
            GITHUB_TOKEN: githubToken,
          },
        },
      },
    });

    console.error(`[pr-god] status=${result.status} id=${result.id ?? "n/a"}`);
    if (result.result) {
      console.log(typeof result.result === "string" ? result.result : JSON.stringify(result.result));
    }
    if (result.status === "error") {
      process.exit(2);
    }
  } catch (err) {
    if (err && typeof err === "object" && "name" in err) {
      const e = /** @type {{ message?: string, isRetryable?: boolean }} */ (err);
      console.error(
        `[pr-god] startup failed: ${e.message ?? err}` +
          (e.isRetryable != null ? ` retryable=${e.isRetryable}` : ""),
      );
    } else {
      console.error("[pr-god] failed:", err);
    }
    if (CursorAgentError && err instanceof CursorAgentError) {
      process.exit(1);
    }
    process.exit(1);
  }
}

main();
