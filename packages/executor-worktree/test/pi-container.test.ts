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
import type { RunnerContext, TraceEvent } from "@dahrk/contracts";
import { createContainerPiSession, createIsolatedPiRunner } from "../src/pi-container.js";
import type { PiSessionLike } from "../src/pi-adapter.js";

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

test("createContainerPiSession: assigns a container name starting with skakel-pi-", async () => {
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
