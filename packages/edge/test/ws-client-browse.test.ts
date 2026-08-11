/**
 * The worktree-browse frames on the socket (DHK-1104).
 *
 * A request/response pair, like the health frame, so it inherits that frame's one hard rule: the node
 * must ALWAYS answer. The hub waits on a three-second timeout and reports silence as "the node did not
 * answer", which is a claim that the machine is unreachable rather than that a path was not there - so
 * a request naming a run this node has never held still has to come back, and come back typed.
 *
 * What the browse logic itself does with a real worktree is covered in `worktree-browse.test.ts`. This
 * file is about the wire: the capability advert the hub gates on, and the guarantee of a reply.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { decode, encode, type EdgeToHub } from "@dahrk/contracts";
import { startEdgeNode, type EdgeOptions } from "../src/ws-client.js";

const welcome = encode({
  type: "welcome",
  nodeId: "n1",
  name: "brave-otter",
  tenantId: "t_node",
  credentialMode: "ambient",
  heartbeatMs: 5000,
  allowedRepos: [],
});

const waitFor = async (cond: () => boolean, ms = 4000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function withEdge(
  fn: (ctx: { inbound: EdgeToHub[]; toEdge: (frame: unknown) => void }) => Promise<void>,
): Promise<void> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.on("listening", r));

  const inbound: EdgeToHub[] = [];
  let live: WebSocket | undefined;
  wss.on("connection", (sock) => {
    live = sock;
    sock.on("message", (raw) => {
      const msg = decode<EdgeToHub>(raw.toString());
      inbound.push(msg);
      if (msg.type === "hello") sock.send(welcome);
    });
  });

  const { port } = wss.address() as AddressInfo;
  const abort = new AbortController();
  try {
    await startEdgeNode({
      hubUrl: `ws://127.0.0.1:${port}`,
      runtimes: ["claude-code"],
      servesRepoIds: [],
      enrolToken: "sket_test",
      signal: abort.signal,
      worktreesDir: join(mkdtempSync(join(tmpdir(), "dahrk-edge-browse-")), "worktrees"),
    } as EdgeOptions);
    await waitFor(() => inbound.some((m) => m.type === "hello"));
    await fn({ inbound, toEdge: (frame) => live?.send(encode(frame as never)) });
  } finally {
    abort.abort();
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((r) => wss.close(() => r()));
  }
}

// The hub gates browsing on this advert, not on a client version, so a node that has not upgraded is
// told "unsupported" at once instead of eating the timeout. That only works if this build claims it.
test("the node advertises worktree-browse on hello, which is what the hub gates on", async () => {
  await withEdge(async ({ inbound }) => {
    const hello = inbound.find((m) => m.type === "hello");
    assert.ok(hello && "capabilities" in hello);
    assert.ok((hello.capabilities as string[]).includes("worktree-browse"));
  });
});

test("a list request for a run this node does not hold is refused, not ignored", async () => {
  await withEdge(async ({ inbound, toEdge }) => {
    toEdge({ type: "worktree-list-request", requestId: "req-1", runId: "run-unknown", path: "" });
    await waitFor(() => inbound.some((m) => m.type === "worktree-list-reply"));
    const reply = inbound.find((m) => m.type === "worktree-list-reply");
    assert.ok(reply && "requestId" in reply);
    // The requestId is echoed verbatim: the hub correlates on it and drops a reply it cannot match.
    assert.equal(reply.requestId, "req-1");
    const result = (reply as { result: { ok: boolean; reason?: string } }).result;
    assert.equal(result.ok, false);
    // Never an empty listing, which would say the worktree is here and has nothing in it.
    assert.equal(result.reason, "not-found");
  });
});

test("a read request for a run this node does not hold is refused too", async () => {
  await withEdge(async ({ inbound, toEdge }) => {
    toEdge({ type: "worktree-read-request", requestId: "req-2", runId: "run-unknown", path: "README.md" });
    await waitFor(() => inbound.some((m) => m.type === "worktree-read-reply"));
    const reply = inbound.find((m) => m.type === "worktree-read-reply");
    assert.ok(reply && "requestId" in reply);
    assert.equal(reply.requestId, "req-2");
    const result = (reply as { result: { ok: boolean; reason?: string } }).result;
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not-found");
  });
});

test("concurrent browse requests are all answered, with no single-flight latch", async () => {
  // Unlike health and upgrade, browsing takes no latch: the portal draws a tree by asking for several
  // directories at once, and a latch would drop all but the first and stall the view.
  await withEdge(async ({ inbound, toEdge }) => {
    for (const id of ["a", "b", "c"]) {
      toEdge({ type: "worktree-list-request", requestId: id, runId: "run-unknown", path: "" });
    }
    await waitFor(() => inbound.filter((m) => m.type === "worktree-list-reply").length === 3);
    const ids = inbound.filter((m) => m.type === "worktree-list-reply").map((m) => (m as { requestId: string }).requestId);
    assert.deepEqual(ids.sort(), ["a", "b", "c"]);
  });
});
