/**
 * Node-local MCP gateway proxy. A per-stage localhost HTTP reverse proxy that holds the
 * brokered MCP credentials and injects them on outbound calls, so the agent's MCP client only ever
 * talks to `127.0.0.1` and never sees the raw token (the MCP 2025-11-25 spec forbids token
 * passthrough). It is a thin byte forwarder - it does not parse MCP protocol.
 *
 * The agent is pointed at `${baseUrl}/<serverId>`; the proxy maps that to the declared upstream `url`
 * and adds `Authorization: Bearer <token>` from the per-job `brokeredCreds`. Lifecycle is owned by
 * the stage runner: started before the runner, stopped at stage finish, so minted tokens are
 * discarded with the stage. Mirrors's GIT_ASKPASS isolation, for MCP instead of git.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { McpServerRef } from "@dahrk/contracts";

export interface McpGateway {
  /** `http://127.0.0.1:<port>`; the adapter routes each server through `${baseUrl}/<serverId>`. */
  baseUrl: string;
  stop(): Promise<void>;
}

export interface McpGatewayOptions {
  servers: ReadonlyArray<McpServerRef>;
  /** serverId -> bearer token (decrypted). A server with no entry is forwarded without auth. */
  creds: Record<string, string>;
}

/** Hop-by-hop and identity headers we must not forward verbatim to the upstream. */
const STRIP_REQUEST_HEADERS = new Set(["host", "connection", "content-length", "authorization"]);

/** Start the per-stage gateway, bound to an ephemeral localhost port. */
export async function startMcpGateway(opts: McpGatewayOptions): Promise<McpGateway> {
  const byId = new Map(opts.servers.map((s) => [s.id, s]));

  const server = http.createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const segs = url.pathname.split("/").filter(Boolean);
    const id = segs[0];
    const target = id ? byId.get(id) : undefined;
    if (!target) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unknown mcp server" }));
      return;
    }

    // Map `/<id>/<rest>` onto the upstream url + the remaining path + the query string.
    const restPath = segs.slice(1).join("/");
    const base = target.url.replace(/\/+$/, "");
    const finalUrl = restPath ? `${base}/${restPath}${url.search}` : `${base}${url.search}`;

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || STRIP_REQUEST_HEADERS.has(k.toLowerCase())) continue;
      headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    }
    const token = opts.creds[id!];
    if (token) headers.set("authorization", `Bearer ${token}`);

    const method = req.method ?? "GET";
    const hasBody = method !== "GET" && method !== "HEAD";
    const upstream = await fetch(finalUrl, {
      method,
      headers,
      ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: "half" } : {}),
    } as RequestInit);

    const outHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      if (key.toLowerCase() === "content-length") return; // let node frame the streamed body
      outHeaders[key] = value;
    });
    res.writeHead(upstream.status, outHeaders);
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as never), res);
    else res.end();
  };

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
