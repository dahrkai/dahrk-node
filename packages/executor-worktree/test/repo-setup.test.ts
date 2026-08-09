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

test("runs the command once, writes the marker, and captures output", () => {
  const wt = mkdtempSync(join(tmpdir(), "dahrk-setup-run-"));
  try {
    const res = runRepoSetup({ worktreePath: wt, command: "echo installing && echo hi > out.txt" });
    assert.equal(res.status, "ran");
    assert.match(res.status === "ran" ? res.output : "", /installing/, "combined output is captured");
    assert.equal(readFileSync(join(wt, "out.txt"), "utf8").trim(), "hi", "the command's side effect landed");
    assert.ok(existsSync(markerFor(wt)), "the idempotency marker is written on success");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("a second call with the same command is cached and does NOT re-run it (once per worktree)", () => {
  const wt = mkdtempSync(join(tmpdir(), "dahrk-setup-cache-"));
  try {
    const command = "echo x >> counter.txt";
    const first = runRepoSetup({ worktreePath: wt, command });
    assert.equal(first.status, "ran");
    const second = runRepoSetup({ worktreePath: wt, command });
    assert.equal(second.status, "cached", "re-dispatch onto the same worktree reuses the installed tree");
    // The command appends a line; if it had re-run there would be two.
    assert.equal(readFileSync(join(wt, "counter.txt"), "utf8").trim().split("\n").length, 1, "the command ran exactly once");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("a non-zero exit reports `failed` and leaves no marker, so a retry re-runs", () => {
  const wt = mkdtempSync(join(tmpdir(), "dahrk-setup-fail-"));
  try {
    const res = runRepoSetup({ worktreePath: wt, command: "echo boom >&2; exit 3" });
    assert.equal(res.status, "failed");
    assert.equal(res.status === "failed" ? res.exitCode : undefined, 3, "the non-zero exit code is surfaced");
    assert.match(res.status === "failed" ? res.output : "", /boom/, "stderr is folded into the captured output");
    assert.ok(!existsSync(markerFor(wt)), "no marker on failure, so the next dispatch re-runs setup");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("a changed command invalidates the marker and re-runs", () => {
  const wt = mkdtempSync(join(tmpdir(), "dahrk-setup-change-"));
  try {
    assert.equal(runRepoSetup({ worktreePath: wt, command: "echo a >> log.txt" }).status, "ran");
    // Different command => digest mismatch => it must run again rather than report cached.
    assert.equal(runRepoSetup({ worktreePath: wt, command: "echo b >> log.txt" }).status, "ran");
    assert.equal(readFileSync(join(wt, "log.txt"), "utf8").trim().split("\n").length, 2, "both distinct commands ran");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("DHK-358: each repo of a run gets its own marker, so a sibling's setup is never skipped", () => {
  // The shared scratch makes this a real risk: one marker under it would mean the first repo's setup
  // marks the second's as done, and the agent gets an uninstalled tree with no trace event at all.
  const runDir = mkdtempSync(join(tmpdir(), "dahrk-setup-run-"));
  const a = join(runDir, "repo-a");
  const b = join(runDir, "repo-b");
  try {
    for (const wt of [a, b]) mkdirSync(join(wt, ".dahrk", "scratch"), { recursive: true });
    const cmd = "echo installing > installed.txt";
    assert.equal(runRepoSetup({ worktreePath: a, command: cmd }).status, "ran");
    // Same command, different repo: it must still RUN, not report cached.
    assert.equal(runRepoSetup({ worktreePath: b, command: cmd }).status, "ran");
    assert.ok(existsSync(join(b, "installed.txt")), "the sibling's setup actually executed");
    // ...and each repo caches independently thereafter.
    assert.equal(runRepoSetup({ worktreePath: b, command: cmd }).status, "cached");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
