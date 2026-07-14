import "dotenv/config";
import { z } from "zod";

/**
 * Environment configuration for the PR Review MCP server.
 *
 * Two auth modes are supported:
 *  - PAT (default): GITHUB_TOKEN is set.
 *  - GitHub App: all three GITHUB_APP_* vars are set (PAT is then optional).
 *
 * The App path is wired here but the actual token exchange lives in
 * github/client.ts so it stays a drop-in later without touching config.
 */

const positiveIntString = z
  .string()
  .min(1)
  .refine((v) => /^\d+$/.test(v) && Number(v) > 0, {
    message: "must be a positive integer",
  });

const rawSchema = z.object({
  GITHUB_TOKEN: z.string().min(1).optional(),
  GITHUB_APP_ID: z.string().min(1).optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
  GITHUB_APP_INSTALLATION_ID: positiveIntString.optional(),
  GITHUB_API_BASE_URL: z.string().url().optional(),
  MAX_DIFF_PATCH_BYTES: z.coerce.number().int().positive().optional(),
  /** Soft cap for get_file_content blob fallback (bytes). Default 8 MiB. */
  MAX_FILE_CONTENT_BYTES: z.coerce.number().int().positive().optional(),
});

function fail(message: string): never {
  // stderr only: stdout is the JSON-RPC channel for stdio transport.
  console.error(`[pr-god] config error: ${message}`);
  process.exit(1);
}

const parsed = rawSchema.safeParse(process.env);
if (!parsed.success) {
  fail(
    "invalid environment variables:\n" +
      parsed.error.issues
        .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n"),
  );
}

const env = parsed.data;

const appVars = [
  env.GITHUB_APP_ID,
  env.GITHUB_APP_PRIVATE_KEY,
  env.GITHUB_APP_INSTALLATION_ID,
] as const;
const appVarsPresent = appVars.filter(Boolean).length;
const hasApp = appVarsPresent === 3;
const hasPat = Boolean(env.GITHUB_TOKEN);

if (appVarsPresent > 0 && appVarsPresent < 3) {
  fail(
    "partial GitHub App configuration. Set all of GITHUB_APP_ID, " +
      "GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID, or leave all three unset " +
      "and use GITHUB_TOKEN instead.",
  );
}

if (!hasPat && !hasApp) {
  fail(
    "no GitHub credentials found. Set GITHUB_TOKEN for PAT auth, or all of " +
      "GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_APP_INSTALLATION_ID for GitHub App auth.",
  );
}

export type AuthMode = "pat" | "app";

export interface AppConfig {
  authMode: AuthMode;
  githubToken?: string;
  app?: {
    appId: string;
    privateKey: string;
    installationId: number;
  };
  apiBaseUrl?: string;
  maxDiffPatchBytes: number;
  maxFileContentBytes: number;
}

export const config: AppConfig = {
  // Prefer App auth when fully configured, otherwise fall back to PAT.
  authMode: hasApp ? "app" : "pat",
  githubToken: env.GITHUB_TOKEN,
  app: hasApp
    ? {
        appId: env.GITHUB_APP_ID as string,
        // Support private keys pasted with literal "\n" escapes.
        privateKey: (env.GITHUB_APP_PRIVATE_KEY as string).replace(/\\n/g, "\n"),
        installationId: Number(env.GITHUB_APP_INSTALLATION_ID),
      }
    : undefined,
  apiBaseUrl: env.GITHUB_API_BASE_URL,
  maxDiffPatchBytes: env.MAX_DIFF_PATCH_BYTES ?? 500_000,
  maxFileContentBytes: env.MAX_FILE_CONTENT_BYTES ?? 8 * 1024 * 1024,
};
