/**
 * Brokered runtime-auth injection for the Claude adapter (DHK-89). A node has no login of its own, so
 * the hub mints the provider key into `runtimeEnv` (or the subscription token onto `runtimeAuth`) and
 * the adapter must pass it as the CLI subprocess `env`. This pins the pure option helper
 * `runtimeEnvOptions`, used by every `query()` site via `baseOptions`.
 *
 * There is no ambient branch left to pin (DHK-1006): the adapter used to resolve the HOST's own Claude
 * login from the Keychain or `~/.claude/.credentials.json` when a job arrived with no credential. A job
 * with no credential now simply runs without one and the SDK reports its own auth error.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { RunnerContext } from "@dahrk/contracts";
import { runtimeEnvOptions, selectClaudeModel } from "../src/claude-adapter.js";

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

test("a job with no brokered credential gets no env option at all", () => {
  // The host's own Claude login is never consulted. Returning `{}` leaves the SDK inheriting
  // process.env, so it reports its own authentication error rather than silently borrowing a login.
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

// --- the model the stage runs on -----------------------------------------------------------------
// The profile's `defaultModel` reached Pi and was dropped on the floor by Claude, so an account-wide
// default model did nothing on a Claude stage and nothing said so. That was survivable while a runtime
// was picked by hand; it is not now that runtimes are DERIVED from the auth profile, which makes
// `claude-code` the runtime for every Anthropic-bound account and so for most stages.

test("a stage's own model wins over the profile default", () => {
  const c = ctx({
    config: { runtime: "claude-code", interaction: "batch", model: "opus" },
    runtimeAuth: { providers: [], defaultModel: "sonnet" },
  } as Partial<RunnerContext>);
  assert.equal(selectClaudeModel(c), "opus", "an explicit stage instruction is never overridden");
});

test("the profile's defaultModel is used when the stage names none", () => {
  const c = ctx({ runtimeAuth: { providers: [], defaultModel: "sonnet" } } as Partial<RunnerContext>);
  assert.equal(selectClaudeModel(c), "sonnet", "the account default is the fallback, as it is on Pi");
});

test("with neither set the runtime chooses - no opinion is not an error", () => {
  assert.equal(selectClaudeModel(ctx()), undefined);
  // And the option is OMITTED rather than set undefined: the SDK distinguishes the two.
  assert.equal("model" in runtimeEnvOptions(ctx()), false);
});
