import { harness } from "./helpers/assert.mjs";
import { ToolError, mapOctokitError, withToolError, ok } from "../dist/errors.js";

const { check, section, done } = harness("unit-errors");

section("mapOctokitError: HTTP status classification");
{
  check("401 => unauthorized", mapOctokitError({ status: 401, message: "bad creds" }).kind === "unauthorized");
  check("404 => not_found", mapOctokitError({ status: 404, message: "missing" }).kind === "not_found");
  check("422 => validation", mapOctokitError({ status: 422, message: "invalid" }).kind === "validation");
  check("429 => rate_limit", mapOctokitError({ status: 429, message: "slow down" }).kind === "rate_limit");
  check("403 plain => forbidden", mapOctokitError({ status: 403, message: "forbidden" }).kind === "forbidden");
  check("500 => unknown", mapOctokitError({ status: 500, message: "server error" }).kind === "unknown");
}

section("mapOctokitError: rate-limit detection variants");
{
  check(
    "403 + x-ratelimit-remaining:0",
    mapOctokitError({ status: 403, message: "x", response: { headers: { "x-ratelimit-remaining": "0" } } }).kind === "rate_limit",
  );
  check(
    "403 + retry-after header",
    mapOctokitError({ status: 403, message: "x", response: { headers: { "retry-after": "30" } } }).kind === "rate_limit",
  );
  check(
    "403 + 'secondary rate limit' message",
    mapOctokitError({ status: 403, message: "You have exceeded a secondary rate limit" }).kind === "rate_limit",
  );
  check(
    "403 + 'abuse detection' message",
    mapOctokitError({ status: 403, message: "abuse detection mechanism triggered" }).kind === "rate_limit",
  );
}

section("mapOctokitError: 422 keeps details");
{
  const mapped = mapOctokitError({ status: 422, message: "invalid", response: { data: { errors: [{ field: "line" }] } } });
  check("kind validation", mapped.kind === "validation");
  check("details carried through", JSON.stringify(mapped.details) === JSON.stringify({ errors: [{ field: "line" }] }), mapped.details);
}

section("mapOctokitError: network codes (no status)");
{
  check("ENOTFOUND => network", mapOctokitError({ code: "ENOTFOUND", message: "dns" }).kind === "network");
  check("ECONNREFUSED => network", mapOctokitError({ code: "ECONNREFUSED", message: "refused" }).kind === "network");
  check("ETIMEDOUT => network", mapOctokitError({ code: "ETIMEDOUT", message: "timeout" }).kind === "network");
  check("ECONNRESET => network", mapOctokitError({ code: "ECONNRESET", message: "reset" }).kind === "network");
  check("EAI_AGAIN => network", mapOctokitError({ code: "EAI_AGAIN", message: "again" }).kind === "network");
}

section("mapOctokitError: passthrough + fallbacks");
{
  const te = new ToolError("validation", "already a tool error", { a: 1 });
  const mapped = mapOctokitError(te);
  check("ToolError passthrough identity", mapped === te);
  check("passthrough keeps kind", mapped.kind === "validation");
  check("passthrough keeps details", JSON.stringify(mapped.details) === JSON.stringify({ a: 1 }));

  check("plain Error => unknown", mapOctokitError(new Error("boom")).kind === "unknown");
  check("plain Error keeps message", mapOctokitError(new Error("boom")).message === "boom");
  check("string throw => unknown", mapOctokitError("weird").kind === "unknown");
  check("null throw => unknown", mapOctokitError(null).kind === "unknown");
  check("undefined throw => unknown", mapOctokitError(undefined).kind === "unknown");
}

section("ok(): success shape");
{
  const r = ok({ hello: "world", n: 2 });
  check("has content array", Array.isArray(r.content) && r.content.length === 1);
  check("content type text", r.content[0].type === "text");
  check("text is JSON of result", JSON.parse(r.content[0].text).hello === "world");
  check("no isError on success", r.isError === undefined);
}

section("withToolError: success path");
{
  const wrapped = withToolError(async (a) => ({ doubled: a.x * 2 }));
  const r = await wrapped({ x: 21 });
  check("no isError", r.isError === undefined);
  check("returns computed result", JSON.parse(r.content[0].text).doubled === 42);
}

section("withToolError: error path (ToolError)");
{
  const wrapped = withToolError(async () => {
    throw new ToolError("validation", "bad line", { invalid_comments: [{ path: "a.ts", line: 9 }] });
  });
  const r = await wrapped({});
  check("isError true", r.isError === true);
  const payload = JSON.parse(r.content[0].text);
  check("error.kind = validation", payload.error.kind === "validation", payload.error);
  check("error.message preserved", payload.error.message === "bad line");
  check("error.details preserved", Array.isArray(payload.error.details.invalid_comments), payload.error.details);
}

section("withToolError: error path (raw Octokit-like)");
{
  const wrapped = withToolError(async () => {
    const err = new Error("Not Found");
    err.status = 404;
    throw err;
  });
  const r = await wrapped({});
  check("isError true", r.isError === true);
  check("mapped to not_found", JSON.parse(r.content[0].text).error.kind === "not_found");
}

done();
