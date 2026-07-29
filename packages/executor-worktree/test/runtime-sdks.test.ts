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
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { RUNTIME_SDK, canResolveSdk, piAmbientCredentialAvailable } from "../src/runtime-sdks.js";

test("canResolveSdk: both runtime SDKs resolve from the package that imports them", () => {
  // If this fails, the adapters' own `import`s would fail the same way - the point of resolving from
  // `executor-worktree` rather than from `edge`, which depends on neither.
  assert.equal(canResolveSdk(RUNTIME_SDK["claude-code"]!), true);
  assert.equal(canResolveSdk(RUNTIME_SDK.pi!), true);
});

test("canResolveSdk: an absent package is false, not a throw", () => {
  assert.equal(canResolveSdk("@dahrk/definitely-not-a-real-package"), false);
});

test("piAmbientCredentialAvailable: no provider key in the env -> no ambient credential", async () => {
  assert.equal(await piAmbientCredentialAvailable({ PATH: process.env.PATH ?? "" }), false);
});

test("piAmbientCredentialAvailable: a provider key in the env IS an ambient credential", async () => {
  // The behaviour the first draft got wrong. The key is never used to call anything - `getAvailable()`
  // only reports which models the auth it can see would permit - so a bogus value is enough.
  assert.equal(
    await piAmbientCredentialAvailable({ PATH: process.env.PATH ?? "", ANTHROPIC_API_KEY: "sk-not-a-real-key" }),
    true,
  );
});

test("piAmbientCredentialAvailable: does not read the machine-global ~/.pi, and leaves no temp dirs", async () => {
  // It must mirror what a stage gets. If this probe consulted `~/.pi`, a node would advertise Pi on the
  // strength of an OAuth login its own stages are built never to see.
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith("dahrk-pi-probe-")).length;
  const withRealHome = await piAmbientCredentialAvailable({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" });
  assert.equal(withRealHome, false, "a `~/.pi` login must not count as an ambient credential");
  const after = readdirSync(tmpdir()).filter((n) => n.startsWith("dahrk-pi-probe-")).length;
  assert.equal(after, before, "the throwaway config dir is cleaned up");
});

test("piAmbientCredentialAvailable: restores process.env even though it swaps it during the probe", async () => {
  // Pi reads `process.env` directly, so the probe swaps it for the caller's. Leaking that swap would
  // corrupt the whole process - every later env read in the node would see the probe's view.
  const sentinel = `dahrk-sentinel-${process.pid}`;
  process.env[sentinel] = "1";
  try {
    await piAmbientCredentialAvailable({ PATH: process.env.PATH ?? "" });
    assert.equal(process.env[sentinel], "1", "the real process env is restored");
  } finally {
    delete process.env[sentinel];
  }
});
