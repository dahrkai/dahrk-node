/**
 * createCheckRunner - the deterministic quality gate, as a `Runner`.
 *
 * A check stage names commands (lint, typecheck, test, a security scan, a formatter in `--check`
 * mode); the node runs each in the run's shared worktree and the EXIT CODE is the verdict. Nothing
 * infers, classifies or summarises the result, so "the tests pass" stops being an inference the way
 * it is when an agent stage is asked to police itself. That is the whole point: the determinism
 * boundary comes to cover verdicts, not just routing.
 *
 * ## Why a `Runner` rather than a special case in the stage runner
 *
 * Implementing the existing port means the stage wall clock, `cancel()`, the trace writer, progress
 * streaming to the hub, and `finish()` all work unmodified. `createMockRunner` is the precedent: a
 * complete, LLM-free `Runner`. The stage runner only has to choose this factory instead of
 * `makeRunner()`.
 *
 * ## Why `spawn`, not `execFileSync`
 *
 * The two existing shell paths on the node - `runRepoSetup` and the stage-exit hooks - are both
 * synchronous. That is tolerable for a dependency install at stage entry; it is NOT tolerable here. A
 * check stage runs `pnpm test`, which can take minutes, and `execFileSync` would block the event loop
 * for the whole of it: no WebSocket heartbeat (so the hub's lease reaper would consider this node
 * dead), no progress frames, no trace streaming, and every other run sharing this node stalled behind
 * it. So each check is an async `spawn` with streaming capture.
 *
 * ## Trust
 *
 * Commands come from the repo's declared config, resolved by the hub, and run with the node process's
 * own privileges outside the agent-facing fs-confine policy - identical treatment to
 * `RepositorySetup.command`, and for the same reason: repo-declared infrastructure, not agent-authored
 * input.
 *
 * They do NOT, however, get the repo's git credential, and that asymmetry is deliberate. The node
 * holds the brokered token only transiently, in the env of its own git operations; a check gets
 * `process.env` and no askpass helper. Widening that so a `git fetch` check could pass would hand a
 * token scoped (ADR 0003) to clone, push and open PRs to every command a repo can declare. So a check
 * that genuinely needs the credential is a node-native PROBE instead (`CheckProbe`, injected here as
 * `probes`): the node performs it, the check env stays credential-free.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type {
  CheckProbe,
  JobResult,
  ResolvedCheck,
  Runner,
  RunnerContext,
  StageVerification,
  TraceEvent,
} from "@dahrk/contracts";
import { detachedGroup, killProcessGroup } from "./process-group.js";

/** Default per-check wall clock, matching the setup step's own cap. */
const DEFAULT_TIMEOUT_MS = 600_000;
/** Captured output kept per check, matching `runRepoSetup`'s cap. The TAIL is kept: a failing
 *  compiler or test runner puts its summary last, and the first 16KiB of a verbose run is noise. */
const OUTPUT_CAP = 16_384;

/** One check's outcome: everything the note, the trace and the verification need. */
export interface CheckOutcome {
  name: string;
  command: string;
  /** `null` when the process was killed (timeout or stage cancel) rather than exiting on its own. */
  exitCode: number | null;
  /** Combined stdout+stderr, tail-capped to `OUTPUT_CAP`. */
  output: string;
  status: StageVerification["status"];
  durationMs: number;
  /** True when this check was killed by its own per-check wall clock. */
  timedOut: boolean;
}

/** What a node-native probe returns: the same four facts a spawned check yields. */
export interface ProbeOutcome {
  ok: boolean;
  output: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * The node-native probes this runner can perform, keyed by {@link CheckProbe}.
 *
 * Injected rather than imported so the runner keeps no dependency on the git service: a check runner
 * that reached for a worktree service would couple the deterministic gate to the git layer for the
 * sake of one probe. A missing entry is a failed check, not a crash (see `runProbe`).
 */
export type CheckProbes = Partial<Record<CheckProbe, (check: ResolvedCheck) => Promise<ProbeOutcome>>>;

/** Keep only the trailing `OUTPUT_CAP` bytes (the tail is where the failure is stated). */
function tail(output: string): string {
  return output.length > OUTPUT_CAP ? output.slice(output.length - OUTPUT_CAP) : output;
}

/**
 * Perform one node-native probe (a check the node runs itself, because it needs a credential a check
 * command cannot have - see `CheckProbe` in the contracts). Never rejects, for the same reason
 * `runOne` does not: the failure is the verdict.
 *
 * An unhandled probe name is a FAILED check naming the gap, never a silent fall-through to `command`:
 * for a credentialed probe that command cannot pass, so falling through would report a mystery auth
 * error instead of the real "this node does not implement this probe".
 */
async function runProbe(
  check: ResolvedCheck,
  probes: CheckProbes,
  startedAt: number,
): Promise<CheckOutcome> {
  const probe = check.probe!;
  const handler = probes[probe];
  const base = { name: check.name, command: check.command, timedOut: false };
  if (!handler) {
    return {
      ...base,
      exitCode: null,
      output: `check could not run: this node does not implement the "${probe}" probe`,
      status: "failed",
      durationMs: Date.now() - startedAt,
    };
  }
  try {
    const r = await handler(check);
    return {
      ...base,
      exitCode: r.exitCode,
      output: tail(r.output),
      status: r.ok ? "passed" : "failed",
      durationMs: Date.now() - startedAt,
      timedOut: r.timedOut,
    };
  } catch (err) {
    // A probe that throws is a failed check, not a crashed stage - identical treatment to a spawn
    // failure in `runOne`.
    return {
      ...base,
      exitCode: null,
      output: tail(`probe "${probe}" could not run: ${err instanceof Error ? err.message : String(err)}`),
      status: "failed",
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * Run one check to completion. Never rejects: a spawn failure, a non-zero exit and a timeout are all
 * ordinary outcomes of "did this check pass", not exceptions.
 */
async function runOne(
  check: ResolvedCheck,
  cwd: string,
  startedAt: number,
  register?: (child: ChildProcess | undefined) => void,
): Promise<CheckOutcome> {
  const timeoutMs = (check.timeoutSeconds ?? DEFAULT_TIMEOUT_MS / 1000) * 1000;
  return await new Promise<CheckOutcome>((resolve) => {
    let chunks = "";
    let timedOut = false;
    let settled = false;

    // `detached` so the command leads its own process group: a check that backgrounds a child
    // (`npm run dev &`, a watcher) can then be reaped by GROUP rather than leaking that grandchild past
    // the stage - killing only `sh` never reached it (DHK-1099). Registered with the runner so a
    // `cancel()` (wall clock, stage stop) can reap the in-flight group too, not just at the next check.
    const child = spawn("sh", ["-c", check.command], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      ...detachedGroup,
    });
    register?.(child);

    // Cap as we go rather than at the end, so a runaway command cannot grow the buffer without bound.
    const append = (buf: Buffer): void => {
      chunks = tail(chunks + buf.toString("utf8"));
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child);
    }, timeoutMs);

    const settle = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      register?.(undefined);
      // Reap the group on EVERY exit, including a clean one: a check that exited 0 having backgrounded a
      // server left that server running, and it must not outlive the stage. The leader is gone but its
      // group persists while a member lives, so `-pid` still reaches the survivor; a group with nothing
      // left throws `ESRCH`, which the helper swallows, so the ordinary no-background case is a no-op.
      killProcessGroup(child);
      resolve({
        name: check.name,
        command: check.command,
        exitCode,
        output: chunks,
        status: exitCode === 0 ? "passed" : "failed",
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    };

    child.on("close", (code) => settle(code));
    // A spawn failure (no `sh`, cwd gone) is a FAILED check, not a crashed stage: the run should learn
    // the check could not run, deterministically, rather than the node throwing mid-stage.
    child.on("error", (err) => {
      chunks = tail(`${chunks}\ncheck could not start: ${err.message}`);
      settle(null);
    });
  });
}

/** A deterministic one-line summary. No model writes this, which is why `summarise` can be free. */
export function summariseChecks(outcomes: readonly CheckOutcome[]): string {
  const failed = outcomes.filter((o) => o.status === "failed");
  const skipped = outcomes.filter((o) => o.status === "skipped");
  if (outcomes.length === 0) return "no checks declared";
  const suffix = skipped.length > 0 ? `; ${skipped.length} not run` : "";
  if (failed.length === 0) return `all ${outcomes.length} checks passed${suffix}`;
  return `${failed.length} of ${outcomes.length} checks failed: ${failed.map((o) => o.name).join(", ")}${suffix}`;
}

/**
 * A `Runner` that runs `checks` in order and reports each one.
 *
 * ALL of them run even after one fails, so a single loop-back carries every defect rather than one
 * per round-trip. Three sequential defects otherwise cost three full rebuild cycles against a finite
 * `maxLoops`, which trades cheap machine time for expensive agent time and wall clock - the wrong way
 * round.
 */
export function createCheckRunner(
  checks: readonly ResolvedCheck[],
  onOutcomes?: (outcomes: CheckOutcome[]) => void,
  probes: CheckProbes = {},
): Runner {
  let cancelled = false;
  let lastSummary = "";
  /** The check currently spawned, so `cancel()` can reap its process group at once rather than waiting
   *  for the next check boundary. Undefined between checks and once a check settles. */
  let currentChild: ChildProcess | undefined;

  return {
    // A check stage runs no agent, so claiming an agent runtime here would corrupt the trace record
    // the optimiser and the observability CLI both read.
    runtime: "check",

    async runBatch(ctx: RunnerContext, onTrace: (event: TraceEvent) => void): Promise<Omit<JobResult, "jobId" | "summary">> {
      const cwd = ctx.workspace.worktreePath;
      const outcomes: CheckOutcome[] = [];
      let seq = 0;

      for (const check of checks) {
        if (cancelled) {
          // The stage wall clock fired. Record the remainder honestly as not-run instead of silently
          // dropping them, so `verifications` always has one entry per declared check.
          outcomes.push({
            name: check.name,
            command: check.command,
            exitCode: null,
            output: "",
            status: "skipped",
            durationMs: 0,
            timedOut: false,
          });
          continue;
        }

        // `action` then `observation`, the pairing the trace and the hub's progress preview already
        // understand: the command line clips to the action preview, the output to the larger
        // observation cap. No change to `previewOf` is needed.
        onTrace({
          seq: seq++,
          runtime: "check",
          type: "action",
          ts: new Date().toISOString(),
          tool: "check",
          toolUseId: check.name,
          input: { name: check.name, command: check.command },
        });

        // A probe is performed by the node itself rather than spawned, because it needs a credential a
        // check command cannot have (see `CheckProbe`). Everything downstream - the trace pairing, the
        // verification, the summary - is identical either way.
        const outcome = check.probe
          ? await runProbe(check, probes, Date.now())
          : await runOne(check, cwd, Date.now(), (c) => {
              currentChild = c;
            });
        outcomes.push(outcome);

        onTrace({
          seq: seq++,
          runtime: "check",
          type: "observation",
          ts: new Date().toISOString(),
          toolUseId: check.name,
          isError: outcome.status === "failed",
          output: {
            name: outcome.name,
            exitCode: outcome.exitCode,
            timedOut: outcome.timedOut,
            durationMs: outcome.durationMs,
            output: outcome.output,
          },
        });
      }

      lastSummary = summariseChecks(outcomes);
      onTrace({
        seq: seq++,
        runtime: "check",
        type: "response",
        ts: new Date().toISOString(),
        text: lastSummary,
      });

      // Hand the full outcomes (with captured output) back to the stage runner, which owns writing the
      // worktree note. The note can be tens of kilobytes, so it belongs in the worktree rather than in
      // the JobResult that crosses the socket.
      onOutcomes?.(outcomes);

      const verifications: StageVerification[] = outcomes.map((o) => ({ name: o.name, status: o.status }));
      const anyFailed = outcomes.some((o) => o.status === "failed");
      return {
        status: cancelled ? "timeout" : anyFailed ? "fail" : "ok",
        verifications,
      };
    },

    async runInteractive(): Promise<Omit<JobResult, "jobId">> {
      // Unreachable by construction: the workflow schema makes `check` mutually exclusive with the
      // interaction fields, so a check stage cannot be authored as interactive.
      throw new Error("a check stage cannot be interactive");
    },

    /** Deterministic, and free: no model is asked to describe a lint run. */
    async summarise(): Promise<string> {
      return lastSummary || summariseChecks([]);
    },

    async cancel(): Promise<void> {
      // Stops the loop at the next check boundary AND reaps the in-flight check's process group now, so a
      // wall-clock or stage-stop cancel takes down the running command and anything it backgrounded
      // rather than leaving it to outlive the stage (DHK-1099). The killed child settles with a null exit
      // and the remaining checks record as skipped, so `verifications` still has one entry per check.
      cancelled = true;
      if (currentChild) killProcessGroup(currentChild);
    },
  };
}

/** Total cap on a check note, matching `ARTIFACT_CAP_BYTES`. When a run of verbose checks exceeds it,
 *  FAILING checks keep their output in full and passing ones collapse to a status line: the note exists
 *  to explain a failure, so passing noise is what should give way. */
const CHECK_NOTE_CAP_BYTES = 64 * 1024;

/** Make a stage id safe as a filename. A fan-out branch job's stageId is `<stageId>#<branchId>`. */
export const safeStageSegment = (stageId: string): string => stageId.replace(/[^A-Za-z0-9._-]/g, "-");

/** Render the note body. Pure, so it is unit-testable without a worktree. */
export function renderCheckNote(stageId: string, attempt: number, outcomes: readonly CheckOutcome[]): string {
  const failed = outcomes.filter((o) => o.status === "failed");
  const head =
    `# checks/${stageId} (attempt ${attempt}) - ${failed.length === 0 ? "PASSED" : "FAILED"}\n\n` +
    `${summariseChecks(outcomes)}\n`;

  // Failing checks first and in full: this note is read by an agent that has been looped back to fix
  // something, and the thing it must fix should not be below a screen of passing output.
  const ordered = [...outcomes].sort((a, b) => Number(b.status === "failed") - Number(a.status === "failed"));
  let body = "";
  let budget = CHECK_NOTE_CAP_BYTES - head.length;
  for (const o of ordered) {
    const verdict =
      o.status === "skipped"
        ? "not run (the stage was cancelled before it started)"
        : o.timedOut
          ? `TIMED OUT after ${Math.round(o.durationMs / 1000)}s`
          : `exit ${o.exitCode}`;
    const header = `\n## ${o.name} - ${o.status} (${verdict})\n\n$ ${o.command}\n`;
    const output = o.output.trim();
    // A passing check's output is dropped once the budget is tight; a failing one keeps it.
    const includeOutput = output.length > 0 && (o.status === "failed" || header.length + output.length < budget);
    const chunk = includeOutput ? `${header}\n\`\`\`\n${output}\n\`\`\`\n` : header;
    body += chunk;
    budget -= chunk.length;
  }
  return head + body;
}
