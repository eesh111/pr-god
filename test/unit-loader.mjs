process.env.DOTENV_CONFIG_PATH = "definitely-nonexistent.env";
process.env.GITHUB_TOKEN = "synthetic-token-not-used";

import { harness, expectThrows } from "./helpers/assert.mjs";
import { ToolError } from "../dist/errors.js";
// Dynamic import AFTER env is set (loader.js -> config.js reads env at load time).
const { __setOctokitForTest, getReviewRules } = await import("../dist/rules/loader.js");

const { check, section, done } = harness("unit-loader");

const rulesText = "# Review rules\n- Ignore console.log in tests.";
const rulesB64 = Buffer.from(rulesText, "utf8").toString("base64");

function octo(getContent) {
  return { repos: { getContent } };
}

section("rules found");
{
  __setOctokitForTest(octo(async () => ({ data: { type: "file", encoding: "base64", content: rulesB64 } })));
  const r = await getReviewRules("o", "r");
  check("found true", r.found === true);
  check("content decoded", r.content === rulesText);
  check("note mentions hard overrides", /hard override/i.test(r.note), r.note);
  check("path is REVIEW_INSTRUCTIONS", r.path === ".github/REVIEW_INSTRUCTIONS.md");
}

section("rules missing (404) => friendly not-found");
{
  __setOctokitForTest(
    octo(async () => {
      const e = new Error("Not Found");
      e.status = 404;
      throw e;
    }),
  );
  const r = await getReviewRules("o", "r");
  check("found false", r.found === false);
  check("empty content", r.content === "");
  check("note mentions no file / standard judgment", /no .*REVIEW_INSTRUCTIONS|standard/i.test(r.note), r.note);
}

section("other error (500) => throws mapped ToolError");
{
  __setOctokitForTest(
    octo(async () => {
      const e = new Error("server error");
      e.status = 500;
      throw e;
    }),
  );
  const err = await expectThrows(() => getReviewRules("o", "r"));
  check("throws ToolError", err instanceof ToolError, err?.constructor?.name);
  check("kind unknown for 500", err.kind === "unknown", err?.kind);
}

section("401 => throws unauthorized (not swallowed)");
{
  __setOctokitForTest(
    octo(async () => {
      const e = new Error("bad creds");
      e.status = 401;
      throw e;
    }),
  );
  const err = await expectThrows(() => getReviewRules("o", "r"));
  check("throws unauthorized", err instanceof ToolError && err.kind === "unauthorized", err?.kind);
}

section("path is a directory => found false");
{
  __setOctokitForTest(octo(async () => ({ data: [{ type: "file", name: "x" }] })));
  const r = await getReviewRules("o", "r");
  check("found false for directory", r.found === false);
  check("note about not readable", /not a readable file/i.test(r.note), r.note);
}

section("non-file type => found false");
{
  __setOctokitForTest(octo(async () => ({ data: { type: "symlink" } })));
  const r = await getReviewRules("o", "r");
  check("found false for symlink", r.found === false);
}

done();
