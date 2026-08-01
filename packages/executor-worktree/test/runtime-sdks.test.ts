/**
 * Drives `runtime-sdks.ts` against the REAL installed SDKs rather than a fake, because both functions
 * exist to answer questions about the real installation and a mock would answer the question we
 * assumed rather than the one the SDK actually answers.
 *
 * That distinction is not hypothetical here: this module was first written believing a Pi stage could
 * never authenticate from an ambient host, on the reasoning that `defaultCreatePiSession` builds a
 * hermetic config dir and never reads `~/.pi`. True, and irrelevant - Pi reads provider keys straight
 * off the process environment, so an ambient node with a key can serve Pi Jobs perfectly well. Only a
 * live probe catches that.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { RUNTIME_SDK, canResolveSdk } from "../src/runtime-sdks.js";

test("canResolveSdk: both runtime SDKs resolve from the package that imports them", () => {
  // If this fails, the adapters' own `import`s would fail the same way - the point of resolving from
  // `executor-worktree` rather than from `edge`, which depends on neither.
  assert.equal(canResolveSdk(RUNTIME_SDK["claude-code"]!), true);
  assert.equal(canResolveSdk(RUNTIME_SDK.pi!), true);
});

test("canResolveSdk: an absent package is false, not a throw", () => {
  assert.equal(canResolveSdk("@dahrk/definitely-not-a-real-package"), false);
});
