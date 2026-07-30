/**
 * overlay tests: project pinned components into the worktree, normalised per runtime - Claude
 * materialises files under `.claude/` with repo-local precedence; Pi injects skills by path (no
 * copy), reshapes commands into `.pi/prompts/` prompt templates, and warns-and-skips subagents;
 * every other runtime (Codex) warns and writes nothing. Idempotent on re-dispatch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ComponentRef } from "@dahrk/contracts";
import { createPackCache, type ComponentBytes, type PackSource } from "../src/pack-cache.js";
import { overlayComponents, reshapeClaudeCommandToPi } from "../src/overlay.js";

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

test("Pi injects a pinned skill by path, copying nothing into the worktree", async () => {
  const skill = component("skill", "review", ".claude/skills/review/SKILL.md", "central skill");
  const cache = fixtureCache(skill);
  const worktree = mkdtempSync(join(tmpdir(), "dahrk-wt-"));

  const res = await overlayComponents({
    worktreePath: worktree,
    runtime: "pi",
    components: [skill.ref],
    cache,
  });

  // The skill is referenced by its verified CAS directory, never written into the worktree.
  const casDir = cache.pathFor(skill.ref.contentHash);
  assert.deepEqual(res.injected, [casDir]);
  assert.equal(res.written.length, 0);
  assert.equal(res.warnings.length, 0);
  assert.equal(res.skippedRepoLocal.length, 0);
  // The bytes live under the CAS dir Pi will scan, not in the worktree.
  assert.equal(existsSync(join(casDir, ".claude/skills/review/SKILL.md")), true);
  assert.equal(existsSync(join(worktree, ".claude/skills/review/SKILL.md")), false);
  assert.equal(existsSync(join(worktree, ".claude")), false);
});

test("Pi reshapes a pinned command into a .pi/prompts prompt template", async () => {
  const body = [
    "---",
    "description: Ship the change",
    "argument-hint: <version>",
    "allowed-tools: Bash",
    "model: opus",
    "---",
    "",
    "Ship version $ARGUMENTS now.",
  ].join("\n");
  const command = component("command", "ship", ".claude/commands/ship.md", body);
  const cache = fixtureCache(command);
  const worktree = mkdtempSync(join(tmpdir(), "dahrk-wt-"));

  const res = await overlayComponents({
    worktreePath: worktree,
    runtime: "pi",
    components: [command.ref],
    cache,
  });

  assert.deepEqual(res.written, [".pi/prompts/ship.md"]);
  assert.equal(res.injected.length, 0);
  assert.equal(res.warnings.length, 0);
  const written = readFileSync(join(worktree, ".pi/prompts/ship.md"), "utf8");
  // Pi's two prompt-template frontmatter keys carry across; Claude-only keys are dropped.
  assert.match(written, /description: Ship the change/);
  assert.match(written, /argument-hint: <version>/);
  assert.doesNotMatch(written, /allowed-tools/);
  assert.doesNotMatch(written, /model:/);
  // The body and its argument substitution are preserved verbatim.
  assert.match(written, /Ship version \$ARGUMENTS now\./);
  // Nothing is left under the Claude command path.
  assert.equal(existsSync(join(worktree, ".claude/commands/ship.md")), false);
});

test("Pi command overlay honours repo-local precedence and is idempotent", async () => {
  const body = "---\ndescription: Ship\n---\n\nShip $ARGUMENTS.";
  const command = component("command", "ship", ".claude/commands/ship.md", body);
  const cache = fixtureCache(command);
  const worktree = mkdtempSync(join(tmpdir(), "dahrk-wt-"));

  // A repo already shipping the template at the Pi path wins.
  const dest = join(worktree, ".pi/prompts/ship.md");
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, "repo template");
  const repoLocal = await overlayComponents({ worktreePath: worktree, runtime: "pi", components: [command.ref], cache });
  assert.deepEqual(repoLocal.skippedRepoLocal, [".pi/prompts/ship.md"]);
  assert.equal(repoLocal.written.length, 0);
  assert.equal(readFileSync(dest, "utf8"), "repo template");

  // A fresh worktree writes once, then a re-overlay of identical bytes is a no-op.
  const wt2 = mkdtempSync(join(tmpdir(), "dahrk-wt-"));
  const first = await overlayComponents({ worktreePath: wt2, runtime: "pi", components: [command.ref], cache });
  assert.deepEqual(first.written, [".pi/prompts/ship.md"]);
  const second = await overlayComponents({ worktreePath: wt2, runtime: "pi", components: [command.ref], cache });
  assert.equal(second.written.length, 0);
  assert.equal(second.skippedRepoLocal.length, 0);
});

test("Pi warns and skips a pinned subagent, naming the real reason", async () => {
  const agent = component("agent", "critic", ".claude/agents/critic.md", "critic agent");
  const cache = fixtureCache(agent);
  const worktree = mkdtempSync(join(tmpdir(), "dahrk-wt-"));

  const res = await overlayComponents({
    worktreePath: worktree,
    runtime: "pi",
    components: [agent.ref],
    cache,
  });

  assert.equal(res.written.length, 0);
  assert.equal(res.injected.length, 0);
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0]!, /critic/);
  // The reason is Pi's deliberate absence of subagents, not "no components surface".
  assert.match(res.warnings[0]!, /subagent/i);
  assert.match(res.warnings[0]!, /no subagents/i);
});

test("reshapeClaudeCommandToPi keeps Pi's frontmatter keys, drops Claude-only ones, relocates the path", () => {
  const src = [
    "---",
    "description: Do the thing",
    "argument-hint: <arg>",
    "allowed-tools: Bash, Read",
    "model: sonnet",
    "---",
    "",
    "Body with $1 and ${2:-fallback} and $ARGUMENTS.",
  ].join("\n");

  const out = reshapeClaudeCommandToPi(".claude/commands/thing.md", src);

  assert.equal(out.dest, ".pi/prompts/thing.md");
  assert.match(out.content, /^---\n/);
  assert.match(out.content, /description: Do the thing/);
  assert.match(out.content, /argument-hint: <arg>/);
  assert.doesNotMatch(out.content, /allowed-tools/);
  assert.doesNotMatch(out.content, /model:/);
  // Body and its positional/all-arg substitution + defaults survive untouched.
  assert.match(out.content, /Body with \$1 and \$\{2:-fallback\} and \$ARGUMENTS\./);
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
