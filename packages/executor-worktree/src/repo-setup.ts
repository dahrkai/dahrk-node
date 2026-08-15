/**
 * runRepoSetup - make a stage worktree buildable before the agent starts (DHK-731).
 *
 * After the worktree is created and the `.claude/` overlay applied, but BEFORE the runner starts,
 * the node runs the repo's declared `setup` command inside the worktree so the agent inherits a
 * buildable tree (dependencies installed, generators run, ...). It runs the command as a node
 * subprocess with the node process's own privileges - it is provisioning the tree, not an
 * agent-driven action, so it is deliberately outside the agent-facing fs-confine policy (the pnpm
 * store the install writes to is already in the writable roots regardless). It is ASYNC because the
 * command can run for minutes and the node's heartbeat shares its event loop - see `spawnSetup`.
 *
 * Idempotency is per worktree: a sentinel file in the worktree's scratch dir records a digest of the
 * command that last succeeded. A reused worktree (re-dispatch / continuation) whose marker matches
 * the current command is NOT reinstalled; a fresh worktree has no marker and runs setup afresh. A
 * changed command invalidates the marker and re-runs. A failed setup leaves NO marker, so a retry
 * re-runs rather than trusting a half-built tree.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { detachedGroup, killProcessGroup } from "./process-group.js";

/** Minimal logger; defaults to a no-op so the library is quiet in tests. Mirrors GitLogger. */
export interface RepoSetupLogger {
  info(msg: string): void;
  warn(msg: string): void;
}
const noopLogger: RepoSetupLogger = { info: () => {}, warn: () => {} };

export interface RepoSetupOpts {
  /** Absolute path to the run's worktree; the command runs with this as its cwd. */
  worktreePath: string;
  /** The repo's declared setup command, run via `sh -c`. */
  command: string;
  /** Process env for the command; defaults to `process.env`. Brokered env is DHK-730, out of scope. */
  env?: NodeJS.ProcessEnv;
  /** Wall-clock cap on the setup subprocess; default 600s. A hung installer is killed, not left to wedge. */
  timeoutMs?: number;
  log?: RepoSetupLogger;
}

/**
 * Wall-clock milliseconds this call spent, on EVERY variant, because the interesting question is a
 * comparison: what a cold install costs against what the cached path costs.
 *
 * WHY IT IS RECORDED AT ALL (ADR 0019). Idempotency here is keyed on a marker in the WORKTREE. An edge
 * node is long-lived, so its worktrees and package stores persist and this is mostly `cached`. A managed
 * guest is torn down after a stage or group (ADR 0011), so every managed run gets a fresh worktree and
 * pays `ran` in full - a cost the 600s cap below implies is minutes, charged to every customer run
 * rather than to a few CI runs a week. ADR 0019 has to choose between a shared toolchain volume, baking
 * toolchains into the rootfs template, and doing nothing, and this number is what chooses. It was
 * explicitly left unmeasured there rather than guessed.
 */
export type RepoSetupResult =
  /** The marker for this exact command is already present; setup was not re-run. */
  | { status: "cached"; durationMs: number }
  /** Ran to a zero exit; the marker was written. `output` is the bounded combined stdout+stderr tail. */
  | { status: "ran"; durationMs: number; output: string }
  /** Non-zero exit, threw, or timed out; the marker was NOT written so a retry re-runs. */
  | { status: "failed"; durationMs: number; exitCode: number | null; output: string };

/** The engine-owned scratch dir, matching GitService's `SCRATCH_DIR`. Untracked, so the marker never
 *  enters a commit or the PR, and it survives a worktree reuse (createWorktree only `mkdir -p`s it). */
const SCRATCH_DIR = join(".dahrk", "scratch");
/** The idempotency sentinel: its content is the digest of the command that last succeeded here. */
const MARKER_NAME = ".setup-done";
/** Per-repo markers live here, under the run's SHARED scratch. */
const MARKER_DIR = "setup";
/** Default wall-clock cap on the setup subprocess (10 min): long enough for a cold install, bounded. */
const DEFAULT_TIMEOUT_MS = 600_000;
/** Cap the captured output folded into the trace so a chatty installer cannot bloat it (tail kept). */
const OUTPUT_CAP = 16_384;

/** A short, stable digest of the command; a change invalidates the marker so setup re-runs. */
function digest(command: string): string {
  return createHash("sha256").update(command).digest("hex").slice(0, 16);
}

/** Keep only the trailing `OUTPUT_CAP` bytes of captured output (the tail is where errors surface). */
function tail(output: string): string {
  return output.length > OUTPUT_CAP ? output.slice(output.length - OUTPUT_CAP) : output;
}

export async function runRepoSetup(opts: RepoSetupOpts): Promise<RepoSetupResult> {
  const { worktreePath, command } = opts;
  const log = opts.log ?? noopLogger;
  // Timed from the TOP, not from around the spawn: the marker read is part of what the cached path
  // costs, and a comparison between the two paths is the whole point (see RepoSetupResult).
  // `performance.now()` rather than `Date.now()` because it is monotonic - an NTP step mid-install
  // would otherwise be able to report a negative duration.
  const startedAt = performance.now();
  const elapsedMs = (): number => Math.round(performance.now() - startedAt);
  // Keyed by the repo's own directory name, because a run's repos now SHARE one scratch (DHK-358).
  // A single marker under the shared scratch would mean repo A's marker is repo B's, so repo B's
  // install would silently never run and the agent would get an uninstalled tree with no trace event
  // and no warning - reintroducing exactly the DHK-729/731 failure this marker exists to prevent.
  const markerPath = join(worktreePath, SCRATCH_DIR, MARKER_DIR, `${basename(worktreePath)}${MARKER_NAME}`);
  const want = digest(command);

  // Cached: the marker exists and records this exact command -> reuse the installed tree.
  if (existsSync(markerPath)) {
    try {
      if (readFileSync(markerPath, "utf8").trim() === want) {
        log.info(`repo setup: cached (marker matches), skipping`);
        return { status: "cached", durationMs: elapsedMs() };
      }
    } catch {
      // An unreadable marker is treated as absent: fall through and re-run.
    }
  }

  log.info(`repo setup: running \`${command}\``);
  const { exitCode, output, spawnError } = await spawnSetup(opts, command);

  // Clean exit (status 0, no spawn/timeout error): mark the tree installed. mkdir -p in case a fresh
  // worktree's scratch dir is not yet present (the stage runner creates it, but the helper must not
  // assume the order).
  if (exitCode === 0 && !spawnError) {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, want);
    const durationMs = elapsedMs();
    log.info(`repo setup: ran in ${durationMs}ms`);
    return { status: "ran", durationMs, output: tail(output) };
  }
  // A non-zero exit, a signal (timeout kill), or a spawn error. Never write the marker - a retry must
  // re-run rather than trust a half-built tree.
  log.warn(`repo setup failed (exit ${exitCode ?? "null"})`);
  return {
    status: "failed",
    durationMs: elapsedMs(),
    exitCode,
    output: tail(output || spawnError || ""),
  };
}

/**
 * Spawn the setup command and resolve once it has exited. Never rejects: a spawn failure is a returned
 * `spawnError`, because "setup did not run" is an ordinary outcome here, not an exception.
 *
 * ## Why `spawn`, not `spawnSync`
 *
 * This used to be `spawnSync`, justified as "setup runs before the runner, so blocking is fine". It is
 * not fine, and the cap on this very call says why: a setup command may run for `DEFAULT_TIMEOUT_MS`
 * (ten minutes), and the synchronous form blocks the event loop for the whole of it. The node's
 * WebSocket heartbeat lives on that loop, so a long install starved it and the socket went stale and
 * terminated - which the hub reads as a node that has stopped answering, mid-stage. `check-runner.ts`
 * reached the same conclusion for the same reason and its header documents it; `git-service.ts` did
 * too. This is the third and last of those shell paths.
 *
 * `detached` (via `detachedGroup`) makes the `sh` a group leader, so a setup command that backgrounded
 * something (`generator --watch &`) - or timed out mid-install - does not leak that child past setup:
 * it is signalled with the group rather than left orphaned on the operator's machine (DHK-1099).
 */
function spawnSetup(
  opts: RepoSetupOpts,
  command: string,
): Promise<{ exitCode: number | null; output: string; spawnError?: string }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let combined = "";
    let settled = false;

    const child = spawn("sh", ["-c", command], {
      cwd: opts.worktreePath,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      ...detachedGroup,
    });

    // Cap as we go rather than at the end, so a runaway installer cannot grow the buffer without
    // bound. Both streams append to one string, so the trace shows what the installer said IN ORDER -
    // which the synchronous form only claimed to do, having actually concatenated all of stdout then
    // all of stderr.
    const append = (buf: Buffer): void => {
      combined = tail(combined + buf.toString("utf8"));
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => {
      killProcessGroup(child);
    }, timeoutMs);

    const settle = (exitCode: number | null, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Reap the group on EVERY exit, including a clean one: a setup command that exited 0 having
      // backgrounded a watcher left it running, and it must not outlive setup. Best-effort - a
      // command that backgrounded nothing is a cheap no-op.
      killProcessGroup(child);
      resolve({ exitCode, output: combined, ...(spawnError ? { spawnError } : {}) });
    };

    // `error` fires when the spawn itself failed (no `sh`, bad cwd); no `close` follows it.
    child.on("error", (err: Error) => settle(null, err.message));
    // `close`, not `exit`: it waits for the captured streams to drain, so no output is lost.
    child.on("close", (code) => settle(code));
  });
}
