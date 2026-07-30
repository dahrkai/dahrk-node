/**
 * Tests for the container Pi session factory.
 *
 * `createContainerPiSession` returns a `PiSessionFactory` that spawns `docker run -i` and
 * wraps the child in `PiRpcSession`, so the T6 adapter's orchestration runs unchanged against
 * a containerised Pi. Tests inject a custom `spawn` to avoid real Docker; the e2e test drives
 * the factory through `fake-pi-rpc.mjs` (same fixture as pi-rpc-client.test.ts).
 *
 * `createIsolatedPiRunner` is the convenience wrapper: returns a Pi runner whose session
 * factory is `createContainerPiSession`.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ElicitQuestion, HumanTurn, PolicyOutcome, RunnerContext, TraceEvent } from "@dahrk/contracts";
import { createContainerPiSession, createIsolatedPiRunner } from "../src/pi-container.js";
import { createPiRunner } from "../src/pi-adapter.js";
import type { PiSessionLike } from "../src/pi-adapter.js";
import { ManagedMailbox } from "../src/mailbox.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = join(here, "fixtures", "fake-pi-rpc.mjs");

/**
 * Every fake-pi child this suite spawns is tracked here so a test that throws before its
 * `dispose()`/`cancel()` cannot orphan a subprocess. `fake-pi-rpc.mjs` only exits on stdin EOF,
 * so a leaked child keeps Node's event loop alive and hangs `node --test` indefinitely. The
 * top-level `after` hook force-kills any survivors, guaranteeing the process exits even when an
 * assertion fails (see / post-mortem).
 */
const spawnedChildren = new Set<ReturnType<typeof spawn>>();
function track(child: ReturnType<typeof spawn>): ReturnType<typeof spawn> {
  spawnedChildren.add(child);
  child.on("exit", () => spawnedChildren.delete(child));
  return child;
}

after(() => {
  for (const child of spawnedChildren) child.kill("SIGKILL");
  spawnedChildren.clear();
});

/**
 * Builds a fake spawn function. When the command is `docker run`, it spawns `fake-pi-rpc.mjs`
 * and records the docker args. When the command is `docker kill`, it spawns `echo ok` as a
 * trivial no-op and records the container name passed. Every spawn call is appended to
 * `calls` as `{ cmd, args }`; every spawned child is tracked for teardown.
 */
function makeFakeSpawn(calls: Array<{ cmd: string; args: string[] }>) {
  return (cmd: string, args: string[], opts: unknown): ReturnType<typeof spawn> => {
    calls.push({ cmd, args: [...args] });
    if (cmd === "docker" && args[0] === "kill") {
      // trivial no-op exit
      return track(spawn(process.execPath, ["-e", "process.exit(0)"], opts as never));
    }
    // docker run -> route to the fake-pi-rpc.mjs fixture
    return track(spawn(process.execPath, [FAKE_PI], opts as never));
  };
}

const ctx = (over: Partial<RunnerContext> = {}): RunnerContext => ({
  config: { runtime: "pi", interaction: "batch" } as RunnerContext["config"],
  workspace: { worktreePath: "/tmp/wt", branch: "main", scratchPath: "/tmp/scratch", repoId: "", gitUrl: "", repo: "", baseBranch: "" },
  ...over,
});

// ---------------------------------------------------------------------------
// Task 2: Docker run command construction
// ---------------------------------------------------------------------------

test("createContainerPiSession: spawns docker run -i --rm with the image and pi --mode rpc", async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const factory = createContainerPiSession({ image: "dahrk/pi:test", spawn: makeFakeSpawn(calls) });

  const session = await factory(ctx());
  session.dispose();

  const runCall = calls.find((c) => c.cmd === "docker" && c.args[0] === "run");
  assert.ok(runCall, "docker run was called");
  assert.ok(runCall.args.includes("-i"), "run -i (interactive stdin)");
  assert.ok(runCall.args.includes("--rm"), "run --rm (remove on exit)");
  assert.ok(runCall.args.includes("dahrk/pi:test"), "image name present");
  // pi --mode rpc must be the last three args (the command inside the container)
  const last3 = runCall.args.slice(-3);
  assert.deepEqual(last3, ["pi", "--mode", "rpc"], "container command is pi --mode rpc");
});

test("createContainerPiSession: assigns a container name starting with dahrk-pi-", async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const factory = createContainerPiSession({ image: "dahrk/pi:test", spawn: makeFakeSpawn(calls) });

  const session = await factory(ctx());
  session.dispose();

  const runCall = calls.find((c) => c.cmd === "docker" && c.args[0] === "run");
  assert.ok(runCall, "docker run was called");
  const nameIdx = runCall.args.indexOf("--name");
  assert.ok(nameIdx !== -1, "--name flag present");
  const containerName = runCall.args[nameIdx + 1];
  assert.ok(containerName?.startsWith("dahrk-pi-"), `container name starts with dahrk-pi-, got: ${containerName}`);
});

test("createContainerPiSession: mounts scratchPath from ctx as /dahrk/scratch", async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const factory = createContainerPiSession({ image: "dahrk/pi:test", spawn: makeFakeSpawn(calls) });

  const session = await factory(ctx({ workspace: { worktreePath: "/tmp/wt", branch: "main", scratchPath: "/var/dahrk/scratch-42", repoId: "", gitUrl: "", repo: "", baseBranch: "" } }));
  session.dispose();

  const runCall = calls.find((c) => c.cmd === "docker" && c.args[0] === "run")!;
  const vIdx = runCall.args.indexOf("-v");
  assert.ok(vIdx !== -1, "-v mount flag present");
  assert.equal(runCall.args[vIdx + 1], "/var/dahrk/scratch-42:/dahrk/scratch", "correct host:container mount");
});

test("createContainerPiSession: explicit scratchDir option overrides ctx.workspace.scratchPath", async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const factory = createContainerPiSession({ image: "dahrk/pi:test", scratchDir: "/explicit/scratch", spawn: makeFakeSpawn(calls) });

  const session = await factory(ctx({ workspace: { worktreePath: "/tmp/wt", branch: "main", scratchPath: "/ctx/scratch", repoId: "", gitUrl: "", repo: "", baseBranch: "" } }));
  session.dispose();

  const runCall = calls.find((c) => c.cmd === "docker" && c.args[0] === "run")!;
  const vIdx = runCall.args.indexOf("-v");
  assert.ok(vIdx !== -1);
  assert.equal(runCall.args[vIdx + 1], "/explicit/scratch:/dahrk/scratch");
});

test("createContainerPiSession: injects runtimeEnv as -e KEY=VAL pairs", async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const factory = createContainerPiSession({ image: "dahrk/pi:test", spawn: makeFakeSpawn(calls) });

  const session = await factory(
    ctx({
      runtimeEnv: {
        ANTHROPIC_API_KEY: "sk-ant-test",
        OPENAI_API_KEY: "sk-openai-test",
      },
    }),
  );
  session.dispose();

  const runCall = calls.find((c) => c.cmd === "docker" && c.args[0] === "run")!;
  const args = runCall.args;

  // Find all -e occurrences
  const eArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-e") eArgs.push(args[i + 1] ?? "");
  }
  assert.ok(eArgs.includes("ANTHROPIC_API_KEY=sk-ant-test"), "ANTHROPIC_API_KEY injected");
  assert.ok(eArgs.includes("OPENAI_API_KEY=sk-openai-test"), "OPENAI_API_KEY injected");
});

test("createContainerPiSession: no -e flags when runtimeEnv is absent", async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const factory = createContainerPiSession({ image: "dahrk/pi:test", spawn: makeFakeSpawn(calls) });

  const session = await factory(ctx());
  session.dispose();

  const runCall = calls.find((c) => c.cmd === "docker" && c.args[0] === "run")!;
  assert.ok(!runCall.args.includes("-e"), "no -e flags when runtimeEnv absent");
});

// ---------------------------------------------------------------------------
// Task 2: kill callback fires docker kill <containerName>
// ---------------------------------------------------------------------------

test("createContainerPiSession: dispose() fires docker kill with the matching container name", async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let killResolve!: () => void;
  const killFired = new Promise<void>((r) => { killResolve = r; });

  const fakeSpawn = (cmd: string, args: string[], opts: unknown): ReturnType<typeof spawn> => {
    calls.push({ cmd, args: [...args] });
    if (cmd === "docker" && args[0] === "kill") {
      killResolve();
      return spawn(process.execPath, ["-e", "process.exit(0)"], opts as never);
    }
    return spawn(process.execPath, [FAKE_PI], opts as never);
  };

  const factory = createContainerPiSession({ image: "dahrk/pi:test", spawn: fakeSpawn });
  const session = await factory(ctx());

  const runCall = calls.find((c) => c.cmd === "docker" && c.args[0] === "run")!;
  const nameIdx = runCall.args.indexOf("--name");
  const containerName = runCall.args[nameIdx + 1]!;

  session.dispose();
  await killFired;

  const killCall = calls.find((c) => c.cmd === "docker" && c.args[0] === "kill");
  assert.ok(killCall, "docker kill was called");
  assert.equal(killCall.args[1], containerName, "docker kill targets the same container name");
});

test("createContainerPiSession: kill is idempotent (dispose() twice fires kill once)", async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const factory = createContainerPiSession({ image: "dahrk/pi:test", spawn: makeFakeSpawn(calls) });
  const session = await factory(ctx());

  session.dispose();
  session.dispose();

  // Give the async kill callbacks a chance to fire
  await new Promise((r) => setImmediate(r));

  const killCalls = calls.filter((c) => c.cmd === "docker" && c.args[0] === "kill");
  assert.equal(killCalls.length, 1, "kill fired exactly once despite two dispose() calls");
});

// ---------------------------------------------------------------------------
// Task 2: returned session satisfies PiSessionLike
// ---------------------------------------------------------------------------

test("createContainerPiSession: returned session satisfies PiSessionLike", async () => {
  const factory = createContainerPiSession({ image: "dahrk/pi:test", spawn: makeFakeSpawn([]) });
  const session: PiSessionLike = await factory(ctx());
  assert.equal(typeof session.subscribe, "function");
  assert.equal(typeof session.prompt, "function");
  assert.equal(typeof session.abort, "function");
  assert.equal(typeof session.dispose, "function");
  session.dispose();
});

// ---------------------------------------------------------------------------
// Task 2+3 E2E: factory + createPiRunner drives a full batch stage over RPC
// ---------------------------------------------------------------------------

test("createContainerPiSession + createPiRunner: runBatch drives the fake-pi-rpc subprocess end-to-end", async () => {
  const { createPiRunner } = await import("../src/pi-adapter.js");
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const factory = createContainerPiSession({ image: "dahrk/pi:test", spawn: makeFakeSpawn(calls) });
  const runner = createPiRunner({ createSession: factory });

  const events: TraceEvent[] = [];
  const result = await runner.runBatch(ctx(), (e) => events.push(e));

  assert.equal(result.status, "ok", "batch stage completed successfully");
  assert.ok(events.length > 0, "trace events were emitted");
  // Verify a tool event came through the RPC pipe. The normalised TraceEvent vocabulary maps a
  // tool call to `type: "action"` (contracts/src/trace.ts; pi-mappers.ts) - there is no "tool_use"
  // type - so assert on the action emitted for the fake-pi-rpc `bash` call.
  assert.ok(
    events.some((e) => e.type === "action" && e.tool === "bash"),
    "tool action present (from fake-pi-rpc bash tool call)",
  );
  await runner.cancel();
});

// ---------------------------------------------------------------------------
// DHK-982 seam 3: the stage model reaches the containerised agent, resolved provider-aware. The
// injected `resolveModelId` stands in for the SDK-backed host-side resolution (unit-tested separately
// via `selectStageModel` in pi-model-provider.test.ts); these assert the FACTORY carries the resolved
// id into the container and fails loudly rather than spawning-and-continuing on an unresolvable model.
// ---------------------------------------------------------------------------

test("DHK-982: a resolved stage model is carried into the container as --model after pi --mode rpc", async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const factory = createContainerPiSession({
    image: "dahrk/pi:test",
    spawn: makeFakeSpawn(calls),
    resolveModelId: async () => "claude-opus-4-8",
  });

  const session = await factory(ctx({ config: { runtime: "pi", interaction: "batch", model: "opus" } as RunnerContext["config"] }));
  session.dispose();

  const runCall = calls.find((c) => c.cmd === "docker" && c.args[0] === "run")!;
  const mIdx = runCall.args.indexOf("--model");
  assert.ok(mIdx !== -1, "--model flag present on the container command");
  assert.equal(runCall.args[mIdx + 1], "claude-opus-4-8", "the provider-aware resolved id, not the bare alias");
  // pi --mode rpc still leads the container command; --model follows it.
  const rpcIdx = runCall.args.indexOf("rpc");
  assert.ok(rpcIdx !== -1 && mIdx > rpcIdx, "--model follows the pi --mode rpc command");
});

test("DHK-982: no configured model leaves the container command unchanged (Pi picks - the no-opinion path)", async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let resolverCalled = false;
  const factory = createContainerPiSession({
    image: "dahrk/pi:test",
    spawn: makeFakeSpawn(calls),
    resolveModelId: async () => {
      resolverCalled = true;
      return undefined;
    },
  });

  const session = await factory(ctx());
  session.dispose();

  assert.ok(resolverCalled, "the resolver was consulted");
  const runCall = calls.find((c) => c.cmd === "docker" && c.args[0] === "run")!;
  assert.ok(!runCall.args.includes("--model"), "no --model flag when nothing was resolved");
  assert.deepEqual(runCall.args.slice(-3), ["pi", "--mode", "rpc"], "container command is unchanged");
});

test("DHK-982: an unresolvable model rejects the factory rather than spawning a container on the wrong model", async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const factory = createContainerPiSession({
    image: "dahrk/pi:test",
    spawn: makeFakeSpawn(calls),
    resolveModelId: async () => {
      throw new Error("Pi cannot resolve the model 'claude-opus-99': unknown model.");
    },
  });

  await assert.rejects(
    () => factory(ctx({ config: { runtime: "pi", interaction: "batch", model: "claude-opus-99" } as RunnerContext["config"] })),
    /cannot resolve the model 'claude-opus-99'/,
    "the loud model-resolution failure propagates out of the factory",
  );
  assert.ok(
    !calls.some((c) => c.cmd === "docker" && c.args[0] === "run"),
    "no docker run was spawned - the container never starts on a substituted model",
  );
});

// ---------------------------------------------------------------------------
// DHK-982 seam 2: cost across the whole container path. A container-isolated batch stage reports the
// real dollar figure Pi priced the session at (queried over RPC), so `JobResult.costUsd` carries a
// real number and the hub's `cost_budget` policy has something to act on - never a silent $0.
// ---------------------------------------------------------------------------

test("DHK-982 runBatch over the container factory: costUsd carries the RPC-surfaced session cost", async () => {
  const factory = createContainerPiSession({ image: "dahrk/pi:test", spawn: makeFakeSpawn([]) });
  const runner = createPiRunner({ createSession: factory });

  const result = await runner.runBatch(ctx(), () => {});
  assert.equal(result.status, "ok");
  assert.equal(result.costUsd, 0.0731, "Pi's aggregate session cost flows out as costUsd over RPC, not a silent 0");
  await runner.cancel();
});

// ---------------------------------------------------------------------------
// Task 3: createIsolatedPiRunner convenience factory
// ---------------------------------------------------------------------------

test("createIsolatedPiRunner: returns a runner with runtime 'pi'", () => {
  const runner = createIsolatedPiRunner({ image: "dahrk/pi:test", spawn: makeFakeSpawn([]) });
  assert.equal(runner.runtime, "pi");
});

test("createIsolatedPiRunner: runBatch drives the container factory end-to-end", async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const runner = createIsolatedPiRunner({ image: "dahrk/pi:test", spawn: makeFakeSpawn(calls) });

  const events: TraceEvent[] = [];
  const result = await runner.runBatch(ctx(), (e) => events.push(e));

  assert.equal(result.status, "ok");
  assert.ok(events.length > 0, "trace events emitted through isolated runner");

  // Docker was actually called
  const runCall = calls.find((c) => c.cmd === "docker" && c.args[0] === "run");
  assert.ok(runCall, "docker run was spawned by the isolated runner");

  await runner.cancel();
});

// ---------------------------------------------------------------------------
// DHK-981: the tool gate and structured elicitation over RPC, driven end-to-end through
// createPiRunner over the fake subprocess (no Docker). The fixture emits the two subprocess-initiated
// request frames (keyed off FAKE_PI_GATE / FAKE_PI_ELICIT env), so this proves the container path
// enforces policy before execution and can elicit, using the SAME edge-policy / elicit machinery as
// embedded Pi (mirrors pi-adapter.test.ts's DHK-504 runBatch gate and DHK-505 runInteractive elicit).
// ---------------------------------------------------------------------------

/** Like `makeFakeSpawn`, but injects env into the fake-pi child so it drives the gate/elicit flows. */
function makeFakeSpawnWithEnv(calls: Array<{ cmd: string; args: string[] }>, env: Record<string, string>) {
  return (cmd: string, args: string[], opts: unknown): ReturnType<typeof spawn> => {
    calls.push({ cmd, args: [...args] });
    if (cmd === "docker" && args[0] === "kill") {
      return track(spawn(process.execPath, ["-e", "process.exit(0)"], opts as never));
    }
    const o = (opts ?? {}) as { stdio?: unknown };
    return track(spawn(process.execPath, [FAKE_PI], { ...o, env: { ...process.env, ...env } } as never));
  };
}

const humanTurn = (text: string): HumanTurn => ({ text, ts: "2026-07-29T00:00:00Z" });

test("DHK-981 runBatch gate over RPC: a policy-violating tool call is blocked before execution with the same recorded deny/reason", async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const factory = createContainerPiSession({ image: "dahrk/pi:test", spawn: makeFakeSpawnWithEnv(calls, { FAKE_PI_GATE: "1" }) });
  const runner = createPiRunner({ createSession: factory });

  // The edge policy the stage runner supplies: deny `write`, allow everything else - identical to the
  // embedded gate test, routed through the container transport this time.
  const consulted: Array<{ tool: string; input: unknown }> = [];
  const authorizeToolUse = (tool: string, input: unknown): PolicyOutcome => {
    consulted.push({ tool, input });
    return tool === "write"
      ? { verdict: "deny", policy: "fs_confine", reason: "write escapes the worktree" }
      : { verdict: "allow", policy: "none" };
  };

  const events: TraceEvent[] = [];
  const result = await runner.runBatch({ ...ctx(), authorizeToolUse } as RunnerContext, (e) => events.push(e));

  assert.equal(result.status, "ok", "the stage still settles ok - only the denied tool was stopped");
  // The gate was consulted through the edge policy with the exact tool name/input the container-side
  // hook carried - so the deny flows through the stage runner's recordDeny path exactly as embedded.
  assert.deepEqual(
    consulted.find((c) => c.tool === "write"),
    { tool: "write", input: { path: "/etc/passwd", content: "x" } },
    "authorizeToolUse was consulted for the write with its input (the recorded-deny path)",
  );
  // Blocked BEFORE execution: the denied write produced neither an action nor an observation - it did
  // not run and was not run-then-annotated (mirrors the embedded DHK-504 runBatch gate assertions).
  assert.ok(
    !events.some((e) => e.type === "action" && (e as Extract<TraceEvent, { type: "action" }>).tool === "write"),
    "the denied write produced no action - blocked before execution",
  );
  assert.ok(
    !events.some((e) => e.type === "observation" && (e as Extract<TraceEvent, { type: "observation" }>).toolUseId === "w1"),
    "the denied write produced no observation - it was not run-then-annotated",
  );
  // The allowed bash call still ran through the RPC pipe. (The agent-visible deny reason riding back
  // over the wire in the tool_call_response is asserted at the client seam in pi-rpc-client.test.ts.)
  assert.ok(
    events.some((e) => e.type === "action" && (e as Extract<TraceEvent, { type: "action" }>).tool === "bash"),
    "the allowed bash call executes over RPC",
  );
  await runner.cancel();
});

test("DHK-981 runInteractive elicit over RPC: a structured question reaches emitElicit and the pick returns into the turn", async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const factory = createContainerPiSession({ image: "dahrk/pi:test", spawn: makeFakeSpawnWithEnv(calls, { FAKE_PI_ELICIT: "1" }) });
  const runner = createPiRunner({ createSession: factory });

  const elicited: ElicitQuestion[] = [];
  const turns = new ManagedMailbox<HumanTurn>();
  const events: TraceEvent[] = [];
  const onTrace = (e: TraceEvent): void => {
    events.push(e);
    // The human replies exactly when the question is raised, then the turn stream ends so the stage
    // settles to gate (mirrors the embedded DHK-505 test).
    if (e.type === "elicitation") {
      turns.push(humanTurn("Option B"));
      turns.end();
    }
  };

  const interactiveCtx = {
    ...ctx({ config: { runtime: "pi", interaction: "interactive" } as RunnerContext["config"] }),
    emitElicit: (q: ElicitQuestion) => elicited.push(q),
  } as RunnerContext;

  const result = await runner.runInteractive(interactiveCtx, turns, onTrace);

  // emitElicit received the folded ElicitQuestion: the prompt carries each option's description, options
  // map label -> { label, value: label }, and multiSelect is preserved - byte-identical to embedded Pi.
  assert.equal(elicited.length, 1, "the question reached the edge emitElicit seam exactly once over RPC");
  assert.equal(elicited[0]!.prompt, "Which approach?\n\n- Option A: the safe one\n- Option B: the fast one");
  assert.deepEqual(elicited[0]!.options, [
    { label: "Option A", value: "Option A" },
    { label: "Option B", value: "Option B" },
  ]);
  assert.equal(elicited[0]!.multiSelect, true);
  // The human's pick flowed back into the containerised turn as the tool result (Claude-identical wording).
  assert.ok(
    events.some((e) => e.type === "response" && ((e as Extract<TraceEvent, { type: "response" }>).text ?? "").includes("The user selected: Option B")),
    "the pick returned into the turn over the RPC transport",
  );
  assert.equal(result.status, "ok");
  await runner.cancel();
});

// ---------------------------------------------------------------------------
// DHK-968: the container path cannot register brokered MCP servers (`PiRpcSession` declares
// `capabilities.brokeredMcp = false`). A stage that declares them no longer loses them in silence:
// the runner emits a loud `capability-degraded` trace event and the stage still runs (warn-and-continue).
// The gate/elicit/cost capabilities DID land over RPC (DHK-981/982), so they are declared supported and
// a policy-gated container stage does NOT refuse.
// ---------------------------------------------------------------------------

test("DHK-968: a container stage declaring brokered MCP servers emits a capability-degraded trace event, and still runs", async () => {
  const factory = createContainerPiSession({ image: "dahrk/pi:test", spawn: makeFakeSpawn([]) });
  const runner = createPiRunner({ createSession: factory });

  const mcpConfig = {
    runtime: "pi",
    interaction: "batch",
    mcpServers: [{ id: "linear", type: "http", url: "https://mcp.linear.app/mcp" }],
  } as RunnerContext["config"];
  const events: TraceEvent[] = [];
  const result = await runner.runBatch(
    { ...ctx({ config: mcpConfig }), mcpProxyBaseUrl: "http://127.0.0.1:8931" } as RunnerContext,
    (e) => events.push(e),
  );

  const degraded = events.find(
    (e) => e.type === "error" && (e as Extract<TraceEvent, { type: "error" }>).kind === "capability-degraded",
  ) as Extract<TraceEvent, { type: "error" }> | undefined;
  assert.ok(degraded, "the brokered-MCP loss surfaced as a capability-degraded trace event (not only a log)");
  assert.match(degraded.message, /brokered MCP/, "the event names the dropped capability");
  assert.equal(result.status, "ok", "warn-and-continue: the stage still runs, just without the MCP servers");
  await runner.cancel();
});

test("DHK-968: PiRpcSession declares gate/elicit/cost supported and brokered-MCP/summarise-denial unsupported", async () => {
  const factory = createContainerPiSession({ image: "dahrk/pi:test", spawn: makeFakeSpawn([]) });
  const session = await factory(ctx());
  assert.deepEqual(
    session.capabilities,
    { preExecutionGate: true, elicitation: true, cost: true, brokeredMcp: false, summariseToolDenial: false },
    "the container capability surface is declared, not inferred from method presence",
  );
  session.dispose();
});

test("createIsolatedPiRunner: cancel() triggers docker kill on the active container", async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let killResolve!: () => void;
  const killFired = new Promise<void>((r) => { killResolve = r; });

  const fakeSpawn = (cmd: string, args: string[], opts: unknown): ReturnType<typeof spawn> => {
    calls.push({ cmd, args: [...args] });
    if (cmd === "docker" && args[0] === "kill") {
      killResolve();
      return spawn(process.execPath, ["-e", "process.exit(0)"], opts as never);
    }
    return spawn(process.execPath, [FAKE_PI], opts as never);
  };

  const runner = createIsolatedPiRunner({ image: "dahrk/pi:test", spawn: fakeSpawn });
  await runner.runBatch(ctx(), () => {});
  await runner.cancel();
  await killFired;

  const killCall = calls.find((c) => c.cmd === "docker" && c.args[0] === "kill");
  assert.ok(killCall, "docker kill was triggered on cancel()");
});
