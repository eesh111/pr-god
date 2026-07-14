import { harness } from "./helpers/assert.mjs";
import {
  parseHunks,
  validateCommentLine,
  commentableLinesSummary,
  isPatchPresent,
} from "../dist/github/diffUtils.js";

const { check, section, done } = harness("unit-diffutils");

const sortNums = (s) => [...s].sort((a, b) => a - b).join(",");

section("single hunk: added + removed + context");
{
  const patch = "@@ -10,3 +10,4 @@\n line10\n-old11\n+new11\n+new12\n line13";
  const { rightLines, leftLines } = parseHunks(patch);
  check("RIGHT = 10,11,12,13", sortNums(rightLines) === "10,11,12,13", sortNums(rightLines));
  check("LEFT = 10,11,12", sortNums(leftLines) === "10,11,12", sortNums(leftLines));
}

section("added-only hunk (new file region)");
{
  const patch = "@@ -0,0 +1,3 @@\n+a\n+b\n+c";
  const { rightLines, leftLines } = parseHunks(patch);
  check("RIGHT = 1,2,3", sortNums(rightLines) === "1,2,3", sortNums(rightLines));
  check("LEFT empty", leftLines.size === 0);
}

section("removed-only hunk");
{
  const patch = "@@ -5,3 +5,0 @@\n-a\n-b\n-c";
  const { rightLines, leftLines } = parseHunks(patch);
  check("LEFT = 5,6,7", sortNums(leftLines) === "5,6,7", sortNums(leftLines));
  check("RIGHT empty", rightLines.size === 0);
}

section("multi-hunk patch combines line sets");
{
  const patch =
    "@@ -10,3 +10,4 @@\n line10\n-old11\n+new11\n+new12\n line13\n" +
    "@@ -30,2 +31,2 @@\n ctx30\n-rem31\n+add32";
  const { rightLines, leftLines } = parseHunks(patch);
  check("RIGHT = 10,11,12,13,31,32", sortNums(rightLines) === "10,11,12,13,31,32", sortNums(rightLines));
  check("LEFT = 10,11,12,30,31", sortNums(leftLines) === "10,11,12,30,31", sortNums(leftLines));
}

section("single-line hunk header (no counts)");
{
  const patch = "@@ -1 +1 @@\n-old\n+new";
  const { rightLines, leftLines } = parseHunks(patch);
  check("RIGHT = 1", sortNums(rightLines) === "1", sortNums(rightLines));
  check("LEFT = 1", sortNums(leftLines) === "1", sortNums(leftLines));
}

section("ignores '\\ No newline' marker and file headers");
{
  const patch = "@@ -1,2 +1,2 @@\n ctx1\n-old2\n+new2\n\\ No newline at end of file";
  const { rightLines, leftLines } = parseHunks(patch);
  check("RIGHT = 1,2", sortNums(rightLines) === "1,2", sortNums(rightLines));
  check("LEFT = 1,2", sortNums(leftLines) === "1,2", sortNums(leftLines));
}

section("CRLF line endings still parse");
{
  const patch = "@@ -10,3 +10,4 @@\r\n line10\r\n-old11\r\n+new11\r\n+new12\r\n line13";
  const { rightLines } = parseHunks(patch);
  check("RIGHT = 10,11,12,13 with CRLF", sortNums(rightLines) === "10,11,12,13", sortNums(rightLines));
}

section("empty / null / malformed patches => empty sets");
{
  check("empty string", parseHunks("").rightLines.size === 0 && parseHunks("").leftLines.size === 0);
  check("null", parseHunks(null).rightLines.size === 0);
  check("undefined", parseHunks(undefined).rightLines.size === 0);
  const noHeader = parseHunks("just some text\nwith no hunk header");
  check("no hunk header => empty", noHeader.rightLines.size === 0 && noHeader.leftLines.size === 0);
}

section("isPatchPresent");
{
  check("present when non-empty string", isPatchPresent({ patch: "@@ -1 +1 @@\n+x" }) === true);
  check("absent when empty string", isPatchPresent({ patch: "" }) === false);
  check("absent when undefined", isPatchPresent({}) === false);
  check("absent when null", isPatchPresent({ patch: null }) === false);
}

section("validateCommentLine RIGHT/LEFT");
{
  const patch = "@@ -10,3 +10,4 @@\n line10\n-old11\n+new11\n+new12\n line13";
  check("RIGHT 11 valid", validateCommentLine(patch, 11, "RIGHT").ok === true);
  check("RIGHT 13 valid (context)", validateCommentLine(patch, 13, "RIGHT").ok === true);
  check("RIGHT default side valid", validateCommentLine(patch, 12).ok === true);
  check("LEFT 11 valid (removed)", validateCommentLine(patch, 11, "LEFT").ok === true);
  check("LEFT 13 invalid (not in old)", validateCommentLine(patch, 13, "LEFT").ok === false);

  const bad = validateCommentLine(patch, 999, "RIGHT");
  check("RIGHT 999 invalid", bad.ok === false);
  check("invalid provides nearest (ascending)", Array.isArray(bad.nearest) && bad.nearest.length > 0, bad.nearest);
  check("nearest sorted ascending", JSON.stringify(bad.nearest) === JSON.stringify([...bad.nearest].sort((a, b) => a - b)), bad.nearest);
  check("nearest capped at 6", bad.nearest.length <= 6, bad.nearest.length);

  const missing = validateCommentLine(undefined, 5, "RIGHT");
  check("missing patch => not ok", missing.ok === false);
  check("missing patch reason mentions no diff", /no diff patch/i.test(missing.reason), missing.reason);
}

section("commentableLinesSummary ranges");
{
  const contiguous = "@@ -10,3 +10,4 @@\n line10\n-old11\n+new11\n+new12\n line13";
  check("contiguous => 10-13", commentableLinesSummary(contiguous, "RIGHT") === "10-13", commentableLinesSummary(contiguous, "RIGHT"));

  const multi =
    "@@ -10,3 +10,4 @@\n line10\n-old11\n+new11\n+new12\n line13\n" +
    "@@ -30,2 +31,2 @@\n ctx30\n-rem31\n+add32";
  check("multi RIGHT => 10-13, 31-32", commentableLinesSummary(multi, "RIGHT") === "10-13, 31-32", commentableLinesSummary(multi, "RIGHT"));
  check("multi LEFT => 10-12, 30-31", commentableLinesSummary(multi, "LEFT") === "10-12, 30-31", commentableLinesSummary(multi, "LEFT"));

  const single = "@@ -1 +1 @@\n-old\n+new";
  check("single line => '1'", commentableLinesSummary(single, "RIGHT") === "1", commentableLinesSummary(single, "RIGHT"));

  check("empty patch => (none)", commentableLinesSummary("", "RIGHT") === "(none)");
}

done();
