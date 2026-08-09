/**
 * Where a run's worktrees live on disk, and how to read a runId back out of a path.
 *
 * A run used to be one worktree at `<worktreesDir>/<runId>`, so the runId was simply the directory's
 * basename. Two places relied on that, and both are dangerous when it stops being true:
 *
 *   - the reaper, which asks `isLive(runId)` / `isBusy(runId)` before collecting a directory. A wrong
 *     runId never matches, so a LIVE run - including one parked at a human gate - looks collectable.
 *   - the branch-holder eviction in `git-service`, which refuses to tear down a worktree whose run is
 *     still in flight. A wrong runId makes that guard silently always-false.
 *
 * Neither fails loudly. Both destroy work. So the derivation lives here, in one tested function, and
 * both callers import it rather than reaching for `basename` again.
 *
 * A multi-repo run (DHK-251) needs several worktrees at once, so the layout is now
 * `<worktreesDir>/<runId>/<repoDir>/` for EVERY run - single-repo included, rather than two shapes
 * to reason about. The run directory also gives the run's repos a place to share one scratch
 * directory that belongs to none of them.
 */
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

/**
 * The run a worktree path belongs to, or `undefined` when the path is not one of ours.
 *
 * Handles both layouts, because a node that upgrades mid-flight still has flat directories on disk
 * from the previous process:
 *
 *   `<worktreesDir>/<runId>/<repoDir>`  -> runId   (current)
 *   `<worktreesDir>/<runId>`            -> runId   (legacy flat)
 *
 * Anything else returns `undefined`, and callers must treat that as "do not touch", never as a
 * licence to guess.
 *
 * BOTH sides are canonicalised here rather than at the call sites. `readdir` yields a path as it was
 * configured while `git worktree list --porcelain` yields the fully resolved one - on macOS that is
 * `/var/...` against `/private/var/...` - so a prefix test on the raw strings fails for every worktree
 * under a symlinked temp dir. Leaving that to callers made it a footgun that only shows up on one
 * platform, and getting it wrong here means a live run looks unrecognised.
 */
export function runIdOfWorktreePath(worktreesDir: string, p: string): string | undefined {
  // Both the lexical and the resolved form of each side, because they can legitimately differ and we
  // do not know which form each argument arrived in. A deleted path has no resolved form at all -
  // normal here, since the reaper's job includes directories that have already gone - so mixing a
  // resolved base with a lexical target would silently stop matching exactly when it matters.
  const forms = (raw: string): string[] => {
    const lexical = resolve(raw);
    try {
      const real = realpathSync(lexical);
      return real === lexical ? [lexical] : [lexical, real];
    } catch {
      return [lexical];
    }
  };

  for (const base of forms(worktreesDir)) {
    for (const target of forms(p)) {
      if (target === base || !target.startsWith(base + sep)) continue;
      const segments = target.slice(base.length + 1).split(sep).filter(Boolean);
      // One segment = legacy flat, two = a repo inside its run directory. Three or more is not a
      // layout this module ever produced, so it is somebody else's directory and we leave it alone.
      if (segments.length === 1 || segments.length === 2) return segments[0];
    }
  }
  return undefined;
}
