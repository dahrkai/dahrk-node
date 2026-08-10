/**
 * Reap a node-owned subprocess AND everything it backgrounded, by process group (DHK-1099).
 *
 * A stage's shell command can background a long-lived child - `npm run dev &`, `nohup ...`, a file
 * watcher. On POSIX that grandchild is reparented to init when its `sh` exits and, absent a group kill,
 * outlives the check, the run and the node itself: an orphaned server holding a port and memory with
 * nothing that will ever clean it up. Signalling the single `sh` pid never reaches it.
 *
 * The fix is two halves that only work together:
 *  - spawn the command `detached: true`, which on POSIX makes it a session/process-group LEADER whose
 *    group id equals its pid (see {@link detachedGroup});
 *  - signal the NEGATIVE pid, which delivers to every process in that group, so the backgrounded
 *    grandchildren go down with the shell.
 *
 * The group outlives its leader: a process group persists as long as ANY member is alive, so this still
 * reaps the descendants of a `sh` that has already exited on its own - the case where a check passed but
 * left a server running.
 */
import type { ChildProcess } from "node:child_process";

/** Spawn options that make a child a process-group leader, so {@link killProcessGroup} can reap its whole
 *  subtree. Spread into a `spawn`/`spawnSync` opts object. Kept as one exported constant so every
 *  node-owned shell spawn opts in the same way and none is silently left group-less. */
export const detachedGroup = { detached: true } as const;

/** A child-like with just what the reap needs: its pid and (optionally) a single-process `kill`. Lets
 *  both an async `ChildProcess` and a synchronous `spawnSync` result (which carries a `pid` but no
 *  `kill`) be reaped through one function. */
type GroupLeader = Pick<ChildProcess, "pid"> & { kill?: ChildProcess["kill"] };

/**
 * Kill a process-group leader and its whole group.
 *
 * Best-effort and idempotent by design. A group with no live member throws `ESRCH` - which is exactly
 * the healthy path, where the command backgrounded nothing and its `sh` has already exited - so that is
 * swallowed. If the group signal is refused for any other reason, fall back to the single pid so a
 * still-live child is never left behind. Safe to call more than once and on a child that has exited.
 *
 * The leader MUST have been spawned with {@link detachedGroup}; otherwise its group id is the node's own
 * and `-pid` would signal the node. Callers in this package always pair the two.
 */
export function killProcessGroup(child: GroupLeader, signal: NodeJS.Signals = "SIGKILL"): void {
  const { pid } = child;
  // pid 0 is never a real child; `-0` would target the caller's own group, so refuse it explicitly.
  if (pid === undefined || pid === 0) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill?.(signal);
    } catch {
      /* already exited: nothing left to reap */
    }
  }
}
