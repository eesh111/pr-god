/**
 * Smoke-test Streamable HTTP MCP: health + initialize session.
 * Starts httpServer as a child, then hits /health and /mcp.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const PORT = 18787;
const BEARER = "smoke-test-bearer";
const base = `http://127.0.0.1:${PORT}`;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const child = spawn(process.execPath, [path.join(root, "dist/httpServer.js")], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    MCP_HTTP_BEARER: BEARER,
    // Avoid real GitHub during smoke; tools aren't invoked.
    GITHUB_TOKEN: process.env.GITHUB_TOKEN || "smoke-dummy-token",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (c) => {
  stderr += c.toString();
});

async function waitReady() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await sleep(100);
  }
  throw new Error(`HTTP server did not become ready.\nstderr:\n${stderr}`);
}

try {
  await waitReady();

  const health = await fetch(`${base}/health`).then((r) => r.json());
  assert(health.ok === true, "health.ok");
  assert(health.name === "pr-reviewer", "health.name");
  assert(health.auth === "bearer", "health.auth");

  const noAuth = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "http-smoke", version: "0.0.0" },
      },
    }),
  });
  assert(noAuth.status === 401, `expected 401 without bearer, got ${noAuth.status}`);

  const initRes = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${BEARER}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "http-smoke", version: "0.0.0" },
      },
    }),
  });
  const bodyText = await initRes.text();
  assert(initRes.ok, `initialize failed: ${initRes.status} ${bodyText.slice(0, 500)}`);
  const sessionId = initRes.headers.get("mcp-session-id");
  assert(sessionId, "missing mcp-session-id header");
  assert(
    bodyText.includes("pr-reviewer") ||
      bodyText.includes("pr-review-mcp") ||
      bodyText.includes("result") ||
      bodyText.includes("serverInfo"),
    `unexpected initialize body: ${bodyText.slice(0, 500)}`,
  );

  console.log("http-smoke: OK (health + bearer reject + initialize session)");
  process.exitCode = 0;
} catch (err) {
  console.error("http-smoke: FAIL", err);
  process.exitCode = 1;
} finally {
  if (child.pid) {
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {
      /* ignore */
    }
    await sleep(200);
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
}
