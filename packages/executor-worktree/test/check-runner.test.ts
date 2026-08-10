/**
 * The deterministic quality gate. Modelled on `repo-setup.test.ts`: real `sh -c` against a real temp
 * directory, because the whole value of a check stage is that the exit code of a real process is the
 * verdict. Mocking the process away would test nothing that matters.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ResolvedCheck, RunnerContext, TraceEvent, WorkspaceRef } from "@dahrk/contracts";
import {
  createCheckRunner,
  summariseChecks,
  type CheckOutcome,
  type CheckProbes,
} from "../src/check-runner.js";

function sandbox(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-checks-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const ctxFor = (dir: string): RunnerContext =>
  ({
    config: { runtime: "claude-code" },
    workspace: { worktreePath: dir, scratchPath: join(dir, ".dahrk", "scratch") } as WorkspaceRef,
  }) as RunnerContext;

async function run(dir: string, checks: ResolvedCheck[]) {
  const events: TraceEvent[] = [];
  let outcomes: CheckOutcome[] = [];
  const runner = createCheckRunner(checks, (o) => {
    outcomes = o;
  });
  const result = await runner.runBatch(ctxFor(dir), (e) => events.push(e));
  return { result, events, outcomes, summary: await runner.summarise(ctxFor(dir)) };
}

test("all checks passing yields ok and one passed verification each", async () => {
  const { dir, cleanup } = sandbox();
  try {
    const { result, summary } = await run(dir, [
      { name: "lint", command: "true" },
      { name: "typecheck", command: "exit 0" },
    ]);
    assert.equal(result.status, "ok");
    assert.deepEqual(result.verifications, [
      { name: "lint", status: "passed" },
      { name: "typecheck", status: "passed" },
    ]);
    assert.match(summary, /all 2 checks passed/);
  } finally {
    cleanup();
  }
});

// The load-bearing semantic: a single loop-back must carry EVERY defect. Stopping at the first failure
// would cost one full rebuild cycle per defect against a finite maxLoops, trading cheap machine time
// for expensive agent time and wall clock.
test("a failing check does NOT stop the ones after it", async () => {
  const { dir, cleanup } = sandbox();
  try {
    const { result, summary } = await run(dir, [
      { name: "lint", command: "echo lint-broke >&2; exit 1" },
      { name: "typecheck", command: "exit 2" },
      { name: "test", command: "true" },
    ]);
    assert.equal(result.status, "fail");
    assert.deepEqual(result.verifications, [
      { name: "lint", status: "failed" },
      { name: "typecheck", status: "failed" },
      { name: "test", status: "passed" },
    ]);
    assert.match(summary, /2 of 3 checks failed: lint, typecheck/);
  } finally {
    cleanup();
  }
});

test("commands run in the worktree and capture stdout and stderr together", async () => {
  const { dir, cleanup } = sandbox();
  try {
    writeFileSync(join(dir, "marker.txt"), "present");
    const { outcomes } = await run(dir, [
      { name: "cwd", command: "cat marker.txt; echo to-stderr >&2; exit 3" },
    ]);
    assert.equal(outcomes[0]?.exitCode, 3);
    assert.match(outcomes[0]!.output, /present/, "ran with the worktree as cwd");
    assert.match(outcomes[0]!.output, /to-stderr/, "stderr is captured too");
  } finally {
    cleanup();
  }
});

test("a per-check timeout kills the command and reports it honestly", async () => {
  const { dir, cleanup } = sandbox();
  try {
    const { result, outcomes } = await run(dir, [{ name: "hang", command: "sleep 30", timeoutSeconds: 1 }]);
    assert.equal(result.status, "fail");
    assert.equal(outcomes[0]?.timedOut, true);
    assert.equal(outcomes[0]?.status, "failed");
  } finally {
    cleanup();
  }
});

// A check that cannot even start is a FAILED check, not a crashed stage: the run must learn the verdict
// deterministically rather than the node throwing mid-stage.
test("a command that cannot start is a failed check, not an exception", async () => {
  const { dir, cleanup } = sandbox();
  try {
    const { result, outcomes } = await run(dir, [
      { name: "nonsense", command: "definitely-not-a-real-binary-xyz" },
    ]);
    assert.equal(result.status, "fail");
    assert.equal(outcomes[0]?.status, "failed");
  } finally {
    cleanup();
  }
});

test("output is tail-capped so a chatty check cannot bloat the note or the trace", async () => {
  const { dir, cleanup } = sandbox();
  try {
    // ~40KiB of output against a 16KiB cap; the TAIL is what a failing runner puts its summary in.
    const { outcomes } = await run(dir, [
      { name: "chatty", command: "for i in $(seq 1 4000); do echo 0123456789; done; echo LAST_LINE; exit 1" },
    ]);
    assert.ok(outcomes[0]!.output.length <= 16_384, `got ${outcomes[0]!.output.length} bytes`);
    assert.match(outcomes[0]!.output, /LAST_LINE/, "the tail is kept, not the head");
  } finally {
    cleanup();
  }
});

// The trace pairing the hub's progress preview already understands: the command clips to the small
// action preview, the output to the larger observation cap. No change to `previewOf` needed.
test("each check emits an action then an observation, and the stage ends with a response", async () => {
  const { dir, cleanup } = sandbox();
  try {
    const { events } = await run(dir, [{ name: "lint", command: "exit 1" }]);
    assert.deepEqual(events.map((e) => e.type), ["action", "observation", "response"]);
    assert.equal(events.every((e) => e.runtime === "check"), true, "a check stage never claims an agent runtime");
    const observation = events[1] as Extract<TraceEvent, { type: "observation" }>;
    assert.equal(observation.isError, true);
    assert.equal(observation.toolUseId, "lint", "paired with its action by check name");
  } finally {
    cleanup();
  }
});

// The stage wall clock fired. Every declared check must still appear in `verifications`, or the Card
// strip and the loop-back note silently lose checks rather than reporting them as not run.
test("cancelling mid-stage records the remaining checks as skipped, not missing", async () => {
  const { dir, cleanup } = sandbox();
  try {
    const runner = createCheckRunner([
      { name: "first", command: "true" },
      { name: "second", command: "true" },
      { name: "third", command: "true" },
    ]);
    const events: TraceEvent[] = [];
    const promise = runner.runBatch(ctxFor(dir), (e) => {
      events.push(e);
      void runner.cancel();
    });
    const result = await promise;
    assert.equal(result.status, "timeout");
    assert.deepEqual(
      result.verifications?.map((v) => v.status),
      ["passed", "skipped", "skipped"],
      "one entry per declared check, always",
    );
  } finally {
    cleanup();
  }
});

/** Is this pid still alive? `kill(pid, 0)` sends no signal; it throws `ESRCH` once the process is gone. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until `pid` is gone or the budget elapses. SIGKILL delivery is asynchronous, so a bare check
 *  straight after settle can still see the process for a beat. Returns whether it died in time. */
async function waitDead(pid: number, budgetMs = 2000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await delay(25);
  }
  return !isAlive(pid);
}

/** Read the pid a backgrounded child wrote to `bg.pid`, once it appears. */
async function readBgPid(dir: string): Promise<number> {
  const path = join(dir, "bg.pid");
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      const pid = Number(readFileSync(path, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      /* not written yet */
    }
    await delay(25);
  }
  throw new Error("the backgrounded child never recorded its pid");
}

// The DHK-1099 regression. A check that backgrounds a long-lived child - a dev server, a watcher -
// used to leave that grandchild running once the check's own `sh` was SIGKILLed, because the kill went
// to the shell's pid alone and the reparented grandchild never received it. It must now die with the
// stage. Timeout path: the per-check wall clock fires and reaps the whole process group.
test("a backgrounded child is reaped when the check times out, not left to outlive the stage", async () => {
  const { dir, cleanup } = sandbox();
  try {
    // Background a long sleep, record its pid, then wait on it so the check itself hangs to the timeout.
    const runP = run(dir, [
      { name: "leaky", command: "sleep 30 & echo $! > bg.pid; wait", timeoutSeconds: 1 },
    ]);
    const bgPid = await readBgPid(dir);
    const { result, outcomes } = await runP;
    assert.equal(outcomes[0]?.timedOut, true);
    assert.equal(result.status, "fail");
    assert.equal(await waitDead(bgPid), true, `the backgrounded child (pid ${bgPid}) survived the stage`);
  } finally {
    cleanup();
  }
});

// Clean-exit path: a check that exits 0 having backgrounded a server (its stdio detached, so the check
// settles at once) must still not leave that server running past the stage.
test("a backgrounded child is reaped even when the check exits cleanly", async () => {
  const { dir, cleanup } = sandbox();
  try {
    const { result } = await run(dir, [
      { name: "starts-a-server", command: "sleep 30 >/dev/null 2>&1 & echo $! > bg.pid" },
    ]);
    assert.equal(result.status, "ok", "the check itself exited 0");
    const bgPid = await readBgPid(dir);
    assert.equal(await waitDead(bgPid), true, `the backgrounded child (pid ${bgPid}) survived a clean stage exit`);
  } finally {
    cleanup();
  }
});

// Cancel path (the stage wall clock / a stage-stop): the in-flight check and anything it backgrounded
// are reaped at once, not left running until the next check boundary the flag would take effect at.
test("cancelling reaps the in-flight check's whole process group", async () => {
  const { dir, cleanup } = sandbox();
  try {
    const runner = createCheckRunner([{ name: "leaky", command: "sleep 30 & echo $! > bg.pid; wait" }]);
    const promise = runner.runBatch(ctxFor(dir), () => {});
    const bgPid = await readBgPid(dir);
    await runner.cancel();
    await promise;
    assert.equal(await waitDead(bgPid), true, `the backgrounded child (pid ${bgPid}) survived the cancel`);
  } finally {
    cleanup();
  }
});

test("summarise is deterministic and never calls a model", async () => {
  assert.equal(summariseChecks([]), "no checks declared");
  assert.equal(
    summariseChecks([
      { name: "a", command: "", exitCode: 0, output: "", status: "passed", durationMs: 1, timedOut: false },
      { name: "b", command: "", exitCode: 1, output: "", status: "failed", durationMs: 1, timedOut: false },
      { name: "c", command: "", exitCode: null, output: "", status: "skipped", durationMs: 0, timedOut: false },
    ]),
    "1 of 3 checks failed: b; 1 not run",
  );
});

test("an interactive check stage is unrepresentable and refuses loudly", async () => {
  const runner = createCheckRunner([{ name: "lint", command: "true" }]);
  await assert.rejects(() => runner.runInteractive({} as RunnerContext, [] as never, () => {}), /cannot be interactive/);
});

test("the sandbox leaves no worktree artefacts behind", () => {
  const { dir, cleanup } = sandbox();
  cleanup();
  assert.equal(existsSync(dir), false);
});

// The note is the durable, full-fidelity record the looped-back agent reads. Rendered pure so it is
// testable without a worktree.
test("the note leads with the verdict and puts failing checks first, with their output", async () => {
  const { renderCheckNote } = await import("../src/check-runner.js");
  const note = renderCheckNote("verify", 2, [
    { name: "format", command: "prettier --check .", exitCode: 0, output: "all matched", status: "passed", durationMs: 5, timedOut: false },
    { name: "lint", command: "pnpm -s lint", exitCode: 1, output: "src/foo.ts:12 'x' unused", status: "failed", durationMs: 9, timedOut: false },
  ]);
  assert.match(note, /^# checks\/verify \(attempt 2\) - FAILED/);
  assert.match(note, /1 of 2 checks failed: lint/);
  // Failing first: the agent must not have to scroll past passing output to find what it must fix.
  assert.ok(note.indexOf("## lint") < note.indexOf("## format"), note);
  assert.match(note, /\$ pnpm -s lint/);
  assert.match(note, /'x' unused/);
});

test("a timed-out check says so in the note rather than reporting a bare exit code", async () => {
  const { renderCheckNote } = await import("../src/check-runner.js");
  const note = renderCheckNote("verify", 1, [
    { name: "test", command: "pnpm -s test", exitCode: null, output: "", status: "failed", durationMs: 1_200_000, timedOut: true },
  ]);
  assert.match(note, /TIMED OUT after 1200s/);
});

test("an all-green note is still written, so 'did it run and pass' is answerable", async () => {
  const { renderCheckNote } = await import("../src/check-runner.js");
  const note = renderCheckNote("verify", 1, [
    { name: "lint", command: "pnpm -s lint", exitCode: 0, output: "", status: "passed", durationMs: 3, timedOut: false },
  ]);
  assert.match(note, /- PASSED/);
  assert.match(note, /all 1 checks passed/);
});

// --- node-native probes -----------------------------------------------------------------------------

/**
 * A `probe` check is performed by the node, not spawned, because it needs the repo's git credential
 * and a check env deliberately has none. `repo-fetch` ran as a bare `git fetch` for its whole life and
 * so failed on every brokered node with `could not read Password ... Device not configured` - a
 * REQUIRED probe that could never pass, which pinned preflight's verdict to `pass-with-findings` and
 * made onboarding's finding-free gate unreachable (evidence: `preflight-79af58f15a3a`).
 */
async function runWithProbes(dir: string, checks: ResolvedCheck[], probes: CheckProbes) {
  const events: TraceEvent[] = [];
  let outcomes: CheckOutcome[] = [];
  const runner = createCheckRunner(
    checks,
    (o) => {
      outcomes = o;
    },
    probes,
  );
  const result = await runner.runBatch(ctxFor(dir), (e) => events.push(e));
  return { result, events, outcomes, summary: await runner.summarise(ctxFor(dir)) };
}

test("a probe check is performed by the node, and its command is never spawned", async () => {
  const { dir, cleanup } = sandbox();
  try {
    // The command would CREATE this file if it ran. It must not: the probe replaces it entirely.
    const marker = join(dir, "spawned");
    let called = 0;
    const { result, outcomes } = await runWithProbes(
      dir,
      [{ name: "repo-fetch", command: `touch ${marker}`, probe: "git-fetch" }],
      {
        "git-fetch": async () => {
          called++;
          return { ok: true, output: "", exitCode: 0, timedOut: false };
        },
      },
    );

    assert.equal(called, 1, "the node performed the probe");
    assert.equal(existsSync(marker), false, "the check command was not spawned");
    assert.equal(result.status, "ok");
    assert.deepEqual(result.verifications, [{ name: "repo-fetch", status: "passed" }]);
    assert.equal(outcomes[0]?.exitCode, 0);
  } finally {
    cleanup();
  }
});

test("a failing probe is a failed check carrying git's real reason, not a crashed stage", async () => {
  const { dir, cleanup } = sandbox();
  try {
    const reason = "fatal: could not read Password for 'https://x-access-token@github.com/o/r.git'";
    const { result, outcomes } = await runWithProbes(
      dir,
      [{ name: "repo-fetch", command: "git fetch --dry-run", probe: "git-fetch" }],
      { "git-fetch": async () => ({ ok: false, output: reason, exitCode: 128, timedOut: false }) },
    );

    assert.equal(result.status, "fail");
    assert.deepEqual(result.verifications, [{ name: "repo-fetch", status: "failed" }]);
    assert.equal(outcomes[0]?.output, reason, "the operator sees what git actually said");
    assert.equal(outcomes[0]?.exitCode, 128);
  } finally {
    cleanup();
  }
});

test("an unimplemented probe fails the check naming the gap, rather than falling back to the command", async () => {
  const { dir, cleanup } = sandbox();
  try {
    // Falling through to `command` would be worse than useless here: for a credentialed probe the
    // command cannot pass, so the operator would get a mystery auth error instead of the real cause.
    const marker = join(dir, "spawned");
    const { result, outcomes } = await runWithProbes(
      dir,
      [{ name: "repo-fetch", command: `touch ${marker}`, probe: "git-fetch" }],
      {},
    );

    assert.equal(existsSync(marker), false, "no silent fall-through to the command");
    assert.equal(result.status, "fail");
    assert.match(outcomes[0]?.output ?? "", /does not implement the "git-fetch" probe/);
  } finally {
    cleanup();
  }
});

test("a probe that throws is a failed check, exactly like a spawn failure", async () => {
  const { dir, cleanup } = sandbox();
  try {
    const { result, outcomes } = await runWithProbes(
      dir,
      [{ name: "repo-fetch", command: "git fetch --dry-run", probe: "git-fetch" }],
      {
        "git-fetch": async () => {
          throw new Error("worktree vanished");
        },
      },
    );

    assert.equal(result.status, "fail");
    assert.match(outcomes[0]?.output ?? "", /worktree vanished/);
  } finally {
    cleanup();
  }
});

test("probe and command checks run side by side, each by its own mechanism", async () => {
  const { dir, cleanup } = sandbox();
  try {
    const { result } = await runWithProbes(
      dir,
      [
        { name: "git-available", command: "true" },
        { name: "repo-fetch", command: "false", probe: "git-fetch" },
        { name: "node-version", command: "true" },
      ],
      { "git-fetch": async () => ({ ok: true, output: "", exitCode: 0, timedOut: false }) },
    );

    // `repo-fetch`'s command is `false`; it passes anyway, which is only possible via the probe.
    assert.equal(result.status, "ok");
    assert.deepEqual(result.verifications, [
      { name: "git-available", status: "passed" },
      { name: "repo-fetch", status: "passed" },
      { name: "node-version", status: "passed" },
    ]);
  } finally {
    cleanup();
  }
});
