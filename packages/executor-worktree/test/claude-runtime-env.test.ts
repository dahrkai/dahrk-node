/**
 * Brokered runtime-auth injection for the Claude adapter (DHK-89). A managed / Docker-isolated node
 * has no ambient `claude` login, so the hub mints the provider key into `runtimeEnv` and the adapter
 * must pass it as the CLI subprocess `env`. This pins the pure option helper `runtimeEnvOptions`
 * (used by every `query()` site via `baseOptions`): brokered nodes get the key in `env` over an
 * inherited process.env; ambient nodes get no `env` (the SDK keeps its process.env default / login).
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { RunnerContext } from "@dahrk/contracts";
import { runtimeEnvOptions } from "../src/claude-adapter.js";

const ctx = (over: Partial<RunnerContext> = {}): RunnerContext =>
  ({
    config: { runtime: "claude-code", interaction: "batch" },
    workspace: {
      repoId: "r",
      gitUrl: "https://github.com/dahrkai/dahrk-node.git",
      repo: "dahrk-node",
      baseBranch: "main",
      worktreePath: "/tmp/wt",
      scratchPath: "/tmp/wt/.dahrk/scratch",
    },
    ...over,
  }) as RunnerContext;

test("ambient node (no runtimeEnv): no env option, so the SDK keeps the operator's ambient login", () => {
  assert.deepEqual(runtimeEnvOptions(ctx()), {});
});

test("brokered node: the minted provider key is set in env, over an inherited process.env", () => {
  process.env.DHK89_SENTINEL = "keep-me";
  try {
    const opts = runtimeEnvOptions(ctx({ runtimeEnv: { ANTHROPIC_API_KEY: "sk-brokered" } }));
    assert.ok(opts.env, "env is populated on a brokered node");
    assert.equal(opts.env?.ANTHROPIC_API_KEY, "sk-brokered", "the brokered key is injected");
    // env REPLACES the subprocess environment, so PATH and other inherited vars must survive.
    assert.equal(opts.env?.PATH, process.env.PATH, "PATH is carried through from process.env");
    assert.equal(opts.env?.DHK89_SENTINEL, "keep-me", "other inherited vars survive");
  } finally {
    delete process.env.DHK89_SENTINEL;
  }
});

test("brokered runtimeEnv overrides an ambient value of the same key", () => {
  process.env.ANTHROPIC_API_KEY = "sk-ambient";
  try {
    const opts = runtimeEnvOptions(ctx({ runtimeEnv: { ANTHROPIC_API_KEY: "sk-brokered" } }));
    assert.equal(opts.env?.ANTHROPIC_API_KEY, "sk-brokered", "the brokered key wins over the ambient one");
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

// --- auth-profile model: coverage beyond the single-key legacy path --------------------------

test("multiple keys in runtimeEnv all reach the subprocess env (multi-credential brokered node)", () => {
  // The broker can mint more than one credential (e.g. ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL for a
  // proxy endpoint). All must reach the subprocess unchanged.
  const opts = runtimeEnvOptions(
    ctx({ runtimeEnv: { ANTHROPIC_API_KEY: "sk-ant", ANTHROPIC_BASE_URL: "https://proxy.example/v1" } }),
  );
  assert.ok(opts.env, "env is populated");
  assert.equal(opts.env?.ANTHROPIC_API_KEY, "sk-ant", "primary inference key reaches subprocess");
  assert.equal(opts.env?.ANTHROPIC_BASE_URL, "https://proxy.example/v1", "secondary key reaches subprocess");
});

test("non-Anthropic key in runtimeEnv passes through: broker can thread any credential under any name", () => {
  // An opaque key name carries the secret; the Claude adapter must not filter by var name.
  const opts = runtimeEnvOptions(ctx({ runtimeEnv: { DAHRK_RUNTIME_KEY_1: "sk-alt-value" } }));
  assert.equal(opts.env?.DAHRK_RUNTIME_KEY_1, "sk-alt-value");
});

test("runtimeAuth hint present alongside runtimeEnv: env is set correctly (hint does not change output)", () => {
  // The broker mints both runtimeAuth (provider declaration) and runtimeEnv (the actual secret).
  // Claude reads only runtimeEnv; the runtimeAuth hint must be transparent to runtimeEnvOptions.
  const hint = { providers: [{ kind: "api_key" as const, provider: "anthropic", envVar: "ANTHROPIC_API_KEY" }] };
  const opts = runtimeEnvOptions(
    { ...ctx({ runtimeEnv: { ANTHROPIC_API_KEY: "sk-brokered" } }), runtimeAuth: hint } as RunnerContext,
  );
  assert.ok(opts.env, "env is populated when both runtimeAuth and runtimeEnv are present");
  assert.equal(opts.env?.ANTHROPIC_API_KEY, "sk-brokered", "the key from runtimeEnv reaches subprocess unchanged");
});

test("ambient node with runtimeAuth but no runtimeEnv: no env option (the hint alone does not activate brokered auth)", () => {
  // Self-managed nodes may carry a hint describing their provider without minting runtime credentials.
  // Absence of runtimeEnv must produce the no-env path, not a broken partial env.
  const hint = { providers: [{ kind: "api_key" as const, provider: "anthropic", envVar: "ANTHROPIC_API_KEY" }] };
  const opts = runtimeEnvOptions({ ...ctx(), runtimeAuth: hint } as RunnerContext);
  assert.deepEqual(opts, {}, "no runtimeEnv -> no env option, even when runtimeAuth carries a hint");
});
