/**
 * The live node health frame (DHK-1059).
 *
 * The only request/RESPONSE pair on this socket - `upgrade`, `policy` and `cancel` are all
 * fire-and-forget - so this is the one frame where the node MUST answer, and answering is the whole
 * contract. The hub waits on a bounded timeout and reports silence as "the node did not answer", which
 * is a claim about the machine being unreachable rather than about a check that went wrong. So the
 * property every test here leans on is that a reply always goes out: with no host probe wired, with a
 * probe that throws, and under a duplicate frame.
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

const NODE_TENANT = "t_node";

const welcome = encode({
  type: "welcome",
  nodeId: "n1",
  name: "brave-otter",
  tenantId: NODE_TENANT,
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
  edgeOpts: Partial<EdgeOptions> = {},
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
      // A worktree root that does NOT exist yet, which is the state of every node that has not run a
      // job - and the state of a CI runner. Pinned rather than left to default, because the default
      // resolves under the author's home directory, where it usually DOES exist: that difference is
      // what let the `unsound` regression pass locally and fail on a fresh runner. Modelling a new
      // node here is both more realistic and the only way these tests stay honest.
      worktreesDir: join(mkdtempSync(join(tmpdir(), "dahrk-edge-health-")), "worktrees"),
      ...edgeOpts,
    } as EdgeOptions);
    await waitFor(() => inbound.some((m) => m.type === "hello"));
    await fn({ inbound, toEdge: (frame) => live?.send(encode(frame as never)) });
  } finally {
    abort.abort();
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((r) => wss.close(() => r()));
  }
}

const request = (requestId = "req-1") => ({ type: "node-health-request", requestId });
const reports = (inbound: EdgeToHub[]) => inbound.filter((m) => m.type === "node-health-report");

// The hub gates the frame on this advert rather than on a client version, so a fleet that has not
// upgraded is answered "your client is too old" instantly instead of eating the full timeout. That only
// works if this build actually claims it.
test("the node advertises health-probe on hello, which is what the hub gates on", async () => {
  await withEdge(async ({ inbound }) => {
    const hello = inbound.find((m) => m.type === "hello");
    assert.ok(hello && "capabilities" in hello);
    assert.ok((hello.capabilities as string[]).includes("health-probe"));
  });
});

// The regression CI caught. With the worktree root absent (see `withEdge`), probing it directly makes
// `checkWorktreeRoot` fail and the fold report `unsound` - a brand-new, perfectly healthy node told no
// stage can run on it, which is the most damaging thing this report can say. The probe must judge the
// nearest EXISTING ancestor, because that is what the on-demand mkdir will need.
test("a node whose worktree root does not exist yet is not reported unsound", async () => {
  await withEdge(async (ctx) => {
    ctx.toEdge(request());
    await waitFor(() => reports(ctx.inbound).length === 1);

    const { verdict, sections } = reports(ctx.inbound)[0]!.report;
    assert.notEqual(verdict, "unsound", "a not-yet-created worktree root is not a fault");
    assert.equal(sections.find((s) => s.label === "Worktree root")?.status, "ok");
  });
});

test("a health request is answered with a report carrying the same requestId", async () => {
  await withEdge(async (ctx) => {
    ctx.toEdge(request("req-abc"));
    await waitFor(() => reports(ctx.inbound).length === 1);

    const reply = reports(ctx.inbound)[0]!;
    assert.equal(reply.requestId, "req-abc", "the correlation id must round-trip, or the hub drops it");
    assert.ok(reply.report.sections.length > 0);
    assert.ok(reply.report.readMarkdown.length > 0);
    assert.ok(typeof reply.report.tookMs === "number");
    assert.ok(typeof reply.report.gatheredAt === "number");
  });
});

// The hub and token rows are SYNTHESISED, never re-probed: the request arrived on a live, welcomed
// socket, so that IS the evidence. Re-probing would open a second WebSocket, blow the hub's budget, and
// risk spending a one-shot enrolment token (the DHK-1041 shape).
test("the hub and token rows are answered from this socket, not by a second probe", async () => {
  await withEdge(async (ctx) => {
    ctx.toEdge(request());
    await waitFor(() => reports(ctx.inbound).length === 1);

    const { sections } = reports(ctx.inbound)[0]!.report;
    const hub = sections.find((s) => s.label === "Hub reachability");
    const token = sections.find((s) => s.label === "Enrolment token");
    assert.equal(hub?.status, "ok");
    assert.equal(token?.status, "ok");
  });
});

// A library embedding (and every test above) wires no host probe. That must mean "fewer rows", never
// "no reply" and never a fabricated verdict about git or the supervisor.
test("with no host probe wired the node still answers, with fewer sections", async () => {
  await withEdge(async (ctx) => {
    ctx.toEdge(request());
    await waitFor(() => reports(ctx.inbound).length === 1);

    const { sections } = reports(ctx.inbound)[0]!.report;
    assert.ok(!sections.some((s) => s.label === "git"), "no tool row is invented");
    assert.ok(!sections.some((s) => s.label === "Service"), "no supervisor row is invented");
    assert.ok(sections.some((s) => s.label === "Node version"), "the in-process rows are still there");
  });
});

test("an injected host probe's checks are folded into the report", async () => {
  await withEdge(
    async (ctx) => {
      ctx.toEdge(request());
      await waitFor(() => reports(ctx.inbound).length === 1);

      const { sections, verdict } = reports(ctx.inbound)[0]!.report;
      assert.ok(sections.some((s) => s.label === "git" && s.status === "ok"));
      // A `warn` is a limitation the node runs with, so it maps to `skipped` and only ever moves the
      // verdict as far as `findings`.
      assert.ok(sections.some((s) => s.label === "docker" && s.status === "skipped"));
      assert.equal(verdict, "findings");
    },
    {
      probeHostChecks: async () => [
        { status: "pass", label: "git", detail: "installed" },
        { status: "warn", label: "docker", detail: "not present; container stages are unavailable" },
      ],
    },
  );
});

// The rule the upgrade branch already documents, applied here: silence is the failure mode this whole
// branch exists to remove. A throwing probe must still put a reply on the wire.
test("a host probe that throws still produces a reply, marked unsound", async () => {
  await withEdge(
    async (ctx) => {
      ctx.toEdge(request("req-boom"));
      await waitFor(() => reports(ctx.inbound).length === 1);

      const reply = reports(ctx.inbound)[0]!;
      assert.equal(reply.requestId, "req-boom");
      assert.equal(reply.report.verdict, "unsound");
      assert.match(reply.report.sections[0]!.detail, /could not run/);
    },
    {
      probeHostChecks: async () => {
        throw new Error("probe exploded");
      },
    },
  );
});

// Single-flight. A double-click in the portal, or a hub re-send, must not contend for the same child
// processes - the reply the first probe produces answers both.
test("a duplicate request while one is in flight is dropped, not probed twice", async () => {
  let probes = 0;
  let release!: () => void;
  const blocked = new Promise<void>((r) => (release = r));

  await withEdge(
    async (ctx) => {
      ctx.toEdge(request("req-1"));
      await waitFor(() => probes === 1);
      ctx.toEdge(request("req-2"));
      // Give the second frame time to be handled (and dropped) before the first is released.
      await new Promise((r) => setTimeout(r, 50));
      release();

      await waitFor(() => reports(ctx.inbound).length === 1);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(probes, 1, "the second frame did not start a second probe");
      assert.equal(reports(ctx.inbound).length, 1);
      assert.equal(reports(ctx.inbound)[0]!.requestId, "req-1");
    },
    {
      probeHostChecks: async () => {
        probes++;
        await blocked;
        return [{ status: "pass", label: "git", detail: "installed" }];
      },
    },
  );
});

// ...and once it settles the latch clears, so a node stays checkable. Unlike `upgrading`, which is
// deliberately never reset (an accepted upgrade ends in a restart), this one must.
test("the single-flight latch clears, so a later request is answered", async () => {
  await withEdge(async (ctx) => {
    ctx.toEdge(request("first"));
    await waitFor(() => reports(ctx.inbound).length === 1);
    ctx.toEdge(request("second"));
    await waitFor(() => reports(ctx.inbound).length === 2);
    assert.deepEqual(reports(ctx.inbound).map((r) => r.requestId), ["first", "second"]);
  });
});
