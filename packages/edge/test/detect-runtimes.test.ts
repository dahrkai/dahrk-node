/**
 * Runtime auto-detect. Advertising is now a single question - CAPABILITY, i.e. does the runtime's SDK
 * resolve from here - so `canResolve` is injected and nothing depends on what happens to be installed
 * on the test host.
 *
 * The suite used to be dominated by a second axis, CREDENTIALS: fake `claude`/`pi` binaries on a
 * throwaway PATH, a fake `~/.claude/.credentials.json`, a stubbed Keychain reader, and an injected
 * "can Pi authenticate from this env". All of it existed to answer "is there a login on this host a
 * stage could borrow", which nothing asks any more: the hub brokers every credential. What survives is
 * the refused-credential latch, which is not a guess about the host but the runtime having tried to
 * authenticate and been told no.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { REFUSED_CREDENTIAL_SUMMARY } from "@dahrk/executor-worktree";
import { detectRuntimes, probeRuntimeStatuses, type DetectOptions } from "../src/detect-runtimes.js";
import { createCredentialLatch } from "../src/credential-latch.js";

const CLAUDE_SDK = "@anthropic-ai/claude-agent-sdk";
const PI_SDK = "@earendil-works/pi-coding-agent";

/** A stage summary shaped as `runBatchLoop` writes one for a refusal. The latch owns the rule that
 *  recognises it, so this suite feeds it real evidence rather than reaching for a setter. */
const refusalSummary = `${REFUSED_CREDENTIAL_SUMMARY}: 401 OAuth access token has been revoked`;

/** Both SDKs present - the normal shape of a correct install. */
const bothCapable = (s: string) => s === CLAUDE_SDK || s === PI_SDK;

function baseOpts(overrides: Partial<DetectOptions> = {}): DetectOptions {
  return { env: {}, canResolve: bothCapable, ...overrides };
}

// --- capability: the only axis left ---------------------------------------------------------------

test("both SDKs resolvable -> both runtimes advertised, in a stable order", async () => {
  assert.deepEqual(await detectRuntimes(baseOpts()), ["claude-code", "pi"]);
});

test("a runtime whose SDK is missing is not advertised, and the reason names the package", async () => {
  const statuses = await probeRuntimeStatuses(baseOpts({ canResolve: (s) => s === CLAUDE_SDK }));
  const pi = statuses.find((s) => s.runtime === "pi");
  assert.equal(pi?.capable, false);
  assert.equal(pi?.credential, "none");
  assert.equal(pi?.available, false);
  assert.match(pi?.detail ?? "", /@earendil-works\/pi-coding-agent is not installed/);
  assert.deepEqual(await detectRuntimes(baseOpts({ canResolve: (s) => s === CLAUDE_SDK })), ["claude-code"]);
});

test("a capable runtime is credentialled by the hub, with no host login consulted", async () => {
  // The point of the change: nothing on this host - no PATH entry, no credentials file, no keychain,
  // no env var - can make a capable runtime unadvertisable. Note the empty env.
  const statuses = await probeRuntimeStatuses(baseOpts());
  for (const s of statuses) {
    assert.equal(s.credential, "brokered", `${s.runtime} is credentialled by the hub`);
    assert.equal(s.available, true);
    assert.match(s.detail, /brokered credentials from the hub/);
  }
});

test("no SDK at all -> nothing advertised", async () => {
  assert.deepEqual(await detectRuntimes(baseOpts({ canResolve: () => false })), []);
});

// --- refused-credential latch (DHK-998) --------------------------------------------------------

test("a refused brokered credential de-advertises the runtime, and the reason points at the pool's profile", async () => {
  // Keep advertising after the provider has refused and every Job dies on its first turn, at $0.00,
  // each one billed to the agent. The latch is the one credential signal that survives, because it
  // comes from the runtime actually trying rather than from sniffing the host.
  const latch = createCredentialLatch();
  const opts = baseOpts({ latch });

  const before = await probeRuntimeStatuses(opts);
  assert.equal(before.find((s) => s.runtime === "claude-code")?.available, true, "healthy to begin with");

  latch.record({ runtime: "claude-code", status: "fail", summary: refusalSummary, isCheck: false });
  const after = await probeRuntimeStatuses(opts);
  const claude = after.find((s) => s.runtime === "claude-code");
  assert.equal(claude?.capable, true, "capability is unaffected: the SDK is still right there");
  assert.equal(claude?.credential, "none");
  assert.equal(claude?.available, false);
  assert.match(claude?.detail ?? "", /refused/i, "the reason says the provider refused it");
  assert.match(claude?.detail ?? "", /auth profile/i, "and points at where the credential is configured");
  assert.deepEqual(await detectRuntimes(opts), ["pi"], "only the refused runtime is withheld");
});

test("a refused credential clears when a stage authenticates again, with no restart", async () => {
  const latch = createCredentialLatch();
  latch.record({ runtime: "claude-code", status: "fail", summary: refusalSummary, isCheck: false });
  assert.deepEqual(await detectRuntimes(baseOpts({ latch })), ["pi"]);

  latch.record({ runtime: "claude-code", status: "ok", summary: "stage-1: ok", isCheck: false });
  assert.deepEqual(await detectRuntimes(baseOpts({ latch })), ["claude-code", "pi"], "recovered on re-probe");
});
