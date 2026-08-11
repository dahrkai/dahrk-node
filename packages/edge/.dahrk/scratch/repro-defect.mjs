// Throwaway reproduction (scratch only; not a repo source file).
// Proves: a batch runner that streams SDK messages via ctx.writeRaw() but whose
// messages normalise to ZERO trace events (so onTrace never fires) is killed by the
// stall watchdog - exactly the DHK-1136 production shape.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitService } from "@dahrk/executor-worktree";
import { createStageRunner } from "./../../src/stage-runner.ts";

const root = mkdtempSync(join(tmpdir(), "dahrk-repro-"));
const repo = join(root, "repo");
execFileSync("mkdir", ["-p", repo]);
const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
git("init", "-b", "main");
git("config", "user.email", "t@e.com");
git("config", "user.name", "T");
execFileSync("sh", ["-c", "echo hi > README.md"], { cwd: repo });
git("add", "."); git("commit", "-m", "init");

// A runner that is ALIVE: it "receives" one SDK message every 20ms for ~400ms, calling
// ctx.writeRaw(msg) each time (as the real Claude/Pi adapters do per message), but each
// message normalises to zero trace events, so onTrace is NEVER called. Then it finishes ok.
const makeLiveButQuietRunner = (rt) => ({
  runtime: rt,
  async runBatch(ctx /*, onTrace */) {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 20));
      ctx.writeRaw?.({ type: "stream_event", i }); // a real sign of life the watchdog cannot see
    }
    return { status: "ok" };
  },
  async runInteractive() { return { status: "ok" }; },
  async summarise() { return "done"; },
  async cancel() {},
});

const runner = createStageRunner({
  gitService: createGitService({ worktreesDir: join(root, "wt"), mirrorsDir: join(root, "mir") }),
  makeRunner: makeLiveButQuietRunner,
  rules: [],
  sendProgress: () => {},
  trace: { event: () => {}, finalised: () => {}, requestBlobUrl: async (r) => ({ key: r.sha256 }) },
});

const job = {
  tenantId: "t_default", runId: "run-repro", stageId: "build", jobId: "job-repro-1",
  awakeableId: "awk", executorType: "worktree",
  agentConfig: { runtime: "claude-code", interaction: "batch", tools: ["shell"] },
  workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
};

process.env.DAHRK_BATCH_STALL_MS = "100"; // 100ms window; the stage streams life for ~400ms
const res = await runner.runJob(job);
console.log("STATUS:", res.status, "| SUMMARY:", res.summary, "| failureClass:", res.failureClass);
console.log(res.status === "ok"
  ? "PASS: live stage survived (bug fixed)"
  : "BUG REPRODUCED: a live stage was killed by the stall watchdog");
rmSync(root, { recursive: true, force: true });
