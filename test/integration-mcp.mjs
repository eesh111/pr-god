/**
 * Full-stack integration test (no real GitHub, synthetic token).
 *
 * Spins up a fake GitHub HTTP server, then launches the REAL compiled MCP
 * server (dist/mcpServer.js) as a child over stdio and drives it with the MCP
 * client. This exercises the entire stack: MCP protocol wiring, Zod input
 * validation, real Octokit request building + auth header + pagination, and our
 * client logic - all against canned data via GITHUB_API_BASE_URL.
 */
import http from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { harness } from "./helpers/assert.mjs";

const { check, section, done } = harness("integration-mcp");

// --- fixtures --------------------------------------------------------------

const file1Patch = "@@ -10,3 +10,4 @@\n line10\n-old11\n+new11\n+new12\n line13";
const bigPatch = "@@ -1,1 +1,2 @@\n line1\n+" + "x".repeat(300);
const genericFileText = "alpha\nbeta\ngamma\ndelta\nepsilon";
const rulesText = "# Review rules\n- Ignore console.log in tests.";

const PR_FILES = [
  { filename: "src/app.ts", status: "modified", additions: 2, deletions: 1, changes: 3, patch: file1Patch },
  { filename: "src/huge.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: bigPatch },
  { filename: "assets/logo.png", status: "added", additions: 0, deletions: 0, changes: 0 },
];

function b64(text) {
  return Buffer.from(text, "utf8").toString("base64");
}
function fileObj(path, text) {
  return { type: "file", encoding: "base64", content: b64(text), size: text.length, name: path.split("/").pop(), path };
}

let authHeaderSeen = false;

// --- fake GitHub server ----------------------------------------------------

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const method = req.method;

  // consume body
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.headers.authorization) authHeaderSeen = true;
    if (!req.headers.authorization) return sendJSON(res, 401, { message: "Requires authentication" });

    // GraphQL (reviewThreads)
    if (method === "POST" && p.includes("graphql")) {
      return sendJSON(res, 200, {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    isResolved: true,
                    isOutdated: false,
                    comments: {
                      nodes: [{ path: "src/app.ts", line: 11, originalLine: 11, body: "existing note", author: { login: "bot" } }],
                    },
                  },
                ],
              },
            },
          },
        },
      });
    }

    // pulls .../files
    let m = p.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/files$/);
    if (method === "GET" && m) return sendJSON(res, 200, PR_FILES);

    // reviews (create)
    m = p.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/reviews$/);
    if (method === "POST" && m) return sendJSON(res, 200, { id: 5001, html_url: "https://x/review/5001" });

    // review comments (POST create / GET list fallback)
    m = p.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/comments$/);
    if (m && method === "POST") return sendJSON(res, 201, { id: 6001, html_url: "https://x/comment/6001" });
    if (m && method === "GET")
      return sendJSON(res, 200, [{ path: "src/app.ts", line: 11, original_line: 11, body: "rest note", user: { login: "dev" } }]);

    // pull detail
    m = p.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/);
    if (method === "GET" && m) {
      const num = Number(m[3]);
      if (num === 999) return sendJSON(res, 404, { message: "Not Found" });
      return sendJSON(res, 200, {
        number: num,
        title: "Add feature X",
        body: "This PR adds feature X.",
        head: { sha: "headsha123" },
        base: { sha: "basesha456" },
        changed_files: PR_FILES.length,
      });
    }

    // contents
    m = p.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
    if (method === "GET" && m) {
      const owner = m[1];
      const filePath = decodeURIComponent(m[3]);
      if (owner === "norules") return sendJSON(res, 404, { message: "Not Found" });
      if (filePath.endsWith("REVIEW_INSTRUCTIONS.md")) return sendJSON(res, 200, fileObj(filePath, rulesText));
      return sendJSON(res, 200, fileObj(filePath, genericFileText));
    }

    // code search
    if (method === "GET" && p === "/search/code") {
      return sendJSON(res, 200, {
        total_count: 1,
        incomplete_results: false,
        items: [{ path: "src/app.ts", repository: { full_name: "o/r" }, html_url: "https://x/app", score: 2.5 }],
      });
    }

    return sendJSON(res, 404, { message: `unhandled ${method} ${p}` });
  });
});

// --- helpers ---------------------------------------------------------------

function parseTool(result) {
  const text = result?.content?.[0]?.text;
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { isError: result?.isError === true, data };
}

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const serverPath = fileURLToPath(new URL("../dist/mcpServer.js", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      GITHUB_TOKEN: "synthetic-token-not-used",
      GITHUB_API_BASE_URL: baseUrl,
      DOTENV_CONFIG_PATH: "definitely-nonexistent.env",
      MAX_DIFF_PATCH_BYTES: "120",
    },
  });

  const client = new Client({ name: "integration-test", version: "1.0.0" });
  await client.connect(transport);

  try {
    section("tool discovery");
    {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name).sort();
      const expected = [
        "get_existing_review_comments",
        "get_file_content",
        "get_file_context",
        "get_pull_request_diff",
        "get_review_rules",
        "post_comment",
        "post_review",
        "search_codebase",
      ];
      check("all 8 tools registered", JSON.stringify(names) === JSON.stringify(expected), names);
    }

    section("get_pull_request_diff (real Octokit -> fake GitHub)");
    {
      const { isError, data } = parseTool(await client.callTool({ name: "get_pull_request_diff", arguments: { owner: "o", repo: "r", pr_number: 42 } }));
      check("no error", isError === false);
      check("title from fake", data.title === "Add feature X", data.title);
      check("head_sha", data.head_sha === "headsha123");
      const f2 = data.files.find((f) => f.filename === "src/huge.ts");
      const f3 = data.files.find((f) => f.filename === "assets/logo.png");
      check("huge.ts truncated", f2.patch_present === false && f2.patch_omitted_reason === "diff_truncated_by_size_limit", f2);
      check("logo.png unavailable", f3.patch_present === false && f3.patch_omitted_reason === "patch_unavailable_from_github", f3);
      check("truncated true", data.truncated === true);
    }

    section("get_pull_request_diff bad PR => standardized not_found (gap 5)");
    {
      const { isError, data } = parseTool(await client.callTool({ name: "get_pull_request_diff", arguments: { owner: "o", repo: "r", pr_number: 999 } }));
      check("isError true", isError === true);
      check("kind not_found", data.error?.kind === "not_found", data.error);
    }

    section("get_file_content");
    {
      const { isError, data } = parseTool(await client.callTool({ name: "get_file_content", arguments: { owner: "o", repo: "r", path: "src/app.ts", ref: "headsha123" } }));
      check("no error", isError === false);
      check("content decoded", data.content === genericFileText, data.content);
      check("line_count 5", data.line_count === 5);
    }

    section("get_file_context");
    {
      const { data } = parseTool(await client.callTool({ name: "get_file_context", arguments: { owner: "o", repo: "r", path: "src/app.ts", ref: "headsha123", line: 2, window: 1 } }));
      check("start 1", data.start_line === 1, data.start_line);
      check("end 3", data.end_line === 3, data.end_line);
    }

    section("search_codebase");
    {
      const { data } = parseTool(await client.callTool({ name: "search_codebase", arguments: { owner: "o", repo: "r", query: "TODO" } }));
      check("one match", data.matches.length === 1 && data.matches[0].path === "src/app.ts", data.matches);
    }

    section("get_existing_review_comments");
    {
      const { data } = parseTool(await client.callTool({ name: "get_existing_review_comments", arguments: { owner: "o", repo: "r", pr_number: 42 } }));
      check("source graphql or rest", ["graphql", "rest"].includes(data.source), data.source);
      check("at least one thread", data.thread_count >= 1, data.thread_count);
      if (data.source === "graphql") check("graphql thread resolved", data.threads[0].resolved === true);
    }

    section("get_review_rules (found + not found)");
    {
      const found = parseTool(await client.callTool({ name: "get_review_rules", arguments: { owner: "o", repo: "r" } }));
      check("found true", found.data.found === true);
      check("content has rules", /Review rules/.test(found.data.content), found.data.content);

      const missing = parseTool(await client.callTool({ name: "get_review_rules", arguments: { owner: "norules", repo: "r" } }));
      check("found false when 404", missing.data.found === false);
    }

    section("post_review dry_run (preview, no write)");
    {
      const { data } = parseTool(
        await client.callTool({
          name: "post_review",
          arguments: { owner: "o", repo: "r", pr_number: 42, commit_sha: "headsha123", summary: "s", comments: [{ path: "src/app.ts", line: 11, body: "note", side: "RIGHT" }], dry_run: true },
        }),
      );
      check("posted false", data.posted === false && data.dry_run === true, data);
    }

    section("post_review real (valid line)");
    {
      const { isError, data } = parseTool(
        await client.callTool({
          name: "post_review",
          arguments: { owner: "o", repo: "r", pr_number: 42, commit_sha: "headsha123", summary: "s", comments: [{ path: "src/app.ts", line: 12, body: "nit" }] },
        }),
      );
      check("no error", isError === false, data);
      check("posted true", data.posted === true);
      check("review_id 5001", data.review_id === 5001);
    }

    section("post_review invalid line => validation (gap 1)");
    {
      const { isError, data } = parseTool(
        await client.callTool({
          name: "post_review",
          arguments: { owner: "o", repo: "r", pr_number: 42, commit_sha: "headsha123", summary: "s", comments: [{ path: "src/app.ts", line: 999, body: "bad" }] },
        }),
      );
      check("isError true", isError === true);
      check("kind validation", data.error?.kind === "validation", data.error);
      check("details list invalid comment", Array.isArray(data.error?.details?.invalid_comments), data.error?.details);
    }

    section("post_comment valid + invalid");
    {
      const okc = parseTool(await client.callTool({ name: "post_comment", arguments: { owner: "o", repo: "r", pr_number: 42, path: "src/app.ts", line: 11, body: "note" } }));
      check("valid posts", okc.data.posted === true && okc.data.comment_id === 6001, okc.data);

      const badc = parseTool(await client.callTool({ name: "post_comment", arguments: { owner: "o", repo: "r", pr_number: 42, path: "src/app.ts", line: 999, body: "note" } }));
      check("invalid => isError validation", badc.isError === true && badc.data.error?.kind === "validation", badc.data);
    }

    section("Zod input validation (bad args rejected)");
    {
      let rejected = false;
      try {
        const r = await client.callTool({ name: "get_pull_request_diff", arguments: { owner: "o", repo: "r", pr_number: "not-a-number" } });
        rejected = r?.isError === true;
      } catch {
        rejected = true; // SDK throws McpError on schema validation failure
      }
      check("invalid pr_number rejected by schema", rejected === true);
    }

    section("auth wiring");
    {
      check("Authorization header reached fake GitHub", authHeaderSeen === true);
    }
  } finally {
    await client.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
}

// Hard timeout so a hang never wedges CI.
const killer = setTimeout(() => {
  console.error("integration-mcp: TIMEOUT after 45s");
  process.exit(1);
}, 45000);
killer.unref();

main()
  .then(() => done())
  .catch((e) => {
    console.error("integration-mcp: fatal", e?.stack || e);
    process.exitCode = 1;
  });
