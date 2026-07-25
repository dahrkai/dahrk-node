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
 */
import { spawn } from "node:child_process";
import type { JobResult, ResolvedCheck, Runner, RunnerContext, StageVerification, TraceEvent } from "@dahrk/contracts";

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

/** Keep only the trailing `OUTPUT_CAP` bytes (the tail is where the failure is stated). */
function tail(output: string): string {
  return output.length > OUTPUT_CAP ? output.slice(output.length - OUTPUT_CAP) : output;
}

/**
 * Run one check to completion. Never rejects: a spawn failure, a non-zero exit and a timeout are all
 * ordinary outcomes of "did this check pass", not exceptions.
 */
async function runOne(check: ResolvedCheck, cwd: string, startedAt: number): Promise<CheckOutcome> {
  const timeoutMs = (check.timeoutSeconds ?? DEFAULT_TIMEOUT_MS / 1000) * 1000;
  return await new Promise<CheckOutcome>((resolve) => {
    let chunks = "";
    let timedOut = false;
    let settled = false;

    const child = spawn("sh", ["-c", check.command], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });

    // Cap as we go rather than at the end, so a runaway command cannot grow the buffer without bound.
    const append = (buf: Buffer): void => {
      chunks = tail(chunks + buf.toString("utf8"));
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const settle = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
): Runner {
  let cancelled = false;
  let lastSummary = "";

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

        const outcome = await runOne(check, cwd, Date.now());
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
      // Takes effect at the next check boundary; the in-flight child is bounded by its own per-check
      // wall clock. Documented rather than escalated because killing mid-check would report a
      // verdict for a command that never finished.
      cancelled = true;
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
