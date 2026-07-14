/**
 * Unified-diff parsing utilities (plan gap 1: line-number validation).
 *
 * GitHub's review-comment API rejects (422) any inline comment whose line is
 * not part of the diff hunk. We parse the `@@ -a,b +c,d @@` headers in a file's
 * patch to know exactly which line numbers are commentable, per side:
 *
 *   RIGHT side (default): added ('+') and context (' ') lines, numbered in the
 *     new file. This is where almost all review comments go.
 *   LEFT side: removed ('-') and context (' ') lines, numbered in the old file.
 *
 * These sets let us reject bad lines with actionable feedback BEFORE calling
 * GitHub, instead of surfacing an opaque 422.
 */

export type DiffSide = "RIGHT" | "LEFT";

export interface ParsedPatch {
  rightLines: Set<number>;
  leftLines: Set<number>;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified-diff patch string into the sets of commentable line numbers
 * for each side. Returns empty sets when the patch is absent/empty.
 */
export function parseHunks(patch: string | null | undefined): ParsedPatch {
  const rightLines = new Set<number>();
  const leftLines = new Set<number>();
  if (!patch) return { rightLines, leftLines };

  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldLine = parseInt(header[1], 10);
      newLine = parseInt(header[3], 10);
      inHunk = true;
      continue;
    }

    // Ignore anything before the first hunk header (diff/index/file headers).
    if (!inHunk) continue;

    // Ignore the "\ No newline at end of file" marker and file headers.
    if (line.startsWith("\\")) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;

    const marker = line[0];
    if (marker === "+") {
      rightLines.add(newLine);
      newLine += 1;
    } else if (marker === "-") {
      leftLines.add(oldLine);
      oldLine += 1;
    } else {
      // context line (starts with a space, or empty line inside a hunk):
      // present on both sides.
      rightLines.add(newLine);
      leftLines.add(oldLine);
      newLine += 1;
      oldLine += 1;
    }
  }

  return { rightLines, leftLines };
}

/** True when GitHub actually returned patch text for this file. */
export function isPatchPresent(file: { patch?: string | null }): boolean {
  return typeof file.patch === "string" && file.patch.length > 0;
}

export interface LineValidation {
  ok: boolean;
  reason?: string;
  /** Nearby valid line numbers on the requested side, for actionable feedback. */
  nearest?: number[];
}

/**
 * Validate that `line` is commentable on `side` for the given patch.
 * On failure, includes the nearest valid lines so the agent can adjust.
 */
export function validateCommentLine(
  patch: string | null | undefined,
  line: number,
  side: DiffSide = "RIGHT",
): LineValidation {
  if (!isPatchPresent({ patch })) {
    return {
      ok: false,
      reason:
        "No diff patch is available for this file (it may be too large, binary, or unchanged). " +
        "Reference the issue in the review summary instead of as an inline comment.",
    };
  }

  const { rightLines, leftLines } = parseHunks(patch);
  const valid = side === "LEFT" ? leftLines : rightLines;

  if (valid.has(line)) return { ok: true };

  const sorted = [...valid].sort((a, b) => a - b);
  const nearest = sorted
    .map((l) => ({ l, d: Math.abs(l - line) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 6)
    .map((x) => x.l)
    .sort((a, b) => a - b);

  return {
    ok: false,
    reason:
      `Line ${line} is not part of the diff on the ${side} side, so GitHub would reject ` +
      `an inline comment there. Move the comment to a changed/context line, or put the ` +
      `observation in the review summary.`,
    nearest,
  };
}

/** Compact "1-4, 10, 22-25" style summary of commentable lines for a side. */
export function commentableLinesSummary(
  patch: string | null | undefined,
  side: DiffSide = "RIGHT",
): string {
  const { rightLines, leftLines } = parseHunks(patch);
  const nums = [...(side === "LEFT" ? leftLines : rightLines)].sort((a, b) => a - b);
  if (nums.length === 0) return "(none)";

  const ranges: string[] = [];
  let start = nums[0];
  let prev = nums[0];
  for (let i = 1; i < nums.length; i++) {
    const n = nums[i];
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = n;
    prev = n;
  }
  ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
  return ranges.join(", ");
}
