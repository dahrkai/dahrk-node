/**
 * `runRepoSetup` makes a stage worktree buildable before the agent starts: it runs the repo's
 * declared setup command inside the worktree, once per worktree, and reports whether it ran, was
 * cached, or failed. The idempotency marker lives in the worktree's scratch dir so a re-dispatch
 * onto the same (reused) worktree does not reinstall, while a fresh worktree runs setup afresh.
 * A non-zero exit reports `failed` and leaves NO marker, so a retry re-runs rather than handing
 * the agent a half-built tree.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runRepoSetup } from "../src/repo-setup.js";

/** The marker is keyed by the repo's own directory name, because a run's repos share one scratch
 *  (DHK-358) and a single marker there would make repo A's marker serve repo B - silently skipping
 *  B's install. */
const markerFor = (worktreePath: string): string =>
  join(worktreePath, ".dahrk", "scratch", "setup", `${basename(worktreePath)}.setup-done`);

test("runs the command once, writes the marker, and captures output", async () => {
  const wt = mkdtempSync(join(tmpdir(), "dahrk-setup-run-"));
  try {
    const res = await runRepoSetup({ worktreePath: wt, command: "echo installing && echo hi > out.txt" });
    assert.equal(res.status, "ran");
    assert.match(res.status === "ran" ? res.output : "", /installing/, "combined output is captured");
    assert.equal(readFileSync(join(wt, "out.txt"), "utf8").trim(), "hi", "the command's side effect landed");
    assert.ok(existsSync(markerFor(wt)), "the idempotency marker is written on success");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("a second call with the same command is cached and does NOT re-run it (once per worktree)", async () => {
  const wt = mkdtempSync(join(tmpdir(), "dahrk-setup-cache-"));
  try {
    const command = "echo x >> counter.txt";
    const first = await runRepoSetup({ worktreePath: wt, command });
    assert.equal(first.status, "ran");
    const second = await runRepoSetup({ worktreePath: wt, command });
    assert.equal(second.status, "cached", "re-dispatch onto the same worktree reuses the installed tree");
    // The command appends a line; if it had re-run there would be two.
    assert.equal(readFileSync(join(wt, "counter.txt"), "utf8").trim().split("\n").length, 1, "the command ran exactly once");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("a non-zero exit reports `failed` and leaves no marker, so a retry re-runs", async () => {
  const wt = mkdtempSync(join(tmpdir(), "dahrk-setup-fail-"));
  try {
    const res = await runRepoSetup({ worktreePath: wt, command: "echo boom >&2; exit 3" });
    assert.equal(res.status, "failed");
    assert.equal(res.status === "failed" ? res.exitCode : undefined, 3, "the non-zero exit code is surfaced");
    assert.match(res.status === "failed" ? res.output : "", /boom/, "stderr is folded into the captured output");
    assert.ok(!existsSync(markerFor(wt)), "no marker on failure, so the next dispatch re-runs setup");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("a changed command invalidates the marker and re-runs", async () => {
  const wt = mkdtempSync(join(tmpdir(), "dahrk-setup-change-"));
  try {
    assert.equal((await runRepoSetup({ worktreePath: wt, command: "echo a >> log.txt" })).status, "ran");
    // Different command => digest mismatch => it must run again rather than report cached.
    assert.equal((await runRepoSetup({ worktreePath: wt, command: "echo b >> log.txt" })).status, "ran");
    assert.equal(readFileSync(join(wt, "log.txt"), "utf8").trim().split("\n").length, 2, "both distinct commands ran");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("DHK-358: each repo of a run gets its own marker, so a sibling's setup is never skipped", async () => {
  // The shared scratch makes this a real risk: one marker under it would mean the first repo's setup
  // marks the second's as done, and the agent gets an uninstalled tree with no trace event at all.
  const runDir = mkdtempSync(join(tmpdir(), "dahrk-setup-run-"));
  const a = join(runDir, "repo-a");
  const b = join(runDir, "repo-b");
  try {
    for (const wt of [a, b]) mkdirSync(join(wt, ".dahrk", "scratch"), { recursive: true });
    const cmd = "echo installing > installed.txt";
    assert.equal((await runRepoSetup({ worktreePath: a, command: cmd })).status, "ran");
    // Same command, different repo: it must still RUN, not report cached.
    assert.equal((await runRepoSetup({ worktreePath: b, command: cmd })).status, "ran");
    assert.ok(existsSync(join(b, "installed.txt")), "the sibling's setup actually executed");
    // ...and each repo caches independently thereafter.
    assert.equal((await runRepoSetup({ worktreePath: b, command: cmd })).status, "cached");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("the event loop keeps running while setup does, so the node's heartbeat is not starved", async () => {
  // THE regression test for this module. Setup used to be `spawnSync`, which blocks the event loop for
  // the whole command - and the cap on that command is ten minutes. The node's WebSocket heartbeat
  // lives on the same loop, so a long install starved it: the socket went stale and terminated, and a
  // node running a perfectly healthy stage went silent for as long as the install took.
  //
  // Asserted with a TIMER rather than by inspecting the call: a timer that keeps firing is exactly the
  // thing the heartbeat is, so this fails if and only if the real defect comes back. A synchronous
  // implementation records 0 ticks here no matter how long the command runs.
  const wt = mkdtempSync(join(tmpdir(), "dahrk-setup-loop-"));
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 25);
  try {
    const res = await runRepoSetup({ worktreePath: wt, command: "sleep 0.5" });
    assert.equal(res.status, "ran");
    assert.ok(ticks >= 5, `expected the loop to keep ticking during setup, got ${ticks} ticks`);
  } finally {
    clearInterval(timer);
    rmSync(wt, { recursive: true, force: true });
  }
});

test("a setup command that cannot spawn reports `failed` rather than throwing", async () => {
  // The `error` event path: no `close` follows it, so a settle that only listened for `close` would
  // hang for ever - and a hung setup is indistinguishable from the starvation this module just fixed.
  const wt = mkdtempSync(join(tmpdir(), "dahrk-setup-spawnerr-"));
  try {
    const res = await runRepoSetup({ worktreePath: join(wt, "does-not-exist"), command: "true" });
    assert.equal(res.status, "failed");
    assert.equal(res.status === "failed" ? res.exitCode : undefined, null, "a spawn failure has no exit code");
    assert.ok((res.status === "failed" ? res.output : "").length > 0, "the spawn error message is surfaced");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("a setup command that exceeds its timeout is killed and reported failed", async () => {
  const wt = mkdtempSync(join(tmpdir(), "dahrk-setup-timeout-"));
  try {
    const res = await runRepoSetup({ worktreePath: wt, command: "sleep 30", timeoutMs: 250 });
    assert.equal(res.status, "failed", "a hung installer is killed, not left to wedge the stage");
    assert.ok(!existsSync(markerFor(wt)), "a timed-out setup leaves no marker, so a retry re-runs");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

// --- ADR 0019: the duration is the number that chooses the managed-tier toolchain cache ------------
// Recorded on every variant so the two paths can be COMPARED. On an edge node setup is mostly cached
// and cheap; a managed guest is torn down after a stage, so its worktree - and therefore the marker -
// dies with it and every run pays the uncached cost in full. Guessing that number is what ADR 0019
// refused to do.

test("ADR 0019: a run reports a duration that reflects the time the command actually took", async () => {
  const wt = mkdtempSync(join(tmpdir(), "dahrk-setup-duration-"));
  try {
    const res = await runRepoSetup({ worktreePath: wt, command: "sleep 0.25" });
    assert.equal(res.status, "ran");
    const ms = res.status === "ran" ? res.durationMs : -1;
    // Asserted as a RANGE, not a constant: the point is that it measures real elapsed time rather than
    // reporting a plausible-looking zero, which is the way this instrumentation fails silently.
    assert.ok(ms >= 250, `expected at least the 250ms sleep, got ${ms}ms`);
    assert.ok(ms < 30_000, `expected a sane wall time, got ${ms}ms`);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("ADR 0019: the cached path reports a duration too, and it is far below the run it replaced", async () => {
  const wt = mkdtempSync(join(tmpdir(), "dahrk-setup-duration-cached-"));
  try {
    const command = "sleep 0.25";
    const ran = await runRepoSetup({ worktreePath: wt, command });
    const cached = await runRepoSetup({ worktreePath: wt, command });
    assert.equal(ran.status, "ran");
    assert.equal(cached.status, "cached");
    // The comparison IS the measurement: a cached call must not be paying the install again.
    assert.ok(
      (cached.status === "cached" ? cached.durationMs : Infinity) < (ran.status === "ran" ? ran.durationMs : 0),
      "the cached path must be cheaper than the run it skipped",
    );
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("ADR 0019: a failed setup still reports how long it burned before failing", async () => {
  const wt = mkdtempSync(join(tmpdir(), "dahrk-setup-duration-failed-"));
  try {
    // A failure that took nine minutes to arrive is a different operational problem from one that
    // failed instantly, and the trace should be able to tell them apart.
    const res = await runRepoSetup({ worktreePath: wt, command: "sleep 0.25; exit 3" });
    assert.equal(res.status, "failed");
    assert.ok((res.status === "failed" ? res.durationMs : -1) >= 250, "time spent before the failure is reported");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});
