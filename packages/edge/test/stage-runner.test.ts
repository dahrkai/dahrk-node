/**
 * The stage runner streams its normalised trace to the observability sink as it runs
 * and finalises at stage exit. This exercises a real worktree (git) + the mock runner
 * and a capturing TraceSink, asserting: every event is streamed with a contiguous seq,
 * the finalised frame carries the authoritative count + archive key, and heavy payloads
 * are offered to the sink for upload. No hub, no network.
 *
 * All runtime-agnostic scenarios are driven for both supported runtimes (claude-code and
 * pi) via `forBothRuntimes`, so the runtime-neutral stage-runner layer is proven neutral
 * (DHK-973). Single-runtime tests carry an inline reason.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobProgress, JobRequest, PushJob, Runner, RunnerContext, Runtime, TraceEvent, TraceMeta } from "@dahrk/contracts";
import { REFUSED_CREDENTIAL_SUMMARY, createGitService, createMockRunner, type PreExecutionCapability } from "@dahrk/executor-worktree";
import {
  createStageRunner,
  resolveStageArtifact,
  runtimeUsesMcpGateway,
  type BlobPutRequestArgs,
  type TraceSink,
} from "../src/stage-runner.js";
import { createCredentialLatch } from "../src/credential-latch.js";

const RUNTIMES: Runtime[] = ["claude-code", "pi"];

/** Run a test scenario for both supported runtimes. The test name gains a `[runtime]` suffix. */
function forBothRuntimes(name: string, fn: (runtime: Runtime) => Promise<void>): void {
  for (const runtime of RUNTIMES) {
    test(`${name} [${runtime}]`, () => fn(runtime));
  }
}

function initRepo(dir: string): void {
  const git = (...args: string[]): void => void execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "Test");
  execFileSync("sh", ["-c", "echo hello > README.md"], { cwd: dir });
  git("add", ".");
  git("commit", "-m", "init");
}

forBothRuntimes("stage runner streams the trace and finalises with count + archive key", async (runtime) => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-sr-"));
  const repo = join(root, "repo");
  const worktrees = join(root, "wt");
  execFileSync("mkdir", ["-p", repo]);
  initRepo(repo);

  const streamed: TraceEvent[] = [];
  const uploads: BlobPutRequestArgs[] = [];
  let finalised: { meta: TraceMeta; eventCount: number; archiveKey?: string } | undefined;
  const sink: TraceSink = {
    event: (f) => void streamed.push(f.event),
    finalised: (f) => void (finalised = { meta: f.meta, eventCount: f.eventCount, ...(f.archiveKey ? { archiveKey: f.archiveKey } : {}) }),
    requestBlobUrl: async (req) => {
      uploads.push(req);
      return { key: `key/${req.slot}/${req.sha256}` }; // no url -> the runner skips the PUT
    },
  };

  const runner = createStageRunner({
    gitService: createGitService({ worktreesDir: worktrees, mirrorsDir: join(root, "mir") }),
    makeRunner: createMockRunner,
    rules: [],
    sendProgress: () => undefined,
    trace: sink,
  });

  const job: JobRequest = {
    tenantId: "t_default",
    runId: "run-sr-1",
    stageId: "build",
    jobId: "job-sr-1",
    awakeableId: "awk-1",
    executorType: "worktree",
    agentConfig: { runtime, interaction: "batch", tools: ["shell"] },
    // gitUrl is the local source repo: the edge clones it on demand into the mirror cache.
    workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
    timeout: 60,
  };

  try {
    const result = await runner.runJob(job);
    assert.equal(result.status, "ok");

    // attempt-start + mock (thought, action, observation, response) + stage-exit = 6.
    assert.equal(streamed.length, 6, "every written event is streamed");
    assert.equal(streamed[0]!.type, "state");
    assert.equal((streamed[0] as { event: string }).event, "attempt-start");
    assert.equal((streamed[streamed.length - 1] as { event: string }).event, "stage-exit");
    // Seqs are contiguous and writer-assigned (0..n-1), so the hub can detect gaps.
    assert.deepEqual(streamed.map((e) => e.seq), [0, 1, 2, 3, 4, 5]);

    assert.ok(finalised, "a finalised frame is sent");
    assert.equal(finalised.eventCount, 6, "finalised count matches the events written");
    assert.equal(finalised.meta.status, "ok");
    assert.equal(finalised.archiveKey, `key/archive/${finalised.archiveKey?.split("/").pop()}`);

    // The finalised trace.jsonl archive is always offered for upload.
    assert.ok(uploads.some((u) => u.slot === "archive"), "the archive is offered to object storage");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

forBothRuntimes("a telemetry-only Job (no workspaceRef) runs in scratch with no clone attempted", async (runtime) => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-sr-meta-"));
  const scratchRoot = join(root, "scratch");

  const streamed: TraceEvent[] = [];
  let finalised: { meta: TraceMeta; eventCount: number } | undefined;
  const sink: TraceSink = {
    event: (f) => void streamed.push(f.event),
    finalised: (f) => void (finalised = { meta: f.meta, eventCount: f.eventCount }),
    requestBlobUrl: async (req) => ({ key: `k/${req.sha256}` }),
  };

  // A git service whose clone path throws if ever entered: proof that no worktree is built for a
  // telemetry-only run. Only createWorktree is fatal; the (unused) teardown is a no-op.
  const noCloneGit = {
    createWorktree: () => assert.fail("createWorktree must not be called for a telemetry-only run"),
    teardownWorktree: async () => undefined,
  };

  const runner = createStageRunner({
    gitService: noCloneGit as never,
    makeRunner: createMockRunner,
    rules: [],
    sendProgress: () => undefined,
    trace: sink,
    scratchRoot,
  });

  // No workspaceRef: the meta-loop run carries no customer repo, only injected telemetry.
  const job: JobRequest = {
    tenantId: "t_platform",
    runId: "run-meta-1",
    stageId: "diagnose",
    jobId: "job-meta-1",
    awakeableId: "awk-meta",
    executorType: "worktree",
    agentConfig: { runtime, interaction: "batch", tools: ["shell"] },
    issueContext: "# Telemetry\n\nRun health: degraded.",
    timeout: 60,
  };

  try {
    const result = await runner.runJob(job);
    assert.equal(result.status, "ok", "the stage completes against injected telemetry + scratch");

    // The injected telemetry was written to the run's scratch dir, no git involved.
    const issuePath = join(scratchRoot, "run-meta-1", ".dahrk", "scratch", "issue.md");
    assert.ok(existsSync(issuePath), "the injected issueContext is written to scratch");
    assert.equal(readFileSync(issuePath, "utf8"), job.issueContext);

    // The trace still streams and finalises (attempt-start ... stage-exit).
    assert.equal(streamed[0]!.type, "state");
    assert.equal((streamed[0] as { event: string }).event, "attempt-start");
    assert.equal((streamed[streamed.length - 1] as { event: string }).event, "stage-exit");
    assert.ok(finalised, "a finalised frame is sent");
    assert.equal(finalised.meta.status, "ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Single-runtime (claude-code): the tenant guard fires before the runner is constructed, so the
// runtime in agentConfig has no effect on the outcome. Running it for both runtimes would add no
// coverage of the runtime-agnostic layer.
test("a tenant-bound node refuses a Job for another tenant (no worktree built)", async () => {
  // A git service whose clone path throws if ever entered: proof the guard short-circuits BEFORE the
  // worktree is created for a mismatched tenant.
  const noCloneGit = {
    createWorktree: () => assert.fail("createWorktree must not be called for a refused Job"),
    teardownWorktree: async () => undefined,
  };
  const runner = createStageRunner({
    gitService: noCloneGit as never,
    makeRunner: createMockRunner,
    rules: [],
    sendProgress: () => undefined,
    tenantId: "t_platform", // this node is bound to the platform tenant.
  });

  const job: JobRequest = {
    tenantId: "t_default", // a customer-tenant Job that should never have been dispatched here.
    runId: "run-mismatch-1",
    stageId: "diagnose",
    jobId: "job-mismatch-1",
    awakeableId: "awk-mismatch",
    executorType: "worktree",
    agentConfig: { runtime: "claude-code", interaction: "batch", tools: ["shell"] },
    issueContext: "# Telemetry",
    timeout: 60,
  };

  const result = await runner.runJob(job);
  assert.equal(result.status, "fail");
  assert.match(result.summary ?? "", /refuses a job for tenant "t_default"/);
});

forBothRuntimes("a matching-tenant Job runs normally under a tenant-bound node", async (runtime) => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-sr-tenant-"));
  const scratchRoot = join(root, "scratch");
  const runner = createStageRunner({
    gitService: {
      createWorktree: () => assert.fail("telemetry-only job needs no clone"),
      teardownWorktree: async () => undefined,
    } as never,
    makeRunner: createMockRunner,
    rules: [],
    sendProgress: () => undefined,
    tenantId: "t_platform",
    scratchRoot,
  });

  // Telemetry-only (no workspaceRef) so the run needs no real repo; the tenant matches the node's.
  const job: JobRequest = {
    tenantId: "t_platform",
    runId: "run-match-1",
    stageId: "diagnose",
    jobId: "job-match-1",
    awakeableId: "awk-match",
    executorType: "worktree",
    agentConfig: { runtime, interaction: "batch", tools: ["shell"] },
    issueContext: "# Telemetry",
    timeout: 60,
  };

  try {
    const result = await runner.runJob(job);
    assert.equal(result.status, "ok", "a same-tenant Job passes the guard and runs");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

forBothRuntimes("retention tears down old run worktrees and keeps the newest", async (runtime) => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-ret-"));
  const repo = join(root, "repo");
  const worktrees = join(root, "wt");
  execFileSync("mkdir", ["-p", repo]);
  initRepo(repo);

  const torn: string[] = [];
  const gitService = createGitService({ worktreesDir: worktrees, mirrorsDir: join(root, "mir") });
  const wrapped = {
    ...gitService,
    teardownWorktree: async (ref: { worktreePath: string }) => {
      torn.push(ref.worktreePath);
      return gitService.teardownWorktree(ref as never);
    },
  };

  const runner = createStageRunner({
    gitService: wrapped as never,
    makeRunner: createMockRunner,
    rules: [],
    sendProgress: () => undefined,
    retention: { maxRuns: 2 },
  });

  const mkJob = (n: number): JobRequest => ({
    tenantId: "t_default",
    runId: `run-${n}`,
    stageId: "build",
    jobId: `job-${n}`,
    awakeableId: `awk-${n}`,
    executorType: "worktree",
    agentConfig: { runtime, interaction: "batch", tools: ["shell"] },
    workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
    timeout: 60,
  });

  try {
    // Three sequential runs with maxRuns=2: the first run's worktree is pruned.
    await runner.runJob(mkJob(1));
    await runner.runJob(mkJob(2));
    assert.equal(torn.length, 0, "within the limit, nothing is pruned");
    await runner.runJob(mkJob(3));
    assert.equal(torn.length, 1, "exceeding maxRuns prunes the least-recently-used run");
    assert.ok(torn[0]!.includes("run-1"), "the oldest run (run-1) is the one torn down");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

forBothRuntimes("a stage that exceeds its timeout is killed and marked `timeout` (job.timeout kill)", async (runtime) => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-sr-to-"));
  const repo = join(root, "repo");
  execFileSync("mkdir", ["-p", repo]);
  initRepo(repo);

  const sink: TraceSink = {
    event: () => undefined,
    finalised: () => undefined,
    requestBlobUrl: async (req) => ({ key: `k/${req.sha256}` }),
  };

  // A runner whose run hangs until cancel() aborts it - exactly how the real adapters behave on
  // AbortController.abort(): runBatch resolves gracefully with a non-ok status, it does not throw.
  // The stage runner's wall-clock kill must fire cancel() at job.timeout and force status `timeout`.
  const makeHangingRunner = (rt: Runner["runtime"]): Runner => {
    let release: (() => void) | undefined;
    const aborted = new Promise<void>((r) => (release = r));
    return {
      runtime: rt,
      async runBatch() {
        await aborted;
        return { status: "fail" };
      },
      async runInteractive() {
        await aborted;
        return { status: "fail", summary: "cancelled" };
      },
      async summarise() {
        return "n/a";
      },
      async cancel() {
        release?.();
      },
    };
  };

  const runner = createStageRunner({
    gitService: createGitService({ worktreesDir: join(root, "wt"), mirrorsDir: join(root, "mir") }),
    makeRunner: makeHangingRunner,
    rules: [],
    sendProgress: () => undefined,
    trace: sink,
  });

  const job: JobRequest = {
    tenantId: "t_default",
    runId: "run-sr-to",
    stageId: "build",
    jobId: "job-sr-to-1",
    awakeableId: "awk-to",
    executorType: "worktree",
    agentConfig: { runtime, interaction: "batch", tools: ["shell"] },
    workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
    timeout: 0.05, // 50ms wall-clock; the hanging runner only completes when the kill fires cancel()
  };

  try {
    const result = await runner.runJob(job);
    assert.equal(result.status, "timeout", "the stage is killed at its timeout and reported `timeout`");
    assert.equal(result.failureClass, "harness", "a harness-owned wall-clock kill is billed harness, not agent (DHK-569)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

forBothRuntimes("a batch stage that streams no output for `stallMs` is cancelled and marked `timeout` (stall watchdog)", async (runtime) => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-sr-stall-"));
  const repo = join(root, "repo");
  execFileSync("mkdir", ["-p", repo]);
  initRepo(repo);

  const sink: TraceSink = {
    event: () => undefined,
    finalised: () => undefined,
    requestBlobUrl: async (req) => ({ key: `k/${req.sha256}` }),
  };

  // A runner that hangs producing no trace at all - the orphaned-subprocess case. With no wall clock
  // (job.timeout absent), only the batch output-idle watchdog can end it: it fires cancel() after
  // `stallMs` of silence, and the stage is reported `timeout` with a distinct `stalled` summary.
  const makeSilentRunner = (rt: Runner["runtime"]): Runner => {
    let release: (() => void) | undefined;
    const aborted = new Promise<void>((r) => (release = r));
    return {
      runtime: rt,
      async runBatch() {
        await aborted;
        return { status: "fail" };
      },
      async runInteractive() {
        await aborted;
        return { status: "fail" };
      },
      async summarise() {
        return "n/a";
      },
      async cancel() {
        release?.();
      },
    };
  };

  const runner = createStageRunner({
    gitService: createGitService({ worktreesDir: join(root, "wt"), mirrorsDir: join(root, "mir") }),
    makeRunner: makeSilentRunner,
    rules: [],
    sendProgress: () => undefined,
    trace: sink,
  });

  const job: JobRequest = {
    tenantId: "t_default",
    runId: "run-sr-stall",
    stageId: "build",
    jobId: "job-sr-stall-1",
    awakeableId: "awk-stall",
    executorType: "worktree",
    agentConfig: { runtime, interaction: "batch", tools: ["shell"] },
    workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
    // No `timeout`: the wall clock is opt-in and absent here, so the stall watchdog is the only guard.
  };

  const prev = process.env.DAHRK_BATCH_STALL_MS;
  process.env.DAHRK_BATCH_STALL_MS = "50"; // 50ms of silence -> stall
  try {
    const result = await runner.runJob(job);
    assert.equal(result.status, "timeout", "a silent batch stage is cancelled by the stall watchdog");
    assert.match(result.summary ?? "", /stalled \(no output for/, "the summary marks it a stall, not a plain timeout");
    assert.equal(result.failureClass, "harness", "a harness-owned stall kill is billed harness, not agent (DHK-569)");
  } finally {
    if (prev === undefined) delete process.env.DAHRK_BATCH_STALL_MS;
    else process.env.DAHRK_BATCH_STALL_MS = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

forBothRuntimes("a batch stage that keeps streaming resets the stall watchdog and is never cancelled", async (runtime) => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-sr-nostall-"));
  const repo = join(root, "repo");
  execFileSync("mkdir", ["-p", repo]);
  initRepo(repo);

  const sink: TraceSink = {
    event: () => undefined,
    finalised: () => undefined,
    requestBlobUrl: async (req) => ({ key: `k/${req.sha256}` }),
  };

  // A runner that streams a `thought` every 5ms for ~100ms, then finishes ok. Every event bumps the
  // 50ms watchdog; 5ms intervals give a 10x margin vs the 50ms window, so the stage is never cancelled
  // even under concurrent test load - proving an actively-working batch stage outlives the watchdog.
  const makeStreamingRunner = (rt: Runner["runtime"]): Runner => ({
    runtime: rt,
    async runBatch(_ctx: RunnerContext, onTrace: (event: TraceEvent) => void) {
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 5));
        onTrace({ seq: i, ts: new Date().toISOString(), type: "thought", runtime: rt, text: `tick ${i}` });
      }
      return { status: "ok" };
    },
    async runInteractive() {
      return { status: "ok" };
    },
    async summarise() {
      return "done";
    },
    async cancel() {},
  });

  const runner = createStageRunner({
    gitService: createGitService({ worktreesDir: join(root, "wt"), mirrorsDir: join(root, "mir") }),
    makeRunner: makeStreamingRunner,
    rules: [],
    sendProgress: () => undefined,
    trace: sink,
  });

  const job: JobRequest = {
    tenantId: "t_default",
    runId: "run-sr-nostall",
    stageId: "build",
    jobId: "job-sr-nostall-1",
    awakeableId: "awk-nostall",
    executorType: "worktree",
    agentConfig: { runtime, interaction: "batch", tools: ["shell"] },
    workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
  };

  const prev = process.env.DAHRK_BATCH_STALL_MS;
  process.env.DAHRK_BATCH_STALL_MS = "50"; // shorter than the total run, longer than each 20ms gap
  try {
    const result = await runner.runJob(job);
    assert.equal(result.status, "ok", "a continuously-streaming batch stage is never cancelled by the watchdog");
  } finally {
    if (prev === undefined) delete process.env.DAHRK_BATCH_STALL_MS;
    else process.env.DAHRK_BATCH_STALL_MS = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

forBothRuntimes("a batch stage doing one long non-streaming tool call outlives the stall window (DHK-955)", async (runtime) => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-sr-toolcall-"));
  const repo = join(root, "repo");
  execFileSync("mkdir", ["-p", repo]);
  initRepo(repo);

  const sink: TraceSink = {
    event: () => undefined,
    finalised: () => undefined,
    requestBlobUrl: async (req) => ({ key: `k/${req.sha256}` }),
  };

  // The `pnpm test | tail` shape: the agent opens ONE tool call, the tool streams no intermediate
  // output while it runs (200ms >> the 50ms stall window), then returns and the stage finishes ok.
  // With the watchdog measuring *any* silence this was cancelled mid-tool-call; measuring *agent*
  // silence (the open call suspends the timer) lets the healthy stage run to completion.
  const makeToolCallRunner = (rt: Runner["runtime"]): Runner => ({
    runtime: rt,
    async runBatch(_ctx: RunnerContext, onTrace: (event: TraceEvent) => void) {
      const ts = new Date().toISOString();
      onTrace({ seq: 0, ts, type: "action", runtime: rt, tool: "Bash", toolUseId: "call-1", input: { cmd: "pnpm test | tail" } });
      await new Promise((r) => setTimeout(r, 200)); // the tool runs, streaming nothing
      onTrace({ seq: 1, ts: new Date().toISOString(), type: "observation", runtime: rt, toolUseId: "call-1", output: { ok: true } });
      return { status: "ok" };
    },
    async runInteractive() {
      return { status: "ok" };
    },
    async summarise() {
      return "done";
    },
    async cancel() {},
  });

  const runner = createStageRunner({
    gitService: createGitService({ worktreesDir: join(root, "wt"), mirrorsDir: join(root, "mir") }),
    makeRunner: makeToolCallRunner,
    rules: [],
    sendProgress: () => undefined,
    trace: sink,
  });

  const job: JobRequest = {
    tenantId: "t_default",
    runId: "run-sr-toolcall",
    stageId: "build",
    jobId: "job-sr-toolcall-1",
    awakeableId: "awk-toolcall",
    executorType: "worktree",
    agentConfig: { runtime, interaction: "batch", tools: ["shell"] },
    workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
  };

  const prev = process.env.DAHRK_BATCH_STALL_MS;
  process.env.DAHRK_BATCH_STALL_MS = "50"; // 50ms window, far shorter than the 200ms tool call
  try {
    const result = await runner.runJob(job);
    assert.equal(result.status, "ok", "a stage blocked on one long tool call is never cancelled by the watchdog");
  } finally {
    if (prev === undefined) delete process.env.DAHRK_BATCH_STALL_MS;
    else process.env.DAHRK_BATCH_STALL_MS = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

forBothRuntimes("the Job's runtimeEnv is threaded onto the runner ctx (injection boundary)", async (runtime) => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-sr-rtenv-"));
  const repo = join(root, "repo");
  execFileSync("mkdir", ["-p", repo]);
  initRepo(repo);

  const sink: TraceSink = {
    event: () => undefined,
    finalised: () => undefined,
    requestBlobUrl: async (req) => ({ key: `k/${req.sha256}` }),
  };

  // A runner that records the ctx it is handed, so we can assert the stage runner set runtimeEnv from
  // the Job (the adapter would apply it as the inference process env; here we only check the seam).
  const seen: RunnerContext[] = [];
  const makeCapturingRunner = (rt: Runner["runtime"]): Runner => ({
    runtime: rt,
    async runBatch(ctx) {
      seen.push(ctx);
      return { status: "ok" };
    },
    async runInteractive(ctx) {
      seen.push(ctx);
      return { status: "ok", summary: "n/a" };
    },
    async summarise() {
      return "n/a";
    },
    async cancel() {},
  });

  const runner = createStageRunner({
    gitService: createGitService({ worktreesDir: join(root, "wt"), mirrorsDir: join(root, "mir") }),
    makeRunner: makeCapturingRunner,
    rules: [],
    sendProgress: () => undefined,
    trace: sink,
  });

  const mkJob = (
    jobId: string,
    runtimeEnv?: Record<string, string>,
    runtimeAuth?: unknown,
  ): JobRequest => ({
    tenantId: "t_default",
    runId: "run-sr-rtenv",
    stageId: "build",
    jobId,
    awakeableId: "awk-rtenv",
    executorType: "worktree",
    agentConfig: { runtime, interaction: "batch", tools: ["shell"] },
    workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
    timeout: 60,
    ...(runtimeEnv ? { runtimeEnv } : {}),
    ...(runtimeAuth ? { runtimeAuth } : {}),
  });

  try {
    await runner.runJob(mkJob("job-rtenv-1", { ANTHROPIC_API_KEY: "sk-test", PI_MODEL: "claude-opus-4-8" }));
    assert.deepEqual(seen[0]?.runtimeEnv, { ANTHROPIC_API_KEY: "sk-test", PI_MODEL: "claude-opus-4-8" });

    await runner.runJob(mkJob("job-rtenv-2")); // no runtimeEnv -> absent on ctx (ambient node)
    assert.equal(seen[1]?.runtimeEnv, undefined);

    // DHK-509/511: the auth-profile hint must ride across the SAME seam. The adapter applies nothing
    // for a provider the hint does not name, so if this passthrough is missing the brokered key above
    // arrives and is silently ignored - which is precisely how a managed node ended up with no
    // inference auth at all while looking correctly configured from the hub's side.
    const hint = {
      providers: [{ kind: "api_key", provider: "anthropic", envVar: "ANTHROPIC_API_KEY" }],
      defaultModel: "claude-opus-4-8",
    };
    await runner.runJob(mkJob("job-rtenv-3", { ANTHROPIC_API_KEY: "sk-test" }, hint));
    assert.deepEqual((seen[2] as { runtimeAuth?: unknown })?.runtimeAuth, hint);

    // An oauth-subscription mint carries a hint and NO env at all, so the hint must attach on its own.
    const oauthHint = {
      providers: [
        { kind: "oauth", provider: "openai-codex", access: "at", refresh: "rt", expires: 1, extra: { accountId: "a" } },
      ],
      defaultModel: "gpt-5.5",
    };
    await runner.runJob(mkJob("job-rtenv-4", undefined, oauthHint));
    assert.equal(seen[3]?.runtimeEnv, undefined, "a subscription brings no env");
    assert.deepEqual((seen[3] as { runtimeAuth?: unknown })?.runtimeAuth, oauthHint);

    await runner.runJob(mkJob("job-rtenv-5")); // ambient node -> neither field
    assert.equal((seen[4] as { runtimeAuth?: unknown })?.runtimeAuth, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

forBothRuntimes("runner authorization denies a policy-blocked tool before execution (pre-execution hook)", async (runtime) => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-sr-auth-"));
  const repo = join(root, "repo");
  execFileSync("mkdir", ["-p", repo]);
  initRepo(repo);

  const streamed: TraceEvent[] = [];
  const progress: JobProgress[] = [];
  const sink: TraceSink = {
    event: (f) => void streamed.push(f.event),
    finalised: () => undefined,
    requestBlobUrl: async (req) => ({ key: `k/${req.sha256}` }),
  };

  const makeAuthorizingRunner = (rt: Runner["runtime"]): Runner => ({
    runtime: rt,
    async runBatch(ctx) {
      const verdict = (ctx as RunnerContext & { authorizeToolUse?: (tool: string, input: unknown) => { verdict: string } })
        .authorizeToolUse?.("Bash", { command: "sudo true" });
      assert.equal(verdict?.verdict, "deny");
      return { status: "ok" };
    },
    async runInteractive() {
      return { status: "ok", summary: "n/a" };
    },
    async summarise() {
      return "n/a";
    },
    async cancel() {},
  });

  const runner = createStageRunner({
    gitService: createGitService({ worktreesDir: join(root, "wt"), mirrorsDir: join(root, "mir") }),
    makeRunner: makeAuthorizingRunner,
    rules: [],
    sendProgress: (p) => void progress.push(p),
    trace: sink,
  });

  const job: JobRequest = {
    tenantId: "t_default",
    runId: "run-auth-1",
    stageId: "build",
    jobId: "job-auth-1",
    awakeableId: "awk-auth",
    executorType: "worktree",
    agentConfig: { runtime, interaction: "batch" },
    workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
    policies: [{ shell_guard: { mode: "deny" } }],
    timeout: 60,
  };

  try {
    const result = await runner.runJob(job);
    assert.equal(result.status, "ok");
    assert.match(result.summary ?? "", /tool actions were blocked/);
    assert.ok(streamed.some((e) => e.type === "state" && (e as { event?: string }).event === "policy-deny"));
    assert.ok(!streamed.some((e) => e.type === "action" && e.tool === "Bash"), "the denied Bash action was never emitted/executed");
    assert.ok(progress.some((p) => p.kind === "error" && /shell command blocked/.test(p.text ?? "")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// DHK-983: the confinement-escape decision keys off whether the SESSION pre-blocks tool calls
// (`enforcesPreExecution`), NOT off the runtime name. A runner whose session pre-blocks (Claude's
// canUseTool, embedded Pi's wired gate) that surfaces an fs_confine-denying action on the trace has
// merely had a call BLOCKED - the stage stays ok with a recorded deny. A runner whose session cannot
// pre-block (container Pi) let the command run first, so the same surfaced action is a genuine escape
// that must hard-fail. Both directions, both runtimes.

/** A runner that emits ONE confinement-escaping action straight onto the trace (never pre-authorised),
 *  mimicking a tool call that surfaces after the fact, then settles ok. `enforcesPreExecution` models
 *  whether its session has a wired pre-execution gate. */
const makeEscapingRunner = (
  runtime: Runner["runtime"],
  enforcesPreExecution: boolean,
): Runner & PreExecutionCapability => ({
  runtime,
  enforcesPreExecution,
  async runBatch(_ctx: RunnerContext, onTrace: (event: TraceEvent) => void) {
    onTrace({
      seq: 0,
      ts: new Date().toISOString(),
      type: "action",
      runtime,
      tool: "Bash",
      toolUseId: "escape-1",
      input: { command: "ls /Volumes" }, // a mounted-volume scan, outside the worktree -> fs_confine deny
    });
    return { status: "ok" };
  },
  async runInteractive() {
    return { status: "ok", summary: "n/a" };
  },
  async summarise() {
    return "n/a";
  },
  async cancel() {},
});

const mkEscapeJob = (runtime: Runner["runtime"], repo: string, id: string): JobRequest => ({
  tenantId: "t_default",
  runId: `run-${id}`,
  stageId: "build",
  jobId: `job-${id}`,
  awakeableId: `awk-${id}`,
  executorType: "worktree",
  agentConfig: { runtime, interaction: "batch" },
  workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
  timeout: 60,
});

const hasPolicyDeny = (streamed: TraceEvent[]): boolean =>
  streamed.some((e) => e.type === "state" && (e as { event?: string }).event === "policy-deny");
// The escape surfaces to the human on a `sendProgress` error frame (the terminal trace event is
// archived, not streamed live), so the progress frame is what a test can observe.
const escapeSurfaced = (progress: JobProgress[]): boolean =>
  progress.some((p) => p.kind === "error" && /could not block it before it ran/.test(p.text ?? ""));

test("a pre-blocking session's fs_confine deny is a blocked deny, not an escape (DHK-983)", async () => {
  // Both runtimes: an `enforcesPreExecution` session keeps the stage ok even though "pi" is not
  // "claude-code" - the old runtime-name check wrongly hard-failed embedded Pi here.
  for (const runtime of ["pi", "claude-code"] as const) {
    const root = mkdtempSync(join(tmpdir(), "dahrk-sr-preblock-"));
    const repo = join(root, "repo");
    execFileSync("mkdir", ["-p", repo]);
    initRepo(repo);

    const streamed: TraceEvent[] = [];
    const progress: JobProgress[] = [];
    const sink: TraceSink = {
      event: (f) => void streamed.push(f.event),
      finalised: () => undefined,
      requestBlobUrl: async (req) => ({ key: `k/${req.sha256}` }),
    };
    const runner = createStageRunner({
      gitService: createGitService({ worktreesDir: join(root, "wt"), mirrorsDir: join(root, "mir") }),
      makeRunner: (rt) => makeEscapingRunner(rt, true),
      rules: [],
      sendProgress: (p) => void progress.push(p),
      trace: sink,
    });

    try {
      const result = await runner.runJob(mkEscapeJob(runtime, repo, `preblock-${runtime}`));
      assert.equal(result.status, "ok", `${runtime}: a pre-blocked confinement deny keeps the stage ok`);
      assert.ok(hasPolicyDeny(streamed), `${runtime}: the deny is still recorded`);
      assert.ok(!escapeSurfaced(progress), `${runtime}: a pre-blocked deny is NOT an escape hard-failure`);
      assert.match(result.summary ?? "", /blocked/, `${runtime}: the blocked deny rides out as a note`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a session that cannot pre-block hard-fails on an fs_confine escape (DHK-983)", async () => {
  // Both runtimes: with `enforcesPreExecution` false the breach already happened, so even "claude-code"
  // hard-fails - proving the decision reads the capability, not the runtime name. Guards the security
  // property (container Pi) against regression.
  for (const runtime of ["pi", "claude-code"] as const) {
    const root = mkdtempSync(join(tmpdir(), "dahrk-sr-escape-"));
    const repo = join(root, "repo");
    execFileSync("mkdir", ["-p", repo]);
    initRepo(repo);

    const progress: JobProgress[] = [];
    const sink: TraceSink = {
      event: () => undefined,
      finalised: () => undefined,
      requestBlobUrl: async (req) => ({ key: `k/${req.sha256}` }),
    };
    const runner = createStageRunner({
      gitService: createGitService({ worktreesDir: join(root, "wt"), mirrorsDir: join(root, "mir") }),
      makeRunner: (rt) => makeEscapingRunner(rt, false),
      rules: [],
      sendProgress: (p) => void progress.push(p),
      trace: sink,
    });

    try {
      const result = await runner.runJob(mkEscapeJob(runtime, repo, `escape-${runtime}`));
      assert.equal(result.status, "fail", `${runtime}: an unblockable confinement escape hard-fails the stage`);
      assert.ok(escapeSurfaced(progress), `${runtime}: the escape is surfaced to the human`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

forBothRuntimes("repeated identical policy denials surface only one human-visible error (DHK-493)", async (runtime) => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-sr-denyspam-"));
  const repo = join(root, "repo");
  execFileSync("mkdir", ["-p", repo]);
  initRepo(repo);

  const streamed: TraceEvent[] = [];
  const progress: JobProgress[] = [];
  const sink: TraceSink = {
    event: (f) => void streamed.push(f.event),
    finalised: () => undefined,
    requestBlobUrl: async (req) => ({ key: `k/${req.sha256}` }),
  };

  // A runner that attempts the SAME denied command several times, as a capped or looping agent would.
  const makeSpammingRunner = (rt: Runner["runtime"]): Runner => ({
    runtime: rt,
    async runBatch(ctx) {
      const authorize = (ctx as RunnerContext & { authorizeToolUse?: (tool: string, input: unknown) => { verdict: string } })
        .authorizeToolUse;
      for (let i = 0; i < 5; i++) {
        const verdict = authorize?.("Bash", { command: "sudo true" });
        assert.equal(verdict?.verdict, "deny");
      }
      return { status: "ok" };
    },
    async runInteractive() {
      return { status: "ok", summary: "n/a" };
    },
    async summarise() {
      return "n/a";
    },
    async cancel() {},
  });

  const runner = createStageRunner({
    gitService: createGitService({ worktreesDir: join(root, "wt"), mirrorsDir: join(root, "mir") }),
    makeRunner: makeSpammingRunner,
    rules: [],
    sendProgress: (p) => void progress.push(p),
    trace: sink,
  });

  const job: JobRequest = {
    tenantId: "t_default",
    runId: "run-denyspam-1",
    stageId: "build",
    jobId: "job-denyspam-1",
    awakeableId: "awk-denyspam",
    executorType: "worktree",
    agentConfig: { runtime, interaction: "batch" },
    workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
    policies: [{ shell_guard: { mode: "deny" } }],
    timeout: 60,
  };

  try {
    const result = await runner.runJob(job);
    assert.equal(result.status, "ok");
    // Every deny is still recorded in the trace (observability is unchanged)...
    const denyEvents = streamed.filter((e) => e.type === "state" && (e as { event?: string }).event === "policy-deny");
    assert.equal(denyEvents.length, 5, "each denied action is recorded once in the trace");
    // ...but the human-visible error frame (which becomes a Linear comment) is collapsed to one.
    const errorFrames = progress.filter((p) => p.kind === "error" && /shell command blocked/.test(p.text ?? ""));
    assert.equal(errorFrames.length, 1, "the same deny reason surfaces at most one comment per stage");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact resolution rejects paths that escape the worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-artifact-"));
  const worktreePath = join(root, "worktree");
  const scratchPath = join(worktreePath, ".dahrk", "scratch");
  execFileSync("mkdir", ["-p", scratchPath]);
  initRepo(worktreePath);
  writeFileSync(join(root, "secret.md"), "outside");

  const ref = { repoId: "repo", gitUrl: "u", repo: "repo", baseBranch: "main", worktreePath, scratchPath };

  try {
    assert.equal(resolveStageArtifact(ref, "../secret.md", undefined), undefined);
    assert.equal(resolveStageArtifact(ref, undefined, { path: "../secret.md", content: "handoff" }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A recording GitService stub: enough surface for the runPush routing tests, no real git. */
function recordingGitService() {
  const calls: { method: string; branch?: string }[] = [];
  const ref = { repoId: "repo", gitUrl: "u", repo: "repo", baseBranch: "main", worktreePath: "/tmp/wt", scratchPath: "/tmp/wt/.dahrk" };
  const svc = {
    createWorktree: async (spec: { branch?: string }) => {
      calls.push({ method: "createWorktree", ...(spec.branch ? { branch: spec.branch } : {}) });
      return ref;
    },
    commitAndPush: async (_r: unknown, opts: { branch: string }) => {
      calls.push({ method: "commitAndPush", branch: opts.branch });
      return { headSha: "deadbeef1234567", pushed: true, nothingToCommit: false, commitsAhead: 1, integration: "clean" as const };
    },
    backupPush: async (_r: unknown, opts: { branch: string }) => {
      calls.push({ method: "backupPush", branch: opts.branch });
      return { headSha: "cafebabe7654321", pushed: true, nothingToCommit: false, wipRef: opts.branch };
    },
    openPrAmbient: async () => ({ prError: "not exercised" }),
    teardownWorktree: async () => undefined,
  };
  return { svc, calls };
}

const mkPushJob = (over: Partial<PushJob> & { mode?: "deliver" | "backup" }): PushJob => ({
  tenantId: "t_default",
  runId: "run-push-1",
  jobId: "job-push-1",
  awakeableId: "awk-push",
  workspaceRef: { repoId: "repo", gitUrl: "u", repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
  branch: "dahrk/issue-PUSH",
  base: "main",
  message: "deliver",
  ...over,
});

test("runPush mode:backup routes to backupPush on the sticky worktree and returns wipRef", async () => {
  const { svc, calls } = recordingGitService();
  const runner = createStageRunner({ gitService: svc as never, makeRunner: createMockRunner, rules: [], sendProgress: () => undefined });

  // A first deliver push seeds the run's sticky worktree (via the createWorktree fallback).
  await runner.runPush(mkPushJob({ jobId: "job-deliver", branch: "dahrk/issue-PUSH" }));
  assert.ok(calls.some((c) => c.method === "commitAndPush"), "deliver took the commitAndPush path");

  // The backup push reuses that worktree and force-preserves HEAD on the wip ref - no commitAndPush.
  const wipRef = "dahrk/wip/run-push-1";
  const before = calls.length;
  const res = await runner.runPush(mkPushJob({ jobId: "job-backup", mode: "backup", branch: wipRef, message: "preserve" }));
  const backupCalls = calls.slice(before);

  assert.equal(res.status, "ok");
  assert.equal((res as { wipRef?: string }).wipRef, wipRef, "the preserved ref is echoed back");
  assert.equal(res.pushed, true);
  assert.equal(res.headSha, "cafebabe7654321");
  assert.deepEqual(backupCalls, [{ method: "backupPush", branch: wipRef }], "only backupPush ran (no merge, no PR)");
});

test("runPush forwards a `noop` integration as a clean, non-error no-op (no PR, no conflictFiles)", async () => {
  // DHK-318: commitAndPush reports `noop` when the branch adds nothing over the base. The runner must
  // close the push as a successful no-op - status ok, nothing pushed, no PR opened, no conflictFiles -
  // so the run reaches a non-error terminal state.
  const calls: string[] = [];
  const ref = { repoId: "repo", gitUrl: "u", repo: "repo", baseBranch: "main", worktreePath: "/tmp/wt", scratchPath: "/tmp/wt/.dahrk" };
  const svc = {
    createWorktree: async () => ref,
    commitAndPush: async () => {
      calls.push("commitAndPush");
      return { headSha: "deadbeef1234567", pushed: false, nothingToCommit: true, commitsAhead: 0, integration: "noop" as const };
    },
    backupPush: async () => ({ headSha: "x", pushed: false, nothingToCommit: true, wipRef: "w" }),
    openPrAmbient: async () => {
      calls.push("openPrAmbient");
      return {};
    },
    teardownWorktree: async () => undefined,
  };
  const runner = createStageRunner({ gitService: svc as never, makeRunner: createMockRunner, rules: [], sendProgress: () => undefined });

  const res = await runner.runPush(mkPushJob({ jobId: "job-noop", openPr: { title: "t", body: "b" } }));
  assert.equal(res.status, "ok", "a no-op is a non-error terminal outcome");
  assert.equal(res.pushed, false);
  assert.equal(res.nothingToCommit, true);
  assert.equal((res as { conflictFiles?: string[] }).conflictFiles, undefined, "no conflictFiles on a no-op");
  assert.ok(!calls.includes("openPrAmbient"), "no PR is opened when nothing was delivered");
  assert.match(res.summary, /already present/);
});

test("runPush mode:backup fails truthfully when the run has no live worktree", async () => {
  const { svc, calls } = recordingGitService();
  const runner = createStageRunner({ gitService: svc as never, makeRunner: createMockRunner, rules: [], sendProgress: () => undefined });

  // No prior stage/deliver for this run, so the sticky worktree is absent. Backup must NOT re-clone the
  // branch (that would push the base tip and lose the work) - it fails, preserving nothing silently.
  const res = await runner.runPush(mkPushJob({ runId: "run-missing", jobId: "job-backup-miss", mode: "backup", branch: "dahrk/wip/run-missing" }));
  assert.equal(res.status, "fail");
  assert.match(res.summary, /no live worktree/);
  assert.equal(calls.length, 0, "neither backupPush nor createWorktree was called");
});

forBothRuntimes("DHK-371: a job that throws before `finish` must not leave the run marked busy for ever", async (runtime) => {
  // The leak: `inFlight` was incremented at job start but only decremented inside `finish`, which a throw
  // before it (e.g. `createWorktree` failing on a stale branch claim) skipped entirely. The run then stayed
  // "busy" for the life of the process, so every reaper/retention pass keyed on `isBusy` skipped it -
  // precisely the runs that most needed collecting, and precisely the ones whose worktree was wedging the
  // next run of the same issue.
  const root = mkdtempSync(join(tmpdir(), "dahrk-busy-"));
  const repo = join(root, "repo");
  execFileSync("mkdir", ["-p", repo]);
  initRepo(repo);

  const gitService = createGitService({ worktreesDir: join(root, "wt"), mirrorsDir: join(root, "mir") });
  const exploding = {
    ...gitService,
    createWorktree: async () => {
      throw new Error("fatal: 'dahrk/issue-DHK-1' is already used by worktree at /somewhere/stale");
    },
  };

  const runner = createStageRunner({
    gitService: exploding as never,
    makeRunner: createMockRunner,
    rules: [],
    sendProgress: () => undefined,
  });

  const job: JobRequest = {
    tenantId: "t_default",
    runId: "run-explode",
    stageId: "build",
    jobId: "job-explode",
    awakeableId: "awk-explode",
    executorType: "worktree",
    agentConfig: { runtime, interaction: "batch", tools: ["shell"] },
    workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
    timeout: 60,
  };

  try {
    assert.equal(runner.isBusy("run-explode"), false, "precondition: not busy before the job");
    await assert.rejects(() => runner.runJob(job), /already used by worktree/);
    assert.equal(
      runner.isBusy("run-explode"),
      false,
      "the in-flight marker is released even though the job threw before `finish`",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

forBothRuntimes("action and observation progress frames carry a shared toolUseId through a parallel/deferred sequence", async (runtime) => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-sr-corr-"));
  const repo = join(root, "repo");
  const worktrees = join(root, "wt");
  execFileSync("mkdir", ["-p", repo]);
  initRepo(repo);

  // A runner mimicking parallel/deferred tools: two tool calls are issued before either result
  // arrives, and the results return out of call order (B before A). Adjacency alone would mis-pair
  // action A with observation B; only the toolUseId makes correlation robust (DHK-384). tu-A's output
  // is > PREVIEW (500) chars to prove a result is no longer clipped mid-content.
  const bigOutput = "x".repeat(2000);
  const makeInterleavedRunner = (rt: Runner["runtime"]): Runner => ({
    runtime: rt,
    async runBatch(_ctx: RunnerContext, onTrace: (event: TraceEvent) => void) {
      const ts = new Date().toISOString();
      const events: TraceEvent[] = [
        { seq: 0, runtime: rt, type: "action", ts, tool: "ToolSearch", toolUseId: "tu-A", input: { q: "A" } },
        { seq: 1, runtime: rt, type: "action", ts, tool: "Read", toolUseId: "tu-B", input: { q: "B" } },
        { seq: 2, runtime: rt, type: "observation", ts, toolUseId: "tu-B", output: { ok: "B" } },
        { seq: 3, runtime: rt, type: "observation", ts, toolUseId: "tu-A", output: bigOutput },
        { seq: 4, runtime: rt, type: "response", ts, text: "done" },
      ];
      for (const event of events) onTrace(event);
      return { status: "ok" };
    },
    async runInteractive() {
      return { status: "ok", summary: "unused" };
    },
    async summarise() {
      return "mock summary";
    },
    async cancel() {},
  });

  const captured: (JobProgress & { toolUseId?: string })[] = [];
  const runner = createStageRunner({
    gitService: createGitService({ worktreesDir: worktrees, mirrorsDir: join(root, "mir") }),
    makeRunner: makeInterleavedRunner,
    rules: [],
    sendProgress: (p) => void captured.push(p),
  });

  const job: JobRequest = {
    tenantId: "t_default",
    runId: "run-corr-1",
    stageId: "build",
    jobId: "job-corr-1",
    awakeableId: "awk-corr",
    executorType: "worktree",
    agentConfig: { runtime, interaction: "batch", tools: ["shell"] },
    workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
    timeout: 60,
  };

  try {
    const result = await runner.runJob(job);
    assert.equal(result.status, "ok");

    const actions = captured.filter((p) => p.kind === "action");
    const observations = captured.filter((p) => p.kind === "observation");
    assert.deepEqual(actions.map((p) => p.toolUseId), ["tu-A", "tu-B"], "every action frame carries its toolUseId");
    assert.deepEqual(
      observations.map((p) => p.toolUseId),
      ["tu-B", "tu-A"],
      "every observation frame carries its toolUseId, in emission order",
    );

    // Pair by id, not adjacency: tu-A's result arrives after tu-B's, yet still resolves to action A.
    const actA = actions.find((p) => p.toolUseId === "tu-A");
    const obsA = observations.find((p) => p.toolUseId === "tu-A");
    assert.ok(actA && obsA, "both the action and observation for tu-A were emitted");
    assert.equal(obsA!.toolUseId, actA!.toolUseId, "an action and its observation share a toolUseId");

    // The 2000-char result survives whole (RESULT cap), not clipped to the 500-char PREVIEW.
    assert.equal(obsA!.text, bigOutput, "the observation result is transmitted whole, not truncated at 500");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

forBothRuntimes("a repo `setup` step runs in the worktree before the agent, and is folded into the trace (DHK-731)", async (runtime) => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-sr-setup-"));
  const repo = join(root, "repo");
  const worktrees = join(root, "wt");
  execFileSync("mkdir", ["-p", repo]);
  initRepo(repo);

  const streamed: TraceEvent[] = [];
  const sink: TraceSink = {
    event: (f) => void streamed.push(f.event),
    finalised: () => undefined,
    requestBlobUrl: async (req) => ({ key: `k/${req.sha256}` }),
  };

  const runner = createStageRunner({
    gitService: createGitService({ worktreesDir: worktrees, mirrorsDir: join(root, "mir") }),
    makeRunner: createMockRunner,
    rules: [],
    sendProgress: () => undefined,
    trace: sink,
  });

  // The setup command installs deps in-tree (here, leaves a marker file the way `pnpm install` would).
  const job = {
    tenantId: "t_default",
    runId: "run-setup-ok",
    stageId: "build",
    jobId: "job-setup-ok",
    awakeableId: "awk-setup-ok",
    executorType: "worktree",
    agentConfig: { runtime, interaction: "batch", tools: ["shell"] },
    // `setup` rides the WorkspaceRef, which is where the hub attaches it and where
    // `@dahrk/contracts` declares it. Setting it at the Job ROOT (as this test used to) is what
    // kept DHK-731 dead in production invisible to CI: the node read the root too, and
    // `undefined?.command` is merely falsy.
    workspaceRef: {
      repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "",
      setup: { command: "mkdir -p node_modules && echo done > node_modules/.installed" },
    },
    timeout: 60,
  } as unknown as JobRequest;

  try {
    const result = await runner.runJob(job);
    assert.equal(result.status, "ok", "the stage succeeds with a buildable tree");
    assert.ok(
      existsSync(join(worktrees, "run-setup-ok", "node_modules", ".installed")),
      "setup ran in the worktree before the agent, so node_modules is present",
    );
    assert.ok(
      streamed.some((e) => e.type === "state" && (e as { event?: string }).event === "setup"),
      "setup's outcome is folded into the trace as a state event",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

forBothRuntimes("a failing repo `setup` fails the stage cleanly before the agent runs (DHK-731)", async (runtime) => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-sr-setup-fail-"));
  const repo = join(root, "repo");
  const worktrees = join(root, "wt");
  execFileSync("mkdir", ["-p", repo]);
  initRepo(repo);

  const streamed: TraceEvent[] = [];
  const progress: JobProgress[] = [];
  const sink: TraceSink = {
    event: (f) => void streamed.push(f.event),
    finalised: () => undefined,
    requestBlobUrl: async (req) => ({ key: `k/${req.sha256}` }),
  };

  // A runner that would return ok if it ever ran; setup must fail the stage BEFORE it is constructed,
  // so the agent never touches the broken tree.
  let ranAgent = false;
  const makeGuardRunner = (rt: Runner["runtime"]): Runner => ({
    runtime: rt,
    async runBatch() {
      ranAgent = true;
      return { status: "ok" };
    },
    async runInteractive() {
      ranAgent = true;
      return { status: "ok", summary: "n/a" };
    },
    async summarise() {
      return "n/a";
    },
    async cancel() {},
  });

  const runner = createStageRunner({
    gitService: createGitService({ worktreesDir: worktrees, mirrorsDir: join(root, "mir") }),
    makeRunner: makeGuardRunner,
    rules: [],
    sendProgress: (p) => void progress.push(p),
    trace: sink,
  });

  const job = {
    tenantId: "t_default",
    runId: "run-setup-fail",
    stageId: "build",
    jobId: "job-setup-fail",
    awakeableId: "awk-setup-fail",
    executorType: "worktree",
    agentConfig: { runtime, interaction: "batch", tools: ["shell"] },
    // `setup` rides the WorkspaceRef, which is where the hub attaches it and where
    // `@dahrk/contracts` declares it. Setting it at the Job ROOT (as this test used to) is what
    // kept DHK-731 dead in production invisible to CI: the node read the root too, and
    // `undefined?.command` is merely falsy.
    workspaceRef: {
      repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "",
      setup: { command: "echo cannot install >&2; exit 1" },
    },
    timeout: 60,
  } as unknown as JobRequest;

  try {
    const result = await runner.runJob(job);
    assert.equal(result.status, "fail", "a broken setup fails the stage");
    assert.equal(result.failureClass, "harness", "a pre-agent provisioning failure is the harness's, not the agent's");
    assert.equal(ranAgent, false, "the agent runner is never constructed on a broken tree");
    // The distinct `setup-failed` error frame is recorded in the trace archive (like provision-failed /
    // hook-failed), and surfaced to the hub as a legible progress error - not stumbled into by the agent.
    const traceLines = execFileSync("grep", ["-rh", "setup-failed", join(worktrees, "run-setup-fail", ".dahrk", "scratch", "traces")], { encoding: "utf8" });
    assert.match(traceLines, /"kind":"setup-failed"/, "the trace carries a distinct `setup-failed` error kind");
    assert.ok(
      progress.some((p) => p.kind === "error" && /repo setup failed/.test(p.text ?? "")),
      "the failure is surfaced to the hub as a legible progress error",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

forBothRuntimes("no repo `setup` means no setup trace frames and no behaviour change (DHK-731)", async (runtime) => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-sr-setup-absent-"));
  const repo = join(root, "repo");
  const worktrees = join(root, "wt");
  execFileSync("mkdir", ["-p", repo]);
  initRepo(repo);

  const streamed: TraceEvent[] = [];
  const sink: TraceSink = {
    event: (f) => void streamed.push(f.event),
    finalised: () => undefined,
    requestBlobUrl: async (req) => ({ key: `k/${req.sha256}` }),
  };

  const runner = createStageRunner({
    gitService: createGitService({ worktreesDir: worktrees, mirrorsDir: join(root, "mir") }),
    makeRunner: createMockRunner,
    rules: [],
    sendProgress: () => undefined,
    trace: sink,
  });

  const job: JobRequest = {
    tenantId: "t_default",
    runId: "run-setup-absent",
    stageId: "build",
    jobId: "job-setup-absent",
    awakeableId: "awk-setup-absent",
    executorType: "worktree",
    agentConfig: { runtime, interaction: "batch", tools: ["shell"] },
    workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
    timeout: 60,
  };

  try {
    const result = await runner.runJob(job);
    assert.equal(result.status, "ok");
    // The unchanged event tape: attempt-start + mock (4) + stage-exit = 6, with no setup frame.
    assert.equal(streamed.length, 6, "no extra frames when setup is absent");
    assert.ok(!streamed.some((e) => (e as { event?: string }).event === "setup"), "no setup state frame");
    assert.ok(!streamed.some((e) => (e as { kind?: string }).kind === "setup-failed"), "no setup-failed error frame");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the node MCP gateway starts for both brokered-MCP runtimes (claude-code and pi), not codex (DHK-507)", () => {
  // The gateway holds the brokered token and injects it upstream; a runtime with no MCP client can
  // never route through it. Claude consumes brokered MCP via the SDK, Pi via its extension bridge;
  // Codex has no MCP in its SDK, so a proxy for it would be dead weight.
  assert.equal(runtimeUsesMcpGateway("claude-code"), true);
  assert.equal(runtimeUsesMcpGateway("pi"), true);
  assert.equal(runtimeUsesMcpGateway("codex"), false);
});

// --- the refused-credential latch ------------------------------------------------------------------
//
// Link 2 of the chain (DHK-998): `runBatchLoop` writes the refusal-prefixed summary, the stage runner
// carries it into `finish`, and the latch decides. The latch's own rule is covered exhaustively in
// `credential-latch.test.ts` and the summary SHAPE is pinned at its source in the executor package's
// `shared-loop.test.ts`. What is proven here is only the wiring between them - the part that stays
// green while silently doing nothing if the evidence is assembled wrong.

/** A runner that terminates a batch stage with a caller-chosen status and summary. */
function makeSettlingRunner(status: "ok" | "fail", summary: string): (rt: Runtime) => Runner {
  return (rt) => ({
    runtime: rt,
    async runBatch() {
      return { status, summary } as Awaited<ReturnType<Runner["runBatch"]>>;
    },
    async runInteractive() {
      return { status, summary };
    },
    async summarise() {
      return summary;
    },
    async cancel() {},
  });
}

/** Drive one batch Job through a real stage runner with an injected latch, and hand back the latch. */
async function runJobWithLatch(opts: {
  runtime: Runtime;
  status: "ok" | "fail";
  summary: string;
  isCheck?: boolean;
  interaction?: "batch" | "interactive";
  latch?: ReturnType<typeof createCredentialLatch>;
}): Promise<ReturnType<typeof createCredentialLatch>> {
  const root = mkdtempSync(join(tmpdir(), "dahrk-sr-latch-"));
  const repo = join(root, "repo");
  execFileSync("mkdir", ["-p", repo]);
  initRepo(repo);
  const latch = opts.latch ?? createCredentialLatch();

  const runner = createStageRunner({
    gitService: createGitService({ worktreesDir: join(root, "wt"), mirrorsDir: join(root, "mir") }),
    makeRunner: makeSettlingRunner(opts.status, opts.summary),
    makeCheckRunner: () => makeSettlingRunner(opts.status, opts.summary)("claude-code"),
    rules: [],
    sendProgress: () => undefined,
    latch,
  });

  const job: JobRequest = {
    tenantId: "t_default",
    runId: `run-latch-${Math.round(performance.now() * 1000)}`,
    stageId: "build",
    jobId: `job-latch-${Math.round(performance.now() * 1000)}`,
    awakeableId: "awk-latch",
    executorType: "worktree",
    // `kind` is load-bearing: `isCheckJob` requires it, so that a Job dispatched before check stages
    // existed (no `kind`) is never misread as a check.
    ...(opts.isCheck
      ? { kind: "check" as const, checks: [{ name: "test", command: "true" }] }
      : { agentConfig: { runtime: opts.runtime, interaction: opts.interaction ?? "batch", tools: ["shell"] } }),
    workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
    timeout: 60,
  } as JobRequest;

  try {
    await runner.runJob(job);
    return latch;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

forBothRuntimes("a stage that fails on a refused credential latches the runtime", async (runtime) => {
  // Without this wiring the node keeps advertising a runtime the provider has already refused, and
  // burns one run per attempt at $0.00, each billed to the agent.
  const latch = await runJobWithLatch({
    runtime,
    status: "fail",
    summary: `${REFUSED_CREDENTIAL_SUMMARY}: 401 OAuth access token has been revoked`,
  });
  assert.equal(latch.isRefused(runtime), true, "the stage runner fed the latch its evidence");
});

forBothRuntimes("an ordinary stage failure does not latch the runtime", async (runtime) => {
  const latch = await runJobWithLatch({ runtime, status: "fail", summary: "build: fail" });
  assert.equal(latch.isRefused(runtime), false, "a failed task says nothing about the credential");
});

forBothRuntimes("a later successful stage clears a standing refusal", async (runtime) => {
  const latch = createCredentialLatch();
  await runJobWithLatch({
    runtime,
    status: "fail",
    summary: `${REFUSED_CREDENTIAL_SUMMARY}: 401`,
    latch,
  });
  assert.equal(latch.isRefused(runtime), true, "latched to begin with");

  await runJobWithLatch({ runtime, status: "ok", summary: "build: ok", latch });
  assert.equal(latch.isRefused(runtime), false, "a re-credentialled pool recovers with no restart");
});

test("a check stage runs to a result rather than throwing (DHK-1017) [claude-code]", async () => {
  // Single-runtime: a check job has no runtime at all, so there is nothing to drive twice.
  //
  // Regression guard. `runJob` used to read `agentConfig.stallMs` unconditionally when arming the batch
  // stall watchdog; a check job has NO `agentConfig` (the contract narrows it away - see `isCheckJob`),
  // so every check stage dispatched to a node died with `TypeError` before one check command ran. It
  // survived release because this suite had no check-job test at all.
  const latch = await runJobWithLatch({
    runtime: "claude-code",
    status: "ok",
    summary: "checks passed",
    isCheck: true,
  });
  // Reaching here at all is the assertion that matters; the latch state below is the behaviour the
  // crash was hiding.
  assert.equal(latch.isRefused("claude-code"), false);
});

test("a passing check stage does not clear a standing refusal [claude-code]", async () => {
  // A check runs no agent and holds no credential, so it cannot authenticate. If it looked like a
  // success to the latch, one green check stage would put a runtime with a dead credential back on the
  // air. Covered at the latch's own interface too; this proves the stage runner hands it the evidence
  // that lets it tell the difference.
  const latch = createCredentialLatch();
  await runJobWithLatch({
    runtime: "claude-code",
    status: "fail",
    summary: `${REFUSED_CREDENTIAL_SUMMARY}: 401`,
    latch,
  });
  assert.equal(latch.isRefused("claude-code"), true, "latched to begin with");

  await runJobWithLatch({ runtime: "claude-code", status: "ok", summary: "checks passed", isCheck: true, latch });
  assert.equal(latch.isRefused("claude-code"), true, "a passing check is not an authentication");
});

forBothRuntimes("an INTERACTIVE stage refused a credential latches too (DHK-1018)", async (runtime) => {
  // The interactive loop used to report `ok` for a refused credential, which reaches the latch as an
  // acceptance and CLEARS a standing refusal. Both interaction modes must produce the same verdict:
  // the credential is a property of the node's pool, not of how the stage talks to a human.
  const latch = await runJobWithLatch({
    runtime,
    interaction: "interactive",
    status: "fail",
    summary: `${REFUSED_CREDENTIAL_SUMMARY}: 401 OAuth access token has been revoked`,
  });
  assert.equal(latch.isRefused(runtime), true);
});

forBothRuntimes("an interactive refusal does not clear an existing refusal (DHK-1018)", async (runtime) => {
  const latch = createCredentialLatch();
  await runJobWithLatch({ runtime, status: "fail", summary: `${REFUSED_CREDENTIAL_SUMMARY}: 401`, latch });
  await runJobWithLatch({
    runtime,
    interaction: "interactive",
    status: "fail",
    summary: `${REFUSED_CREDENTIAL_SUMMARY}: 401`,
    latch,
  });
  assert.equal(latch.isRefused(runtime), true, "a second refusal is still a refusal, not a reset");
});

// The `runtime-detect` probe (replacing `command -v claude`). Driven through a real stage runner so
// the probe TABLE wiring is proven too, not just the predicate: the previous defect was never in the
// predicate, it was in what the hub asked and what the node answered drifting apart.
async function captureRuntimeProbe(
  probeRuntimes: Runtime[] | undefined,
  statuses: Array<{ runtime: Runtime; capable: boolean; detail: string }>,
): Promise<{ ok: boolean; output: string; exitCode: number | null }> {
  const root = mkdtempSync(join(tmpdir(), "dahrk-sr-rt-"));
  const repo = join(root, "repo");
  execFileSync("mkdir", ["-p", repo]);
  initRepo(repo);

  let probes: Record<string, (c: unknown) => Promise<{ ok: boolean; output: string; exitCode: number | null }>> = {};
  const runner = createStageRunner({
    gitService: createGitService({ worktreesDir: join(root, "wt"), mirrorsDir: join(root, "mir") }),
    makeRunner: makeSettlingRunner("ok", "ok"),
    makeCheckRunner: (_checks, _onOutcomes, p) => {
      probes = (p ?? {}) as typeof probes;
      return makeSettlingRunner("ok", "checks: ok")("claude-code");
    },
    // Injected, so the test never has to add or remove a package from node_modules to make a runtime
    // look present or absent.
    probeRuntimes: async () =>
      statuses.map((s) => ({ ...s, credential: "brokered" as const, available: s.capable })),
    rules: [],
    sendProgress: () => undefined,
  });

  const check = { name: "agent-runtime", command: "true", probe: "runtime-detect" as const, ...(probeRuntimes ? { probeRuntimes } : {}) };
  const job = {
    tenantId: "t_default",
    runId: "run-rt-1",
    stageId: "checks",
    jobId: "job-rt-1",
    awakeableId: "awk-rt",
    executorType: "worktree",
    kind: "check" as const,
    checks: [check],
    workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
    timeout: 60,
  } as unknown as JobRequest;

  try {
    await runner.runJob(job);
    const handler = probes["runtime-detect"];
    assert.ok(handler, "the stage runner offers a runtime-detect probe");
    return await handler(check);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("runtime-detect passes when every asserted runtime is executable here", async () => {
  const r = await captureRuntimeProbe(["pi"], [
    { runtime: "claude-code", capable: true, detail: "brokered credentials from the hub" },
    { runtime: "pi", capable: true, detail: "brokered credentials from the hub" },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /pi: executable/);
  // Only what was asserted is reported, so an openai-codex tenant's report never mentions Claude.
  assert.doesNotMatch(r.output, /claude-code/);
});

test("runtime-detect fails naming the runtime that cannot run, and why", async () => {
  const r = await captureRuntimeProbe(["claude-code"], [
    { runtime: "claude-code", capable: false, detail: "cannot run here: @anthropic-ai/claude-agent-sdk is not installed (reinstall dahrk-node)" },
    { runtime: "pi", capable: true, detail: "brokered credentials from the hub" },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
  assert.match(r.output, /claude-code: NOT executable/);
  assert.match(r.output, /reinstall dahrk-node/, "the operator is told the fix is a reinstall, not a login");
});

// How a tenant with nothing to assert emits a check that passes, rather than every caller carrying a
// special case. An unbound tenant must not be told its node is broken.
test("runtime-detect passes when nothing is asserted", async () => {
  for (const wanted of [[] as Runtime[], undefined]) {
    const r = await captureRuntimeProbe(wanted, [{ runtime: "pi", capable: false, detail: "absent" }]);
    assert.equal(r.ok, true, `empty assertion passes (${JSON.stringify(wanted)})`);
  }
});

// A newer hub can name a runtime this build has never heard of. "Absent from my own detection" is the
// honest answer; silently passing would advertise a capability that does not exist.
test("runtime-detect treats a runtime it does not know as missing", async () => {
  const r = await captureRuntimeProbe(["mystery" as Runtime], [{ runtime: "pi", capable: true, detail: "ok" }]);
  assert.equal(r.ok, false);
  assert.match(r.output, /does not know this runtime/);
});
