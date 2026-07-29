/**
 * Tests for the Pi RPC client. `PiRpcSession` drives a `pi --mode rpc`
 * subprocess as a `PiSessionLike`, so the T6 adapter orchestration runs unchanged against a
 * container back-end. Two levels: (1) the strict LF-only JSONL decoder is unit-tested against
 * multi-chunk splits and a JSON string containing U+2028 (the `readline` pitfall rpc.md warns
 * about); (2) the session is driven against a fixture `fake-pi-rpc.mjs` subprocess with no
 * Docker and no live inference.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PiEvent } from "../src/pi-mappers.js";
import { PiRpcSession, createLineDecoder } from "../src/pi-rpc-client.js";
import { elicitOutcomeReply } from "../src/elicit-router.js";
import type { AskUserQuestions } from "../src/pi-adapter.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = join(here, "fixtures", "fake-pi-rpc.mjs");

test("createLineDecoder: splits on LF only, strips trailing CR, reassembles multi-chunk records", () => {
  const dec = createLineDecoder();
  // A record delivered across two chunks; a CRLF-terminated record; a trailing partial.
  assert.deepEqual(dec.push('{"a":'), []);
  assert.deepEqual(dec.push('1}\n{"b":2}\r\n{"c'), ['{"a":1}', '{"b":2}']);
  assert.deepEqual(dec.push('":3}\n'), ['{"c":3}']);
  assert.deepEqual(dec.end(), []);
});

test("createLineDecoder: a U+2028 inside a JSON string is NOT a record boundary", () => {
  const dec = createLineDecoder();
  // U+2028 (\u2028) and U+2029 live inside the string; only \n terminates a record.
  const record = '{"delta":"a\u2028b\u2029c"}';
  // Split the chunk mid-record and mid-multibyte to prove the decoder buffers correctly.
  const bytes = Buffer.from(record + "\n", "utf8");
  const cut = bytes.indexOf(0xa8); // middle of the U+2028 byte sequence (e2 80 a8)
  const lines = [...dec.push(bytes.subarray(0, cut)), ...dec.push(bytes.subarray(cut))];
  assert.equal(lines.length, 1, "exactly one record despite the embedded separators");
  assert.equal(JSON.parse(lines[0]!).delta, "a\u2028b\u2029c");
});

test("prompt() resolves only after agent_end; subscribers receive events in order", async () => {
  const child = spawn(process.execPath, [FAKE_PI], { stdio: ["pipe", "pipe", "pipe"] });
  const stderr: string[] = [];
  child.stderr.on("data", (c) => stderr.push(c.toString()));
  const session = new PiRpcSession(child, {});
  const order: string[] = [];
  session.subscribe((ev) => order.push(`ev:${ev.type}`));

  await session.prompt("hi");
  order.push("resolved");

  const types = order.filter((o) => o.startsWith("ev:"));
  assert.deepEqual(types, [
    "ev:agent_start",
    "ev:turn_start",
    "ev:message_update",
    "ev:tool_execution_start",
    "ev:tool_execution_end",
    "ev:message_update",
    "ev:turn_end",
    "ev:agent_end",
  ]);
  assert.ok(order.indexOf("ev:agent_end") < order.indexOf("resolved"), "agent_end delivered before prompt resolves");
  assert.equal(order[order.length - 1], "resolved");

  const sent = stderr.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(sent.some((c) => c.type === "prompt" && c.message === "hi"), "sent the prompt command");

  session.dispose();
  await once(child, "exit");
});

// DHK-982 seam 1: cost across the RPC boundary. After a priced prompt the session surfaces the real
// dollar figure Pi computed (queried over RPC once the run finishes), so `makePiRuntimeSession.cost()`
// -> `JobResult.costUsd` flows on the container path exactly as embedded and `cost_budget` has a real
// figure to act on. A session that reports no cost surfaces `undefined`, never a fabricated `0`.

test("getSessionStats() returns the real session cost after a priced prompt (queried over RPC)", async () => {
  const child = spawn(process.execPath, [FAKE_PI], { stdio: ["pipe", "pipe", "pipe"] });
  const session = new PiRpcSession(child, {});
  assert.equal(session.getSessionStats(), undefined, "no cost before a prompt has priced anything");
  await session.prompt("hi");
  assert.deepEqual(session.getSessionStats(), { cost: 0.0731 }, "the figure the fixture priced the session at");
  session.dispose();
  await once(child, "exit");
});

test("getSessionStats(): a session that cannot price the run reports undefined, never a fabricated 0", async () => {
  const child = spawn(process.execPath, [FAKE_PI], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, FAKE_PI_NOCOST: "1" },
  });
  const session = new PiRpcSession(child, {});
  await session.prompt("hi");
  assert.equal(session.getSessionStats(), undefined, "no cost reported rather than a misleading 0");
  session.dispose();
  await once(child, "exit");
});

test("subscribed events preserve a U+2028 inside a text delta over the subprocess stdio", async () => {
  const child = spawn(process.execPath, [FAKE_PI], { stdio: ["pipe", "pipe", "pipe"] });
  const session = new PiRpcSession(child, {});
  const deltas: string[] = [];
  session.subscribe((ev) => {
    if (ev.type === "message_update" && ev.assistantMessageEvent.type === "text_delta") {
      deltas.push(String(ev.assistantMessageEvent.delta ?? ""));
    }
  });
  await session.prompt("hi");
  assert.ok(deltas.some((d) => d.includes("\u2028")), "U+2028 survived framing intact");
  session.dispose();
  await once(child, "exit");
});

test("getState() populates sessionId best-effort from the get_state response", async () => {
  const child = spawn(process.execPath, [FAKE_PI], { stdio: ["pipe", "pipe", "pipe"] });
  const session = new PiRpcSession(child, {});
  assert.equal(session.sessionId, undefined);
  await session.getState();
  assert.equal(session.sessionId, "pi-rpc-sess-1");
  session.dispose();
  await once(child, "exit");
});

test("abort() sends {type:'abort'} and resolves on the ack", async () => {
  const child = spawn(process.execPath, [FAKE_PI], { stdio: ["pipe", "pipe", "pipe"] });
  const stderr: string[] = [];
  child.stderr.on("data", (c) => stderr.push(c.toString()));
  const session = new PiRpcSession(child, {});
  await session.abort();
  const sent = stderr.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(sent.some((c) => c.type === "abort"), "sent the abort command");
  session.dispose();
  await once(child, "exit");
});

test("dispose() closes stdin and fires the kill callback exactly once (idempotent)", async () => {
  const child = spawn(process.execPath, [FAKE_PI], { stdio: ["pipe", "pipe", "pipe"] });
  let kills = 0;
  const session = new PiRpcSession(child, { kill: () => void kills++ });
  session.dispose();
  session.dispose();
  assert.equal(kills, 1, "kill callback fired exactly once");
  await once(child, "exit"); // stdin closed -> fixture exits
});

// Guard against the PiSessionLike shape drifting: the adapter drives exactly these members.
test("PiRpcSession satisfies the PiSessionLike contract the adapter drives", () => {
  const child = spawn(process.execPath, [FAKE_PI], { stdio: ["pipe", "pipe", "pipe"] });
  const session: import("../src/pi-adapter.js").PiSessionLike = new PiRpcSession(child, {});
  assert.equal(typeof session.subscribe, "function");
  assert.equal(typeof session.prompt, "function");
  assert.equal(typeof session.abort, "function");
  assert.equal(typeof session.dispose, "function");
  // DHK-981: the container path now implements the gate + elicit registrars, so the optional
  // capability members are present (no longer a silent optional-chaining no-op).
  assert.equal(typeof session.setToolCallGate, "function", "setToolCallGate is implemented (gate capability present)");
  assert.equal(typeof session.setAskUserQuestionHandler, "function", "setAskUserQuestionHandler is implemented (elicit capability present)");
  // DHK-982: the container path now surfaces session cost over RPC, so the stats accessor is a real
  // member rather than a silent optional-chaining no-op (`cost_budget` acts on a real figure).
  assert.equal(typeof session.getSessionStats, "function", "getSessionStats is implemented (cost capability present)");
  session.dispose();
});

// DHK-981 seam 1: the RPC wire is now bidirectional for gate + elicit. A subprocess-initiated
// `tool_call_request` / `elicit_request` is routed through the SAME registered gate/handler the
// embedded path uses, and the correct `*_response` frame is written back to the subprocess's stdin.
// Driven over PassThrough streams (no Docker, no fixture) so the wire behaviour is observed directly.

/** Let the client's reader loop process the queued stdout line and write its reply back to stdin. */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

test("PiRpcSession tool gate: a tool_call_request is answered with the registered gate's deny decision", async () => {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const written: string[] = [];
  stdin.on("data", (c) => written.push(c.toString()));
  const session = new PiRpcSession({ stdin, stdout }, {});

  const seen: Array<{ toolName: string; input: unknown }> = [];
  session.setToolCallGate((toolName, input) => {
    seen.push({ toolName, input });
    return toolName === "write" ? { block: true, reason: "write escapes the worktree" } : undefined;
  });

  stdout.write(JSON.stringify({ type: "tool_call_request", id: "tcr-1", toolName: "write", input: { path: "/etc/passwd" } }) + "\n");
  await tick();

  const frames = written.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const reply = frames.find((f) => f.type === "tool_call_response");
  assert.ok(reply, "a tool_call_response was written back to the subprocess");
  assert.equal(reply.id, "tcr-1", "the subprocess's request id is echoed verbatim");
  assert.equal(reply.block, true, "the deny verdict blocks the call");
  assert.equal(reply.reason, "write escapes the worktree", "the policy reason rides back to the agent");
  assert.deepEqual(seen, [{ toolName: "write", input: { path: "/etc/passwd" } }], "the gate was consulted with the exact toolName/input");
  session.dispose();
});

test("PiRpcSession tool gate: no gate registered -> the call is allowed (block:false)", async () => {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const written: string[] = [];
  stdin.on("data", (c) => written.push(c.toString()));
  const session = new PiRpcSession({ stdin, stdout }, {});

  stdout.write(JSON.stringify({ type: "tool_call_request", id: "tcr-2", toolName: "bash", input: { command: "ls" } }) + "\n");
  await tick();

  const reply = written.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((f) => f.type === "tool_call_response");
  assert.ok(reply, "a tool_call_response was written back even with no gate");
  assert.equal(reply.id, "tcr-2");
  assert.equal(reply.block, false, "no gate registered -> tool runs, matching embedded 'no gate = allow'");
  assert.equal(reply.reason, undefined, "no reason when nothing is blocked");
  session.dispose();
});

test("PiRpcSession elicit: an elicit_request routes through the registered handler and its return rides back", async () => {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const written: string[] = [];
  stdin.on("data", (c) => written.push(c.toString()));
  const session = new PiRpcSession({ stdin, stdout }, {});

  const questions: AskUserQuestions = [
    { question: "Which approach?", options: [{ label: "A", description: "safe" }, { label: "B", description: "fast" }], multiSelect: true },
  ];
  let received: AskUserQuestions | undefined;
  session.setAskUserQuestionHandler(async (qs) => {
    received = qs;
    return "The user selected: B";
  });

  stdout.write(JSON.stringify({ type: "elicit_request", id: "er-1", questions }) + "\n");
  await tick();

  const reply = written.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((f) => f.type === "elicit_response");
  assert.ok(reply, "an elicit_response was written back");
  assert.equal(reply.id, "er-1");
  assert.equal(reply.text, "The user selected: B", "the human's pick returns into the turn");
  assert.deepEqual(received, questions, "the handler received the exact questions");
  session.dispose();
});

test("PiRpcSession elicit: no handler registered -> the byte-identical noreply soft note is returned", async () => {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const written: string[] = [];
  stdin.on("data", (c) => written.push(c.toString()));
  const session = new PiRpcSession({ stdin, stdout }, {});

  stdout.write(JSON.stringify({ type: "elicit_request", id: "er-2", questions: [{ question: "Which?", options: [{ label: "X" }] }] }) + "\n");
  await tick();

  const reply = written.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((f) => f.type === "elicit_response");
  assert.ok(reply, "an elicit_response was written back even with no handler (never leave the container blocked)");
  assert.equal(reply.id, "er-2");
  assert.equal(reply.text, elicitOutcomeReply({ kind: "noreply" }), "no handler -> the shared noreply soft note");
  session.dispose();
});

test("PiRpcSession: malformed stdout lines are dropped at the wire boundary - never forwarded, never crash the reader", async () => {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const session = new PiRpcSession({ stdin, stdout }, {});
  const received: PiEvent[] = [];
  session.subscribe((ev) => received.push(ev));

  // Each line is valid JSON but not a well-formed event: a null (JSON null crashed the old `msg as
  // PiEvent` cast on `ev.type`), a primitive, an array, a typeless object, and a bodyless
  // message_update (whose `ame.type` access would throw). None must reach the subscriber or throw
  // inside the stdout 'data' handler.
  for (const line of ["null", "42", '"agent_end"', '[{"type":"agent_end"}]', '{"foo":1}', '{"type":"message_update"}']) {
    stdout.write(`${line}\n`);
  }
  // Command responses are still consumed (not events), and a well-formed event still flows through.
  stdout.write('{"type":"response","command":"noop","success":true}\n');
  stdout.write('{"type":"turn_start"}\n');
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(received.map((e) => e.type), ["turn_start"], "only the well-formed event reached the subscriber");
  session.dispose();
});
