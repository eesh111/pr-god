/**
 * Helper spawned by config.spawn.mjs. Imports the compiled config module (which
 * validates env and may process.exit) and prints the resulting config as JSON.
 *
 * The parent controls the environment; DOTENV_CONFIG_PATH is pointed at a
 * nonexistent file so the real .env is never read during tests.
 */
import { config } from "../../dist/config.js";

// Redact any secret before printing (we only need shape/mode, never the token).
const redacted = {
  authMode: config.authMode,
  hasToken: Boolean(config.githubToken),
  app: config.app
    ? {
        appId: config.app.appId,
        installationId: config.app.installationId,
        privateKeyHasRealNewline: config.app.privateKey.includes("\n"),
        privateKeyHasLiteralBackslashN: config.app.privateKey.includes("\\n"),
      }
    : null,
  apiBaseUrl: config.apiBaseUrl ?? null,
  maxDiffPatchBytes: config.maxDiffPatchBytes,
  maxFileContentBytes: config.maxFileContentBytes,
};

process.stdout.write(JSON.stringify(redacted));
