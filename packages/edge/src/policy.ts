/**
 * Policy evaluation (build spec section 13). A policy is deterministic code that
 * receives an event (a tool call, a stage entry) and returns allow / deny / ask -
 * never an LLM, never a next-stage choice, so it sits inside the determinism
 * boundary. Policies compose in declared order; the first non-allow short-circuits.
 *
 * M3 ships the evaluator and the hook points (the stage runner calls it at stage
 * entry and around each tool action) plus one demo rule (`denyToolRule`). The
 * Phase 1 builtins (cost_budget, write_scope, max_tool_calls, shell_guard) are M6.
 */
import type { PolicyOutcome } from "@dahrk/contracts";

/** What a policy evaluates. Extended as more hook points arrive. */
export type PolicyEvent =
  | { kind: "stage-entry"; stageId: string }
  | { kind: "action"; stageId: string; tool: string; input?: unknown };

export interface PolicyRule {
  /** The builtin name surfaced in the outcome (e.g. "shell_guard"). */
  readonly name: string;
  /** Return a verdict, or null to abstain (treated as allow). */
  evaluate(event: PolicyEvent): PolicyOutcome | null;
}

const ALLOW: PolicyOutcome = { verdict: "allow", policy: "none" };

/** Compose rules in order; the first deny/ask wins, else allow. Pure. */
export function evaluatePolicies(event: PolicyEvent, rules: readonly PolicyRule[]): PolicyOutcome {
  for (const rule of rules) {
    const outcome = rule.evaluate(event);
    if (outcome && outcome.verdict !== "allow") return outcome;
  }
  return ALLOW;
}

/** Demo rule (M3): deny any tool action whose tool matches `tool`. Replaced by builtins at M6. */
export function denyToolRule(tool: string): PolicyRule {
  return {
    name: "deny_tool",
    evaluate(event) {
      if (event.kind === "action" && event.tool === tool) {
        return { verdict: "deny", policy: "deny_tool", reason: `tool "${tool}" is denied` };
      }
      return null;
    },
  };
}
