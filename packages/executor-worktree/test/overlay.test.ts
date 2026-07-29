/**
 * overlay tests: project pinned components into a run's worktree per runtime. Claude writes files
 * under `.claude/` with repo-local precedence; Pi injects skills by path (no copy), reshapes commands
 * into `.pi/prompts/` templates, and warns-and-skips subagents (Pi ships none); other runtimes
 * warn-and-skip. Plus idempotency on re-dispatch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ComponentRef } from "@dahrk/contracts";
import { createPackCache, type ComponentBytes, type PackSource } from "../src/pack-cache.js";
import { overlayComponents, reshapeCommandToPiTemplate } from "../src/overlay.js";

const sha = (s: string): string => createHash("sha256").update(Buffer.from(s)).digest("hex");

function component(kind: ComponentRef["kind"], name: string, path: string, body: string): { ref: ComponentRef; bytes: ComponentBytes } {
  const fileSha = sha(body);
  const combined = createHash("sha256");
  combined.update(path);
  combined.update("\0");
  combined.update(fileSha);
  combined.update("\0");
  return {
    ref: { kind, name, version: "1.0.0", contentHash: `sha256:${combined.digest("hex")}` },
    bytes: { files: [{ path, bytes: Buffer.from(body), sha256: fileSha }] },
  };
}

function fixtureCache(...comps: { ref: ComponentRef; bytes: ComponentBytes }[]) {
  const map: Record<string, ComponentBytes> = {};
  for (const c of comps) map[c.ref.contentHash] = c.bytes;
  const source: PackSource = {
    async fetch(ref) {
      const b = map[ref.contentHash];
      if (!b) throw new Error(`no fixture for ${ref.contentHash}`);
      return b;
    },
  };
  const root = mkdtempSync(join(tmpdir(), "dahrk-cas-"));
  return createPackCache({ root, source });
}

test("Claude writes skill/command/agent files into the right .claude/ subdirs", async () => {
  const skill = component("skill", "review", ".claude/skills/review/SKILL.md", "review skill");
  const command = component("command", "ship", ".claude/commands/ship.md", "ship command");
  const agent = component("agent", "critic", ".claude/agents/critic.md", "critic agent");
  const cache = fixtureCache(skill, command, agent);
  const worktree = mkdtempSync(join(tmpdir(), "dahrk-wt-"));

  const res = await overlayComponents({
    worktreePath: worktree,
    runtime: "claude-code",
    components: [skill.ref, command.ref, agent.ref],
    cache,
  });

  assert.deepEqual(res.written.sort(), [
    ".claude/agents/critic.md",
    ".claude/commands/ship.md",
    ".claude/skills/review/SKILL.md",
  ]);
  assert.equal(res.skippedRepoLocal.length, 0);
  assert.equal(res.warnings.length, 0);
  assert.equal(readFileSync(join(worktree, ".claude/skills/review/SKILL.md"), "utf8"), "review skill");
});

test("a repo file at the same path is preserved (repo-local precedence) and reported", async () => {
  const skill = component("skill", "review", ".claude/skills/review/SKILL.md", "central skill");
  const cache = fixtureCache(skill);
  const worktree = mkdtempSync(join(tmpdir(), "dahrk-wt-"));
  const dest = join(worktree, ".claude/skills/review/SKILL.md");
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, "repo skill");

  const res = await overlayComponents({
    worktreePath: worktree,
    runtime: "claude-code",
    components: [skill.ref],
    cache,
  });

  assert.deepEqual(res.skippedRepoLocal, [".claude/skills/review/SKILL.md"]);
  assert.equal(res.written.length, 0);
  assert.equal(readFileSync(dest, "utf8"), "repo skill", "the repo's file must not be clobbered");
});

test("Codex warns and writes nothing", async () => {
  const skill = component("skill", "review", ".claude/skills/review/SKILL.md", "central skill");
  const cache = fixtureCache(skill);
  const worktree = mkdtempSync(join(tmpdir(), "dahrk-wt-"));

  const res = await overlayComponents({
    worktreePath: worktree,
    runtime: "codex",
    components: [skill.ref],
    cache,
  });

  assert.equal(res.written.length, 0);
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0]!, /codex runtime/);
  assert.equal(existsSync(join(worktree, ".claude/skills/review/SKILL.md")), false);
});

test("Pi skill is injected by path and copies nothing into the worktree", async () => {
  const skill = component("skill", "review", ".claude/skills/review/SKILL.md", "review skill body");
  const cache = fixtureCache(skill);
  const worktree = mkdtempSync(join(tmpdir(), "dahrk-wt-"));

  const res = await overlayComponents({
    worktreePath: worktree,
    runtime: "pi",
    components: [skill.ref],
    cache,
  });

  // Injected-by-path, not written: one entry, pointing at an existing CAS directory that holds the
  // skill's SKILL.md, and nothing copied into the worktree.
  assert.equal(res.injected.length, 1, "the skill is represented as injected-by-path");
  assert.equal(res.written.length, 0, "nothing is written to disk for a Pi skill");
  assert.equal(res.warnings.length, 0);
  assert.ok(existsSync(join(res.injected[0]!, "SKILL.md")), "the injected path is the skill's own directory");
  assert.equal(existsSync(join(worktree, ".claude/skills/review/SKILL.md")), false, "the worktree stays untouched");
});

test("Pi subagent warns with the accurate reason (Pi ships no subagents) and touches nothing", async () => {
  const agent = component("agent", "critic", ".claude/agents/critic.md", "critic agent");
  const cache = fixtureCache(agent);
  const worktree = mkdtempSync(join(tmpdir(), "dahrk-wt-"));

  const res = await overlayComponents({ worktreePath: worktree, runtime: "pi", components: [agent.ref], cache });

  assert.equal(res.warnings.length, 1, "exactly one warning");
  assert.match(res.warnings[0]!, /pi runtime/);
  assert.match(res.warnings[0]!, /critic/);
  // The reason must name the real cause (Pi ships no subagents), NOT the old "no components surface".
  assert.match(res.warnings[0]!, /ships no subagents/);
  assert.doesNotMatch(res.warnings[0]!, /no .*surface/i);
  assert.equal(res.written.length, 0);
  assert.equal(res.injected.length, 0);
  assert.equal(existsSync(join(worktree, ".claude/agents/critic.md")), false);
});

const CLAUDE_COMMAND = [
  "---",
  "description: Ship a release",
  "argument-hint: <version>",
  "allowed-tools: Bash",
  "model: opus",
  "---",
  "",
  "Ship version $1 now. Full args: $ARGUMENTS",
  "",
].join("\n");

test("reshapeCommandToPiTemplate keeps Pi's keys, drops Claude-only ones, preserves the body", () => {
  const out = reshapeCommandToPiTemplate(CLAUDE_COMMAND);

  // Pi reads `description` and `argument-hint`; they survive.
  assert.match(out, /description: Ship a release/);
  assert.match(out, /argument-hint: <version>/);
  // Claude-only frontmatter keys are dropped (Pi never reads them).
  assert.doesNotMatch(out, /allowed-tools/);
  assert.doesNotMatch(out, /^model:/m);
  // The body and its substitution tokens are untouched - a reshape, not a rewrite.
  assert.match(out, /Ship version \$1 now\. Full args: \$ARGUMENTS/);
});

test("reshapeCommandToPiTemplate passes a command with no frontmatter through unchanged", () => {
  const body = "Just a body, no frontmatter. Uses $1.\n";
  assert.equal(reshapeCommandToPiTemplate(body), body);
});

test("Pi command is reshaped into a .pi/prompts template with repo-local precedence and idempotence", async () => {
  const command = component("command", "ship", ".claude/commands/ship.md", CLAUDE_COMMAND);
  const cache = fixtureCache(command);
  const worktree = mkdtempSync(join(tmpdir(), "dahrk-wt-"));

  const res = await overlayComponents({ worktreePath: worktree, runtime: "pi", components: [command.ref], cache });

  // Written as a Pi prompt template, not injected, no warning.
  assert.deepEqual(res.written, [join(".pi", "prompts", "ship.md")]);
  assert.equal(res.injected.length, 0);
  assert.equal(res.warnings.length, 0);
  const onDisk = readFileSync(join(worktree, ".pi", "prompts", "ship.md"), "utf8");
  assert.match(onDisk, /argument-hint: <version>/, "the file on disk carries Pi-shaped frontmatter");
  assert.doesNotMatch(onDisk, /allowed-tools/, "Claude-only frontmatter is gone");
  assert.match(onDisk, /Ship version \$1 now/, "the body is preserved");

  // Idempotence: a second identical overlay writes nothing and is not a repo-local skip.
  const again = await overlayComponents({ worktreePath: worktree, runtime: "pi", components: [command.ref], cache });
  assert.equal(again.written.length, 0, "an identical re-overlay writes nothing");
  assert.equal(again.skippedRepoLocal.length, 0, "an identical re-overlay is not a repo-local skip");
});

test("a repo file at the Pi command's target path wins (repo-local precedence)", async () => {
  const command = component("command", "ship", ".claude/commands/ship.md", CLAUDE_COMMAND);
  const cache = fixtureCache(command);
  const worktree = mkdtempSync(join(tmpdir(), "dahrk-wt-"));
  const dest = join(worktree, ".pi", "prompts", "ship.md");
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, "repo template");

  const res = await overlayComponents({ worktreePath: worktree, runtime: "pi", components: [command.ref], cache });

  assert.deepEqual(res.skippedRepoLocal, [join(".pi", "prompts", "ship.md")]);
  assert.equal(res.written.length, 0);
  assert.equal(readFileSync(dest, "utf8"), "repo template", "the repo's template must not be clobbered");
});

test("a second overlay over identical bytes is idempotent (no clobber, no skip)", async () => {
  const skill = component("skill", "review", ".claude/skills/review/SKILL.md", "central skill");
  const cache = fixtureCache(skill);
  const worktree = mkdtempSync(join(tmpdir(), "dahrk-wt-"));

  const first = await overlayComponents({ worktreePath: worktree, runtime: "claude-code", components: [skill.ref], cache });
  assert.deepEqual(first.written, [".claude/skills/review/SKILL.md"]);

  const second = await overlayComponents({ worktreePath: worktree, runtime: "claude-code", components: [skill.ref], cache });
  assert.equal(second.written.length, 0, "an identical re-overlay writes nothing");
  assert.equal(second.skippedRepoLocal.length, 0, "an identical re-overlay is not a repo-local skip");
});
