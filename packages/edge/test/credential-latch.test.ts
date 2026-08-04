/**
 * The refused-credential latch owns one judgement: what a finished stage proved about this node's
 * credential for its runtime. These tests drive that judgement through the latch's own interface -
 * no git repo, no runner, no stage runner - because the rule is the whole module.
 *
 * The refusal prefix is imported rather than spelled out. Hard-coding the string here would let the
 * two sides drift apart silently, which is the failure this latch exists to prevent (DHK-998); the
 * shape is separately pinned at its source in `executor-worktree/test/shared-loop.test.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { REFUSED_CREDENTIAL_SUMMARY } from "@dahrk/executor-worktree";
import { createCredentialLatch } from "../src/credential-latch.js";

const refusal = `${REFUSED_CREDENTIAL_SUMMARY}: 401 OAuth access token has been revoked`;

test("a refused credential latches the runtime", () => {
  const latch = createCredentialLatch();
  latch.record({ runtime: "claude-code", status: "fail", summary: refusal, isCheck: false });
  assert.equal(latch.isRefused("claude-code"), true);
});

test("a refusal latches only the runtime that was refused", () => {
  const latch = createCredentialLatch();
  latch.record({ runtime: "claude-code", status: "fail", summary: refusal, isCheck: false });
  // A dead Anthropic login says nothing about a working provider key for another runtime.
  assert.equal(latch.isRefused("pi"), false);
});

test("a later success clears the latch, so a re-credentialled pool needs no restart", () => {
  const latch = createCredentialLatch();
  latch.record({ runtime: "claude-code", status: "fail", summary: refusal, isCheck: false });
  latch.record({ runtime: "claude-code", status: "ok", summary: "stage-1: ok", isCheck: false });
  assert.equal(latch.isRefused("claude-code"), false);
});

test("an ordinary failure does not latch: it says nothing about the credential", () => {
  const latch = createCredentialLatch();
  latch.record({ runtime: "claude-code", status: "fail", summary: "stage-1: fail", isCheck: false });
  assert.equal(latch.isRefused("claude-code"), false);
});

test("a non-credential config failure does not latch", () => {
  const latch = createCredentialLatch();
  // `failureClass: "config"` also covers an unbound git credential or a repo no node serves. Latching
  // on those would take a healthy runtime off the air, which is why the rule keys on the summary.
  latch.record({
    runtime: "claude-code",
    status: "fail",
    summary: "edge does not serve repo \"acme/widgets\"",
    isCheck: false,
  });
  assert.equal(latch.isRefused("claude-code"), false);
});

test("an ordinary failure does not clear a standing refusal", () => {
  const latch = createCredentialLatch();
  latch.record({ runtime: "claude-code", status: "fail", summary: refusal, isCheck: false });
  latch.record({ runtime: "claude-code", status: "fail", summary: "stage-2: fail", isCheck: false });
  // Only authenticating clears it. A failure for some other reason proves nothing either way.
  assert.equal(latch.isRefused("claude-code"), true);
});

test("a check stage never touches the latch: it runs no agent and holds no credential", () => {
  const latch = createCredentialLatch();
  latch.record({ runtime: "claude-code", status: "fail", summary: refusal, isCheck: false });
  // A passing check must not clear a standing refusal by looking like a success.
  latch.record({ status: "ok", summary: "checks: 3 passed", isCheck: true });
  assert.equal(latch.isRefused("claude-code"), true);
});

test("evidence with no runtime is ignored rather than throwing", () => {
  const latch = createCredentialLatch();
  latch.record({ status: "fail", summary: refusal, isCheck: false });
  assert.equal(latch.isRefused("claude-code"), false);
  assert.equal(latch.isRefused("pi"), false);
});

test("a refusal on one runtime leaves another runtime's standing refusal alone", () => {
  const latch = createCredentialLatch();
  latch.record({ runtime: "claude-code", status: "fail", summary: refusal, isCheck: false });
  latch.record({ runtime: "pi", status: "ok", summary: "stage-1: ok", isCheck: false });
  assert.equal(latch.isRefused("claude-code"), true);
  assert.equal(latch.isRefused("pi"), false);
});
