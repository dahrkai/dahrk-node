/**
 * MCP gateway proxy tests. A throwaway upstream http server stands in for the real MCP
 * server; we assert the proxy injects the brokered Authorization, forwards method/body/response,
 * maps unknown ids to 404, and frees its port on stop().
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { startMcpGateway } from "../src/mcp-gateway.js";

/** A fake upstream that records what it received and echoes a JSON body. */
async function fakeUpstream(): Promise<{
  url: string;
  seen: { authorization?: string; method?: string; body?: string; path?: string };
  close: () => Promise<void>;
}> {
  const seen: { authorization?: string; method?: string; body?: string; path?: string } = {};
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.authorization = req.headers.authorization;
      seen.method = req.method;
      seen.body = body;
      seen.path = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("gateway injects the brokered token and forwards the request/response", async () => {
  const upstream = await fakeUpstream();
  const gw = await startMcpGateway({
    servers: [{ id: "linear", type: "http", url: upstream.url, credentialRef: "mcp-linear" }],
    creds: { linear: "lin_secret_token" },
  });
  try {
    const res = await fetch(`${gw.baseUrl}/linear`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    // The upstream saw the injected bearer; the agent-side request carried no secret.
    assert.equal(upstream.seen.authorization, "Bearer lin_secret_token");
    assert.equal(upstream.seen.method, "POST");
    assert.equal(JSON.parse(upstream.seen.body ?? "{}").method, "ping");
  } finally {
    await gw.stop();
    await upstream.close();
  }
});

test("gateway 404s an unknown server id and forwards no-auth servers without a header", async () => {
  const upstream = await fakeUpstream();
  const gw = await startMcpGateway({
    servers: [{ id: "noauth", type: "http", url: upstream.url }],
    creds: {},
  });
  try {
    assert.equal((await fetch(`${gw.baseUrl}/unknown`, { method: "POST", body: "{}" })).status, 404);
    const res = await fetch(`${gw.baseUrl}/noauth`, { method: "POST", body: "{}" });
    assert.equal(res.status, 200);
    assert.equal(upstream.seen.authorization, undefined); // no token configured -> none injected
  } finally {
    await gw.stop();
    await upstream.close();
  }
});

test("stop() frees the port (a subsequent request fails)", async () => {
  const upstream = await fakeUpstream();
  const gw = await startMcpGateway({
    servers: [{ id: "s", type: "http", url: upstream.url }],
    creds: {},
  });
  const base = gw.baseUrl;
  await gw.stop();
  await assert.rejects(() => fetch(`${base}/s`, { method: "POST", body: "{}" }));
  await upstream.close();
});
