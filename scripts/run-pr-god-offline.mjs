#!/usr/bin/env node
/**
 * PR-God offline CI reviewer — no CURSOR_API_KEY required.
 * Uses the same GitHub I/O layer as the MCP + conservative heuristics.
 * Prefer scripts/run-pr-god-ci.mjs when CURSOR_API_KEY is set.
 *
 * Env: GITHUB_TOKEN, OWNER, REPO, PR_NUMBER
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function reqEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`[pr-god-offline] missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

const owner = reqEnv("OWNER");
const repo = reqEnv("REPO");
const prNumber = Number(reqEnv("PR_NUMBER"));
reqEnv("GITHUB_TOKEN");
if (!Number.isInteger(prNumber) || prNumber < 1) {
  console.error("[pr-god-offline] invalid PR_NUMBER");
  process.exit(1);
}

const RULES = [
  {
    pattern: /Object\.assign\s*\([^,]+,\s*req\.body\)/,
    severity: "high",
    category: "security",
    title: "Mass assignment from req.body",
    evidence:
      "Object.assign copies attacker-controlled body fields onto a trusted object (privilege escalation / data overwrite risk).",
    suggested_fix: "Whitelist allowed fields instead of assigning req.body.",
  },
  {
    pattern: /path\.join\([^)]*req\.(query|params|body)/,
    severity: "high",
    category: "security",
    title: "User-controlled path join",
    evidence:
      "Path joined with request input can escape intended directories (path traversal).",
    suggested_fix: "Resolve under a fixed root and reject paths that escape it.",
  },
  {
    pattern: /role\s*[:=]\s*req\.(body|query)/i,
    severity: "high",
    category: "security",
    title: "Role taken from client input",
    evidence: "Assigning role from the request lets clients self-elevate privileges.",
    suggested_fix: "Set roles server-side from a trusted source.",
  },
  {
    pattern: /(?:VIP|coupon).*free|price\s*=\s*0|discount\s*=\s*1(?:\.0)?/i,
    severity: "medium",
    category: "logic",
    title: "Suspicious free / zero-price coupon path",
    evidence: "Discount or VIP handling may grant unintended free pricing.",
    suggested_fix: "Validate coupon codes server-side against a signed allowlist.",
  },
  {
    pattern: /function\s+refund|\/refund/i,
    severity: "medium",
    category: "security",
    title: "Refund path present — verify authz",
    evidence:
      "Refund endpoints must authorize the acting user against the order owner/admin role.",
    suggested_fix: "Require auth and ownership (or admin) checks before refunds.",
  },
];

function findLine(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

function commentableRightLines(patch) {
  if (!patch) return new Set();
  const lines = new Set();
  let newLine = 0;
  for (const raw of patch.split(/\r?\n/)) {
    if (raw.startsWith("@@")) {
      const m = raw.match(/\+(\d+)(?:,(\d+))?/);
      newLine = m ? Number(m[1]) : 0;
      continue;
    }
    if (raw.startsWith("---") || raw.startsWith("+++") || raw.startsWith("\\")) continue;
    if (raw.startsWith("+")) {
      lines.add(newLine);
      newLine += 1;
    } else if (raw.startsWith("-")) {
      // removed from old file
    } else {
      lines.add(newLine);
      newLine += 1;
    }
  }
  return lines;
}

async function main() {
  const clientUrl = pathToFileURL(path.join(root, "dist/github/client.js")).href;
  const { getPullRequestDiff, getFileContent, postReview } = await import(clientUrl);

  const diff = await getPullRequestDiff(owner, repo, prNumber);
  const comments = [];
  const seen = new Set();

  for (const file of diff.files || []) {
    if (!file.filename || file.status === "removed") continue;
    if (/\.(lock|min\.js)$/.test(file.filename) || file.filename.includes("node_modules/")) {
      continue;
    }

    let content = "";
    try {
      const fc = await getFileContent(owner, repo, file.filename, diff.head_sha);
      content = fc.content || "";
    } catch {
      continue;
    }

    const rightLines = commentableRightLines(file.patch);
    for (const rule of RULES) {
      const m = content.match(rule.pattern);
      if (!m || m.index == null) continue;
      const line = findLine(content, m.index);
      let useLine = line;
      if (rightLines.size && !rightLines.has(line)) {
        const nearby = [...rightLines].sort((a, b) => Math.abs(a - line) - Math.abs(b - line))[0];
        if (nearby == null) continue;
        useLine = nearby;
      }
      const key = `${file.filename}:${useLine}:${rule.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      comments.push({
        path: file.filename,
        line: useLine,
        side: "RIGHT",
        body: `**${rule.severity.toUpperCase()} (${rule.category}):** ${rule.title}\n\n${rule.evidence}${
          rule.suggested_fix ? `\n\nSuggested fix: ${rule.suggested_fix}` : ""
        }\n\n_PR-God offline heuristic_`,
      });
    }
  }

  const summary =
    comments.length === 0
      ? `## PR-God\n\nNo heuristic high/medium hits on \`${owner}/${repo}#${prNumber}\` (head \`${diff.head_sha.slice(0, 7)}\`).`
      : `## PR-God\n\nFound **${comments.length}** heuristic finding(s) on \`${owner}/${repo}#${prNumber}\`.\n\n_Offline mode (no Cursor API key). For full agent review, set repo secret \`CURSOR_API_KEY\`._`;

  const result = await postReview(
    owner,
    repo,
    prNumber,
    diff.head_sha,
    summary,
    comments,
    false,
  );

  console.log(
    JSON.stringify(
      { posted: result.posted, review_id: result.review_id, comment_count: comments.length, html_url: result.html_url },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("[pr-god-offline] failed:", err?.message || err);
  process.exit(1);
});
