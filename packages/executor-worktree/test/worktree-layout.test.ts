/**
 * The runId-from-path derivation (DHK-358).
 *
 * This is tested on its own because both of its callers fail SILENTLY when it is wrong: the reaper
 * would stop matching `isLive`/`isBusy` and collect a run that is still going, and the branch-holder
 * guard in `git-service` would stop matching and tear down a live worktree. Neither throws; both
 * destroy work.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runIdOfWorktreePath } from "../src/worktree-layout.js";

const WT = "/srv/dahrk/worktrees";

test("derives the runId from both layouts", () => {
  // Current: each repo is a directory inside the run's directory.
  assert.equal(runIdOfWorktreePath(WT, `${WT}/run-1/dahrk-harness`), "run-1");
  assert.equal(runIdOfWorktreePath(WT, `${WT}/run-1/dahrk-node`), "run-1");
  // Legacy flat, which an upgraded node still has on disk from its previous process.
  assert.equal(runIdOfWorktreePath(WT, `${WT}/run-1`), "run-1");
});

test("returns undefined rather than guessing for anything outside the worktrees dir", () => {
  // A caller must treat undefined as "do not touch". Guessing here is what destroys work.
  assert.equal(runIdOfWorktreePath(WT, "/somewhere/else/run-1"), undefined);
  assert.equal(runIdOfWorktreePath(WT, WT), undefined, "the worktrees dir is not itself a run");
  assert.equal(runIdOfWorktreePath(WT, `${WT}/run-1/repo/nested/deeper`), undefined);
  // A prefix that merely SHARES leading characters is not inside the directory.
  assert.equal(runIdOfWorktreePath(WT, "/srv/dahrk/worktrees-other/run-1"), undefined);
});

test("normalises trailing slashes and `.` segments", () => {
  assert.equal(runIdOfWorktreePath(WT, `${WT}/run-1/repo/`), "run-1");
  assert.equal(runIdOfWorktreePath(WT, `${WT}/./run-1/repo`), "run-1");
  assert.equal(runIdOfWorktreePath(`${WT}/`, `${WT}/run-1`), "run-1");
});

test("a symlinked worktrees dir still derives, from either side", () => {
  // The real case this exists for: `readdir` yields the configured path and
  // `git worktree list --porcelain` yields the resolved one. On macOS that is /var vs /private/var,
  // so a raw string prefix test fails for every worktree under a temp dir.
  const real = mkdtempSync(join(tmpdir(), "dahrk-layout-real-"));
  const link = join(mkdtempSync(join(tmpdir(), "dahrk-layout-link-")), "worktrees");
  try {
    symlinkSync(real, link);
    mkdirSync(join(real, "run-9", "repo-a"), { recursive: true });
    assert.equal(runIdOfWorktreePath(link, join(real, "run-9", "repo-a")), "run-9");
    assert.equal(runIdOfWorktreePath(real, join(link, "run-9", "repo-a")), "run-9");
  } finally {
    rmSync(real, { recursive: true, force: true });
    rmSync(link, { force: true });
  }
});

test("an already-deleted path still derives, because the reaper's job includes those", () => {
  const base = mkdtempSync(join(tmpdir(), "dahrk-layout-gone-"));
  try {
    assert.equal(runIdOfWorktreePath(base, join(base, "run-gone", "repo-a")), "run-gone");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
