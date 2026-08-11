/**
 * @dahrk/executor-worktree - the Phase 1 executor (build spec sections 9-10).
 *
 * Three things:
 *  1. Runner adapters: thin wrappers over @anthropic-ai/claude-agent-sdk and
 *     @earendil-works/pi-coding-agent implementing the Runner interface from contracts. Added M4.
 *  2. GitService: VENDORED (copied) from cyrus - worktree create/teardown and
 *     base-branch resolution. Pure git/node logic. Added M3. cyrus-core helpers
 *     are replaced with our own.
 *  3. Trace producer: maps a runtime's native stream to the normalised TraceEvent
 *     envelope (the Claude adapter reuses cyrus's AgentSessionManager mapping), writes
 *     trace.jsonl + meta.json, spills large payloads to blobs/, optionally writes the
 *     raw/ sidecar, and maintains the latest pointer. Added M3 (S3 confirms).
 *
 * Net cyrus runtime dependency: zero npm packages. Only the vendored GitService.
 */
import type { Runner } from "@dahrk/contracts";
import { createMockRunner } from "./mock-runner.js";
import { createClaudeRunner } from "./claude-adapter.js";
import { createPiRunner } from "./pi-adapter.js";
import { createIsolatedPiRunner } from "./pi-container.js";

/** GitService - worktree lifecycle and base-branch resolution (M3). */
export {
  createGitService,
  sanitizeBranchName,
  parseOwnerRepo,
  resolveWorktreesDir,
  resolveMirrorsDir,
  ignoredPaths,
  FETCH_PROBE_TIMEOUT_SECONDS,
} from "./git-service.js";
/** Restart-safe collection of run worktrees (DHK-371). See `worktree-reaper.ts`. */
export { createWorktreeReaper } from "./worktree-reaper.js";
export type { ReapPolicy, ReapReport, ReapedWorktree, ReapReason } from "./worktree-reaper.js";
export type {
  GitService,
  GitServiceOptions,
  GitLogger,
  WorktreeSpec,
  CommitPushOpts,
  CommitPushResult,
  BackupPushOpts,
  BackupPushResult,
  FetchProbeOpts,
  FetchProbeResult,
} from "./git-service.js";

/** The pure footprint core: parse `git diff --numstat` and derive the blast-radius numbers (DHK-615). */
export { parseNumstat, deriveFootprint } from "./footprint.js";
export type { NumstatEntry, Numstat, DiffFootprint } from "./footprint.js";

/** The trace producer (M3). */
export { createTraceWriter } from "./trace-writer.js";
export type { TraceWriter } from "./trace-writer.js";

/** A push/close async queue, reused by the edge as the per-job turn mailbox (M5b). */
export { ManagedMailbox } from "./mailbox.js";

/** Component provisioning: the content-addressed cache and the overlay-into-worktree step. */
export { createPackCache, readManifestFiles } from "./pack-cache.js";
export type {
  PackCache,
  PackCacheOptions,
  PackSource,
  ComponentBytes,
  ComponentFile,
  MaterialiseResult,
} from "./pack-cache.js";
export { overlayComponents } from "./overlay.js";
export type { OverlayResult, OverlayOptions } from "./overlay.js";

/** The per-repo setup step: run the repo's declared `setup` command in the worktree before the
 *  agent starts, once per worktree (DHK-731). */
export { runRepoSetup } from "./repo-setup.js";
export type { RepoSetupOpts, RepoSetupResult, RepoSetupLogger } from "./repo-setup.js";

// Reap a node-owned subprocess and everything it backgrounded, by process group (DHK-1099), so a stage's
// backgrounded child cannot outlive the stage.
export { detachedGroup, killProcessGroup } from "./process-group.js";

export { createMockRunner } from "./mock-runner.js";

// The deterministic quality gate: named commands in the worktree, exit code as the verdict.
export { createCheckRunner, summariseChecks, renderCheckNote, safeStageSegment } from "./check-runner.js";
export type { CheckOutcome, CheckProbes, ProbeOutcome } from "./check-runner.js";

/** Whether a runner's session pre-blocks tool calls, so the edge can tell a blocked deny from a
 *  confinement escape by capability rather than runtime name (DHK-983). */
export type { PreExecutionCapability } from "./runtime-session.js";

/** The summary prefix a refused-credential stage failure carries, so the edge's latch can recognise
 *  one without re-deriving the classification.
 *
 *  `classifyRuntimeError` rides out with it because the edge's outer job catch needs the same reading:
 *  a throw from BEFORE the turn loop (resolving the brokered auth profile, preparing the worktree) is
 *  every bit as much a config gap as one from inside it, and shipping it unclassified left the hub to
 *  guess from the string - which is how a missing Anthropic credential came to be reported as an
 *  Anthropic outage. */
export { REFUSED_CREDENTIAL_SUMMARY, classifyRuntimeError } from "./turn-loop.js";

/** The real runner adapters (M4): thin wrappers over the Claude Agent SDK and Pi. */
export { createClaudeRunner, buildBrokeredMcpServers } from "./claude-adapter.js";
/** Which SDK each runtime executes through, resolved from the package that actually imports them. */
export { RUNTIME_SDK, canResolveSdk } from "./runtime-sdks.js";
/** The Pi runtime adapter: the model-agnostic runtime for the managed node. */
export { createPiRunner, PI_STAGE_COMPLETE_TOOL, buildBrokeredPiMcpServers, createBrokeredMcpExtension, assertSessionCapabilities, EMBEDDED_PI_CAPABILITIES } from "./pi-adapter.js";
export type { PiSessionLike, PiSessionCapabilities, PiSessionFactory, PiRunnerDeps, BrokeredPiMcpServer } from "./pi-adapter.js";
/** Container Pi session factory + isolated runner: Docker isolation seam. */
export { createContainerPiSession, createIsolatedPiRunner } from "./pi-container.js";
export type { ContainerPiSessionOpts } from "./pi-container.js";

// The brokered auth-profile hint (DHK-509/511). Exported because the edge's stage runner threads it
// from the Job onto the RunnerContext, so both ends of that seam name the same type.
export type { PiAuthHint, ProviderHint, ApiKeyProviderHint, OAuthProviderHint } from "./pi-auth.js";

/**
 * Construct the runner for a runtime. Defaults to the real adapters; `DAHRK_RUNNER=mock`
 * selects the deterministic, credential-free mock (set by the offline hub harness so its
 * scenarios stay green without Claude/Pi auth).
 *
 * Stage isolation is the node boundary, not a per-stage container — see
 * `docs/adr/0002-stage-isolation-is-the-node-boundary.md`. The `DAHRK_PI_ISOLATION=container`
 * flag is an internal escape hatch for meta-loop Pi stages only; see `piContainerIsolationRequired`.
 */
export function makeRunner(runtime: Runner["runtime"]): Runner {
  if ((process.env.DAHRK_RUNNER ?? "real") === "mock") return createMockRunner(runtime);
  if (runtime === "pi") return piContainerIsolationRequired() ? createIsolatedPiRunner() : createPiRunner();
  if (runtime === "claude-code") return createClaudeRunner();
  // Anything else - `codex`, still in the wire enum pending its harness-side removal (DHK-510), or a
  // runtime a newer hub knows and this client does not - fails loudly. This used to fall through to
  // the Claude runner, so a `codex` stage silently ran on Claude and reported success: the run went
  // green on a runtime nobody chose, which is strictly worse than not running.
  throw new Error(
    `unsupported runtime "${runtime}": this node runs claude-code and pi. ` +
      "Migrate a codex stage to `runtime: pi` with a GPT model (DHK-503), or upgrade the node.",
  );
}

/**
 * INTERNAL — UNSUPPORTED — PI-ONLY — IMAGELESS.
 *
 * Reads `DAHRK_PI_ISOLATION=container` to activate the container Pi path. This flag is not a
 * self-hoster feature: it is scoped to telemetry-only meta-loop Pi stages, the image it names
 * (`dahrk/pi:latest`) is not built in this repository, and it has never run against a real Docker
 * daemon in production. `claude-code` stages are unaffected regardless of this flag — there is no
 * equivalent container path for that runtime (see ADR 0002).
 *
 * See `docs/adr/0002-stage-isolation-is-the-node-boundary.md` for the full rationale.
 */
function piContainerIsolationRequired(): boolean {
  return process.env.DAHRK_PI_ISOLATION === "container";
}
