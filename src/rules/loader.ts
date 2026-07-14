import { mapOctokitError } from "../errors.js";
import { getOctokit } from "../github/client.js";

/**
 * Loads team review rules from `.github/REVIEW_INSTRUCTIONS.md` in the TARGET
 * repository being reviewed (not the local filesystem, since the repo under
 * review is not necessarily the one Cursor has open).
 *
 * Uses the shared throttled Octokit from github/client.ts.
 */

const RULES_PATH = ".github/REVIEW_INSTRUCTIONS.md";

/** Test-only hook: inject a fake Octokit so the loader can be tested offline. */
export { __setOctokitForTest } from "../github/client.js";

export interface ReviewRules {
  found: boolean;
  path: string;
  ref?: string;
  content: string;
  note: string;
}

/**
 * Fetch the review rules markdown from the target repo. On 404 returns a
 * friendly "no custom rules" result instead of throwing.
 */
export async function getReviewRules(
  owner: string,
  repo: string,
  ref?: string,
): Promise<ReviewRules> {
  const octokit = await getOctokit();
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: RULES_PATH,
      ...(ref ? { ref } : {}),
    });

    if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string") {
      return {
        found: false,
        path: RULES_PATH,
        ref,
        content: "",
        note: `${RULES_PATH} exists but is not a readable file.`,
      };
    }

    const content = Buffer.from(data.content, "base64").toString("utf8");
    return {
      found: true,
      path: RULES_PATH,
      ref,
      content,
      note:
        "Treat these rules as HARD overrides: never flag anything the rules say to ignore.",
    };
  } catch (err) {
    const mapped = mapOctokitError(err);
    if (mapped.kind === "not_found") {
      return {
        found: false,
        path: RULES_PATH,
        ref,
        content: "",
        note:
          `No ${RULES_PATH} found in ${owner}/${repo}. Proceed with standard review ` +
          `judgment; there are no repo-specific overrides.`,
      };
    }
    throw mapped;
  }
}
