/**
 * runRepoSetup - make a stage worktree buildable before the agent starts (DHK-731).
 *
 * After the worktree is created and the `.claude/` overlay applied, but BEFORE the runner starts,
 * the node runs the repo's declared `setup` command inside the worktree so the agent inherits a
 * buildable tree (dependencies installed, generators run, ...). It runs the command as a node
 * subprocess with the node process's own privileges - it is provisioning the tree, not an
 * agent-driven action, so it is deliberately outside the agent-facing fs-confine policy (the pnpm
 * store the install writes to is already in the writable roots regardless).
 *
 * Idempotency is per worktree: a sentinel file in the worktree's scratch dir records a digest of the
 * command that last succeeded. A reused worktree (re-dispatch / continuation) whose marker matches
 * the current command is NOT reinstalled; a fresh worktree has no marker and runs setup afresh. A
 * changed command invalidates the marker and re-runs. A failed setup leaves NO marker, so a retry
 * re-runs rather than trusting a half-built tree.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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

export type RepoSetupResult =
  /** The marker for this exact command is already present; setup was not re-run. */
  | { status: "cached" }
  /** Ran to a zero exit; the marker was written. `output` is the bounded combined stdout+stderr tail. */
  | { status: "ran"; output: string }
  /** Non-zero exit, threw, or timed out; the marker was NOT written so a retry re-runs. */
  | { status: "failed"; exitCode: number | null; output: string };

/** The engine-owned scratch dir, matching GitService's `SCRATCH_DIR`. Untracked, so the marker never
 *  enters a commit or the PR, and it survives a worktree reuse (createWorktree only `mkdir -p`s it). */
const SCRATCH_DIR = join(".dahrk", "scratch");
/** The idempotency sentinel: its content is the digest of the command that last succeeded here. */
const MARKER_NAME = ".setup-done";
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

export function runRepoSetup(opts: RepoSetupOpts): RepoSetupResult {
  const { worktreePath, command } = opts;
  const log = opts.log ?? noopLogger;
  const markerPath = join(worktreePath, SCRATCH_DIR, MARKER_NAME);
  const want = digest(command);

  // Cached: the marker exists and records this exact command -> reuse the installed tree.
  if (existsSync(markerPath)) {
    try {
      if (readFileSync(markerPath, "utf8").trim() === want) {
        log.info(`repo setup: cached (marker matches), skipping`);
        return { status: "cached" };
      }
    } catch {
      // An unreadable marker is treated as absent: fall through and re-run.
    }
  }

  log.info(`repo setup: running \`${command}\``);
  try {
    const stdout = execFileSync("sh", ["-c", command], {
      cwd: worktreePath,
      env: opts.env ?? process.env,
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      encoding: "utf8",
      // Fold stderr into stdout so the captured trace shows what the installer said, in order.
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Only on a clean exit do we mark the tree installed. mkdir -p in case a fresh worktree's scratch
    // dir is not yet present (the stage runner creates it, but the helper must not assume the order).
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, want);
    return { status: "ran", output: tail(stdout ?? "") };
  } catch (e) {
    // execFileSync throws on a non-zero exit, a signal (timeout kill), or a spawn error. Never write
    // the marker - a retry must re-run rather than trust a half-built tree.
    const err = e as { status?: number | null; stdout?: Buffer | string; stderr?: Buffer | string };
    const combined = `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}` || (e as Error).message;
    log.warn(`repo setup failed (exit ${err.status ?? "null"})`);
    return { status: "failed", exitCode: err.status ?? null, output: tail(combined) };
  }
}
