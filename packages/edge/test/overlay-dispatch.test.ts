/**
 * The stage runner overlays a Job's pinned components into the worktree `.claude/` at dispatch when a
 * PackCache is configured: a Claude job materialises the files; a job with no `provision` is
 * unchanged; a Codex job surfaces warnings and writes nothing. Real worktree (git) + mock runner.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComponentRef, JobProgress, JobRequest } from "@dahrk/contracts";
import {
  createGitService,
  createMockRunner,
  createPackCache,
  type ComponentBytes,
  type PackSource,
} from "@dahrk/executor-worktree";
import { createStageRunner } from "../src/stage-runner.js";

function initRepo(dir: string): void {
  const git = (...args: string[]): void => void execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "Test");
  execFileSync("sh", ["-c", "echo hello > README.md"], { cwd: dir });
  git("add", ".");
  git("commit", "-m", "init");
}

const sha = (s: string): string => createHash("sha256").update(Buffer.from(s)).digest("hex");

function component(path: string, body: string): { ref: ComponentRef; bytes: ComponentBytes } {
  const fileSha = sha(body);
  const combined = createHash("sha256");
  combined.update(path);
  combined.update("\0");
  combined.update(fileSha);
  combined.update("\0");
  return {
    ref: { kind: "skill", name: "review", version: "1.0.0", contentHash: `sha256:${combined.digest("hex")}` },
    bytes: { files: [{ path, bytes: Buffer.from(body), sha256: fileSha }] },
  };
}

function setup(root: string) {
  const repo = join(root, "repo");
  execFileSync("mkdir", ["-p", repo]);
  initRepo(repo);
  const skill = component(".claude/skills/review/SKILL.md", "central review skill");
  const source: PackSource = {
    async fetch(ref) {
      if (ref.contentHash !== skill.ref.contentHash) throw new Error(`no fixture for ${ref.contentHash}`);
      return skill.bytes;
    },
  };
  const packCache = createPackCache({ root: join(root, "cas"), source });
  const progress: JobProgress[] = [];
  const runner = createStageRunner({
    gitService: createGitService({ worktreesDir: join(root, "wt"), mirrorsDir: join(root, "mir") }),
    makeRunner: createMockRunner,
    rules: [],
    sendProgress: (p) => void progress.push(p),
    packCache,
  });
  return { repo, skill, runner, progress };
}

function jobOf(repo: string, runtime: "claude-code" | "codex", provision?: ComponentRef[]): JobRequest {
  return {
    tenantId: "t_default",
    runId: `run-${runtime}`,
    stageId: "build",
    jobId: `job-${runtime}-1`,
    awakeableId: "awk-1",
    executorType: "worktree",
    agentConfig: { runtime, interaction: "batch", tools: ["shell"] },
    workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
    ...(provision ? { provision } : {}),
    timeout: 60,
  };
}

test("a Claude job overlays its pinned component into the worktree .claude/", async () => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-ovl-"));
  try {
    const { repo, skill, runner, progress } = setup(root);
    const result = await runner.runJob(jobOf(repo, "claude-code", [skill.ref]));
    assert.equal(result.status, "ok");
    const note = progress.find((p) => p.text?.includes("provision:"));
    assert.ok(note, "a provision progress note is surfaced");
    assert.match(note!.text!, /1 written/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a job with no provision runs unchanged (no provision note)", async () => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-ovl-"));
  try {
    const { repo, runner, progress } = setup(root);
    const result = await runner.runJob(jobOf(repo, "claude-code"));
    assert.equal(result.status, "ok");
    assert.equal(progress.some((p) => p.text?.includes("provision:")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Codex job surfaces a warning and writes nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-ovl-"));
  try {
    const { repo, skill, runner, progress } = setup(root);
    const result = await runner.runJob(jobOf(repo, "codex", [skill.ref]));
    assert.equal(result.status, "ok");
    const note = progress.find((p) => p.text?.includes("provision:"));
    assert.ok(note, "a provision note is surfaced even for codex");
    assert.match(note!.text!, /codex runtime/);
    assert.match(note!.text!, /0 written/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
