/**
 * The hub-driven upgrade frame (DHK-1001/DHK-341).
 *
 * The hub shipped the whole upgrade state machine and this client never implemented its half: `upgrade`
 * fell through the dispatch and was dropped. Nothing acked, the node never restarted, and five minutes
 * later the deadline classified a node that had never gone anywhere as "did not reconnect". The portal's
 * Update button could not work, and the badge it produced pointed at the wrong thing.
 *
 * The property these lean hardest on is ORDERING: the ack has to be on the wire before the package
 * manager runs. What follows an accepted upgrade is tens of seconds of `npm install` and then a restart
 * that takes this process down, so an ack sent afterwards is one that usually never arrives.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
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

/** Stand up a hub-side WS server, run the edge against it, then tear both down. */
async function withEdge(
  fn: (ctx: {
    inbound: EdgeToHub[];
    toEdge: (frame: unknown) => void;
  }) => Promise<void>,
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

const upgradeFrame = (target = "0.2.0") => ({ type: "upgrade", nodeId: "n1", target, deadlineMs: 300_000 });
const acks = (inbound: EdgeToHub[]) => inbound.filter((m) => m.type === "upgrade-ack");

test("an upgrade frame is ACKED BEFORE the package manager runs, not after the restart", async () => {
  // The ordering property. `apply` here stands in for `npm install -g` followed by a restart: it takes
  // time and, in production, ends this process. If the ack waited on it, the hub would sit on `sent`
  // until its deadline and report a node that was mid-upgrade as one that never answered.
  const events: string[] = [];
  let released!: () => void;
  const blocked = new Promise<void>((r) => (released = r));
  await withEdge(
    async (ctx) => {
      ctx.toEdge(upgradeFrame());
      await waitFor(() => acks(ctx.inbound).length === 1);
      // The ack reached the hub while `apply` is still blocked. That is the property: the hub learns the
      // node is applying WHILE it applies, not once it is finished - by which time, in production, this
      // process has been restarted out from under the socket.
      assert.ok(events.includes("decided"), "the handler decided before the ack went out");
      assert.ok(!events.includes("apply-finished"), "the ack must not wait for the upgrade to finish");
      released();
      await waitFor(() => events.includes("apply-finished"));
      assert.deepEqual(events, ["decided", "apply-started", "apply-finished"]);
    },
    {
      onUpgrade: async () => {
        events.push("decided");
        return {
          channel: "npm",
          accepted: true,
          apply: async () => {
            events.push("apply-started");
            await blocked;
            events.push("apply-finished");
          },
        };
      },
    },
  );

});

test("a drivable channel acks accepted, and the ack carries the channel the hub reasons about", async () => {
  await withEdge(
    async (ctx) => {
      ctx.toEdge(upgradeFrame());
      await waitFor(() => acks(ctx.inbound).length === 1);
      assert.deepEqual(acks(ctx.inbound)[0], {
        type: "upgrade-ack",
        nodeId: "n1",
        channel: "brew",
        accepted: true,
      });
    },
    { onUpgrade: async () => ({ channel: "brew", accepted: true, apply: async () => {} }) },
  );
});

test("a NON-drivable channel acks accepted:false, so the hub settles `manual` instead of waiting", async () => {
  // A curl or from-source install has no package manager to invoke. Saying so immediately is what turns
  // a five minute wait ending in "did not reconnect" into a copy-paste command on the row.
  let applied = false;
  await withEdge(
    async (ctx) => {
      ctx.toEdge(upgradeFrame());
      await waitFor(() => acks(ctx.inbound).length === 1);
      assert.equal(acks(ctx.inbound)[0]!.accepted, false);
      assert.equal(acks(ctx.inbound)[0]!.channel, "curl");
      assert.equal(applied, false, "a refused upgrade must not run anything");
    },
    {
      onUpgrade: async () => ({
        channel: "curl",
        accepted: false,
        apply: async () => void (applied = true),
      }),
    },
  );
});

test("NO handler wired still acks - a client that cannot upgrade itself must say so, not go silent", async () => {
  // The regression this file exists for. Dropping the frame is indistinguishable, from the hub, from a
  // node that died: both are silence, and silence times out as `gone`.
  await withEdge(async (ctx) => {
    ctx.toEdge(upgradeFrame());
    await waitFor(() => acks(ctx.inbound).length === 1);
    assert.deepEqual(acks(ctx.inbound)[0], {
      type: "upgrade-ack",
      nodeId: "n1",
      channel: "unknown",
      accepted: false,
    });
  });
});

test("a handler that THROWS still acks, rather than letting the deadline invent an explanation", async () => {
  await withEdge(
    async (ctx) => {
      ctx.toEdge(upgradeFrame());
      await waitFor(() => acks(ctx.inbound).length === 1);
      assert.equal(acks(ctx.inbound)[0]!.accepted, false);
    },
    {
      onUpgrade: async () => {
        throw new Error("could not resolve the install channel");
      },
    },
  );
});

test("a re-sent upgrade frame does not start a SECOND package-manager run against one install", async () => {
  // The hub re-sends on its own schedule and across reconnects, exactly as it does for jobs. Two
  // concurrent `npm install -g` runs on one prefix is a corrupted install, not a slow one.
  let starts = 0;
  let released!: () => void;
  const blocked = new Promise<void>((r) => (released = r));
  await withEdge(
    async (ctx) => {
      ctx.toEdge(upgradeFrame());
      await waitFor(() => starts === 1);
      ctx.toEdge(upgradeFrame());
      ctx.toEdge(upgradeFrame());
      // Wait long enough that a second run would have registered.
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(starts, 1, `a duplicate frame started ${starts} upgrades`);
      assert.equal(acks(ctx.inbound).length, 1, "and the duplicate is not re-acked either");
      released();
    },
    {
      onUpgrade: async () => ({
        channel: "npm",
        accepted: true,
        apply: async () => {
          starts++;
          await blocked;
        },
      }),
    },
  );
});

test("a REFUSED upgrade leaves the node open to a later attempt", async () => {
  // The duplicate latch must not become a one-shot: an operator who fixes a broken install and clicks
  // Update again has to be able to get through.
  let calls = 0;
  await withEdge(
    async (ctx) => {
      ctx.toEdge(upgradeFrame());
      await waitFor(() => acks(ctx.inbound).length === 1);
      ctx.toEdge(upgradeFrame());
      await waitFor(() => acks(ctx.inbound).length === 2);
      assert.equal(calls, 2, "a refusal is not a latch");
    },
    {
      onUpgrade: async () => {
        calls++;
        return { channel: "unknown", accepted: false };
      },
    },
  );
});
