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
import { runtimeEnvOptions, ambientAuthEnv } from "../src/claude-adapter.js";

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

/** No host credential anywhere: the pre-DHK-1004 ambient shape, where we add nothing at all. */
const noHostCredential = { platform: "linux" as const, readFile: () => undefined, readKeychain: () => undefined };

test("ambient node with no resolvable host credential: no env option, so the SDK keeps doing what it always did", () => {
  assert.deepEqual(runtimeEnvOptions(ctx(), noHostCredential), {});
});

test("ambient node WITH a host credential: it is resolved and passed explicitly (DHK-1004)", () => {
  // Before DHK-1004 the adapter passed nothing and let the subprocess choose a credential store. On a
  // host with two stores that choice depended on the security session the node was started in, so a
  // launchd node could read a revoked token and fail every stage. Resolving here makes it deterministic.
  const opts = runtimeEnvOptions(ctx(), {
    platform: "linux",
    now: () => 1_000,
    readFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "sk-host", expiresAt: 9_999_999 } }),
    readKeychain: () => undefined,
  });
  assert.equal(opts.env?.CLAUDE_CODE_OAUTH_TOKEN, "sk-host", "the resolved host token rides the child env");
  assert.equal(opts.env?.PATH, process.env.PATH, "and the inherited environment survives");
});

test("an explicit credential in the environment outranks anything we find on disk", () => {
  const opts = ambientAuthEnv(
    {
      platform: "linux",
      now: () => 1_000,
      readFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "sk-disk", expiresAt: 9_999_999 } }),
      readKeychain: () => undefined,
    },
    { CLAUDE_CODE_OAUTH_TOKEN: "sk-operator" },
  );
  assert.deepEqual(opts, {}, "the operator set it deliberately; we must not override it");
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
  const opts = runtimeEnvOptions({ ...ctx(), runtimeAuth: hint } as RunnerContext, noHostCredential);
  assert.deepEqual(opts, {}, "no runtimeEnv -> no env option, even when runtimeAuth carries a hint");
});

// --- OAuth subscription profiles (DHK-998) ------------------------------------------------------

test("brokered node: an Anthropic subscription credentials the stage via CLAUDE_CODE_OAUTH_TOKEN", () => {
  // "Anthropic (Claude Pro/Max)" in the auth portal mints an oauth hint with no env var to carry the
  // secret. Before this reader existed, binding a pool to that profile credentialled nothing at all
  // and the stage silently fell through to whatever ambient login the host had.
  const hint = {
    providers: [
      { kind: "oauth" as const, provider: "anthropic", access: "sk-ant-oat-live", refresh: "sk-ant-ort", expires: 1 },
    ],
  };
  const opts = runtimeEnvOptions({ ...ctx(), runtimeAuth: hint } as RunnerContext);
  assert.ok(opts.env, "an oauth subscription alone is enough to populate env");
  assert.equal(opts.env?.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat-live", "the live access token reaches the subprocess");
  assert.equal(opts.env?.PATH, process.env.PATH, "PATH is still carried through");
});

test("an Anthropic subscription rides alongside, and does not clobber, a minted api key", () => {
  const hint = {
    providers: [
      { kind: "api_key" as const, provider: "anthropic", envVar: "ANTHROPIC_API_KEY" },
      { kind: "oauth" as const, provider: "anthropic", access: "sk-ant-oat-live", refresh: "r", expires: 1 },
    ],
  };
  const opts = runtimeEnvOptions(
    { ...ctx({ runtimeEnv: { ANTHROPIC_API_KEY: "sk-brokered" } }), runtimeAuth: hint } as RunnerContext,
  );
  assert.equal(opts.env?.ANTHROPIC_API_KEY, "sk-brokered");
  assert.equal(opts.env?.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat-live");
});

test("a foreign subscription with no Anthropic credential fails loudly rather than running unauthenticated", () => {
  // claude-code cannot use a Copilot or Codex login. Proceeding would fail on the first turn with a
  // message that reads like the agent's fault; the binding is what is wrong.
  const hint = {
    providers: [
      { kind: "oauth" as const, provider: "github-copilot", access: "gho_x", refresh: "r", expires: 1 },
    ],
  };
  assert.throws(
    () => runtimeEnvOptions({ ...ctx(), runtimeAuth: hint } as RunnerContext),
    /no Anthropic credential .* github-copilot subscription/s,
    "the error names the misbinding and the runtime that cannot use it",
  );
});

test("a foreign subscription is tolerated when an api key also credentials the stage", () => {
  const hint = {
    providers: [
      { kind: "api_key" as const, provider: "anthropic", envVar: "ANTHROPIC_API_KEY" },
      { kind: "oauth" as const, provider: "github-copilot", access: "gho_x", refresh: "r", expires: 1 },
    ],
  };
  const opts = runtimeEnvOptions(
    { ...ctx({ runtimeEnv: { ANTHROPIC_API_KEY: "sk-brokered" } }), runtimeAuth: hint } as RunnerContext,
  );
  assert.equal(opts.env?.ANTHROPIC_API_KEY, "sk-brokered");
  assert.equal(opts.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined, "no foreign token is smuggled onto the env");
});
