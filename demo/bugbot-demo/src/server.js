import http from "node:http";
import { createUser, updateProfile } from "./users.js";
import { placeOrder, refundOrder, loadReceipt } from "./checkout.js";

const port = Number(process.env.PORT) || 3847;

createUser({ email: "shopper@example.com" });
createUser({ email: "ops@example.com", role: "admin" });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/orders") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const payload = JSON.parse(body || "{}");
      const result = placeOrder(payload);
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err.message || err) }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/refunds") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const payload = JSON.parse(body || "{}");
      // BUG: actor taken from body; refundOrder no longer checks admin
      const result = refundOrder(payload.actor, payload.orderId);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err.message || err) }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/receipts") {
    try {
      // BUG: orderId from query used unsafely inside loadReceipt
      const text = loadReceipt(url.searchParams.get("orderId") || "");
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(text);
    } catch (err) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err.message || err) }));
    }
    return;
  }

  if (req.method === "PATCH" && url.pathname === "/profile") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const payload = JSON.parse(body || "{}");
      const user = updateProfile(payload.userId, payload.patchJson);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(user));
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err.message || err) }));
    }
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(port, () => {
  console.log(`bugbot-demo listening on ${port}`);
});
