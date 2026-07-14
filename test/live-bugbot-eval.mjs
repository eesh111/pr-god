/**
 * Live end-to-end evaluation of the agent-driven Bugbot MCP client
 * against https://github.com/eesh111/bugbot-demo/pull/1
 *
 * Always uses postReview(..., dry_run: true). Never posts a real review.
 *
 * Run (unrestricted network + token):
 *   export PATH=".../.tools/gh/bin:.../.tools/node/bin:$PATH"
 *   export GITHUB_TOKEN="$(gh auth token)"
 *   export GH_TOKEN="$GITHUB_TOKEN"
 *   node test/live-bugbot-eval.mjs
 */

process.env.DOTENV_CONFIG_PATH = "/tmp/pr-checker-live-eval-nonexistent.env";

import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const OWNER = "eesh111";
const REPO = "bugbot-demo";
const PR = 1;
const REPORT_PATH = new URL("./live-bugbot-eval-report.md", import.meta.url);

const lines = [];
function out(s = "") {
  lines.push(s);
  console.log(s);
}

function fmtMs(ms) {
  return `${ms}ms`;
}

function isToolError(err) {
  return err && typeof err === "object" && "kind" in err && err.name === "ToolError";
}

async function timed(label, fn) {
  const t0 = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - t0;
    return { ok: true, label, ms, result, error: null };
  } catch (err) {
    const ms = Date.now() - t0;
    return { ok: false, label, ms, result: null, error: err };
  }
}

function summarizeError(err) {
  if (isToolError(err)) {
    return {
      kind: err.kind,
      message: err.message,
      details: err.details ?? null,
    };
  }
  return {
    kind: "thrown",
    message: err?.message ?? String(err),
    details: null,
  };
}

/** Extract RIGHT-side line numbers that appear as added or context in a unified patch. */
function rightLinesFromPatch(patch) {
  if (!patch) return [];
  const right = new Set();
  let rightLine = 0;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      rightLine = Number(hunk[1]);
      continue;
    }
    if (!rightLine) continue;
    if (raw.startsWith("\\")) continue;
    if (raw.startsWith("-")) continue;
    if (raw.startsWith("+") || raw.startsWith(" ")) {
      right.add(rightLine);
      rightLine++;
    }
  }
  return [...right].sort((a, b) => a - b);
}

/** Find first RIGHT line whose added text matches a regex. */
function findAddedLine(patch, re) {
  if (!patch) return null;
  let rightLine = 0;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      rightLine = Number(hunk[1]);
      continue;
    }
    if (!rightLine) continue;
    if (raw.startsWith("\\")) continue;
    if (raw.startsWith("-")) continue;
    if (raw.startsWith("+")) {
      const text = raw.slice(1);
      if (re.test(text)) return { line: rightLine, text: text.trim() };
      rightLine++;
    } else if (raw.startsWith(" ")) {
      rightLine++;
    }
  }
  return null;
}

function patchIncludes(patch, re) {
  return patch != null && re.test(patch);
}

// --- Auth / connectivity ---------------------------------------------------

const wallStart = Date.now();
out("# Live Bugbot MCP evaluation");
out();
out(`Target: https://github.com/${OWNER}/${REPO}/pull/${PR}`);
out(`When: ${new Date().toISOString()}`);
out();

const authCheck = spawnSync("gh", ["api", "user", "-q", ".login"], {
  encoding: "utf8",
  env: process.env,
});
const login = (authCheck.stdout || "").trim();
const authOk = authCheck.status === 0 && Boolean(login);
out("## Auth / connectivity");
out();
if (authOk) {
  out(`- OK — authenticated as \`${login}\``);
} else {
  out(`- FAIL — \`gh api user\` exited ${authCheck.status}: ${authCheck.stderr || authCheck.stdout}`);
  writeFileSync(REPORT_PATH, lines.join("\n") + "\n");
  process.exit(1);
}
out(`- \`GITHUB_TOKEN\` present: ${Boolean(process.env.GITHUB_TOKEN)}`);
out(`- \`DOTENV_CONFIG_PATH\`: \`${process.env.DOTENV_CONFIG_PATH}\` (nonexistent → ignore local .env)`);
out();

if (!process.env.GITHUB_TOKEN) {
  process.env.GITHUB_TOKEN = process.env.GH_TOKEN || "";
}
if (!process.env.GH_TOKEN && process.env.GITHUB_TOKEN) {
  process.env.GH_TOKEN = process.env.GITHUB_TOKEN;
}

const { getReviewRules } = await import("../dist/rules/loader.js");
const {
  getPullRequestDiff,
  getFileContent,
  getFileAroundLine,
  getExistingReviewThreads,
  searchCode,
  postReview,
} = await import("../dist/github/client.js");
const { ToolError } = await import("../dist/errors.js");

const toolResults = [];
let callCount = 0;

async function runTool(label, fn) {
  callCount++;
  const r = await timed(label, fn);
  toolResults.push(r);
  return r;
}

// --- 1. Rules --------------------------------------------------------------

out("## Tool-by-tool results");
out();

const rulesR = await runTool("getReviewRules", () => getReviewRules(OWNER, REPO));
out(`### 1. getReviewRules — ${rulesR.ok ? "PASS" : "FAIL"} (${fmtMs(rulesR.ms)})`);
if (rulesR.ok) {
  out(`- found: ${rulesR.result.found}`);
  out(`- path: \`${rulesR.result.path}\``);
  out(`- note: ${rulesR.result.note}`);
} else {
  out(`- error: ${JSON.stringify(summarizeError(rulesR.error))}`);
}
out();

// --- 2. Diff ---------------------------------------------------------------

const diffR = await runTool("getPullRequestDiff", () => getPullRequestDiff(OWNER, REPO, PR));
out(`### 2. getPullRequestDiff — ${diffR.ok ? "PASS" : "FAIL"} (${fmtMs(diffR.ms)})`);
let headSha = null;
let filesByName = new Map();
if (diffR.ok) {
  const d = diffR.result;
  headSha = d.head_sha;
  for (const f of d.files) filesByName.set(f.filename, f);
  out(`- title: ${d.title}`);
  out(`- head_sha: \`${d.head_sha}\``);
  out(`- base_sha: \`${d.base_sha}\``);
  out(`- changed_files_count: ${d.changed_files_count}`);
  out(`- returned_files_count: ${d.returned_files_count}`);
  out(`- truncated: ${d.truncated}`);
  out(`- bytes_used / budget: ${d.bytes_used} / ${d.bytes_budget}`);
  out(`- omitted_files: ${d.omitted_files?.length ? JSON.stringify(d.omitted_files) : "[]"}`);
  out(`- files:`);
  for (const f of d.files) {
    out(
      `  - \`${f.filename}\` (${f.status}, +${f.additions}/-${f.deletions}, patch_present=${f.patch_present})`,
    );
  }
} else {
  out(`- error: ${JSON.stringify(summarizeError(diffR.error))}`);
}
out();

if (!diffR.ok) {
  out("## Verdict");
  out();
  out("**needs work** — could not fetch PR diff; remaining steps skipped.");
  writeFileSync(REPORT_PATH, lines.join("\n") + "\n");
  process.exit(1);
}

const diff = diffR.result;

// --- 3. File content / around-line for verification ------------------------

const checkoutPatch = filesByName.get("src/checkout.js")?.patch;
const pricingPatch = filesByName.get("src/pricing.js")?.patch;
const usersPatch = filesByName.get("src/users.js")?.patch;
const serverPatch = filesByName.get("src/server.js")?.patch;

const vipHit = findAddedLine(pricingPatch, /VIP/);
const refundHit = findAddedLine(checkoutPatch, /refundOrder\(orderId\)/);
const traversalHit = findAddedLine(checkoutPatch, /receipts.*orderId/);
const roleHit = findAddedLine(usersPatch, /accepts any role|createUser/);
const assignHit =
  findAddedLine(usersPatch, /Object\.assign\s*\(/) ||
  findAddedLine(usersPatch, /Object\.assign/);
const refundsEndpoint = findAddedLine(serverPatch, /\/refunds/);

const contextTargets = [
  {
    label: "getFileAroundLine(pricing VIP)",
    path: "src/pricing.js",
    line: vipHit?.line ?? 8,
  },
  {
    label: "getFileContent(users.js)",
    path: "src/users.js",
    mode: "full",
  },
];

for (const t of contextTargets) {
  if (t.mode === "full") {
    const r = await runTool(t.label, () => getFileContent(OWNER, REPO, t.path, headSha));
    out(`### ${t.label} — ${r.ok ? "PASS" : "FAIL"} (${fmtMs(r.ms)})`);
    if (r.ok) {
      out(`- path: \`${r.result.path}\` ref=\`${r.result.ref}\` lines=${r.result.line_count} source=${r.result.source}`);
      out(`- contains Object.assign: ${/Object\.assign/.test(r.result.content)}`);
      out(`- contains ALLOWED_ROLES: ${/ALLOWED_ROLES/.test(r.result.content)}`);
    } else {
      out(`- error: ${JSON.stringify(summarizeError(r.error))}`);
    }
  } else {
    const r = await runTool(t.label, () =>
      getFileAroundLine(OWNER, REPO, t.path, headSha, t.line, 8),
    );
    out(`### ${t.label} — ${r.ok ? "PASS" : "FAIL"} (${fmtMs(r.ms)})`);
    if (r.ok) {
      out(
        `- slice: ${r.result.start_line}-${r.result.end_line} (center ${r.result.center_line}, total ${r.result.total_lines})`,
      );
      const snippetPreview = r.result.snippet.split("\n").slice(0, 6).join(" | ");
      out(`- snippet preview: ${snippetPreview}`);
    } else {
      out(`- error: ${JSON.stringify(summarizeError(r.error))}`);
    }
  }
  out();
}

// --- 4. Existing review threads --------------------------------------------

const threadsR = await runTool("getExistingReviewThreads", () =>
  getExistingReviewThreads(OWNER, REPO, PR),
);
out(`### getExistingReviewThreads — ${threadsR.ok ? "PASS" : "FAIL"} (${fmtMs(threadsR.ms)})`);
if (threadsR.ok) {
  const t = threadsR.result;
  out(`- source: ${t.source}`);
  out(`- incomplete: ${t.incomplete}`);
  out(`- thread_count: ${t.thread_count}`);
  out(`- note: ${t.note}`);
} else {
  out(`- error: ${JSON.stringify(summarizeError(threadsR.error))}`);
}
out();

// --- 5. searchCode (1–2 calls max) -----------------------------------------

const search1 = await runTool("searchCode(refundOrder)", () =>
  searchCode(OWNER, REPO, "refundOrder"),
);
out(`### searchCode(\"refundOrder\") — ${search1.ok ? "PASS" : "FAIL"} (${fmtMs(search1.ms)})`);
if (search1.ok) {
  out(`- total_count: ${search1.result.total_count}`);
  out(`- incomplete_results: ${search1.result.incomplete_results}`);
  out(`- matches: ${search1.result.matches.map((m) => m.path).join(", ") || "(none)"}`);
} else {
  out(`- error: ${JSON.stringify(summarizeError(search1.error))}`);
}
out();

const search2 = await runTool("searchCode(Object.assign)", () =>
  searchCode(OWNER, REPO, "Object.assign updateProfile"),
);
out(`### searchCode(\"Object.assign updateProfile\") — ${search2.ok ? "PASS" : "FAIL"} (${fmtMs(search2.ms)})`);
if (search2.ok) {
  out(`- total_count: ${search2.result.total_count}`);
  out(`- matches: ${search2.result.matches.map((m) => m.path).join(", ") || "(none)"}`);
} else {
  out(`- error: ${JSON.stringify(summarizeError(search2.error))}`);
}
out();

// --- Accuracy: planted bugs ------------------------------------------------

out("## Accuracy — planted bugs visible to a Bugbot-style agent?");
out();

const planted = [
  {
    id: "VIP coupon free",
    visible: patchIncludes(pricingPatch, /VIP:\s*1\.0/) || patchIncludes(pricingPatch, /code === ["']VIP["']/),
    evidence: vipHit
      ? `\`${vipHit.line ? "src/pricing.js" : "?"}:${vipHit.line}\` — \`${vipHit.text}\``
      : pricingPatch
        ? "VIP logic present in `src/pricing.js` patch (see applyCoupon special-case)"
        : "not in returned diff",
    extra: (() => {
      const ret = findAddedLine(pricingPatch, /return 0/);
      return ret ? `; free-path at src/pricing.js:${ret.line}` : "";
    })(),
  },
  {
    id: "no authz on refund",
    visible:
      patchIncludes(checkoutPatch, /no authorization check/) ||
      (Boolean(refundHit) && patchIncludes(checkoutPatch, /refundOrder\(orderId\)/)),
    evidence: refundHit
      ? `\`src/checkout.js:${refundHit.line}\` — \`${refundHit.text}\` (staff check removed)`
      : "authz removal visible in checkout patch comments/signature",
  },
  {
    id: "path traversal loadReceipt",
    visible:
      patchIncludes(checkoutPatch, /path traversal/) ||
      patchIncludes(checkoutPatch, /receipts.*orderId/) ||
      Boolean(traversalHit),
    evidence: traversalHit
      ? `\`src/checkout.js:${traversalHit.line}\` — \`${traversalHit.text}\``
      : "unsafe path.join with raw orderId in checkout patch",
  },
  {
    id: "open role on createUser",
    visible:
      patchIncludes(usersPatch, /accepts any role/) ||
      patchIncludes(usersPatch, /-const ALLOWED_ROLES/),
    evidence: roleHit
      ? `\`src/users.js\` — role allowlist removed; comment at line near createUser (\`${roleHit.text}\`)`
      : "ALLOWED_ROLES deletion visible in users.js diff",
  },
  {
    id: "Object.assign updateProfile",
    visible: patchIncludes(usersPatch, /Object\.assign\(user,\s*parsed\)/),
    evidence: assignHit
      ? `\`src/users.js:${assignHit.line}\` — \`${assignHit.text}\``
      : "not found",
  },
  {
    id: "missing tests for new endpoints",
    visible:
      patchIncludes(serverPatch, /\/refunds/) ||
      patchIncludes(serverPatch, /\/receipts\//) ||
      patchIncludes(serverPatch, /\/profile\//),
    evidence: (() => {
      const testFiles = diff.files.filter((f) => /test/i.test(f.filename));
      const endpoints = [
        findAddedLine(serverPatch, /\/refunds/),
        findAddedLine(serverPatch, /\/receipts\//),
        findAddedLine(serverPatch, /\/profile\//),
      ].filter(Boolean);
      const epTxt = endpoints.map((e) => `src/server.js:${e.line}`).join(", ");
      return `New endpoints in diff (${epTxt || "server.js"}); test file changes in PR: ${
        testFiles.length ? testFiles.map((f) => f.filename).join(", ") : "**none**"
      } — agent can flag missing tests from diff triage alone`;
    })(),
  },
];

out("| Bug | Locatable from tool data? | Evidence (path:line) |");
out("| --- | --- | --- |");
for (const b of planted) {
  out(`| ${b.id} | ${b.visible ? "YES" : "NO"} | ${(b.evidence + (b.extra || "")).replace(/\|/g, "\\|")} |`);
}
out();
const visibleCount = planted.filter((b) => b.visible).length;
out(`**Score: ${visibleCount}/${planted.length} planted bugs have locatable evidence in returned tool data.**`);
out();

// --- 6. postReview dry_run: valid + invalid --------------------------------

const pricingRights = rightLinesFromPatch(pricingPatch);
const checkoutRights = rightLinesFromPatch(checkoutPatch);
const usersRights = rightLinesFromPatch(usersPatch);

const validComments = [];
const pick = (path, preferredLine, rights, body) => {
  const line =
    preferredLine && rights.includes(preferredLine)
      ? preferredLine
      : rights[Math.floor(rights.length / 2)] ?? rights[0];
  if (line == null) return;
  validComments.push({ path, line, side: "RIGHT", body });
};

pick(
  "src/pricing.js",
  findAddedLine(pricingPatch, /return 0/)?.line ?? vipHit?.line,
  pricingRights,
  "[eval] VIP coupon path makes checkout free — high severity logic/security finding (dry_run).",
);
pick(
  "src/checkout.js",
  refundHit?.line,
  checkoutRights,
  "[eval] refundOrder no longer checks staff authorization (dry_run).",
);
pick(
  "src/users.js",
  assignHit?.line,
  usersRights,
  "[eval] Object.assign(user, parsed) allows prototype/role pollution (dry_run).",
);

out("## postReview dry_run validation");
out();
out("### Valid comments (preview)");
for (const c of validComments) {
  out(`- \`${c.path}:${c.line}\` (${c.side})`);
}

const dryValid = await runTool("postReview(dry_run, valid)", () =>
  postReview(
    OWNER,
    REPO,
    PR,
    headSha,
    "## Eval dry-run only\n\nIntentional preview — do not post.",
    validComments,
    true,
  ),
);
out(`### postReview dry_run (valid) — ${dryValid.ok ? "PASS" : "FAIL"} (${fmtMs(dryValid.ms)})`);
if (dryValid.ok) {
  const r = dryValid.result;
  out(`- posted: ${r.posted} (must be false)`);
  out(`- dry_run: ${r.dry_run}`);
  out(`- commit_sha: \`${r.commit_sha}\``);
  out(`- comment_count: ${r.comment_count}`);
  if (r.posted === true) {
    out("- **BREAKAGE: dry_run returned posted=true**");
  }
} else {
  out(`- error: ${JSON.stringify(summarizeError(dryValid.error))}`);
}
out();

const invalidLine = 99999;
const invalidComments = [
  ...validComments.slice(0, 1),
  {
    path: "src/pricing.js",
    line: invalidLine,
    side: "RIGHT",
    body: "[eval] intentionally invalid line to exercise validation",
  },
];

const dryInvalid = await runTool("postReview(dry_run, invalid line)", () =>
  postReview(
    OWNER,
    REPO,
    PR,
    headSha,
    "## Eval dry-run invalid line",
    invalidComments,
    true,
  ),
);
out(`### postReview dry_run (1 invalid line ${invalidLine}) — expected validation ToolError`);
if (!dryInvalid.ok && isToolError(dryInvalid.error)) {
  const err = dryInvalid.error;
  const details = err.details ?? {};
  const invalidList = details.invalid_comments;
  const first = Array.isArray(invalidList) ? invalidList[0] : null;
  const hasNearest =
    (first && Array.isArray(first.nearest_valid_lines) && first.nearest_valid_lines.length > 0) ||
    (details && Array.isArray(details.nearest_valid_lines));
  const shapeOk = err.kind === "validation" && (Boolean(invalidList) || hasNearest);
  out(`- caught ToolError in ${fmtMs(dryInvalid.ms)}`);
  out(`- kind: \`${err.kind}\` ${err.kind === "validation" ? "(OK)" : "(UNEXPECTED)"}`);
  out(`- message: ${err.message}`);
  out(`- has invalid_comments: ${Boolean(invalidList)}`);
  out(
    `- nearest_valid_lines: ${
      first?.nearest_valid_lines
        ? JSON.stringify(first.nearest_valid_lines)
        : details.nearest_valid_lines
          ? JSON.stringify(details.nearest_valid_lines)
          : "n/a"
    }`,
  );
  if (first) {
    out(`- first invalid: path=${first.path} line=${first.line} reason=${first.reason}`);
    out(`- commentable_lines: ${first.commentable_lines ?? "n/a"}`);
  }
  out(`- validation shape assert: ${shapeOk ? "PASS" : "FAIL"}`);
  if (!(err instanceof ToolError)) {
    out("- note: error is ToolError-shaped but not instanceof (unexpected)");
  }
} else if (dryInvalid.ok) {
  out(`- FAIL — call succeeded unexpectedly; posted=${dryInvalid.result.posted}`);
} else {
  out(`- FAIL — non-ToolError throw: ${JSON.stringify(summarizeError(dryInvalid.error))}`);
}
out();

// Safety: ensure we never called with dry_run false
out("## Safety");
out();
out("- All `postReview` calls used `dry_run: true` only.");
out("- No real review was posted to GitHub.");
out();

// --- Efficiency / breakage / verdict ---------------------------------------

const wallMs = Date.now() - wallStart;
const fails = toolResults.filter((r) => {
  if (r.label.includes("invalid line")) {
    // expected failure
    return !(r.error && isToolError(r.error) && r.error.kind === "validation");
  }
  return !r.ok;
});

out("## Efficiency");
out();
out(`- Approximate tool call count: **${callCount}**`);
out(`- Total wall time: **${fmtMs(wallMs)}**`);
out("- Per-step latency:");
for (const r of toolResults) {
  const status =
    r.label.includes("invalid line") && !r.ok && isToolError(r.error)
      ? `expected-fail(${r.error.kind})`
      : r.ok
        ? "ok"
        : `FAIL(${summarizeError(r.error).kind})`;
  out(`  - ${r.label}: ${fmtMs(r.ms)} — ${status}`);
}
out();

out("## Breakage");
out();
const breakage = [];
if (!authOk) breakage.push("Auth failed");
if (fails.length) {
  for (const f of fails) {
    breakage.push(`${f.label}: ${JSON.stringify(summarizeError(f.error))}`);
  }
}
if (dryValid.ok && dryValid.result.posted) {
  breakage.push("dry_run posted a real review (posted=true)");
}
if (diff.truncated) breakage.push("diff truncated=true (may need paging / get_file_content)");
if (diff.omitted_files?.length) {
  breakage.push(`omitted_files non-empty: ${JSON.stringify(diff.omitted_files)}`);
}
if (!dryInvalid.ok && isToolError(dryInvalid.error)) {
  const d = dryInvalid.error.details;
  if (!d?.invalid_comments && !d?.nearest_valid_lines) {
    // still check nested
    const first = d?.invalid_comments?.[0];
    if (!first?.nearest_valid_lines) {
      // already checked in assert above
    }
  }
}
if (breakage.length === 0) {
  out("- None observed (no crashes, no 422s to GitHub, validation errors were structured ToolErrors).");
} else {
  for (const b of breakage) out(`- ${b}`);
}
out();

const coreOk =
  rulesR.ok &&
  diffR.ok &&
  threadsR.ok &&
  search1.ok &&
  dryValid.ok &&
  dryValid.result.posted === false &&
  dryValid.result.dry_run === true &&
  !dryInvalid.ok &&
  isToolError(dryInvalid.error) &&
  dryInvalid.error.kind === "validation" &&
  Boolean(dryInvalid.error.details?.invalid_comments);

const ready =
  coreOk &&
  visibleCount >= 5 &&
  breakage.filter((b) => !b.includes("truncated") && !b.includes("omitted")).length === 0;

out("## Verdict");
out();
if (ready) {
  out("**ready** — Live Bugbot MCP client tools succeeded against the real PR; planted bugs are visible in diffs/context; dry_run preview works; invalid lines return structured `validation` ToolErrors with `invalid_comments` / `nearest_valid_lines`; nothing was posted to GitHub.");
} else if (coreOk) {
  out(
    `**needs work** — Core tool path mostly works, but accuracy (${visibleCount}/${planted.length}) or secondary checks fell short.`,
  );
} else {
  out("**needs work** — One or more critical tool steps failed or validation shape was wrong. See Breakage / tool results above.");
}
out();

const report = lines.join("\n") + "\n";
writeFileSync(REPORT_PATH, report);
out(`Report written to \`${REPORT_PATH.pathname}\``);
