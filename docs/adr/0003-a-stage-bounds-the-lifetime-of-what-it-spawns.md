# ADR 0003 - A stage bounds the lifetime of the processes spawned during it

**Confidentiality:** Public
**Status:** DRAFT - UNREVIEWED

## Context

A stage can spawn processes, and some of them are meant to be short-lived but are not written to be.
An agent (or a check command, or the repo setup step) can background a process during a stage -
`npm run dev &`, `nohup ...`, a file watcher. Backgrounding is legitimate, it is not on the `DANGEROUS`
blocklist, and the planned preview work depends on it, so the answer is not to forbid it.

Before this ADR there was **no process-group kill anywhere on the node**. Grepping `process.kill(`,
`kill(-`, `detached`, `killSignal`, `pkill` and tree-kill across `packages/edge/src`,
`packages/executor-worktree/src` and `apps/edge-node/src` found exactly one hit: a `process.kill(pid, 0)`
liveness probe on the singleton lock, which sends no signal. No `spawn` on the node passed
`detached: true`, so every child the node spawned joined the **node's own process group** rather than
leading its own.

The consequence at the OS level: when the node killed a child it spawned, it signalled only that one
pid. On POSIX a `sh -c "cmd &"` shell exits (or is `SIGKILL`ed) while the backgrounded grandchild is
reparented to init and keeps running - the kill never reached it because it was never sent to the group.
So a backgrounded process survived stage end, survived the run, and survived until the node process
itself died: on a self-hosted node, a resource leak on the operator's own machine (orphaned servers
holding ports and memory) with nothing that would ever clean it up.

## Decision

**Every process the node spawns for a stage leads its own process group, and is reaped by group when the
stage settles, is cancelled, or hits its wall clock.** A node-owned `sh -c` is spawned `detached: true`
(on POSIX this makes it a session/group leader whose group id equals its pid), and it is killed by
signalling the **negative** pid, which reaches every descendant. So a backgrounded grandchild goes down
with the shell instead of outliving the stage (DHK-1099).

The mechanism is one shared helper, `killProcessGroup` in `packages/executor-worktree/src/process-group.ts`,
paired with the `detachedGroup` spawn option. It is best-effort and idempotent: a group with no live
member throws `ESRCH` - exactly the healthy path, where the command backgrounded nothing - which is
swallowed, and it falls back to the single pid if the group signal is refused.

The healthy path is untouched. A normal `sh -c` that backgrounds nothing exits exactly as before; the
group reap on its clean exit is a no-op. The reap fires **after** the command settles (or on the
timeout/cancel that was already going to kill it), so nothing a stage legitimately needs is killed early.

### Where it is applied (the processes the node owns)

- `packages/executor-worktree/src/check-runner.ts` - each check command. Reaped on every exit path
  (clean, per-check timeout, and now `cancel()`, which kills the in-flight group at once rather than
  only setting a flag that took effect at the next check boundary).
- `packages/executor-worktree/src/repo-setup.ts` - the setup command. Switched from `execFileSync` to
  `spawnSync` purely to obtain the child's pid, so the group can be reaped after the synchronous call
  returns (including after its own timeout kill, which signals only the `sh`).
- `packages/edge/src/stage-runner.ts` - the R4 stage-exit hooks, same `spawnSync` + reap shape.

## Case 2 - an agent's own backgrounded processes are NOT yet reaped

The ticket splits the problem in two, and the second half is **not closed by this ADR**.

**Case 1 (closed):** processes the node spawns itself - check commands, repo setup, stage-exit hooks.
The node owns these pids, so it makes each a group leader and kills the group. Done, with a test.

**Case 2 (open):** processes an agent spawns through its runtime's own shell tool. The node does **not**
own these pids. The runner is owned by the vendored SDK (`query()` for Claude, `createAgentSession()`
for Pi), which surfaces **no pid** - cancellation is an in-process `AbortController`, not a signal (the
crux is documented at `packages/edge/src/ws-client.ts:424-428`). The SDK spawns its agent CLI as a child
of the **node process**, which is not itself a group leader, so the descendants sit in the node's own
process group; there is no negative pid the node can signal that would not also signal the node itself.

Making the node re-exec as a session leader at boot would put every agent subprocess in a reapable
group, but that group also contains the node, so reaping it would kill the node - not a per-stage lever.
The real fix needs one of:

- the vendored SDK to expose the spawned agent's pid (or to accept a `detached`/`setpgid` hook), so the
  node can make that subprocess a group leader and reap its descendants; or
- running the agent runtime inside a detached child process the node owns, which is the "whole stage
  runner in a child" reshaping ADR 0002 already describes for containerisation - a different
  architecture, not a flag.

Neither is available at the current SDK pins, so **Case 2 is left open and a follow-up is filed** to
revisit it when the runtime surfaces a pid or the runner moves into an owned child process. In practice
the agent's own CLI usually dies with the node anyway (its stdio pipes break when the node exits and the
CLI exits), so the acute leak is a process the agent deliberately detached from that stdio - the same
`nohup`/`&` shape Case 1 now reaps for node-owned commands.

## Consequences

- A self-hosted operator no longer accrues orphaned servers from stages that background a process.
- The supervision machinery the planned preview work needs - run a serve command with a lifetime bounded
  by the stage - now exists for node-owned commands.
- `repo-setup` and the stage-exit hooks moved from `execFileSync`/throw to `spawnSync`/inspect-result;
  behaviour is unchanged for the ordinary no-background command (it already blocked on an inherited pipe
  until timeout under `execFileSync`, and still does), but a backgrounded child is now reaped rather than
  leaked.

## Sources

- `packages/executor-worktree/src/process-group.ts` - the `killProcessGroup` helper and `detachedGroup`.
- `packages/executor-worktree/src/check-runner.ts` - group reap on settle, timeout and `cancel()`.
- `packages/executor-worktree/src/repo-setup.ts`, `packages/edge/src/stage-runner.ts` - the synchronous
  node-owned spawns.
- `packages/edge/src/ws-client.ts:424-428` - the vendored SDK surfaces no pid, which is the crux of
  Case 2.
- Related: DHK-1099 (this change), ADR 0002 (stage isolation: why the SDK caller cannot cross a process
  boundary without reshaping the whole stage runner).
