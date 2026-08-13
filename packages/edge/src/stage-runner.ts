/**
 * The stage runner: maps one Job to one runner invocation in a real git worktree,
 * streams progress, writes the normalised trace, evaluates policy around tool
 * actions and at stage entry, runs the R4 stage-exit hooks, and reports a result
 * keyed by jobId. No LLM here - control flow is the engine's; inference (M4) lives
 * inside the Runner. The worktree is created once per run and reused (sticky owner).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ElicitChoice,
  ElicitQuestion,
  FailureClass,
  HumanTurn,
  JobProgress,
  JobRequest,
  JobResult,
  JobStatus,
  PushJob,
  PushResult,
  AgentConfig,
  ResolvedCheck,
  Runner,
  RunnerContext,
  Runtime,
  StageVerification,
  TraceEvent,
  TraceMeta,
  TraceRuntime,
  WorkspaceRef,
} from "@dahrk/contracts";
import type { PolicyOutcome } from "@dahrk/contracts";
import { attachedDocBasename, isCheckJob } from "@dahrk/contracts";
import {
  createCheckRunner,
  renderCheckNote,
  safeStageSegment,
  createTraceWriter,
  createWorktreeReaper,
  detachedGroup,
  killProcessGroup,
  ManagedMailbox,
  overlayComponents,
  resolveMirrorsDir,
  runRepoSetup,
  type GitService,
  type PackCache,
  type CheckOutcome,
  type CheckProbes,
  type ProbeOutcome,
  type PreExecutionCapability,
  type ReapReport,
} from "@dahrk/executor-worktree";
import { credentialLatch, type CredentialLatch } from "./credential-latch.js";
import { probeRuntimeStatuses } from "./detect-runtimes.js";
import { buildRules } from "./builtins.js";
import { computeFsRoots, isUnder } from "./fs-roots.js";
import { createNodeLogger, type NodeLogger } from "./logger.js";
import { evaluatePolicies, type PolicyRule } from "./policy.js";
import { startMcpGateway, type McpGateway } from "./mcp-gateway.js";
import { resolveBackupOutcome, resolveDeliverOutcome, type PushMode } from "./push-outcome.js";

/** Arguments for requesting a presigned upload of a heavy trace payload. */
export interface BlobPutRequestArgs {
  tenantId: string;
  runId: string;
  stageId: string;
  attempt: number;
  sha256: string;
  size: number;
  contentType?: string;
  slot: "blob" | "archive";
}

/** The observability trace sink: stream events to the hub as the stage runs, upload heavy
 *  payloads via hub-minted presigned URLs, and finalise at stage exit. Implemented by the
 *  WebSocket client; absent in tests (the stage still runs and writes its local trace). */
export interface TraceSink {
  event(frame: {
    runId: string;
    stageId: string;
    attempt: number;
    tenantId: string;
    event: TraceEvent;
  }): void;
  finalised(frame: {
    runId: string;
    stageId: string;
    attempt: number;
    tenantId: string;
    meta: TraceMeta;
    eventCount: number;
    archiveKey?: string;
  }): void;
  /** Ask the hub for a presigned PUT (url absent = skip the upload: dedupe or no storage). */
  requestBlobUrl(req: BlobPutRequestArgs): Promise<{ key: string; url?: string }>;
}

export interface StageRunnerDeps {
  gitService: GitService;
  makeRunner: (runtime: Runtime) => Runner;
  /** Builds the deterministic check runner. Injectable so a test can substitute one; defaults to the
   *  real `createCheckRunner`. Separate from `makeRunner` because that switches on a vendor agent
   *  runtime and has no access to the Job's resolved checks. */
  makeCheckRunner?: (
    checks: readonly ResolvedCheck[],
    onOutcomes?: (o: CheckOutcome[]) => void,
    probes?: CheckProbes,
  ) => Runner;
  /** The node's logger. Absent (tests, embedders) = a silent logger, so the runner stays quiet by
   *  default. Used to surface the best-effort paths below, which used to fail invisibly. */
  /** Probe which agent runtimes are executable here, for the `runtime-detect` check. Injected so a
   *  test never has to touch `node_modules` to make a runtime look present or absent; defaults to the
   *  node's own `probeRuntimeStatuses`, which is the same code path that decides what this node
   *  advertises - so the check cannot answer differently from a real dispatch. */
  probeRuntimes?: typeof probeRuntimeStatuses;
  logger?: NodeLogger;
  /** Optional self-hosted allowlist of registry repoIds this edge will serve. Empty/absent
   *  = serve any repo (clone on demand). A Job for a repoId outside a non-empty allowlist is
   *  rejected. This is a binding, not a definition: the repo itself comes from the Job's gitUrl. */
  servesRepoIds?: string[];
  /** The tenant this node is bound to. A managed node is configured with its tenant; when set,
   *  a Job for another tenant is refused as defence in depth (the hub's `nodeCanServe` guard should have
   *  prevented the dispatch). Absent = a legacy ambient edge with no tenant binding, so no guard. */
  tenantId?: string;
  /** Composed policy rules (M3: the demo deny rule; M6 adds the builtins). */
  rules: readonly PolicyRule[];
  /** Stream a progress frame to the hub. */
  sendProgress: (progress: JobProgress) => void;
  /** Raise a Linear `select` elicitation for a mid-interactive-stage `AskUserQuestion` (DHK-344): the
   *  edge emits an `elicit` wire frame the hub turns into an elicitation, and the human's pick rides a
   *  `turn` frame back to the blocked tool. Best-effort like `sendProgress`; absent in tests. */
  sendElicit?: (frame: { jobId: string; prompt: string; options: ElicitChoice[]; multiSelect?: boolean }) => void;
  /** Component provisioning: the content-addressed cache the overlay materialises pinned
   *  skills/commands/agents through. Absent = provisioning disabled (no overlay; existing behaviour). */
  packCache?: PackCache;
  /** Ship the normalised trace to the hub for observability (best-effort; omitted = local-only). */
  trace?: TraceSink;
  /** Worktree retention. Safe because finished runs' traces are streamed durably to the
   *  hub, so pruning the local worktree loses nothing observable. Omitted = keep all. */
  retention?: RetentionPolicy;
  /** Base directory for telemetry-only runs: a Job with no `workspaceRef` runs each stage in
   *  a scratch dir under `<scratchRoot>/<runId>` with NO git clone. Git-service still owns the *worktree*
   *  layout; this is only the no-clone scratch base. Defaults to `<tmpdir>/dahrk/scratch`. */
  scratchRoot?: string;
  /** This node's refused-credential memory, fed with every stage outcome. Defaults to the process-wide
   *  latch the re-detect pass reads, so the two halves agree; injected in tests so a stage never
   *  mutates process state that another test can observe. */
  latch?: CredentialLatch;
}

/** How many recent runs' worktrees to keep on the edge, and/or how old they may get. */
export interface RetentionPolicy {
  /** Keep at most this many runs' worktrees (the newest by last use). */
  maxRuns?: number;
  /** Tear down a run's worktree once it has been idle this long (ms). */
  maxAgeMs?: number;
}

/** Where a worktree-browse request for a run resolves its paths (DHK-1104). */
export interface BrowseRoot {
  /** The directory a browse path is relative to. For a run laid out the current way this is the RUN
   *  directory, one level above each repository, which is what lets a multi-repo run list its
   *  repositories side by side at `path: ""`. */
  root: string;
  /** The run's worktrees as paths relative to `root`, primary first. A single-repo run laid out the
   *  legacy flat way (the worktree IS the run directory) yields one entry whose `dir` is `""`. */
  repos: { dir: string; worktreePath: string }[];
}

export interface StageRunner {
  runJob(job: JobRequest): Promise<JobResult>;
  /**
   * Collect worktrees no longer needed by any run: broken ones (their branch ref was deleted under them,
   * so they are unusable AND go on claiming their branch name), idle ones, and anything over the count
   * cap. Restart-safe: reconciles on-disk and git-registered state, not process-local memory. Called at
   * boot (which is what reclaims a leaked disk) and after each stage. Never touches a busy run.
   */
  reapWorktrees(): Promise<ReapReport>;
  /** True while a run is executing a stage on this node. Consulted by the git service before evicting a
   *  stale worktree that still claims a branch, so a live run is never stomped. */
  isBusy(runId: string): boolean;
  /** Commit the run's worktree changes and push its branch (the `open-pr` action's git side). Uses
   *  the run's sticky worktree so the just-run stages' diff is present. No inference. */
  runPush(job: PushJob): Promise<PushResult>;
  /** Cancel an in-flight Job's runner (the Linear `stop` signal, relayed by the hub). */
  cancel(jobId: string): void;
  /** Tear down a finished run's worktree and drop its sticky state on a hub `run-finished` frame
   *  (DHK-1047), so the run stops counting as live and its disk is freed at once rather than waiting
   *  for the count cap. Idempotent and unordered-safe: a no-op for an unknown run, an already-torn-down
   *  run, or one with a job still in flight (`isBusy` wins). */
  finishRun(runId: string): Promise<void>;
  /** Where to resolve a worktree-browse request for a run, or undefined when this node does not hold
   *  the run (DHK-1104). Deliberately reads the same map as `isLive`, so a run parked at a human gate
   *  answers: that is the case browsing exists for, and it is exactly when no job is in flight. */
  browseRoot(runId: string): BrowseRoot | undefined;
  /** Feed a human turn to an in-flight interactive stage (relayed `prompted` text; M5b). */
  enqueueTurn(jobId: string, turn: HumanTurn): void;
  /** Close an interactive stage's turn stream (the human signed off -> its gate exit; M5b). */
  endTurns(jobId: string): void;
}

const nowIso = (): string => new Date().toISOString();
const PREVIEW = 500;
/** Tool results (`observation` output) get a far larger cap than the noisy PREVIEW kinds: the hub folds
 *  a result into its action's `result` field (DHK-385), so it is user-facing content that must survive
 *  whole in practice, not be clipped mid-content at 500 chars (DHK-384). Bounded to keep pathological
 *  outputs (a whole-repo grep, a large file read) off the control socket; the full-fidelity output is
 *  still preserved in the trace archive via the `outputRef` spill. */
const RESULT = 16_000;

type PolicyAwareRunnerContext = RunnerContext & {
  authorizeToolUse?: (toolName: string, input: unknown) => PolicyOutcome;
  /** Surface an interactive-stage `AskUserQuestion` as a Linear `select` elicitation (DHK-344). */
  emitElicit?: (question: ElicitQuestion) => void;
  /** The runtime received a message from its provider (DHK-1136). Called by the adapter once per
   *  native message, BEFORE normalisation, so it fires for records that map to no trace event at all
   *  (`system`, `stream_event`, `rate_limit_event`). That is the whole point: it is the only honest
   *  liveness signal, and the normalised trace stream is not one. Carried on the local extended shape
   *  since `@dahrk/contracts` does not declare it yet - the same defensive idiom as `injectedSkillPaths`
   *  above. Purely a watchdog reset: it must never write to the trace or the progress stream. */
  onLive?: () => void;
};

/** Upload bytes to a hub-minted presigned URL (heavy trace payloads bypass the control socket). */
const putBytes = async (url: string, body: Buffer, contentType: string): Promise<void> => {
  await fetch(url, { method: "PUT", headers: { "content-type": contentType }, body: new Uint8Array(body) });
};

/** The text an edge sends to the hub for a progress frame, so the hub can post a Linear activity
 *  without reading this edge's trace files. Intermediate steps (thoughts, tool inputs/outputs,
 *  errors) are a bounded PREVIEW: they are noisy and only need to be glanceable. The final
 *  `response` and a gate `elicitation` prompt are the agent's user-facing output that a human reads
 *  in full, so they are sent whole and NOT clipped (matching the engine summary, posted unbounded).
 *
 *  `action` and `observation` also carry their `toolUseId` (DHK-384), so the hub can pair a tool call
 *  with its result by id rather than by adjacency, which breaks when parallel/deferred tools interleave
 *  (e.g. `ToolSearch`). Observation output uses the larger RESULT cap so a folded result is not lost
 *  mid-content. `toolUseId` is additive on the wire: `JobProgress` in the published `@dahrk/contracts`
 *  predates the field, so it rides through the plain-JSON transport untyped until the contract is
 *  republished (the same forward-compat pattern the push-mode and footprint fields used before
 *  `@dahrk/contracts` 0.6.0/0.7.0 declared them). */
/**
 * The `runtime-detect` probe: are all of `wanted` executable on this node?
 *
 * Answered by the node's OWN detection, the same function that decides which runtimes it advertises to
 * the hub, so the check cannot disagree with a real dispatch. That matters because the thing it
 * replaces, `command -v claude`, disagreed by construction: neither runtime is a PATH binary (the
 * Claude adapter calls `query()` from a vendored SDK, the Pi adapter runs `createAgentSession()`
 * in-process), so the command measured something uncorrelated with the ability to run the stage.
 *
 * Asserts `capable` (the SDK resolves from here), NOT `available`. `available` also folds in the
 * credential latch - a refusal the node happens to remember until it restarts - and a REQUIRED
 * onboarding check that a stale memory can fail is the DHK-464 shape all over again. Whether a
 * credential authenticates is answered by the run itself.
 *
 * An empty `wanted` passes: it is how a tenant with nothing to assert emits a check that passes,
 * rather than every caller carrying a special case.
 */
async function runtimeDetectProbe(
  wanted: readonly Runtime[],
  probe: typeof probeRuntimeStatuses = probeRuntimeStatuses,
): Promise<ProbeOutcome> {
  if (wanted.length === 0) {
    return { ok: true, output: "no runtime asserted for this node", exitCode: 0, timedOut: false };
  }
  const statuses = await probe();
  const byRuntime = new Map(statuses.map((s) => [s.runtime, s]));
  const lines = wanted.map((r) => {
    const s = byRuntime.get(r);
    // A runtime this build has never heard of is missing, not fine. A newer hub can name one, and
    // "absent from my own detection" is exactly the honest answer.
    if (!s) return { runtime: r, capable: false, detail: "this node does not know this runtime" };
    return { runtime: r, capable: s.capable, detail: s.detail };
  });
  const missing = lines.filter((l) => !l.capable);
  return {
    ok: missing.length === 0,
    output: lines.map((l) => `${l.runtime}: ${l.capable ? "executable" : "NOT executable"} (${l.detail})`).join("\n"),
    exitCode: missing.length === 0 ? 0 : 1,
    timedOut: false,
  };
}

function previewOf(event: TraceEvent): { text?: string; tool?: string; toolUseId?: string } {
  const clip = (v: unknown, max = PREVIEW): string =>
    (typeof v === "string" ? v : JSON.stringify(v) ?? "").slice(0, max);
  switch (event.type) {
    case "response":
      return event.text !== undefined ? { text: event.text } : {};
    case "elicitation":
      return { text: event.prompt };
    case "thought":
      return event.text !== undefined ? { text: clip(event.text) } : {};
    case "action":
      return {
        tool: event.tool,
        toolUseId: event.toolUseId,
        ...(event.input !== undefined ? { text: clip(event.input) } : {}),
      };
    case "observation":
      return {
        toolUseId: event.toolUseId,
        ...(event.output !== undefined ? { text: clip(event.output, RESULT) } : {}),
      };
    case "error":
      return { text: clip(event.message) };
    default:
      return {};
  }
}
const attemptOf = (jobId: string): number => {
  const m = /-(\d+)$/.exec(jobId);
  return m ? Number(m[1]) : 1;
};
const digest = (value: unknown): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)}`;

/** Merge this stage's progress into the engine-owned scratch state.json. */
function writeScratchState(
  ref: WorkspaceRef,
  job: JobRequest,
  attempt: number,
  status: string,
  worktrees: readonly WorkspaceRef[] = [],
): void {
  const statePath = join(ref.scratchPath, "state.json");
  let state: {
    runId: string;
    tenantId: string;
    stages: Record<string, unknown>;
    repos?: Array<{ repo: string; repoId: string; path: string; branch?: string; baseBranch: string }>;
  };
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    state = { runId: job.runId, tenantId: job.tenantId, stages: {} };
  }
  // The run's repo set (DHK-251), so an agent can discover its siblings on disk as well as in the
  // prompt, and so it survives a stage boundary. Only written for a genuinely multi-repo run, keeping
  // `state.json` byte-identical for the single-repo runs that are still the norm.
  if (worktrees.length > 1) {
    state.repos = worktrees.map((w) => ({
      repo: w.repo,
      repoId: w.repoId,
      // Relative to the primary, which is the agent's working directory - the form it would type.
      path: w.worktreePath === ref.worktreePath ? "." : `../${basename(w.worktreePath)}`,
      ...(w.branch ? { branch: w.branch } : {}),
      baseBranch: w.baseBranch,
    }));
  }
  state.stages[job.stageId] = { currentAttempt: attempt, status };
  mkdirSync(ref.scratchPath, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/** Persist the run's Linear ticket brief into the worktree scratch (idempotent), so a stage can
 *  re-read it as well as receiving it inline. Best-effort; the agent also gets it in its prompt. */
function writeIssueContext(ref: WorkspaceRef, issueContext: string | undefined): void {
  if (issueContext === undefined) return;
  try {
    mkdirSync(ref.scratchPath, { recursive: true });
    writeFileSync(join(ref.scratchPath, "issue.md"), issueContext);
  } catch {
    /* best-effort; the brief still reaches the agent via the stage prompt */
  }
}

/** Persist each attached Linear document's full body into `.dahrk/scratch/docs/<slug>.md`, so the
 *  agent can read the complete text even when the prompt only inlines a capped excerpt. Best-effort;
 *  the slug is sanitised so a malformed value cannot escape the docs directory. */
function writeAttachedDocuments(ref: WorkspaceRef, docs: JobRequest["attachedDocuments"]): void {
  if (!docs || docs.length === 0) return;
  try {
    const dir = join(ref.scratchPath, "docs");
    mkdirSync(dir, { recursive: true });
    for (const doc of docs) {
      writeFileSync(join(dir, `${attachedDocBasename(doc)}.md`), doc.content);
    }
  } catch {
    /* best-effort; a capped excerpt still reaches the agent via the stage prompt */
  }
}

/** Render the issue's comment thread as readable markdown for the scratch file: one section per
 *  comment, oldest first, headed by author and timestamp. The prompt inlines only the most recent few
 *  thousand characters, so this file is where an agent reads the parts that were truncated away. */
function renderCommentsMarkdown(comments: NonNullable<JobRequest["comments"]>): string {
  const blocks = comments.map((c) => {
    const who = c.author.trim() || "unknown";
    const when = c.createdAt ? ` - ${c.createdAt}` : "";
    return `## ${who}${when}\n\n${c.body.trim()}\n`;
  });
  return `# Issue comments\n\n${blocks.join("\n")}`;
}

/** Persist the issue's comment thread into `.dahrk/scratch/comments.md`. Best-effort, mirroring
 *  `writeGuidance`. This is the complete thread; the prompt's `<comments>` block is a capped tail of it. */
function writeComments(ref: WorkspaceRef, comments: JobRequest["comments"]): void {
  if (!comments || comments.length === 0) return;
  try {
    mkdirSync(ref.scratchPath, { recursive: true });
    writeFileSync(join(ref.scratchPath, "comments.md"), renderCommentsMarkdown(comments));
  } catch {
    /* best-effort; a capped excerpt still reaches the agent via the stage prompt */
  }
}

/** Render the one-hop issue manifest as a readable markdown table for the scratch file. Metadata only
 *  (no bodies), matching the prompt's `<related>` block - this is its on-disk companion. */
function renderRelatedMarkdown(related: NonNullable<JobRequest["relatedIssues"]>): string {
  const rows = related.map(
    (r) => `| ${r.relation} | ${r.key} | ${r.title.replace(/\|/g, "\\|")} | ${r.stateName} | ${r.url} |`,
  );
  return [
    "# Related issues",
    "",
    "| Relation | Key | Title | State | URL |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

/** Persist the one-hop issue manifest into `.dahrk/scratch/related.md`. Best-effort, mirroring
 *  `writeGuidance`. */
function writeRelatedIssues(ref: WorkspaceRef, related: JobRequest["relatedIssues"]): void {
  if (!related || related.length === 0) return;
  try {
    mkdirSync(ref.scratchPath, { recursive: true });
    writeFileSync(join(ref.scratchPath, "related.md"), renderRelatedMarkdown(related));
  } catch {
    /* best-effort; the manifest still reaches the agent via the stage prompt */
  }
}

/** Render the run's Linear guidance into a readable markdown block for the scratch file, one
 *  bulleted rule per line annotated with its origin/team. Shared shape with the prompt's `<guidance>`
 *  block (the runner builds the prompt form); this is the on-disk companion. */
function renderGuidanceMarkdown(guidance: NonNullable<JobRequest["guidance"]>): string {
  const lines = guidance.map((rule) => {
    const scope = rule.teamName ? `${rule.origin}: ${rule.teamName}` : rule.origin;
    return `- (${scope}) ${rule.content.trim()}`;
  });
  return `# Workspace guidance\n\n${lines.join("\n")}\n`;
}

/** Persist the run's workspace/team guidance into `.dahrk/scratch/guidance.md`, so a stage
 *  can re-read it as well as receiving it inline in the prompt. Best-effort, mirroring `writeIssueContext`. */
function writeGuidance(ref: WorkspaceRef, guidance: JobRequest["guidance"]): void {
  if (!guidance || guidance.length === 0) return;
  try {
    mkdirSync(ref.scratchPath, { recursive: true });
    writeFileSync(join(ref.scratchPath, "guidance.md"), renderGuidanceMarkdown(guidance));
  } catch {
    /* best-effort; the guidance still reaches the agent via the stage prompt */
  }
}

/**
 * Write the check note into the shared worktree: the durable, full-fidelity record of what each check
 * ran and what it printed.
 *
 * Attempt-scoped (`<stageId>-<attempt>.md`), mirroring the trace writer. A bare `<stageId>.md` would
 * let attempt 2 clobber attempt 1, destroying the evidence from the failure that caused the loop.
 *
 * Written on success as well as failure, so "did this run and pass" is answerable from the worktree.
 * `.dahrk/scratch` is in the worktree-local git excludes, so `deliver` never commits it.
 */
function writeCheckNote(
  ref: WorkspaceRef,
  stageId: string,
  attempt: number,
  outcomes: readonly CheckOutcome[],
): void {
  if (outcomes.length === 0) return;
  try {
    const dir = join(ref.scratchPath, "checks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${safeStageSegment(stageId)}-${attempt}.md`), renderCheckNote(stageId, attempt, outcomes));
  } catch {
    /* best-effort, like every other scratch writer: the verdict still reaches the engine on the result */
  }
}

/** Largest artifact body returned on a JobResult; a feasibility report fits comfortably and this caps
 *  the WebSocket frame. Larger files are truncated (the agent should keep the deliverable concise). */
const ARTIFACT_CAP_BYTES = 64 * 1024;

/** Worktree-relative directory workflows conventionally write deliverables to (mirrors the prompt
 *  guidance in the sample workflows). Scanned as a fallback when the declared path did not resolve. */
const SCRATCH_OUTPUT_DIR = ".dahrk/scratch/output";

function capContent(raw: string): string {
  return raw.length > ARTIFACT_CAP_BYTES ? raw.slice(0, ARTIFACT_CAP_BYTES) : raw;
}

function resolveWorktreeRelativePath(ref: WorkspaceRef, relPath: string): string | undefined {
  if (isAbsolute(relPath)) return undefined;
  const root = resolve(ref.worktreePath);
  const target = resolve(root, relPath);
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    return undefined;
  }
  return target;
}

function isSafeWorktreeRelativePath(ref: WorkspaceRef, relPath: string): boolean {
  return resolveWorktreeRelativePath(ref, relPath) !== undefined;
}

/** Read the file a stage declared via `emitArtifact` (worktree-relative) so a later `attach-document`
 *  action can publish it to Linear. Best-effort: a missing/unreadable file returns undefined and the
 *  action surfaces the absence. Reading is data assembly, not control flow. */
function readEmittedArtifact(ref: WorkspaceRef, relPath: string): { path: string; content: string } | undefined {
  const path = resolveWorktreeRelativePath(ref, relPath);
  if (!path) return undefined;
  try {
    const raw = readFileSync(path, "utf8");
    return { path: relPath, content: capContent(raw) };
  } catch {
    return undefined;
  }
}

/** Fallback: a markdown deliverable under the scratch output dir, preferring one whose basename
 *  matches the declared path (the agent may have written a differently-named file to the right dir). */
function scanScratchOutput(ref: WorkspaceRef, preferRel?: string): { path: string; content: string } | undefined {
  const preferBase = preferRel?.split("/").pop();
  try {
    const names = readdirSync(join(ref.worktreePath, SCRATCH_OUTPUT_DIR)).filter((n) =>
      n.toLowerCase().endsWith(".md"),
    );
    if (names.length === 0) return undefined;
    const pick = (preferBase && names.includes(preferBase) ? preferBase : names[0]) as string;
    const raw = readFileSync(join(ref.worktreePath, SCRATCH_OUTPUT_DIR, pick), "utf8");
    if (raw.trim().length === 0) return undefined;
    return { path: `${SCRATCH_OUTPUT_DIR}/${pick}`, content: capContent(raw) };
  } catch {
    return undefined;
  }
}

/** Last-resort fallback: any new or modified markdown file in the worktree (the agent wrote the
 *  deliverable somewhere entirely different). Best-effort and clearly labelled at the call site, since
 *  it can pick a file that was never intended as the document. */
function scanChangedMarkdown(ref: WorkspaceRef): { path: string; content: string } | undefined {
  const git = (args: string[]): string[] => {
    try {
      return execFileSync("git", ["-C", ref.worktreePath, ...args], { encoding: "utf8" })
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  const rels = [...git(["ls-files", "--others", "--exclude-standard"]), ...git(["diff", "--name-only"])].filter(
    (p) => p.toLowerCase().endsWith(".md"),
  );
  for (const rel of rels) {
    try {
      const raw = readFileSync(join(ref.worktreePath, rel), "utf8");
      if (raw.trim().length > 0) return { path: rel, content: capContent(raw) };
    } catch {
      /* skip unreadable (e.g. staged-then-deleted) entries */
    }
  }
  return undefined;
}

/** Resolve a stage's deliverable document from the first channel that yields content, so a later
 *  `attach-document` publishes it however the prompt author produced it. Precedence: the declared
 *  `emitArtifact` file, then a document handed back through `dahrk_stage_complete` (the in-band
 *  channel, e.g. when the stage wrote no file), then a scan of the scratch output dir, then any
 *  changed markdown. Only invoked when the stage signalled it intends a document (declared a path, or
 *  handed one back), so ordinary code/build stages are never scanned. Read-only data assembly - never
 *  control flow. */
export function resolveStageArtifact(
  ref: WorkspaceRef,
  emitArtifact: string | undefined,
  handedBack: { path: string; content: string } | undefined,
): { artifact: { path: string; content: string }; source: string } | undefined {
  if (emitArtifact) {
    const declared = readEmittedArtifact(ref, emitArtifact);
    if (declared && declared.content.trim().length > 0) return { artifact: declared, source: "declared-file" };
  }
  if (handedBack && handedBack.content.trim().length > 0 && isSafeWorktreeRelativePath(ref, handedBack.path)) {
    return { artifact: { path: handedBack.path, content: capContent(handedBack.content) }, source: "tool-handoff" };
  }
  const scratch = scanScratchOutput(ref, emitArtifact);
  if (scratch) return { artifact: scratch, source: "scratch-scan" };
  const changed = scanChangedMarkdown(ref);
  if (changed) return { artifact: changed, source: "changed-file" };
  return undefined;
}

/**
 * Whether a runtime consumes brokered MCP servers through the node-local gateway proxy, and so needs
 * the gateway started for a stage that declares them (DHK-507). True for Claude (SDK-native MCP) and
 * Pi (its extension bridge, `createBrokeredMcpExtension`); false for Codex, whose SDK has no MCP - a
 * proxy for it would be dead weight. Pure + exported so the gate is unit-testable without standing up
 * the whole stage runner (`startMcpGateway` binds a real socket).
 */
export function runtimeUsesMcpGateway(runtime: Runner["runtime"]): boolean {
  return runtime === "claude-code" || runtime === "pi";
}

export function createStageRunner(deps: StageRunnerDeps): StageRunner {
  /** runId -> the run's PRIMARY worktree. Every existing reader wants this one: it is the agent's
   *  working directory, the repo a check stage runs in, and the repo `deliver` reports on. */
  const worktrees = new Map<string, WorkspaceRef>();
  /** runId -> the run's SIBLING worktrees (DHK-251/DHK-358), in the order the hub resolved them. Kept
   *  beside `worktrees` rather than widening it, so the many readers that legitimately want only the
   *  primary are untouched and only the handful that must see the whole set reach for this. */
  const runSiblings = new Map<string, WorkspaceRef[]>();
  /** Every worktree of a run, primary first. The order matters: `[0]` is the cwd and the identity. */
  const allWorktrees = (runId: string): WorkspaceRef[] => {
    const primary = worktrees.get(runId);
    return primary ? [primary, ...(runSiblings.get(runId) ?? [])] : [];
  };
  /** Silent by default so an embedder (and every existing test) sees no new output. */
  const log = deps.logger ?? createNodeLogger({ level: "silent" });
  /** Defaults to the process-wide latch, which is what the re-detect pass reads. */
  const latch = deps.latch ?? credentialLatch;
  /** In-flight runners by jobId, so a `cancel` frame can abort the right one. */
  const active = new Map<string, Runner>();
  /** Per-job turn mailboxes for in-flight interactive stages (fed by relayed turns; M5b). */
  const turnQueues = new Map<string, ManagedMailbox<HumanTurn>>();
  /** Run-scoped tool-call tallies for max_tool_calls (sticky, like the worktree). */
  const runToolCalls = new Map<string, { count: number }>();
  /** Last-use epoch ms per run, for recency-based retention. */
  const lastUsed = new Map<string, number>();
  /** Count of in-flight jobs per run, so retention never tears down a busy worktree. */
  const inFlight = new Map<string, number>();

  /** True while a run is executing a stage on THIS node. The reaper and the stale-claim eviction in
   *  `createWorktree` both consult it, so a live run is never collected or stomped. */
  const isBusy = (runId: string): boolean => (inFlight.get(runId) ?? 0) > 0;
  /** True while this node still holds a run's worktree and has not seen the run finish (DHK-1045).
   *  Strictly weaker than `isBusy`, and that gap is the whole point: between two stages, and for the
   *  entire length of a human gate, a run has no job in flight yet its worktree is exactly what the
   *  eventual deliver pushes from. The map is only emptied by `teardownRun`, so a process restart
   *  correctly reports nothing live and hands the whole disk back to the reaper. */
  const isLive = (runId: string): boolean => worktrees.has(runId);
  const reaperDryRun = process.env.DAHRK_REAPER_DRY_RUN === "1";
  const reaper = createWorktreeReaper({
    worktreesDir: deps.gitService.worktreesDir,
    mirrorsDir: resolveMirrorsDir(),
    isBusy,
    isLive,
    logger: { info: (m) => console.log(`REAPER ${m}`), warn: (m) => console.warn(`REAPER ${m}`) },
  });
  /** Runs whose workspace is a telemetry-only scratch dir, not a git worktree, so teardown
   *  removes the directory directly rather than calling `git worktree remove` (which would fail). */
  const scratchOnly = new Set<string>();

  /** Tear down a finished run's worktree and drop its sticky state. */
  const teardownRun = async (runId: string): Promise<void> => {
    const ref = worktrees.get(runId);
    if (ref) {
      if (scratchOnly.has(runId)) {
        try {
          rmSync(ref.worktreePath, { recursive: true, force: true });
        } catch (e) {
          /* best-effort; a leftover scratch dir loses nothing observable (traces are streamed) - but a
             disk that keeps failing to clear them eventually fills, so say so. */
          log.warn({ err: e, runId, path: ref.worktreePath }, "teardown: could not remove scratch dir");
        }
      } else {
        // EVERY worktree of the run, not just the primary. One left behind holds both disk and its
        // branch name, which then wedges the next run of the same issue.
        for (const w of allWorktrees(runId)) {
          await deps.gitService.teardownWorktree(w).catch((e: unknown) => {
            // Silent failure here is how a node slowly gums up.
            log.warn({ err: e, runId, path: w.worktreePath }, "teardown: could not remove worktree");
          });
        }
        // Then the run directory itself, which takes the shared scratch with it. Removing only the
        // worktrees would leak the shell and the scratch for ever - indistinguishable from DHK-371.
        try {
          rmSync(dirname(ref.worktreePath), { recursive: true, force: true });
        } catch (e) {
          log.warn({ err: e, runId }, "teardown: could not remove the run directory");
        }
      }
    }
    worktrees.delete(runId);
    runSiblings.delete(runId);
    scratchOnly.delete(runId);
    lastUsed.delete(runId);
    runToolCalls.delete(runId);
  };

  /**
   * Collect worktrees that are no longer needed. Two layers, deliberately:
   *
   *  1. The REAPER, which reconciles what is on disk and what git has registered. It is the load-bearing
   *     one, because it is restart-safe: the in-memory maps below are empty after a process restart, so
   *     anything a previous process created was previously orphaned for ever (that is how one node
   *     reached 92 worktrees and 65 GB, DHK-371). It also runs with real DEFAULTS - "no retention policy
   *     configured" used to mean "never collect anything", which is not a safe default for a disk.
   *  2. The original in-memory LRU, kept for the telemetry-only scratch runs the reaper does not own.
   *
   * Never collects the run we just used, nor any run with an in-flight job. Best-effort throughout:
   * a failure to tidy up must never fail a stage.
   */
  const applyRetention = async (keepRunId: string): Promise<void> => {
    const policy = deps.retention;
    await reaper
      .reap({
        ...(policy?.maxRuns !== undefined ? { maxRuns: policy.maxRuns } : {}),
        ...(policy?.maxAgeMs !== undefined ? { maxIdleMs: policy.maxAgeMs } : {}),
        ...(reaperDryRun ? { dryRun: true } : {}),
      })
      .catch(() => undefined);
    if (!policy) return;
    const prunable = (id: string): boolean => id !== keepRunId && (inFlight.get(id) ?? 0) === 0;
    const now = Date.now();
    if (policy.maxAgeMs !== undefined) {
      for (const id of [...worktrees.keys()]) {
        // Same rule as the reaper (DHK-1045): age is not evidence that a run is over, so a run this
        // node still holds a worktree for is never collected for being old. Every entry in `worktrees`
        // is live by that definition today, which makes this branch inert until something tells the
        // edge a run has finished - the `run-finished` frame. That is the honest state of affairs, not
        // a shorter timer: the count cap below is what bounds the disk in the meantime.
        if (!isLive(id) && prunable(id) && now - (lastUsed.get(id) ?? 0) > policy.maxAgeMs) await teardownRun(id);
      }
    }
    if (policy.maxRuns !== undefined && worktrees.size > policy.maxRuns) {
      const byOldest = [...worktrees.keys()]
        .filter(prunable)
        .sort((a, b) => (lastUsed.get(a) ?? 0) - (lastUsed.get(b) ?? 0));
      let excess = worktrees.size - policy.maxRuns;
      for (const id of byOldest) {
        if (excess <= 0) break;
        await teardownRun(id);
        excess--;
      }
    }
  };

  return {
    isBusy,

    browseRoot(runId) {
      const refs = allWorktrees(runId);
      // A telemetry-only run has a scratch directory, not a worktree; there is nothing to browse and
      // saying so is not the same as an empty listing.
      if (refs.length === 0 || scratchOnly.has(runId)) return undefined;
      const primary = refs[0]!;
      // Composed from the worktrees dir and the runId rather than taken as `dirname(primary)`. For a
      // legacy flat layout the parent of the worktree is the worktrees dir itself, and rooting a
      // browse there would expose every run on this node to a request naming any one of them.
      const runDir = join(deps.gitService.worktreesDir, runId);
      // `isUnder` admits the root itself, so the legacy flat case (worktree === runDir) falls through
      // here and yields a single repo whose `dir` is "" - the same shape, no special case.
      if (!refs.every((r) => isUnder(runDir, r.worktreePath))) {
        return { root: primary.worktreePath, repos: [{ dir: "", worktreePath: primary.worktreePath }] };
      }
      return {
        root: runDir,
        repos: refs.map((r) => ({ dir: relative(runDir, r.worktreePath), worktreePath: r.worktreePath })),
      };
    },

    async reapWorktrees() {
      return reaper.reap(reaperDryRun ? { dryRun: true } : {});
    },

    async runJob(job) {
      const { stageId, jobId, runId } = job;
      // A check job carries no `agentConfig` (no runtime, model or prompt). Everything that reads it
      // below is agent-only and guarded; `traceRuntime` is what the trace record shows either way.
      const isCheck = isCheckJob(job);
      const agentConfig = job.agentConfig;
      const traceRuntime: TraceRuntime = isCheck ? "check" : agentConfig!.runtime;
      const attempt = attemptOf(jobId);

      // Defence in depth: a tenant-bound node refuses a Job for another tenant. The hub's
      // `nodeCanServe` tenant guard should have kept this Job off this node, so reaching here is a
      // routing bug; fail closed rather than run a foreign tenant's stage. Absent binding = a legacy
      // ambient edge, which keeps its untenanted behaviour.
      if (deps.tenantId && job.tenantId !== deps.tenantId) {
        return {
          jobId,
          status: "fail",
          summary: `node (tenant "${deps.tenantId}") refuses a job for tenant "${job.tenantId}"`,
        };
      }

      // Honour the optional self-hosted allowlist: refuse a repo this edge did not opt into. A
      // non-empty allowlist that excludes the Job's repoId fails the stage with a clear message
      // (the hub should not have dispatched it; this is the edge-side guard). A telemetry-only run
      // carries no repo, so the allowlist does not apply.
      const allow = deps.servesRepoIds;
      if (job.workspaceRef && allow && allow.length > 0 && !allow.includes(job.workspaceRef.repoId)) {
        return { jobId, status: "fail", summary: `edge does not serve repo "${job.workspaceRef.repoId}"` };
      }

      inFlight.set(runId, (inFlight.get(runId) ?? 0) + 1);
      // Wrapped so EVERY exit path releases the marker. Previously the decrement sat inside `finish`,
      // which a throw before it (e.g. `createWorktree` failing) skipped entirely, leaving the run
      // marked busy for ever and hiding it from every reaper pass keyed on `isBusy` (DHK-371).
      try {
        lastUsed.set(runId, Date.now());

        // Workspace once per run (sticky owner; reused on re-dispatch and across stages).
        // - Customer-repo run: build a git worktree, cloning on demand from the Job's gitUrl - no
        //   pre-cloned local repo needed.
        // - Telemetry-only run: no `workspaceRef`, so synthesise a scratch-only workspace under
        //   `<scratchRoot>/<runId>` with NO git clone. The empty repo fields mark it repo-free; every
        //   downstream reader uses the resolved `ref`, not `job.workspaceRef`.
        let ref = worktrees.get(runId);
        if (!ref) {
          if (job.workspaceRef) {
            // The run's whole repo set, primary first.
            const extras = job.extraWorkspaces ?? [];
            const specOf = (ws: WorkspaceRef) => ({
              repoId: ws.repoId,
              gitUrl: ws.gitUrl,
              baseBranch: ws.baseBranch,
              runId,
              repo: ws.repo,
              // Stable per-issue branch (continuation); absent = legacy dahrk/<runId>.
              ...(ws.branch ? { branch: ws.branch } : {}),
              // Re-enter from work a prior backup push preserved, rather than starting over from the base
              // (DHK-264). Carried on the contract but never plumbed through to the git service until now.
              ...((ws as { seedRef?: string }).seedRef ? { seedRef: (ws as { seedRef?: string }).seedRef } : {}),
              // The git credential the hub minted for this job, per repo.
              ...(ws.credentialToken ? { credentialToken: ws.credentialToken } : {}),
            });
            // All-or-nothing: a half-provisioned workspace would let the agent produce a change that
            // looks complete and is not.
            const refs = await deps.gitService.createWorktrees([
              specOf(job.workspaceRef),
              ...extras.map(specOf),
            ]);
            ref = refs[0]!;
            if (refs.length > 1) runSiblings.set(runId, refs.slice(1));
          } else {
            const base = deps.scratchRoot ?? join(tmpdir(), "dahrk", "scratch");
            const worktreePath = join(base, runId);
            const scratchPath = join(worktreePath, ".dahrk", "scratch");
            mkdirSync(scratchPath, { recursive: true });
            ref = { repoId: "", gitUrl: "", repo: "", baseBranch: "", worktreePath, scratchPath };
            scratchOnly.add(runId);
          }
          worktrees.set(runId, ref);
        }
        writeScratchState(ref, job, attempt, "in-flight", allWorktrees(runId));
        writeIssueContext(ref, job.issueContext);
        writeGuidance(ref, job.guidance);
        writeAttachedDocuments(ref, job.attachedDocuments);
        writeComments(ref, job.comments);
        writeRelatedIssues(ref, job.relatedIssues);
        // Pre-create the parent of a declared output artifact so the agent's relative write succeeds
        // even if it does not mkdir first.
        if (agentConfig?.emitArtifact) {
          const artifactDir = resolveWorktreeRelativePath(ref, agentConfig.emitArtifact);
          const slash = agentConfig.emitArtifact.lastIndexOf("/");
          if (artifactDir && slash > 0) {
            try {
              mkdirSync(join(ref.worktreePath, agentConfig.emitArtifact.slice(0, slash)), { recursive: true });
            } catch {
              /* best-effort; the agent can still create the directory itself */
            }
          }
        }

        // Per-stage MCP gateway proxy: holds this job's brokered MCP creds and injects them on
        // outbound calls so the agent never sees them. Started below (Claude only) and stopped in
        // `finish`, so minted tokens are discarded with the stage. Declared here so `finish` closes over it.
        let gateway: McpGateway | undefined;

        const meta: TraceMeta = {
          tenantId: job.tenantId,
          runId,
          stageId,
          jobId,
          attempt,
          runtime: traceRuntime,
          model: agentConfig?.model,
          sessionId: job.sessionId,
          configDigest: digest(isCheck ? job.checks : agentConfig),
          startedAt: nowIso(),
        };
        const writer = createTraceWriter(ref.scratchPath, meta);
        // Stream every written event to the hub as it is appended (the live, full-fidelity
        // corpus). The event carries its writer-assigned seq, so the hub persists the
        // identical record and can detect gaps. Best-effort; a missing sink is local-only.
        const streamEvent = (e: TraceEvent): void =>
          deps.trace?.event({ runId, stageId, attempt, tenantId: job.tenantId, event: e });
        streamEvent(
          writer.append({ seq: 0, ts: nowIso(), type: "state", runtime: traceRuntime, event: "attempt-start" }),
        );

        // At stage exit: upload heavy spilled blobs + the finalised trace.jsonl archive to
        // object storage (via hub-minted presigned URLs), then send the authoritative meta.
        const shipFinalTrace = async (finalMeta: TraceMeta): Promise<void> => {
          const sink = deps.trace;
          if (!sink) return;
          const base = { tenantId: job.tenantId, runId, stageId, attempt };
          try {
            for (const name of readdirSync(join(writer.dir, "blobs"))) {
              const bytes = readFileSync(join(writer.dir, "blobs", name));
              const { url } = await sink.requestBlobUrl({
                ...base, sha256: name, size: bytes.length, contentType: "application/octet-stream", slot: "blob",
              });
              if (url) await putBytes(url, bytes, "application/octet-stream");
            }
          } catch {
            /* best-effort; the streamed events are already persisted */
          }
          let archiveKey: string | undefined;
          try {
            const bytes = readFileSync(join(writer.dir, "trace.jsonl"));
            const sha = createHash("sha256").update(bytes).digest("hex");
            const { key, url } = await sink.requestBlobUrl({
              ...base, sha256: sha, size: bytes.length, contentType: "application/x-ndjson", slot: "archive",
            });
            if (url) await putBytes(url, bytes, "application/x-ndjson");
            archiveKey = key;
          } catch {
            /* best-effort */
          }
          sink.finalised({ ...base, meta: finalMeta, eventCount: writer.count(), ...(archiveKey ? { archiveKey } : {}) });
        };

        const finish = async (
          status: JobStatus,
          summary: string,
          sessionId?: string,
          costUsd?: number,
          handedBackDoc?: { path: string; content: string },
          failureClass?: FailureClass,
          verifications?: StageVerification[],
        ): Promise<JobResult> => {
          active.delete(jobId);
          turnQueues.delete(jobId);
          // Feed this node's refused-credential latch (DHK-998), so a refused credential stops the
          // node advertising a runtime it cannot run instead of burning one run per attempt at $0.
          // Unconditional: which outcomes speak to a credential is the latch's judgement, not this
          // function's, so there is no branch here to get wrong.
          latch.record({ ...(agentConfig ? { runtime: agentConfig.runtime } : {}), status, summary, isCheck });
          // discard brokered MCP creds with the stage. A gateway that will not stop is holding a port
          // and, worse, live brokered credentials - never let that pass unremarked.
          await gateway?.stop().catch((e: unknown) => log.warn({ err: e, jobId }, "mcp gateway: stop failed"));
          gateway = undefined;
          streamEvent(
            writer.append({ seq: 0, ts: nowIso(), type: "state", runtime: traceRuntime, event: "stage-exit", status }),
          );
          const endedAt = nowIso();
          writer.finalise({ status, endedAt, ...(sessionId ? { sessionId } : {}) });
          writeScratchState(ref!, job, attempt, status);
          const finalMeta: TraceMeta = {
            ...meta, status, endedAt,
            ...(sessionId ? { sessionId } : {}),
            ...(costUsd !== undefined ? { costUsd } : {}),
          };
          // The single most important best-effort path on the node. If this fails the hub ends up with
          // no finalised trace for the stage - the entire forensic record of what the agent did - and
          // until now nobody found out. It stays non-fatal (the stage result still goes back), but it is
          // logged at error: a run whose trace is missing hub-side has its explanation right here.
          await shipFinalTrace(finalMeta).catch((e: unknown) =>
            log.error({ err: e, runId, stageId: job.stageId, jobId, attempt }, "trace: failed to ship the final trace to the hub"),
          );
          lastUsed.set(runId, Date.now());
          // NB the `inFlight` decrement is NOT here: `finish` is not reached when the job throws before it
          // (e.g. `createWorktree` failing on a stale branch claim), which left the run marked busy for ever
          // and made it invisible to every reaper pass keyed on `isBusy` - exactly the runs that most needed
          // collecting. It now lives in the `finally` of `runJob`, which every exit path goes through.
          await applyRetention(runId).catch((e: unknown) => log.warn({ err: e, runId }, "retention: pass failed"));
          // When the stage intends a document (declared an `emitArtifact` path, or handed one back via
          // `dahrk_stage_complete`) and succeeded, resolve it from whichever channel produced content
          // so the engine can publish it (e.g. the `attach-document` action). Read-only; a miss returns
          // undefined and the action surfaces the absence. Ordinary code/build stages are not scanned.
          // DHK-1053: measure the worktree against base so the deliver gate can quantify the change it
          // asks a human to approve. It has to happen HERE, per stage, because the gate opens before
          // the push - the only thing that had ever measured a diff - and because stage output sits
          // uncommitted until deliver. Every stage shares the worktree, so each probe supersedes the
          // last rather than adding to it. Best-effort by construction (`probeFootprint` swallows its
          // own failures and returns undefined): a measurement is a nicety, and must never be able to
          // fail an otherwise-ok stage.
          // A telemetry-only run's `ref` is a bare scratch dir with no git repo and an empty base, so
          // probing it could only ever fail; skip it rather than warn once per stage for nothing.
          // The `typeof` guard is not ceremony either: `finish` is the ONLY path that returns the
          // stage's result, so anything that throws here loses the whole stage, trace and all. A git
          // service predating this method must degrade to "no measurement", not take the result too.
          // One probe per repo (DHK-251). "Each probe supersedes the last" still holds PER REPO - that
          // was always about stages sharing a worktree - but a run's repos are independent
          // measurements, so summing or overwriting across them would both be wrong.
          const probeable =
            ref && !scratchOnly.has(runId) && typeof deps.gitService.probeFootprint === "function"
              ? allWorktrees(runId)
              : [];
          const perRepo = probeable.flatMap((w) => {
            const fp = deps.gitService.probeFootprint!(w, { base: w.baseBranch });
            return fp ? [{ repoId: w.repoId, repo: w.repo, ...fp }] : [];
          });
          // `footprint` stays the PRIMARY's and stays exactly where it was on the wire, so a hub that
          // has not shipped its half reads precisely what it reads today.
          const footprint = perRepo.find((f) => f.repoId === ref?.repoId);
          const footprints = perRepo.length > 1 ? perRepo : undefined;
          const wantsArtifact = agentConfig?.emitArtifact !== undefined || handedBackDoc !== undefined;
          const resolved =
            status === "ok" && wantsArtifact
              ? resolveStageArtifact(ref!, agentConfig?.emitArtifact, handedBackDoc)
              : undefined;
          if (status === "ok" && wantsArtifact) {
            const detail = resolved
              ? `source=${resolved.source} path=${resolved.artifact.path} bytes=${resolved.artifact.content.length}`
              : "no document resolved (declared path, tool handoff, and scratch/changed-file scans all empty)";
            streamEvent(
              writer.append({ seq: 0, ts: nowIso(), type: "state", runtime: traceRuntime, event: "artifact", detail }),
            );
          }
          return {
            jobId,
            status,
            summary,
            ...(sessionId ? { sessionId } : {}),
            ...(costUsd !== undefined ? { costUsd } : {}),
            ...(resolved ? { artifact: resolved.artifact } : {}),
            ...(failureClass ? { failureClass } : {}),
            // DHK-666: `JobResult.verifications` shipped with a contract, a projection fold, a Card
            // renderer and tests - but this object never forwarded it, which is the entire reason the
            // field has had no producer. Forwarded for EVERY stage, not just check jobs, so a hook or
            // an agent-run gate can populate it too.
            ...(verifications?.length ? { verifications } : {}),
            ...(footprint ? { footprint } : {}),
            // Per-repo footprints for a multi-repo run, so the hub can tell which repos actually
            // changed and therefore which deserve a pull request. Absent at N=1, where `footprint`
            // already says everything there is to say.
            ...(footprints ? { footprints } : {}),
          };
        };

        // Component provisioning: project the run's pinned skills/commands/agents into the worktree
        // before the runner starts, normalised per runtime (Claude writes `.claude/` files with
        // repo-local precedence; Pi injects skills by path, reshapes commands into `.pi/prompts/`, and
        // warns on subagents; Codex warns and skips). Idempotent, so re-dispatch on the sticky worktree
        // is safe. Fail closed: a missing pinned component is a correctness problem, not cosmetic, so a
        // materialise/overlay error fails the stage rather than running without it. Hoisted so the
        // injected-by-path skill dirs reach the runner ctx below (the Pi adapter's only channel to them).
        let overlayResult: Awaited<ReturnType<typeof overlayComponents>> | undefined;
        if (deps.packCache && job.provision && job.provision.length > 0) {
          try {
            const overlay = await overlayComponents({
              worktreePath: ref.worktreePath,
              runtime: agentConfig!.runtime,
              components: job.provision,
              cache: deps.packCache,
            });
            overlayResult = overlay;
            const detail = `provision: ${overlay.written.length} written, ${overlay.injected.length} injected, ${overlay.skippedRepoLocal.length} repo-local, ${overlay.warnings.length} warning(s)`;
            streamEvent(
              writer.append({ seq: 0, ts: nowIso(), type: "state", runtime: traceRuntime, event: "provision", detail }),
            );
            // Surface the summary (and any warnings) to the hub so the overlay is observable.
            const noteText = overlay.warnings.length > 0 ? `${detail}; ${overlay.warnings.join("; ")}` : detail;
            deps.sendProgress({ jobId, kind: "observation", ts: nowIso(), text: noteText });
          } catch (e) {
            const msg = `component provisioning failed: ${(e as Error).message}`;
            writer.append({ seq: 0, ts: nowIso(), type: "error", runtime: traceRuntime, kind: "provision-failed", message: msg });
            deps.sendProgress({ jobId, kind: "error", ts: nowIso(), text: msg });
            return finish("fail", `${stageId}: ${msg}`, job.sessionId);
          }
        }

        // Per-repo setup step (DHK-731): make the worktree buildable BEFORE the runner starts. The
        // repo declares a `setup` command (carried on the Job by DHK-729); the node runs it in the
        // worktree so the agent inherits installed dependencies rather than being handed a bare
        // checkout it must install itself. Read the field defensively - it is not in the pinned
        // `@dahrk/contracts` (^0.6.0) yet, the same idiom as `runtimeAuth`/`seedRef` above; drop the
        // cast once contracts ships `setup`. Absent `setup` -> a no-op, so no new trace events and no
        // behaviour change. Runs once per worktree: `runRepoSetup` caches on a scratch-dir marker, so a
        // continuation / re-dispatch onto the sticky worktree does not reinstall.
        // DHK-729/731 was DEAD IN PRODUCTION until this line was fixed. The hub attaches the resolved
        // setup step at `workspaceRef.setup` (intake.ts), and `@dahrk/contracts` declares it there - but
        // this read was `(job as { setup?: ... }).setup`, i.e. the Job ROOT, where nothing ever sets it.
        // `undefined?.command` is merely falsy, so setup silently never ran: no trace event, no warning.
        // The `as` cast is what hid it, defeating the compiler on exactly the seam it exists to guard,
        // and the node's own test set `setup` at the root too, so the bug was invisible to CI.
        //
        // On a multi-repo run this is PER REPO, in order, primary first: each repo declares its own
        // setup on its own `WorkspaceRef`, and a library usually has to be installed before the
        // consumer that imports it. The marker `runRepoSetup` caches on is keyed by the repo directory,
        // so one repo's install can no longer mark another's as done.
        const setupTargets: Array<{ worktreePath: string; command: string; repo: string }> = ref
          ? [
              ...(job.workspaceRef?.setup?.command
                ? [{ worktreePath: ref.worktreePath, command: job.workspaceRef.setup.command, repo: job.workspaceRef.repo }]
                : []),
              ...(runSiblings.get(runId) ?? []).flatMap((w, i) => {
                const cmd = (job.extraWorkspaces ?? [])[i]?.setup?.command;
                return cmd ? [{ worktreePath: w.worktreePath, command: cmd, repo: w.repo }] : [];
              }),
            ]
          : [];
        for (const target of setupTargets) {
          const outcome = runRepoSetup({ worktreePath: target.worktreePath, command: target.command });
          if (outcome.status === "failed") {
            // Fail closed BEFORE the runner is constructed, so the agent never touches a broken tree.
            // A distinct `setup-failed` kind + `harness` failureClass make it a clean, attributable
            // pre-agent provisioning failure, mirroring the provision-failed path above.
            const msg = `repo setup for ${target.repo} failed (exit ${outcome.exitCode ?? "null"})`;
            const detail = outcome.output ? `${msg}: ${outcome.output}` : msg;
            writer.append({ seq: 0, ts: nowIso(), type: "error", runtime: traceRuntime, kind: "setup-failed", message: detail });
            deps.sendProgress({ jobId, kind: "error", ts: nowIso(), text: detail });
            return finish("fail", `${stageId}: ${msg}`, job.sessionId, undefined, undefined, "harness");
          }
          // Fold the outcome into the trace so setup's stdout/exit are observable (acceptance).
          //
          // The DURATION rides the detail string deliberately. It is the number ADR 0019 needs to choose
          // between a shared toolchain volume, baking toolchains into the rootfs template, and doing
          // nothing, and a managed guest pays the uncached cost on EVERY run (its worktree, and so the
          // marker, dies with the guest). Putting it in the free-text detail means it is queryable from
          // the stage trace today, without waiting on a contracts change - the `event: "setup"` cast
          // below is already evidence of how long that wait can be.
          const detail =
            outcome.status === "cached"
              ? `setup(${target.repo}): cached (already installed) in ${outcome.durationMs}ms`
              : `setup(${target.repo}): ran (exit 0, ${outcome.output.length} bytes) in ${outcome.durationMs}ms`;
          // `event: "setup"` is not in the pinned `@dahrk/contracts` (^0.6.0) state-event union yet,
          // so cast the frame the same way the Job fields above are read defensively; drop the cast
          // once contracts ships the value. The error `kind` below needs no cast (it is an open string).
          streamEvent(
            writer.append({ seq: 0, ts: nowIso(), type: "state", runtime: traceRuntime, event: "setup", detail } as unknown as TraceEvent),
          );
          if (outcome.status === "ran") {
            deps.sendProgress({ jobId, kind: "observation", ts: nowIso(), text: outcome.output || detail });
          }
        }

        // Compose this Job's policies (workflow+stage builtins the engine threaded) with the
        // edge's demo rules. The run-scoped counter is shared across the run's stages.
        let counter = runToolCalls.get(runId);
        if (!counter) {
          counter = { count: 0 };
          runToolCalls.set(runId, counter);
        }
        const jobRules = buildRules(job.policies ?? [], {
          worktreePath: ref.worktreePath,
          repoName: job.workspaceRef?.repo ?? "",
          runToolCalls: counter,
          // DHK-392: the stage is confined to the run's worktree (plus its scratch dir, the git object
          // store it depends on, and the toolchain). A node default, not a workflow policy. A run with
          // no repo still gets a box - just a smaller one, around its scratch dir.
          fsRoots: computeFsRoots({
            worktreePath: ref.worktreePath,
            // Every sibling repo is a writable root of its own, so the agent can read and change them
            // (DHK-358). Their parent run directory deliberately is NOT a root.
            extraWorktreePaths: (runSiblings.get(runId) ?? []).map((w) => w.worktreePath),
            scratchPath: ref.scratchPath,
          }),
        });
        const rules = [...jobRules, ...deps.rules];

        // Policy at stage entry.
        const entry = evaluatePolicies({ kind: "stage-entry", stageId }, rules);
        if (entry.verdict === "deny") {
          writer.append({ seq: 0, ts: nowIso(), type: "state", runtime: traceRuntime, event: "policy-deny", detail: entry.reason });
          return finish("fail", `${stageId}: denied at stage entry (${entry.policy})`, job.sessionId);
        }

        // Run the stage, intercepting tool actions for policy and streaming progress.
        let denied = false;
        // Deny reasons already surfaced to the human this stage. A cap or a retried blocked command
        // denies every subsequent action with the SAME reason, and each `kind:"error"` progress frame
        // becomes a Linear comment - so an uncapped storm posted a wall of identical comments (DHK-493).
        // Reset per stage (this closure is per job); the trace + agent-facing observation still record
        // every deny, we only collapse the human-visible comment to one per distinct reason.
        const surfacedDenyReasons = new Set<string>();
        // DHK-392/DHK-983: an `fs_confine` deny that re-evaluates only AFTER the action surfaced on the
        // trace. Whether that is a *blocked* deny or an unblockable *escape* turns on whether the session
        // pre-blocks tool calls, NOT on the runtime name: a session with a wired pre-execution gate
        // (Claude's `canUseTool`, embedded Pi's `setToolCallGate`) stopped the call before it ran, so the
        // surfaced action is already blocked and must NOT fail the stage; a session without one (container
        // Pi) let the command run first, so the breach already happened and a quiet note would be a lie.
        // We record the raw fact here and classify it at stage exit, once the session's capability
        // (`enforcesPreExecution`) is known - the runtime name cannot express it (embedded and container
        // Pi share the name "pi" but differ on the gate).
        let fsConfineDeniedPostHoc = false;
        const authorisedActions: string[] = [];
        const runtime = agentConfig?.runtime;
        const actionKey = (tool: string, input: unknown): string => {
          try {
            return `${tool}\0${JSON.stringify(input)}`;
          } catch {
            return `${tool}\0`;
          }
        };
        const policyReason = (verdict: PolicyOutcome): string => verdict.reason ?? `tool action denied by ${verdict.policy}`;
        const recordDeny = (verdict: PolicyOutcome, toolUseId?: string): void => {
          denied = true;
          const reason = policyReason(verdict);
          if (toolUseId) {
            streamEvent(writer.append({ seq: 0, ts: nowIso(), type: "observation", runtime: traceRuntime, toolUseId, isError: true, output: { error: reason } }));
          }
          streamEvent(writer.append({ seq: 0, ts: nowIso(), type: "state", runtime: traceRuntime, event: "policy-deny", detail: reason }));
          const surfaceKey = `${verdict.policy}\0${reason}`;
          if (!surfacedDenyReasons.has(surfaceKey)) {
            surfacedDenyReasons.add(surfaceKey);
            deps.sendProgress({ jobId, kind: "error", ts: nowIso(), text: reason });
          }
        };
        const authorizeToolUse = (tool: string, input: unknown): PolicyOutcome => {
          const verdict = evaluatePolicies({ kind: "action", stageId, tool, input }, rules);
          if (verdict.verdict === "deny") {
            recordDeny(verdict);
          } else {
            authorisedActions.push(actionKey(tool, input));
          }
          return verdict;
        };
        // Reset hook for the batch output-idle watchdog (armed below, batch stages only). Every
        // streamed trace event is a sign of life, so bumping it here keeps an actively-working stage
        // alive; a no-op until the watchdog is armed.
        let bumpStall: () => void = () => {};
        // Tool calls the agent has opened but not yet observed to return (DHK-955). A single long tool
        // call that streams no intermediate output (classically `pnpm test | tail`) looks identical to
        // a hung runtime: one `action` event, then total silence until it exits. While a call is open,
        // that silence is expected - the runtime is legitimately blocked on the tool, not hung - so
        // `bumpStall` suspends the watchdog until the set drains. `action`/`observation` pair by
        // `toolUseId` (DHK-384), so interleaved/parallel calls track correctly.
        const openToolCalls = new Set<string>();
        // When the stage last produced a NORMALISED event, as opposed to merely being alive. Only read
        // to make a stall legible (DHK-1136): once `onLive` drives the watchdog, a stall means the
        // runtime went silent entirely, and the gap since the last trace event is what says whether it
        // died mid-turn or while idle.
        let lastTraceAt = Date.now();
        const onTrace = (event: TraceEvent): void => {
          lastTraceAt = Date.now();
          if (event.type === "action") {
            const key = actionKey(event.tool, event.input);
            const authorised = authorisedActions.indexOf(key);
            if (authorised >= 0) {
              authorisedActions.splice(authorised, 1);
            } else {
              const verdict = evaluatePolicies(
                { kind: "action", stageId, tool: event.tool, input: event.input },
                rules,
              );
              if (verdict.verdict === "deny") {
                // A denied action never runs, so it opens no call - do not add it to the set (its
                // synthetic observation bypasses onTrace, which would leak the entry and disable the
                // watchdog forever). It is still a sign of life, so re-arm before returning.
                bumpStall();
                streamEvent(writer.append(event));
                recordDeny(verdict, event.toolUseId);
                if (verdict.policy === "fs_confine") fsConfineDeniedPostHoc = true;
                return;
              }
            }
            // An authorised tool call is now in flight: mark it open BEFORE bumping so the watchdog
            // does not re-arm while it runs.
            openToolCalls.add(event.toolUseId);
          } else if (event.type === "observation") {
            // The call has returned: drop it BEFORE bumping so this event re-arms the watchdog once
            // nothing else is open.
            openToolCalls.delete(event.toolUseId);
          }
          bumpStall();
          streamEvent(writer.append(event));
          if (event.type !== "state") deps.sendProgress({ jobId, kind: event.type, ts: event.ts, ...previewOf(event) });
        };

        // Start the per-stage MCP gateway when the stage declares brokered MCP servers, for every
        // runtime that can route MCP through it: Claude (SDK-native) and Pi (its extension bridge,
        // DHK-507). Codex is excluded - its SDK has no MCP, so a proxy would be dead weight (the codex
        // adapter logs and ignores declared servers). The gateway holds the token and injects it
        // upstream, so the agent never sees the raw secret (`mcpProxyBaseUrl` seam) regardless of runtime.
        const mcpServers = agentConfig?.mcpServers;
        if (runtime && mcpServers && mcpServers.length > 0 && runtimeUsesMcpGateway(runtime)) {
          gateway = await startMcpGateway({ servers: mcpServers, creds: job.brokeredCreds ?? {} });
        }

        // A check stage runs deterministic commands, not an agent. Everything agent-shaped above is
        // already inert for it (it declares no mcpServers, no provision, no emitArtifact); this is the
        // one place the two paths genuinely diverge.
        let checkOutcomes: CheckOutcome[] = [];
        const runner = isCheck
          ? (deps.makeCheckRunner ?? createCheckRunner)(
              job.checks,
              (o) => {
                checkOutcomes = o;
              },
              // Node-native probes: checks the node performs itself because they need the repo's git
              // credential, which a `sh -c` check env deliberately does not carry (see `CheckProbe`).
              // Bound to THIS job's worktree and token, so the probe authenticates exactly as a real
              // fetch would.
              {
                "git-fetch": async () =>
                  await deps.gitService.fetchProbe(ref, {
                    ...(job.workspaceRef?.credentialToken
                      ? { credentialToken: job.workspaceRef.credentialToken }
                      : {}),
                  }),
                "runtime-detect": async (check) =>
                  await runtimeDetectProbe(check.probeRuntimes ?? [], deps.probeRuntimes),
              },
            )
          : deps.makeRunner(runtime!);
        active.set(jobId, runner);
        const ctx: PolicyAwareRunnerContext = {
          // A check runner reads only `workspace.worktreePath`; the empty config keeps the shared
          // RunnerContext shape without inventing a runtime the stage does not have.
          config: agentConfig ?? ({ runtime: "claude-code" } as AgentConfig),
          workspace: ref,
          // The run's whole repo set (DHK-251), primary first, so an adapter can widen its sandbox and
          // the prompt can name the siblings. Omitted at N=1, so a single-repo context is unchanged.
          ...(runSiblings.get(runId)?.length ? { workspaces: allWorktrees(runId) } : {}),
          sessionId: job.sessionId,
          ...(job.issueContext !== undefined ? { issueContext: job.issueContext } : {}),
          ...(job.guidance !== undefined ? { guidance: job.guidance } : {}),
          ...(job.gateFeedback !== undefined ? { gateFeedback: job.gateFeedback } : {}),
          // Why this stage is running again, when it is. Without this passthrough the failing checks
          // reach the node and stop dead here, and the looped-back agent gets the stage's static prompt
          // with no hint of what it is meant to fix.
          ...(job.checkFailures !== undefined ? { checkFailures: job.checkFailures } : {}),
          ...(job.attachedDocuments !== undefined ? { attachedDocuments: job.attachedDocuments } : {}),
          ...(job.comments !== undefined ? { comments: job.comments } : {}),
          ...(job.relatedIssues !== undefined ? { relatedIssues: job.relatedIssues } : {}),
          ...(gateway ? { mcpProxyBaseUrl: gateway.baseUrl } : {}),
          // brokered inference env for a managed node (no operator login). Every runtime adapter and
          // the container executor apply it as the inference process env, so the raw key is never
          // surfaced to the agent's own tool calls. (This once said "inert
          // for the Claude adapter, which uses ambient inference" - untrue since DHK-89 and worth
          // correcting: that adapter reads BOTH this and the `runtimeAuth` hint below.)
          ...(job.runtimeEnv ? { runtimeEnv: job.runtimeEnv } : {}),
          // The brokered auth-profile hint (DHK-509/511): WHICH provider each piece of the inference
          // auth above belongs to, plus the model fallback. The adapter applies nothing for a provider
          // the hint does not name, so without this passthrough `runtimeEnv` arrives and is ignored -
          // a managed node then has no inference auth at all and falls through to whatever provider the
          // runtime defaults to. A plain typed read since `@dahrk/contracts` declares `runtimeAuth` on
          // both `JobRequest` and `RunnerContext`.
          ...(job.runtimeAuth ? { runtimeAuth: job.runtimeAuth } : {}),
          // DHK-979: pinned skills the overlay injected BY PATH (verified pack-cache dirs, never copied
          // into the worktree). The Pi adapter reads this off the ctx and hands it to its resource loader
          // as `additionalSkillPaths`. Carried on a local extended shape since `@dahrk/contracts` does not
          // declare it yet (the same defensive idiom as `setup` above); omitted when nothing was injected,
          // so a Claude stage or a Pi stage with no pinned skills is unchanged.
          ...(overlayResult?.injected.length ? { injectedSkillPaths: overlayResult.injected } : {}),
          // The adapter persists each runtime-native record under the attempt's raw/ sidecar
          // and stamps the rawRef onto the emitted event.
          writeRaw: writer.writeRaw,
          // Sits beside `writeRaw` deliberately: the adapter calls both at the same point, for every
          // native message. `writeRaw` records it, `onLive` says the runtime is alive (DHK-1136).
          onLive: () => bumpStall(),
          authorizeToolUse,
          // Wire the interactive AskUserQuestion elicitation seam (DHK-344): the adapter calls this when
          // the agent asks a structured question, and the edge relays it to the hub as an `elicit` frame.
          ...(deps.sendElicit
            ? {
                emitElicit: (question: ElicitQuestion) =>
                  deps.sendElicit!({
                    jobId,
                    prompt: question.prompt,
                    options: question.options,
                    ...(question.multiSelect ? { multiSelect: true } : {}),
                  }),
              }
            : {}),
        };
        // Interactive stages run a multi-turn conversation fed by relayed human turns (M5b);
        // batch stages run to a terminal result. Both emit through the same onTrace.
        const interactive = agentConfig?.interaction === "interactive";
        let result: Omit<JobResult, "jobId" | "summary"> & { summary?: string };
        // Wall-clock kill (the contract `JobRequest.timeout` promises "on expiry the executor kills the
        // runner; the engine marks the stage timeout"). Enforce it here so it covers batch AND interactive
        // for both adapters: at the deadline we abort the runner via cancel() and force status `timeout`.
        // This bounds real stage runtime below the hub's dispatch deadline (stage timeout + relay margin),
        // so a stage is never re-dispatched while still legitimately executing - the safety prerequisite
        // the re-dispatch leans on. (The edge de-dup in ws-client is the second guard.)
        let timedOut = false;
        const killMs = Math.max(0, Math.floor((job.timeout ?? 0) * 1000));
        const killTimer =
          killMs > 0
            ? setTimeout(() => {
                timedOut = true;
                void runner.cancel();
              }, killMs)
            : undefined;
        // NB: do NOT unref() this timer. It is the active mechanism of the timeout kill; an unref'd
        // timer does not keep the event loop alive, so an otherwise-idle loop could drain before it
        // fires and the kill would never happen. It is always cleared in the `finally` below, so it
        // can never outlive the job.
        //
        // Batch output-idle watchdog. A batch stage has no idle timer of its own, and the wall clock is
        // opt-in (usually absent), so a genuinely hung stage - an orphaned subprocess, a runtime that
        // stops streaming - would otherwise run forever. Cancel the runner if the RUNTIME goes silent
        // for `stallMs`.
        //
        // "Silent" means no native message at all, not no trace event (DHK-1136). Those are different
        // things and conflating them is what made this watchdog kill live stages: the mappers normalise
        // `system` / `stream_event` / `rate_limit_event` to zero events, so a long assistant turn streams
        // a message a second and produces nothing `onTrace` can see. Liveness therefore comes from
        // `ctx.onLive`, which the adapter calls per native message before normalisation; `onTrace` bumps
        // too, since a normalised event implies a message. An actively-working stage is never touched.
        // Batch-only: interactive stages keep
        // their own per-turn idle timer. Override via the stage's `stall_seconds` (-> agentConfig.stallMs,
        // read defensively until the contract republishes) or env `DAHRK_BATCH_STALL_MS`; default 300s.
        let stalled = false;
        let stallTimer: ReturnType<typeof setTimeout> | undefined;
        // Stall window source: the stage's `stall_seconds` (surfaced as agentConfig.stallMs), else the
        // env override, else 300s. Sanitised (clamp to a non-negative integer) exactly as killMs above;
        // interactive stages opt out with 0. Reading env has no side effects, so computing the source
        // unconditionally is equivalent to the old interactive-short-circuit.
        //
        // OPTIONAL CHAIN, not decoration (DHK-1017): a CHECK job has no `agentConfig` at all - the wire
        // contract narrows it away - so an unconditional read threw `TypeError` here and killed every
        // check stage before a single check command ran. The unconditional form was equivalent to the
        // short-circuit it replaced for interactive stages, but that short-circuit also covered checks.
        const stallSource =
          (agentConfig as { stallMs?: number } | undefined)?.stallMs ??
          Number(process.env.DAHRK_BATCH_STALL_MS ?? 300_000);
        // A check stage streams nothing while a command runs (no per-token trace), so the output-idle
        // watchdog would kill any check slower than the 300s default - `pnpm test` on a real repo.
        // Its bounds are the per-check `timeoutSeconds` and the stage's own `timeout_seconds`.
        const stallMs = interactive || isCheck ? 0 : Math.max(0, Math.floor(stallSource));
        if (stallMs > 0) {
          bumpStall = (): void => {
            if (stallTimer) clearTimeout(stallTimer);
            stallTimer = undefined;
            // A tool call is in flight (DHK-955): the runtime is legitimately blocked on it, so the
            // silence is not a hang. Leave the watchdog disarmed until the matching observation drains
            // the set and re-arms it. Measures agent silence, not any silence.
            if (openToolCalls.size > 0) return;
            stallTimer = setTimeout(() => {
              stalled = true;
              void runner.cancel();
            }, stallMs);
          };
          bumpStall(); // arm before the first event, so a stage that never streams still trips
        }
        try {
          if (interactive) {
            const mailbox = new ManagedMailbox<HumanTurn>();
            turnQueues.set(jobId, mailbox);
            result = await runner.runInteractive(ctx, mailbox, onTrace);
          } else {
            result = await runner.runBatch(ctx, onTrace);
          }
        } finally {
          if (killTimer) clearTimeout(killTimer);
          if (stallTimer) clearTimeout(stallTimer);
        }
        // A policy deny blocks the individual *action* (already recorded as a policy-deny trace
        // event and streamed as a progress error); the deny-only guards are guardrails the agent
        // is expected to route around, not stage killers. A single guard-blocked action must NOT
        // poison the *stage* verdict: a stage the runner finished cleanly stays `ok` even if one of
        // its tool actions was denied. (Previously any deny forced the whole stage to `fail`, so a
        // recovered-from `rm -rf` on a throwaway scratch dir turned a correctly-completed build into
        // a false-negative.) The deny still surfaces in the trace and in the summary note below.
        // A wall-clock kill and a batch stall both cancel the runner and surface as `timeout` (the same
        // status the old default wall clock produced, so the hub folds them identically). They differ
        // only in the summary below, so a stall is legible in the trace without a new JobStatus variant.
        let status: JobStatus = timedOut || stalled ? "timeout" : result.status;

        // DHK-983: does the session that just ran pre-block tool calls? The adapters surface this as
        // `enforcesPreExecution` (Claude always true; embedded Pi true once its gate wired; container Pi
        // true too since DHK-981 landed the gate over RPC and DHK-968 made the session declare it). Read
        // defensively - it is additive over the published `Runner`, the same forward-compat
        // idiom as the Job fields above - and only after the run, so a lazily-opened Pi session has
        // registered its gate. A runner that predates the capability falls back to the old runtime-name
        // proxy, so its behaviour is unchanged.
        const enforcesPreExecution =
          (runner as Partial<PreExecutionCapability>).enforcesPreExecution ?? runtime === "claude-code";

        // The one deny that DOES kill the stage (DHK-392/DHK-983). When the session could NOT pre-block
        // the call, the confinement breach was detected after the fact: the command already read what it
        // read. That is not a guardrail the agent routed around, it is one that arrived late, and the
        // honest signal is a loud failure rather than a note at the end of a green stage. When the session
        // DID pre-block (Claude, embedded Pi), the same surfaced deny is already a clean blocked deny, so
        // the stage stays ok and the deny rides out as a note.
        if (status === "ok" && fsConfineDeniedPostHoc && !enforcesPreExecution) {
          status = "fail";
          const msg = `stage reached outside the run's worktree and the session could not block it before it ran (${runtime ?? traceRuntime} has no pre-execution gate)`;
          writer.append({ seq: 0, ts: nowIso(), type: "error", runtime: traceRuntime, kind: "fs-confine-escape", message: msg });
          deps.sendProgress({ jobId, kind: "error", ts: nowIso(), text: msg });
        }

        // R4 stage-exit hooks run in the worktree only if the stage otherwise succeeded.
        if (status === "ok" && job.hooks && job.hooks.length > 0) {
          for (const cmd of job.hooks) {
            // `spawnSync` + `detached` so the hook leads its own process group and we can reap it: a hook
            // that backgrounds a child must not leak it past the stage, same as a check command (DHK-1099).
            const res = spawnSync("sh", ["-c", cmd], {
              cwd: ref.worktreePath,
              stdio: ["pipe", "pipe", "pipe"],
              encoding: "utf8",
              ...detachedGroup,
            });
            killProcessGroup({ pid: res.pid });
            if (res.status !== 0 || res.error) {
              status = "fail";
              const reason = res.error ? res.error.message : `exited ${res.status}`;
              writer.append({ seq: 0, ts: nowIso(), type: "error", runtime: traceRuntime, kind: "hook-failed", message: `hook "${cmd}" failed: ${reason}` });
              break;
            }
          }
        }

        // Interactive stages return their own handoff summary; a batch stage gets the
        // engine-owned summarisation turn (only after success, never failing the stage).
        let summary = result.summary ?? `${stageId}: ${status}`;
        // A stalled batch stage reports a distinct, legible summary (the runner's own summary is
        // unreliable after a mid-stream cancel). Prefer it over the generic `<stage>: timeout`.
        if (stalled && !timedOut) {
          // Say what actually went quiet. Since DHK-1136 the watchdog measures RUNTIME silence (any
          // native message, normalised or not), so a stall here means nothing arrived at all - a real
          // hang, not a long turn. The trace-event age is reported alongside because it is the part
          // that distinguishes "died mid-turn" from "died idle", and reading it off the summary saves
          // the next person the trace archaeology this bug originally cost.
          const traceAgeS = Math.round((Date.now() - lastTraceAt) / 1000);
          summary = `${stageId}: stalled (no runtime output for ${Math.round(stallMs / 1000)}s; last trace event ${traceAgeS}s ago)`;
        }
        if (!interactive && status === "ok") {
          try {
            // For a check job this is the runner's own deterministic one-liner, not an inference call:
            // `createCheckRunner.summarise` returns the precomputed text. That is what keeps a check
            // stage genuinely zero-cost rather than quietly spending a summarisation turn on eslint.
            summary = await runner.summarise(ctx);
          } catch {
            /* keep the fallback summary; a summarise failure must not fail an ok stage */
          }
        }
        // Keep the guardrail hit visible even when the stage still succeeded, so a reviewer can
        // see that an action was blocked without the deny silently flipping the verdict to fail.
        if (denied) summary += "\n\n(note: one or more tool actions were blocked by a deny-only policy guard.)";

        // Explicit failure attribution (DHK-569). A harness-owned watchdog kill - the wall-clock timeout
        // or the batch-stall cancel - is never the agent's fault, so attribute it `harness`. Otherwise
        // honour whatever the runner attributed (the adapter labels an upstream API transient `external`);
        // absent that, leave it unset so the engine's summary heuristic still classes a genuine agent-task
        // failure `agent`. Without this the engine sniffed `"<stage>: stalled (no output for 300s)"`,
        // matched nothing, and mis-billed the harness kill to the agent.
        const failureClass: FailureClass | undefined =
          timedOut || stalled ? "harness" : result.failureClass;

        // The engine-authored handoff note: per-check command, exit code and captured output, in the
        // shared worktree where the next stage's agent can read it. Attempt-scoped, so a loop-back never
        // clobbers the evidence from the previous attempt.
        if (isCheck && ref) writeCheckNote(ref, stageId, attempt, checkOutcomes);

        return finish(
          status,
          summary,
          result.sessionId ?? job.sessionId,
          result.costUsd,
          result.artifact,
          failureClass,
          result.verifications,
        );
      } finally {
        inFlight.set(runId, Math.max(0, (inFlight.get(runId) ?? 1) - 1));
      }
    },

    async runPush(job) {
      const { runId, jobId } = job;
      const allow = deps.servesRepoIds;
      if (allow && allow.length > 0 && !allow.includes(job.workspaceRef.repoId)) {
        return { jobId, status: "fail", summary: `edge does not serve repo "${job.workspaceRef.repoId}"` };
      }
      lastUsed.set(runId, Date.now());
      // Worktree-survival invariant (DHK-264 follow-up #2): count the push as in-flight for its whole
      // duration so `applyRetention`'s `prunable` guard (`inFlight === 0`) cannot reap this run's
      // worktree mid-push. Together with the `lastUsed` bump above (which makes this the most-recently-
      // used run, so LRU/age pruning evicts others first), it keeps the worktree alive for a follow-up
      // backup push - which depends on the committed HEAD still being present in that worktree.
      inFlight.set(runId, (inFlight.get(runId) ?? 0) + 1);
      try {
        const mode: PushMode = job.mode ?? "deliver";

        // Who the commit is by, and what signs it - both decided by the hub, both applied at every
        // commit site the push touches. `identity` carries the repo's dev-cycle override (DHK-60);
        // until this was threaded, the node silently ignored it and stamped its own hardcoded default
        // on every commit, so a repo that configured an author in the portal never got one.
        //
        // `signingKey` is the Dahrk bot's own SSH signing key, brokered per push exactly like the git
        // token: it is read off the frame rather than held on the node, and `GitService` writes it to a
        // temp file outside the worktree for the life of the operation. Absent = commits go out
        // unsigned (and explicitly so - the node must never fall through to a host signing key).
        // Read defensively: a hub older than the field simply sends nothing.
        const signingKey = (job as PushJob & { signingKey?: string }).signingKey;
        const attribution = {
          ...(job.identity ? { identity: job.identity } : {}),
          ...(signingKey ? { signingKey } : {}),
        };

        // Work-preservation push (DHK-264): the hub dispatches `mode:"backup"` after a `deliver` push
        // hit a base-advanced conflict, to save the run's committed HEAD on a durable `dahrk/wip/<runId>`
        // ref before the worktree is reaped. It MUST use the run's sticky worktree (which still holds the
        // HEAD) and take the merge-free path - no base integration, no conflict/diverged branch, no PR. If
        // the worktree is already gone the work cannot be preserved, so fail truthfully rather than
        // re-cloning the branch (which would push the base tip and silently lose the run's work).
        // Which repo THIS push is for. The hub dispatches one push per repo of a multi-repo run
        // (DHK-251), so falling through to the primary would push the wrong repo's worktree.
        const worktreeForPush = (): WorkspaceRef | undefined =>
          allWorktrees(runId).find((w) => w.repoId === job.workspaceRef.repoId);

        if (mode === "backup") {
          const ref = worktreeForPush();
          if (!ref) {
            return {
              jobId,
              status: "fail",
              branch: job.branch,
              summary: `backup push: run ${runId} has no live worktree; committed HEAD cannot be preserved`,
            };
          }
          try {
            const r = await deps.gitService.backupPush(ref, {
              message: job.message,
              branch: job.branch,
              ...(job.workspaceRef.credentialToken ? { credentialToken: job.workspaceRef.credentialToken } : {}),
              ...attribution,
            });
            return resolveBackupOutcome(r, { jobId, branch: job.branch });
          } catch (e) {
            return { jobId, status: "fail", branch: job.branch, summary: `backup push failed: ${(e as Error).message}` };
          }
        }

        // Resolve the run's sticky worktree so the just-run stages' uncommitted diff is present. The
        // pipeline pushes immediately after the last stage, so retention has not pruned it. Re-create
        // off the stable branch only as a defensive fallback (the branch's prior commits are on the
        // remote; any lost-but-uncommitted stage edits cannot be recovered here - they are gone).
        let ref = worktreeForPush();
        if (!ref) {
          ref = await deps.gitService.createWorktree({
            repoId: job.workspaceRef.repoId,
            gitUrl: job.workspaceRef.gitUrl,
            baseBranch: job.workspaceRef.baseBranch,
            runId,
            repo: job.workspaceRef.repo,
            branch: job.branch,
            ...(job.workspaceRef.credentialToken ? { credentialToken: job.workspaceRef.credentialToken } : {}),
          });
          // INSERT into the run's set, never replace it. Overwriting `worktrees` here would strand the
          // run's other repos, so push 2 of a multi-repo deliver would find nothing and re-clone.
          if (worktrees.has(runId)) {
            if (worktrees.get(runId)!.repoId !== ref.repoId) {
              runSiblings.set(runId, [...(runSiblings.get(runId) ?? []), ref]);
            }
          } else {
            worktrees.set(runId, ref);
          }
        }

        try {
          const r = await deps.gitService.commitAndPush(ref, {
            message: job.message,
            branch: job.branch,
            base: job.base,
            ...(job.workspaceRef.credentialToken ? { credentialToken: job.workspaceRef.credentialToken } : {}),
            ...attribution,
          });
          // The node never opens the pull request. It used to, whenever the hub judged the run ambient
          // and set `openPr`: the edge shelled out to the host's `gh` CLI, so PR authorship depended on
          // a host login and on a credential mode nothing surfaced. The hub opens every PR through the
          // GitHub App now, on the same installation that authorised this push.
          return resolveDeliverOutcome(r, { jobId, branch: job.branch, base: job.base });
        } catch (e) {
          return { jobId, status: "fail", summary: `push failed: ${(e as Error).message}` };
        }
      } finally {
        inFlight.set(runId, Math.max(0, (inFlight.get(runId) ?? 1) - 1));
      }
    },

    async finishRun(runId) {
      // isBusy still wins: a frame that races a job in flight must never yank the worktree from under
      // it. A run with no worktree / already torn down / unknown falls through `teardownRun` as a no-op,
      // so this is idempotent and unordered-safe. Clearing `worktrees` (in `teardownRun`) is exactly
      // what flips `isLive` to false, re-arming the age-based reclamation DHK-1045 left inert.
      if (isBusy(runId)) return;
      await teardownRun(runId);
    },

    cancel(jobId) {
      // The runner's cancel() aborts the in-flight SDK query (M4). Also close the turn mailbox
      // so an interactive runner blocked awaiting the next turn unwinds. The stage finishes
      // "fail" and the loop unwinds normally.
      void active.get(jobId)?.cancel();
      turnQueues.get(jobId)?.end();
    },

    enqueueTurn(jobId, turn) {
      turnQueues.get(jobId)?.push(turn);
    },

    endTurns(jobId) {
      turnQueues.get(jobId)?.end();
    },
  };
}
