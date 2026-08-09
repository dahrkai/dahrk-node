/**
 * `buildNodeHealthReport` (DHK-1059): folding the node's own checks into the wire report.
 *
 * The check builders themselves are covered by the CLI's `doctor`/`preflight` suites, which import them
 * from here now that there is one implementation rather than two. What is new, and what these cover, is
 * the FOLD: the verdict algebra, and the mapping of this module's three-value `CheckStatus` onto
 * preflight's section vocabulary.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildNodeHealthReport,
  isWritable,
  nearestExisting,
  type CheckResult,
} from "../src/node-health.js";

const pass = (label: string): CheckResult => ({ status: "pass", label, detail: "fine" });
const warn = (label: string): CheckResult => ({ status: "warn", label, detail: "a bit thin" });
const fail = (label: string): CheckResult => ({ status: "fail", label, detail: "broken" });

test("all passing is `ok`, with every row rendered", () => {
  const report = buildNodeHealthReport([pass("Node version"), pass("Free space")], 12, 1_700_000_000_000);

  assert.equal(report.verdict, "ok");
  assert.equal(report.sections.length, 2);
  assert.ok(report.sections.every((s) => s.status === "ok"));
  assert.equal(report.tookMs, 12);
  assert.equal(report.gatheredAt, 1_700_000_000_000);
});

// A warn is a limitation the node still runs with, so it maps to `skipped` rather than `finding`. That
// keeps the shared card honest: an amber row here means the same thing an amber row means in preflight.
test("a warn is a limitation, not a fault: `skipped`, verdict `findings`", () => {
  const report = buildNodeHealthReport([pass("Node version"), warn("docker")], 5, 0);

  assert.equal(report.verdict, "findings");
  assert.equal(report.sections.find((s) => s.label === "docker")?.status, "skipped");
});

// `unsound` is the state preflight has no equivalent for, and the whole reason `NodeHealthReport` is a
// separate type rather than a reuse of `PreflightReport`. A node with too old a runtime or an
// unwritable worktree root is not "healthy with findings" - no stage can run on it at all.
test("any fail makes the node `unsound`, even alongside passes and warns", () => {
  const report = buildNodeHealthReport([pass("Node version"), warn("docker"), fail("Worktree root")], 5, 0);

  assert.equal(report.verdict, "unsound");
  assert.equal(report.sections.find((s) => s.label === "Worktree root")?.status, "finding");
});

// A fail outranks a warn regardless of order, so the verdict cannot depend on the sequence the
// gatherer happened to push checks in.
test("the verdict is order-independent", () => {
  const checks = [fail("a"), warn("b"), pass("c")];
  const forward = buildNodeHealthReport(checks, 0, 0).verdict;
  const reversed = buildNodeHealthReport([...checks].reverse(), 0, 0).verdict;
  assert.equal(forward, reversed);
  assert.equal(forward, "unsound");
});

test("section ids are stable, machine-readable slugs of the label", () => {
  const report = buildNodeHealthReport([pass("Node version"), pass("Hub reachability"), pass("git")], 0, 0);
  assert.deepEqual(
    report.sections.map((s) => s.id),
    ["node-version", "hub-reachability", "git"],
  );
});

test("a check with no detail still renders one, rather than an empty cell", () => {
  const report = buildNodeHealthReport([{ status: "pass", label: "Service" }], 0, 0);
  assert.equal(report.sections[0]?.detail, "pass");
});

test("the read is the deterministic synthesis, and names what is wrong", () => {
  const failing = buildNodeHealthReport([fail("Worktree root")], 0, 0);
  assert.match(failing.readMarkdown, /unsound/);
  assert.match(failing.readMarkdown, /worktree root/);

  const clean = buildNodeHealthReport([pass("Node version")], 0, 0);
  assert.match(clean.readMarkdown, /floor is sound/);
});

// The gatherer takes no repo path, so there is nothing to leak - but the hub summarises this report
// into a durable node event, so pin the property rather than trusting the convention.
test("an empty check set is a report, not a crash", () => {
  const report = buildNodeHealthReport([], 0, 0);
  assert.equal(report.verdict, "ok");
  assert.deepEqual(report.sections, []);
});

// --- the worktree-root probe (regression, caught by CI) -------------------------------------------

// The worktree root is created ON DEMAND, so on a node that has not run a job yet it does not exist.
// Probing it directly answers "not writable", which `checkWorktreeRoot` turns into a `fail` and the
// fold turns into `unsound` - reporting a perfectly healthy new machine as one no stage can run on.
//
// That is the most damaging false negative this report can produce, because a BRAND-NEW node is
// exactly the one whose health an operator checks first. It passed locally (the author's worktree root
// existed) and failed on a fresh CI runner, which is the whole reason the probe walks up to the
// nearest existing ancestor instead.
test("a worktree root that does not exist yet is judged by its nearest existing ancestor", () => {
  const base = mkdtempSync(join(tmpdir(), "dahrk-health-"));
  const notYetCreated = join(base, "worktrees", "deeper", "still-not-there");

  assert.equal(isWritable(notYetCreated), false, "the dir genuinely does not exist");
  assert.equal(nearestExisting(notYetCreated), base, "it walks up to the first real directory");
  assert.equal(isWritable(nearestExisting(notYetCreated)), true, "...which IS writable, so the mkdir will work");
});

test("nearestExisting terminates at the filesystem root rather than looping", () => {
  // A path with no existing ancestor at all must still return something, not spin: `join(cur, "..")`
  // stops changing at `/`, which is the loop's exit condition.
  assert.ok(nearestExisting("/definitely/not/a/real/path/anywhere").length > 0);
});

test("an existing directory is its own nearest existing ancestor", () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-health-"));
  assert.equal(nearestExisting(dir), dir);
});
