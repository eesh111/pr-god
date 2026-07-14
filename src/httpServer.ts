#!/usr/bin/env node
/**
 * HTTP (Streamable HTTP) entrypoint for Cursor dashboard / Automations.
 *
 * Cursor cloud Automations cannot use local stdio MCP. Host this server at a
 * public HTTPS URL, then add it on cursor.com → Settings → MCP (or team MCP).
 *
 * Auth (recommended):
 *   MCP_HTTP_BEARER=<secret>  — require Authorization: Bearer <secret>
 *
 * Env (same as stdio): GITHUB_TOKEN or GitHub App vars.
 *
 * Listen:
 *   PORT=8787 (default)
 *   HOST=0.0.0.0 (default; use 127.0.0.1 only for local tunnels)
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createPrReviewerServer } from "./serverFactory.js";

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || "0.0.0.0";
const BEARER = process.env.MCP_HTTP_BEARER?.trim() || "";

type SessionRec = {
  transport: StreamableHTTPServerTransport;
};

const sessions = new Map<string, SessionRec>();

function unauthorized(res: Response): void {
  res.status(401).json({ error: "unauthorized", message: "Missing or invalid Bearer token" });
}

function checkAuth(req: Request, res: Response): boolean {
  if (!BEARER) return true;
  const header = req.headers.authorization || "";
  const ok = header === `Bearer ${BEARER}`;
  if (!ok) unauthorized(res);
  return ok;
}

async function main(): Promise<void> {
  const app = createMcpExpressApp({ host: HOST });

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      name: "pr-reviewer",
      transport: "streamable-http",
      auth: BEARER ? "bearer" : "none",
    });
  });

  app.post("/mcp", async (req, res) => {
    if (!checkAuth(req, res)) return;

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    try {
      if (sessionId && sessions.has(sessionId)) {
        const { transport } = sessions.get(sessionId)!;
        await transport.handleRequest(req, res, req.body);
        return;
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        const server = createPrReviewerServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport });
            console.error(`[pr-review-mcp] http session started: ${id}`);
          },
        });

        transport.onclose = () => {
          const id = transport.sessionId;
          if (id) {
            sessions.delete(id);
            console.error(`[pr-review-mcp] http session closed: ${id}`);
          }
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      res.status(400).json({
        error: "bad_request",
        message:
          "Expected InitializeRequest without session, or a request with a valid mcp-session-id.",
      });
    } catch (err) {
      console.error("[pr-review-mcp] http /mcp error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "internal_error", message: String((err as Error).message) });
      }
    }
  });

  app.get("/mcp", async (req, res) => {
    if (!checkAuth(req, res)) return;
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({ error: "bad_request", message: "Invalid or missing mcp-session-id" });
      return;
    }
    const { transport } = sessions.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  app.delete("/mcp", async (req, res) => {
    if (!checkAuth(req, res)) return;
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({ error: "bad_request", message: "Invalid or missing mcp-session-id" });
      return;
    }
    const { transport } = sessions.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  app.listen(PORT, HOST, () => {
    console.error(
      `[pr-review-mcp] HTTP server listening on http://${HOST}:${PORT}/mcp` +
        (BEARER ? " (Bearer auth enabled)" : " (WARNING: no MCP_HTTP_BEARER set)"),
    );
  });
}

main().catch((err) => {
  console.error("[pr-review-mcp] fatal error starting HTTP server:", err);
  process.exit(1);
});
