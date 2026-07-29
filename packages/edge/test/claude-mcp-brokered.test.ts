/**
 * Brokered MCP end-to-end for the Claude adapter (DHK-972): the REAL node gateway proving the
 * raw brokered credential never reaches the agent-facing config that `buildBrokeredMcpServers`
 * produces. Analogue of `pi-mcp-brokered.test.ts`.
 *
 * Topology: MCP client (simulating Claude SDK's internal client) -> node gateway proxy (holds the
 * token) -> stub MCP server. The token is handed ONLY to the gateway's `creds`; the agent-facing
 * config is the localhost proxy url. The stub records the inbound Authorization header to prove the
 * proxy - not the agent config - added it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import type { McpServerRef, RunnerContext } from "@dahrk/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildBrokeredMcpServers } from "@dahrk/executor-worktree";
import { startMcpGateway } from "../src/mcp-gateway.js";

/**
 * A stub MCP server (real SDK, stateless Streamable HTTP) exposing an `echo` tool. Every inbound
 * POST's Authorization header is recorded, so the test can prove the token arrived from the gateway
 * proxy. Mirrors the stub in `pi-mcp-brokered.test.ts`.
 */
async function startStubMcpServer(): Promise<{ url: string; seenAuth: string[]; stop: () => Promise<void> }> {
  const seenAuth: string[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    seenAuth.push(req.headers.authorization ?? "<none>");
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void transport.close());
    const mcp = new McpServer({ name: "stub", version: "0.0.1" });
    mcp.registerTool(
      "echo",
      { description: "Echo the input text back", inputSchema: { text: z.string() } },
      async (args: { text: string }) => ({ content: [{ type: "text", text: `echo:${args.text}` }] }),
    );
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seenAuth,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test("a Claude adapter MCP call routes through the real gateway to the brokered server and returns its result", async () => {
  const TOKEN = "s3cr3t-broker-token-DHK972";
  const stub = await startStubMcpServer();
  const mcpServers: McpServerRef[] = [{ id: "linear", type: "http", url: stub.url, credentialRef: "mcp-linear" }];
  const gateway = await startMcpGateway({ servers: mcpServers, creds: { linear: TOKEN } });
  try {
    // Build the Claude adapter config exactly as `createClaudeRunner` does in production.
    const claudeConfig = buildBrokeredMcpServers({
      config: { runtime: "claude-code", interaction: "batch", mcpServers } as RunnerContext["config"],
      mcpProxyBaseUrl: gateway.baseUrl,
      workspace: { worktreePath: "/tmp/wt", scratchPath: "/tmp/wt/.dahrk/scratch", repoId: "r", gitUrl: "u", repo: "r", baseBranch: "main" },
    } as RunnerContext);

    assert.ok(claudeConfig, "the builder produced a brokered-server map");

    // AC2 (agent side): the agent-facing url is the localhost proxy and the raw token appears NOWHERE.
    const servers = claudeConfig as unknown as Record<string, { type: string; url: string }>;
    assert.equal(servers["linear"].url, `${gateway.baseUrl}/linear`);
    assert.match(servers["linear"].url, /^http:\/\/127\.0\.0\.1:\d+\/linear$/);
    assert.ok(!JSON.stringify(claudeConfig).includes(TOKEN), "the brokered-server config never carries the raw token");

    // AC1: an MCP client at the Claude adapter URL successfully calls the brokered tool.
    // This simulates exactly what Claude SDK's internal MCP client does when it reads the mcpServers option.
    const client = new Client({ name: "dahrk-claude-mcp-test", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL(servers["linear"].url));
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: "echo", arguments: { text: "hello" } });
      assert.deepEqual(result.content, [{ type: "text", text: "echo:hello" }]);
    } finally {
      await client.close();
    }

    // AC2 (upstream): the stub saw `Authorization: Bearer <token>` on every forwarded request —
    // the gateway injected it; the agent-facing config never held it.
    assert.ok(stub.seenAuth.length > 0, "the stub received forwarded requests");
    for (const auth of stub.seenAuth) assert.equal(auth, `Bearer ${TOKEN}`, "every upstream request carried the injected bearer");
  } finally {
    await gateway.stop();
    await stub.stop();
  }
});
