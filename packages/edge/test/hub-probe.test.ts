/**
 * The `dahrk doctor` hub probe. We stand up a throwaway `WebSocketServer` that plays the hub's side
 * of the handshake - welcome, an enrolment-close, or a silent hang - and assert the probe returns the
 * matching verdict. Reaching a not-listening port exercises the `unreachable` path with no server.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { encode } from "@dahrk/contracts";
import { probeHub } from "../src/hub-probe.js";

/** Start a hub-side WS server, run `fn` with its `ws://` URL, then close it. `onConn` acts as the hub. */
async function withHub(
  onConn: (sock: WebSocket) => void,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.on("listening", r));
  wss.on("connection", onConn);
  const { port } = wss.address() as AddressInfo;
  try {
    await fn(`ws://127.0.0.1:${port}`);
  } finally {
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((r) => wss.close(() => r()));
  }
}

test("welcome -> ok with tenant and name", async () => {
  await withHub(
    (sock) =>
      sock.on("message", () =>
        sock.send(
          encode({
            type: "welcome",
            nodeId: "dahrk-doctor",
            name: "brave-otter",
            tenantId: "t_acme",
            heartbeatMs: 5000,
            allowedRepos: [],
          }),
        ),
      ),
    async (url) => {
      const r = await probeHub({ hubUrl: url, enrolToken: "sket_good", nodeId: "node-under-test", timeoutMs: 2000 });
      assert.equal(r.ok, true);
      if (r.ok) {
        assert.equal(r.tenantId, "t_acme");
        assert.equal(r.name, "brave-otter");
      }
    },
  );
});

test("the probe presents the caller's node id, never a borrowed one (DHK-1041)", async () => {
  // The probe does a REAL hello, so the hub claims a one-shot enrolment token for whatever id it
  // carries. This used to default to a fixed `dahrk-doctor`: `dahrk start --token` spent the operator's
  // token as that phantom, and the daemon that connected moments later, as itself, was refused - so
  // onboarding could never complete and the hub grew a junk `dahrk-doctor` node per tenant.
  let helloNodeId: unknown = "(no hello seen)";
  await withHub(
    (sock) =>
      sock.on("message", (raw: Buffer) => {
        helloNodeId = (JSON.parse(raw.toString()) as { nodeId?: string }).nodeId;
        sock.send(
          encode({
            type: "welcome",
            nodeId: "ignored",
            name: "brave-otter",
            tenantId: "t_acme",
            heartbeatMs: 5000,
            allowedRepos: [],
          }),
        );
      }),
    async (url) => {
      await probeHub({ hubUrl: url, enrolToken: "sket_good", nodeId: "22222222-3333-4444-5555-666666666666", timeoutMs: 2000 });
    },
  );
  assert.equal(helloNodeId, "22222222-3333-4444-5555-666666666666");
});

test("enrolment close 4401 -> rejected with the code", async () => {
  await withHub(
    (sock) => sock.on("message", () => sock.close(4401, "bad token")),
    async (url) => {
      const r = await probeHub({ hubUrl: url, enrolToken: "sket_bad", nodeId: "node-under-test", timeoutMs: 2000 });
      assert.equal(r.ok, false);
      if (!r.ok && r.reason === "rejected") {
        assert.equal(r.code, 4401);
        assert.match(r.detail, /bad token/);
      } else {
        assert.fail(`expected rejected, got ${JSON.stringify(r)}`);
      }
    },
  );
});

test("no token -> hub answers ENROL_REQUIRED (4400), reported as rejected", async () => {
  await withHub(
    (sock) => sock.on("message", () => sock.close(4400)),
    async (url) => {
      const r = await probeHub({ hubUrl: url, nodeId: "node-under-test", timeoutMs: 2000 });
      assert.equal(r.ok, false);
      assert.equal(r.ok === false && r.reason === "rejected" && r.code, 4400);
    },
  );
});

test("connect refused -> unreachable", async () => {
  // Port 1 is not listening; the connection is refused before the socket ever opens.
  const r = await probeHub({ hubUrl: "ws://127.0.0.1:1", nodeId: "node-under-test", timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "unreachable");
});

test("hub accepts but never welcomes -> timeout", async () => {
  await withHub(
    () => {
      /* accept the socket, then say nothing */
    },
    async (url) => {
      const r = await probeHub({ hubUrl: url, enrolToken: "sket_x", nodeId: "node-under-test", timeoutMs: 300 });
      assert.equal(r.ok, false);
      assert.equal(r.ok === false && r.reason, "timeout");
    },
  );
});

test("a malformed url resolves unreachable rather than throwing", async () => {
  // `not-a-url` makes the WebSocket constructor throw synchronously; the probe must swallow that.
  const r = await probeHub({ hubUrl: "not-a-url", nodeId: "node-under-test", timeoutMs: 500 });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "unreachable");
});
