/**
 * Policy evaluator tests (pure; no Docker): composition order and deny short-circuit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { denyToolRule, evaluatePolicies, type PolicyRule } from "../src/policy.js";

test("no rules -> allow", () => {
  assert.equal(evaluatePolicies({ kind: "action", stageId: "build", tool: "shell" }, []).verdict, "allow");
});

test("denyToolRule denies a matching action and abstains otherwise", () => {
  const rules = [denyToolRule("shell")];
  assert.equal(evaluatePolicies({ kind: "action", stageId: "build", tool: "shell" }, rules).verdict, "deny");
  assert.equal(evaluatePolicies({ kind: "action", stageId: "build", tool: "edit" }, rules).verdict, "allow");
  assert.equal(evaluatePolicies({ kind: "stage-entry", stageId: "build" }, rules).verdict, "allow");
});

test("first non-allow short-circuits in declared order", () => {
  const denyEntry: PolicyRule = {
    name: "first",
    evaluate: (e) => (e.kind === "stage-entry" ? { verdict: "deny", policy: "first" } : null),
  };
  const askEntry: PolicyRule = {
    name: "second",
    evaluate: () => ({ verdict: "ask", policy: "second" }),
  };
  const out = evaluatePolicies({ kind: "stage-entry", stageId: "x" }, [denyEntry, askEntry]);
  assert.equal(out.verdict, "deny");
  assert.equal(out.policy, "first");
});
