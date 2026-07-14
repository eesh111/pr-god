/**
 * Standardized error contract for tool handlers.
 *
 * Every tool returns either a normal success payload or a consistent
 * `{ isError: true, content: [...] }` shape whose text is
 * `{ error: { kind, message } }`. This lets Cursor's agent distinguish
 * "PR not found" from "insufficient permission" from "rate limited" instead
 * of getting an opaque throw / stack trace.
 */

export type ToolErrorKind =
  | "not_found"
  | "unauthorized"
  | "forbidden"
  | "rate_limit"
  | "validation"
  | "network"
  | "unknown";

export class ToolError extends Error {
  readonly kind: ToolErrorKind;
  /** Optional structured details (e.g. offending lines for validation). */
  readonly details?: unknown;

  constructor(kind: ToolErrorKind, message: string, details?: unknown) {
    super(message);
    this.name = "ToolError";
    this.kind = kind;
    this.details = details;
  }
}

interface OctokitLikeError {
  status?: number;
  message?: string;
  response?: {
    headers?: Record<string, string | undefined>;
    data?: unknown;
  };
}

function isRateLimited(err: OctokitLikeError): boolean {
  const headers = err.response?.headers ?? {};
  const remaining = headers["x-ratelimit-remaining"];
  const retryAfter = headers["retry-after"];
  const msg = (err.message ?? "").toLowerCase();
  return (
    remaining === "0" ||
    retryAfter !== undefined ||
    msg.includes("rate limit") ||
    msg.includes("secondary rate limit") ||
    msg.includes("abuse detection")
  );
}

/**
 * Classify an arbitrary thrown value (usually from Octokit) into a ToolError.
 * If it's already a ToolError it is returned unchanged.
 */
export function mapOctokitError(err: unknown): ToolError {
  if (err instanceof ToolError) return err;

  const e = (err ?? {}) as OctokitLikeError;
  const status = typeof e.status === "number" ? e.status : undefined;
  const baseMessage = e.message ?? "Unknown error";

  switch (status) {
    case 401:
      return new ToolError(
        "unauthorized",
        `Authentication failed (401). Check that your GitHub token is valid: ${baseMessage}`,
      );
    case 403:
      if (isRateLimited(e)) {
        return new ToolError(
          "rate_limit",
          `GitHub rate limit hit (403). Wait and retry, or reduce code-search usage: ${baseMessage}`,
          { headers: e.response?.headers },
        );
      }
      return new ToolError(
        "forbidden",
        `Access forbidden (403). Your token likely lacks the required scope/permission: ${baseMessage}`,
      );
    case 404:
      return new ToolError(
        "not_found",
        `Not found (404). Check owner/repo/pr_number/path/ref: ${baseMessage}`,
      );
    case 422:
      return new ToolError(
        "validation",
        `GitHub rejected the request as invalid (422): ${baseMessage}`,
        e.response?.data,
      );
    case 429:
      return new ToolError(
        "rate_limit",
        `Too many requests (429). Back off and retry: ${baseMessage}`,
      );
    default:
      break;
  }

  // Network-ish errors (no HTTP status) surfaced by fetch/undici/node.
  const code = (err as { code?: string })?.code;
  if (
    !status &&
    (code === "ENOTFOUND" ||
      code === "ECONNREFUSED" ||
      code === "ETIMEDOUT" ||
      code === "ECONNRESET" ||
      code === "EAI_AGAIN")
  ) {
    return new ToolError("network", `Network error contacting GitHub: ${baseMessage}`);
  }

  return new ToolError("unknown", baseMessage);
}

export interface McpTextResult {
  // Index signature so this is assignable to the MCP SDK's CallToolResult,
  // whose type carries `[x: string]: unknown`.
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** Serialize a successful result into the MCP text-content shape. */
export function ok(result: unknown): McpTextResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

/**
 * Wrap a tool handler so any thrown error becomes the standardized
 * `{ isError: true, content: [{ error: { kind, message } }] }` shape.
 */
export function withToolError<Args>(
  fn: (args: Args) => Promise<unknown>,
): (args: Args) => Promise<McpTextResult> {
  return async (args: Args): Promise<McpTextResult> => {
    try {
      const result = await fn(args);
      return ok(result);
    } catch (err) {
      const toolErr = mapOctokitError(err);
      const payload = {
        error: {
          kind: toolErr.kind,
          message: toolErr.message,
          ...(toolErr.details !== undefined ? { details: toolErr.details } : {}),
        },
      };
      // Log full context to stderr for debugging; stdout stays protocol-only.
      console.error(`[pr-review-mcp] tool error (${toolErr.kind}): ${toolErr.message}`);
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }
  };
}
