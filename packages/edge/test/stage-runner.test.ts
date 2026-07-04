/**
 * The stage runner streams its normalised trace to the observability sink as it runs
 * and finalises at stage exit. This exercises a real worktree (git) + the mock runner
 * and a capturing TraceSink, asserting: every event is streamed with a contiguous seq,
 * the finalised frame carries the authoritative count + archive key, and heavy payloads
 * are offered to the sink for upload. No hub, no network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobRequest, Runner, RunnerContext, TraceEvent, TraceMeta } from "@dahrk/contracts";
import { createGitService, createMockRunner } from "@dahrk/executor-worktree";
import { createStageRunner, type BlobPutRequestArgs, type TraceSink } from "../src/stage-runner.js";

function initRepo(dir: string): void {
  const git = (...args: string[]): void => void execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "Test");
  execFileSync("sh", ["-c", "echo hello > README.md"], { cwd: dir });
  git("add", ".");
  git("commit", "-m", "init");
}

test("stage runner streams the trace and finalises with count + archive key", async () => {
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
    agentConfig: { runtime: "claude-code", interaction: "batch", tools: ["shell"] },
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

test("a telemetry-only Job (no workspaceRef) runs in scratch with no clone attempted", async () => {
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
    agentConfig: { runtime: "claude-code", interaction: "batch", tools: ["shell"] },
    issueContext: "# Telemetry\n\nRun health: degraded.",
    timeout: 60,
  };

  try {
    const result = await runner.runJob(job);
    assert.equal(result.status, "ok", "the stage completes against injected telemetry + scratch");

    // The injected telemetry was written to the run's scratch dir, no git involved.
    const issuePath = join(scratchRoot, "run-meta-1", ".skakel", "scratch", "issue.md");
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

test("a matching-tenant Job runs normally under a tenant-bound node", async () => {
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
    agentConfig: { runtime: "claude-code", interaction: "batch", tools: ["shell"] },
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

test("retention tears down old run worktrees and keeps the newest", async () => {
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
    agentConfig: { runtime: "claude-code", interaction: "batch", tools: ["shell"] },
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

test("a stage that exceeds its timeout is killed and marked `timeout` (job.timeout kill)", async () => {
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
  const makeHangingRunner = (runtime: Runner["runtime"]): Runner => {
    let release: (() => void) | undefined;
    const aborted = new Promise<void>((r) => (release = r));
    return {
      runtime,
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
    agentConfig: { runtime: "claude-code", interaction: "batch", tools: ["shell"] },
    workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
    timeout: 0.05, // 50ms wall-clock; the hanging runner only completes when the kill fires cancel()
  };

  try {
    const result = await runner.runJob(job);
    assert.equal(result.status, "timeout", "the stage is killed at its timeout and reported `timeout`");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the Job's runtimeEnv is threaded onto the runner ctx (injection boundary)", async () => {
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
  const makeCapturingRunner = (runtime: Runner["runtime"]): Runner => ({
    runtime,
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

  const mkJob = (jobId: string, runtimeEnv?: Record<string, string>): JobRequest => ({
    tenantId: "t_default",
    runId: "run-sr-rtenv",
    stageId: "build",
    jobId,
    awakeableId: "awk-rtenv",
    executorType: "worktree",
    agentConfig: { runtime: "claude-code", interaction: "batch", tools: ["shell"] },
    workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
    timeout: 60,
    ...(runtimeEnv ? { runtimeEnv } : {}),
  });

  try {
    await runner.runJob(mkJob("job-rtenv-1", { ANTHROPIC_API_KEY: "sk-test", PI_MODEL: "claude-opus-4-8" }));
    assert.deepEqual(seen[0]?.runtimeEnv, { ANTHROPIC_API_KEY: "sk-test", PI_MODEL: "claude-opus-4-8" });

    await runner.runJob(mkJob("job-rtenv-2")); // no runtimeEnv -> absent on ctx (ambient node)
    assert.equal(seen[1]?.runtimeEnv, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
