/**
 * The deterministic quality gate. Modelled on `repo-setup.test.ts`: real `sh -c` against a real temp
 * directory, because the whole value of a check stage is that the exit code of a real process is the
 * verdict. Mocking the process away would test nothing that matters.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedCheck, RunnerContext, TraceEvent, WorkspaceRef } from "@dahrk/contracts";
import { createCheckRunner, summariseChecks, type CheckOutcome } from "../src/check-runner.js";

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
