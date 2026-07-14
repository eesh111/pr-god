import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { harness } from "./helpers/assert.mjs";

const { check, section, done } = harness("config.spawn");

const helper = fileURLToPath(new URL("./helpers/print-config.mjs", import.meta.url));

// Base env: inherit system vars (PATH etc.) but strip all GitHub/config vars and
// point dotenv at a nonexistent file so the real .env is never read.
function baseEnv() {
  const env = { ...process.env, DOTENV_CONFIG_PATH: "definitely-nonexistent.env" };
  delete env.GITHUB_TOKEN;
  delete env.GITHUB_APP_ID;
  delete env.GITHUB_APP_PRIVATE_KEY;
  delete env.GITHUB_APP_INSTALLATION_ID;
  delete env.GITHUB_API_BASE_URL;
  delete env.MAX_DIFF_PATCH_BYTES;
  return env;
}

function run(overrides) {
  const env = { ...baseEnv(), ...overrides };
  const r = spawnSync(process.execPath, [helper], { env, encoding: "utf8" });
  let config = null;
  if (r.status === 0 && r.stdout) {
    try {
      config = JSON.parse(r.stdout);
    } catch {
      config = null;
    }
  }
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", config };
}

section("PAT mode");
{
  const r = run({ GITHUB_TOKEN: "ghp_synthetic" });
  check("exit 0", r.status === 0, { status: r.status, stderr: r.stderr });
  check("authMode pat", r.config?.authMode === "pat", r.config);
  check("hasToken true", r.config?.hasToken === true);
  check("default maxDiffPatchBytes 500000", r.config?.maxDiffPatchBytes === 500000, r.config?.maxDiffPatchBytes);
  check("no app", r.config?.app === null);
}

section("no credentials => exit 1 with clear message");
{
  const r = run({});
  check("exit 1", r.status === 1, r.status);
  check("stderr mentions no credentials", /no GitHub credentials/i.test(r.stderr), r.stderr);
}

section("GitHub App mode (all three vars)");
{
  const r = run({
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN KEY-----\\nABCDEF\\n-----END KEY-----",
    GITHUB_APP_INSTALLATION_ID: "987654",
  });
  check("exit 0", r.status === 0, { status: r.status, stderr: r.stderr });
  check("authMode app", r.config?.authMode === "app", r.config);
  check("installationId numeric", r.config?.app?.installationId === 987654, r.config?.app);
  check("literal \\n converted to real newline", r.config?.app?.privateKeyHasRealNewline === true, r.config?.app);
  check("no leftover literal backslash-n", r.config?.app?.privateKeyHasLiteralBackslashN === false, r.config?.app);
}

section("App precedence over PAT when both set");
{
  const r = run({
    GITHUB_TOKEN: "ghp_synthetic",
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN-----\\nX\\n-----END-----",
    GITHUB_APP_INSTALLATION_ID: "2",
  });
  check("authMode app (precedence)", r.config?.authMode === "app", r.config);
}

section("partial App config alone => exit 1 with partial message");
{
  const r = run({ GITHUB_APP_ID: "123" });
  check("exit 1 (partial app, no token)", r.status === 1, r.status);
  check("stderr mentions partial App", /partial GitHub App/i.test(r.stderr), r.stderr);
}

section("partial App config + PAT => still exit 1 (no silent ignore)");
{
  const r = run({ GITHUB_APP_ID: "123", GITHUB_TOKEN: "ghp_synthetic" });
  check("exit 1 (partial app even with PAT)", r.status === 1, { status: r.status, stderr: r.stderr });
  check("stderr mentions partial App", /partial GitHub App/i.test(r.stderr), r.stderr);
}

section("invalid App installation ID => exit 1");
{
  const r = run({
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN-----\\nX\\n-----END-----",
    GITHUB_APP_INSTALLATION_ID: "not-a-number",
  });
  check("exit 1 for non-numeric installation id", r.status === 1, r.status);
  check("stderr mentions invalid env", /invalid environment|positive integer/i.test(r.stderr), r.stderr);
}

section("MAX_DIFF_PATCH_BYTES: custom + invalid");
{
  const ok = run({ GITHUB_TOKEN: "ghp_synthetic", MAX_DIFF_PATCH_BYTES: "250" });
  check("custom cap honored", ok.config?.maxDiffPatchBytes === 250, ok.config?.maxDiffPatchBytes);

  const bad = run({ GITHUB_TOKEN: "ghp_synthetic", MAX_DIFF_PATCH_BYTES: "not-a-number" });
  check("non-numeric cap => exit 1", bad.status === 1, bad.status);

  const neg = run({ GITHUB_TOKEN: "ghp_synthetic", MAX_DIFF_PATCH_BYTES: "-5" });
  check("negative cap => exit 1", neg.status === 1, neg.status);
}

section("GITHUB_API_BASE_URL: valid + invalid");
{
  const ok = run({ GITHUB_TOKEN: "ghp_synthetic", GITHUB_API_BASE_URL: "https://ghe.example.com/api/v3" });
  check("valid url accepted", ok.status === 0 && ok.config?.apiBaseUrl === "https://ghe.example.com/api/v3", ok.config?.apiBaseUrl);

  const bad = run({ GITHUB_TOKEN: "ghp_synthetic", GITHUB_API_BASE_URL: "not a url" });
  check("invalid url => exit 1", bad.status === 1, bad.status);
}

done();
