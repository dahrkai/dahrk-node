/**
 * Runtime auto-detect. Advertising is the conjunction of CAPABILITY (the runtime's SDK resolves from
 * here) and CREDENTIALS (a stage can authenticate), so the tests drive those two axes independently:
 * `canResolve` is injected, and PATH / env / home are pointed at throwaway fixtures. Nothing here
 * depends on what happens to be installed or logged in on the test host - which matters more than
 * usual, since a real `ANTHROPIC_API_KEY` in the developer's shell would otherwise silently pass a
 * test that should fail.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AmbientAuthResolution } from "@dahrk/executor-worktree";
import { detectRuntimes, probeRuntimeStatuses, type DetectOptions } from "../src/detect-runtimes.js";
import { createCredentialLatch } from "../src/credential-latch.js";

const CLAUDE_SDK = "@anthropic-ai/claude-agent-sdk";
const PI_SDK = "@earendil-works/pi-coding-agent";

/** Both SDKs present - the normal shape of a correct install. */
const bothCapable = (s: string) => s === CLAUDE_SDK || s === PI_SDK;

/** An empty home and a credential-free env, so no ambient credential can leak in from the host running
 *  the tests. PATH is carried through (read at call time, i.e. inside `withFakeBins`) because the CLI
 *  probe now takes its environment from `opts.env` rather than inheriting the process's. */
function baseOpts(overrides: Partial<DetectOptions> = {}): DetectOptions {
  return {
    env: { PATH: process.env.PATH ?? "" },
    homeDir: join(tmpdir(), "dahrk-no-such-home"),
    canResolve: bothCapable,
    // Default to "Pi finds no usable provider in this env". Tests that care drive it explicitly; every
    // other test gets a deterministic answer instead of whatever the developer has exported.
    piAmbientCredential: async () => false,
    // Default to "no host Claude credential anywhere". Without this the resolver would read the real
    // macOS Keychain of whoever is running the tests, so the suite's answer would depend on the
    // developer's own login (DHK-1004).
    resolveAmbientAuth: () => ({ candidates: [], diverged: false, detail: "no ambient Claude login found" }),
    timeoutMs: 2000,
    ...overrides,
  };
}

/** A resolution standing in for a usable host login, optionally a diverged one. */
const resolved = (over: Partial<AmbientAuthResolution> = {}): AmbientAuthResolution => ({
  chosen: { token: "sk-host", source: "file" },
  candidates: [{ token: "sk-host", source: "file" }],
  diverged: false,
  detail: "ambient Claude login resolved from the file store",
  ...over,
});

/** Build a temp bin dir holding a passing fake CLI per name, prepend it to PATH, run fn, then clean up
 *  and restore PATH. */
async function withFakeBins(names: string[], fn: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-detect-"));
  for (const name of names) {
    const p = join(dir, name);
    writeFileSync(p, "#!/bin/sh\nexit 0\n");
    chmodSync(p, 0o755);
  }
  const prevPath = process.env.PATH;
  // Only our fake bins are visible, so a real installed runtime cannot leak into the result.
  process.env.PATH = dir;
  try {
    await fn();
  } finally {
    process.env.PATH = prevPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- capability -------------------------------------------------------------------------------

test("an unresolvable SDK is never advertised, however well-credentialled the node is", async () => {
  // The Slice-1 packaging bug seen from the routing side: the CLI is on PATH and the hub is brokering
  // keys, but the adapter's `await import()` would throw. Advertising it would take a Job we cannot run.
  const statuses = await probeRuntimeStatuses(
    baseOpts({ credentialMode: "brokered", canResolve: (s) => s === CLAUDE_SDK }),
  );
  const pi = statuses.find((s) => s.runtime === "pi");
  assert.equal(pi?.capable, false);
  assert.equal(pi?.available, false);
  assert.match(pi?.detail ?? "", /not installed/);
  assert.deepEqual(await detectRuntimes(baseOpts({ credentialMode: "brokered", canResolve: (s) => s === CLAUDE_SDK })), [
    "claude-code",
  ]);
});

// --- brokered ---------------------------------------------------------------------------------

test("a brokered node advertises everything it can execute, with no host login at all", async () => {
  // The clean-container case that used to advertise nothing: no CLI on PATH, no credentials on disk,
  // but the hub puts a key on every Job. Both runtimes are servable and must be offered.
  await withFakeBins([], async () => {
    const detected = await detectRuntimes(baseOpts({ credentialMode: "brokered" }));
    assert.deepEqual(detected, ["claude-code", "pi"]);
  });
});

test("a brokered node does not shell out at all - the host PATH cannot change its answer", async () => {
  // Guards the optimisation AND the semantics: if a CLI probe could still influence a brokered node,
  // the two signals would be entangled again. A `claude` that hangs for 30s must not be consulted.
  const dir = mkdtempSync(join(tmpdir(), "dahrk-nospawn-"));
  const claude = join(dir, "claude");
  writeFileSync(claude, "#!/bin/sh\nsleep 30\n");
  chmodSync(claude, 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = dir;
  try {
    const started = Date.now();
    const statuses = await probeRuntimeStatuses(baseOpts({ credentialMode: "brokered", timeoutMs: 5000 }));
    assert.ok(Date.now() - started < 1000, "a brokered probe must not wait on a host CLI");
    assert.equal(statuses.every((s) => s.cliVersion === undefined), true);
    assert.equal(statuses.every((s) => s.available), true);
  } finally {
    process.env.PATH = prevPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- ambient: claude --------------------------------------------------------------------------

test("ambient: an API key in the env is enough, with no CLI on PATH", async () => {
  await withFakeBins([], async () => {
    const statuses = await probeRuntimeStatuses(
      baseOpts({ credentialMode: "ambient", env: { PATH: process.env.PATH ?? "", ANTHROPIC_API_KEY: "sk-test" } }),
    );
    const claude = statuses.find((s) => s.runtime === "claude-code");
    assert.equal(claude?.credential, "ambient");
    assert.equal(claude?.available, true);
  });
});

test("ambient: an empty credential env var does not count as a credential", async () => {
  await withFakeBins([], async () => {
    const statuses = await probeRuntimeStatuses(
      baseOpts({ credentialMode: "ambient", env: { PATH: process.env.PATH ?? "", ANTHROPIC_API_KEY: "   " } }),
    );
    assert.equal(statuses.find((s) => s.runtime === "claude-code")?.available, false);
  });
});

test("ambient: a credentials file on disk counts (the Linux / CI login shape)", async () => {
  const home = mkdtempSync(join(tmpdir(), "dahrk-home-"));
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
  try {
    await withFakeBins([], async () => {
      const statuses = await probeRuntimeStatuses(baseOpts({ credentialMode: "ambient", homeDir: home }));
      assert.equal(statuses.find((s) => s.runtime === "claude-code")?.available, true);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ambient: a responding `claude` CLI counts, because a logged-in Mac has no credentials file", async () => {
  // On macOS the CLI keeps its OAuth token in the Keychain. Requiring a file would report every
  // logged-in Mac as uncredentialled, which is the regression this fallback exists to prevent.
  await withFakeBins(["claude"], async () => {
    const statuses = await probeRuntimeStatuses(baseOpts({ credentialMode: "ambient" }));
    const claude = statuses.find((s) => s.runtime === "claude-code");
    assert.equal(claude?.credential, "ambient");
    assert.equal(claude?.available, true);
  });
});

test("ambient: nothing at all -> not advertised, and the reason names the fix", async () => {
  await withFakeBins([], async () => {
    const statuses = await probeRuntimeStatuses(baseOpts({ credentialMode: "ambient" }));
    const claude = statuses.find((s) => s.runtime === "claude-code");
    assert.equal(claude?.capable, true, "capability and credentials are independent");
    assert.equal(claude?.credential, "none");
    assert.equal(claude?.available, false);
    assert.match(claude?.detail ?? "", /no credentials/);
    assert.deepEqual(await detectRuntimes(baseOpts({ credentialMode: "ambient" })), []);
  });
});

// --- ambient: pi ------------------------------------------------------------------------------

test("ambient: a logged-in `pi` on PATH is NOT a credential", async () => {
  // `defaultCreatePiSession` writes a hermetic per-stage config dir and never reads `~/.pi`, so a host
  // Pi login is invisible to a stage. The old probe advertised `pi` on exactly this evidence and then
  // failed every Pi Job it was sent.
  await withFakeBins(["claude", "pi"], async () => {
    const statuses = await probeRuntimeStatuses(baseOpts({ credentialMode: "ambient" }));
    const pi = statuses.find((s) => s.runtime === "pi");
    assert.equal(pi?.capable, true, "pi is executable here - it is the credentials that are missing");
    assert.equal(pi?.credential, "none");
    assert.equal(pi?.available, false);
    assert.equal(pi?.cliVersion, undefined, "a host `pi` is not even consulted");
    assert.deepEqual(await detectRuntimes(baseOpts({ credentialMode: "ambient" })), ["claude-code"]);
  });
});

test("ambient: a provider key in the environment DOES credential Pi", async () => {
  // The correction to the above: Pi reads provider keys straight off the process environment, so
  // "no `~/.pi`" is not "no ambient credential". Refusing to advertise here would drop a runtime the
  // node can genuinely serve - so the question is put to Pi, and this is Pi answering yes.
  await withFakeBins([], async () => {
    const statuses = await probeRuntimeStatuses(
      baseOpts({ credentialMode: "ambient", piAmbientCredential: async () => true }),
    );
    const pi = statuses.find((s) => s.runtime === "pi");
    assert.equal(pi?.credential, "ambient");
    assert.equal(pi?.available, true);
    assert.match(pi?.detail ?? "", /provider key in the environment/);
  });
});

test("Pi's credential question is asked only when it can change the answer", async () => {
  let asked = 0;
  const count = async () => {
    asked++;
    return true;
  };
  await probeRuntimeStatuses(baseOpts({ credentialMode: "brokered", piAmbientCredential: count }));
  assert.equal(asked, 0, "a brokered node is credentialled by the hub; constructing a ModelRuntime is waste");
  await probeRuntimeStatuses(baseOpts({ credentialMode: "ambient", piAmbientCredential: count }));
  assert.equal(asked, 1);
});

// --- the CLI probe itself (DHK-390 behaviour, preserved) ---------------------------------------

test("a transient probe miss is retried, not read as absent (DHK-390)", async () => {
  // The incident: a working `claude` CLI that answers slowly on ONE invocation (a cold Node CLI on a
  // host mid-IO-churn) exceeded the 3s probe and was dropped from the advertisement for the life of
  // the process. This fake reproduces that exactly: its first `--version` sleeps past the probe
  // timeout (so the probe times out and kills it); a marker file makes every later call return at
  // once. With a retry, the runtime must still be detected.
  const dir = mkdtempSync(join(tmpdir(), "dahrk-transient-"));
  const marker = join(dir, "claude.called");
  const claude = join(dir, "claude");
  writeFileSync(
    claude,
    `#!/bin/sh\nif [ -f "${marker}" ]; then exit 0; fi\n: > "${marker}"\nsleep 5\nexit 0\n`,
  );
  chmodSync(claude, 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = dir;
  try {
    // 200ms timeout so the first (sleeping) call times out fast; 2 attempts so the retry succeeds.
    const detected = await detectRuntimes(baseOpts({ credentialMode: "ambient", timeoutMs: 200, attempts: 2 }));
    assert.deepEqual(detected, ["claude-code"], "a single slow probe must not drop a working runtime");
  } finally {
    process.env.PATH = prevPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a CLI that always errors is not a credential (preserved behaviour)", async () => {
  // The retry must not resurrect a genuinely-broken login: a CLI that is present but exits non-zero on
  // every `--version` is retried and, still failing, leaves the node uncredentialled.
  const dir = mkdtempSync(join(tmpdir(), "dahrk-broken-"));
  const claude = join(dir, "claude");
  writeFileSync(claude, "#!/bin/sh\nexit 1\n");
  chmodSync(claude, 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = dir;
  try {
    const detected = await detectRuntimes(baseOpts({ credentialMode: "ambient", attempts: 2 }));
    assert.deepEqual(detected, [], "an always-erroring CLI must not be advertised");
  } finally {
    process.env.PATH = prevPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeRuntimeStatuses reports the host CLI version as a diagnostic, in stable order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-status-"));
  const p = join(dir, "claude");
  writeFileSync(p, '#!/bin/sh\necho "claude 9.9.9"\nexit 0\n');
  chmodSync(p, 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = dir;
  try {
    const statuses = await probeRuntimeStatuses(baseOpts({ credentialMode: "ambient" }));
    assert.deepEqual(statuses.map((s) => s.runtime), ["claude-code", "pi"]);
    assert.equal(statuses[0]?.cliVersion, "claude 9.9.9");
    // Pi is never CLI-probed, so it never reports a version - the number that would matter for Pi is
    // the bundled SDK's, and the host CLI's is routinely a different one entirely.
    assert.equal(statuses[1]?.cliVersion, undefined);
  } finally {
    process.env.PATH = prevPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the default credential mode is ambient - the mode that advertises less", async () => {
  await withFakeBins([], async () => {
    assert.deepEqual(await detectRuntimes(baseOpts()), []);
  });
});

// --- refused-credential latch (DHK-998) --------------------------------------------------------

test("ambient: a refused credential outranks every local hint and de-advertises the runtime", async () => {
  // The DHK-998 shape: a credentials file AND a responding CLI, both satisfied by a login the
  // provider revoked hours ago. Before the latch this node advertised claude-code and then failed
  // every Job it was sent on the first turn, at $0.00, each one billed to the agent.
  const home = mkdtempSync(join(tmpdir(), "dahrk-home-"));
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
  const latch = createCredentialLatch();
  try {
    await withFakeBins(["claude"], async () => {
      const opts = baseOpts({ credentialMode: "ambient", homeDir: home, latch });

      const before = await probeRuntimeStatuses(opts);
      assert.equal(before.find((s) => s.runtime === "claude-code")?.available, true, "healthy to begin with");

      latch.markRefused("claude-code");
      const after = await probeRuntimeStatuses(opts);
      const claude = after.find((s) => s.runtime === "claude-code");
      assert.equal(claude?.credential, "none");
      assert.equal(claude?.available, false, "a runtime whose credential was refused is not advertised");
      assert.match(claude?.detail ?? "", /refused/i, "the reason says the provider refused the login");
      assert.match(claude?.detail ?? "", /auth login/, "and names the remedy");
      assert.deepEqual(await detectRuntimes(opts), [], "the routing view drops it too");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a refused credential is per-runtime, and clears when a stage authenticates again", async () => {
  const latch = createCredentialLatch();
  latch.markRefused("claude-code");
  await withFakeBins([], async () => {
    // Pi is credentialled from the environment and knows nothing about a dead Anthropic login.
    const opts = baseOpts({ credentialMode: "ambient", piAmbientCredential: async () => true, latch });
    assert.deepEqual(await detectRuntimes(opts), ["pi"], "only the refused runtime is withheld");

    // A later stage authenticates: the node recovers on the next re-probe, with no restart.
    latch.markAccepted("claude-code");
    const env = { PATH: process.env.PATH ?? "", ANTHROPIC_API_KEY: "sk-test" };
    assert.deepEqual(
      await detectRuntimes(baseOpts({ credentialMode: "ambient", piAmbientCredential: async () => true, latch, env })),
      ["claude-code", "pi"],
      "clearing the latch restores the runtime",
    );
  });
});

test("brokered: the latch does not withhold a runtime the hub credentials", async () => {
  // The latch records a refusal of THIS HOST's ambient login. A brokered node is credentialled per
  // Job by the hub, so a stale ambient refusal must not take it off the air.
  const latch = createCredentialLatch();
  latch.markRefused("claude-code");
  await withFakeBins([], async () => {
    const statuses = await probeRuntimeStatuses(baseOpts({ credentialMode: "brokered", latch }));
    assert.equal(statuses.find((s) => s.runtime === "claude-code")?.available, true);
  });
});

// --- ambient credential resolution (DHK-1004) ---------------------------------------------------

test("ambient: a resolvable host credential advertises claude-code and reports the store it came from", async () => {
  await withFakeBins([], async () => {
    const statuses = await probeRuntimeStatuses(
      baseOpts({ credentialMode: "ambient", resolveAmbientAuth: () => resolved() }),
    );
    const claude = statuses.find((s) => s.runtime === "claude-code");
    assert.equal(claude?.available, true);
    assert.equal(claude?.credential, "ambient");
    assert.match(claude?.detail ?? "", /file store/, "the detail names the store, so the answer is explicable");
  });
});

test("ambient: an expired host credential grounds the runtime instead of advertising a doomed login", async () => {
  // The pre-DHK-1004 detection asked only whether a login EXISTED, which an expired or revoked one
  // satisfies perfectly well. The node then took a Job per attempt and failed each on its first turn.
  await withFakeBins([], async () => {
    const statuses = await probeRuntimeStatuses(
      baseOpts({
        credentialMode: "ambient",
        resolveAmbientAuth: () => ({
          candidates: [{ token: "sk-old", source: "keychain", expiresAt: 1 }],
          diverged: false,
          detail: "the ambient Claude login has expired in every store (keychain)",
        }),
      }),
    );
    const claude = statuses.find((s) => s.runtime === "claude-code");
    assert.equal(claude?.available, false, "an expired credential is not a credential");
    assert.equal(claude?.credential, "none");
    assert.match(claude?.detail ?? "", /expired/);
  });
});

test("ambient: a divergence between stores is surfaced even though the stage will run", async () => {
  await withFakeBins([], async () => {
    const statuses = await probeRuntimeStatuses(
      baseOpts({
        credentialMode: "ambient",
        resolveAmbientAuth: () =>
          resolved({ diverged: true, detail: "resolved from the file store; NOTE the keychain store holds a different, older token" }),
      }),
    );
    const claude = statuses.find((s) => s.runtime === "claude-code");
    assert.equal(claude?.available, true, "we can still run: we resolved a good credential ourselves");
    assert.match(claude?.detail ?? "", /older token/, "but the operator is told the host needs repairing");
  });
});

test("ambient: an explicit credential in the environment outranks the stores and skips resolution", async () => {
  let resolutions = 0;
  await withFakeBins([], async () => {
    const statuses = await probeRuntimeStatuses(
      baseOpts({
        credentialMode: "ambient",
        env: { PATH: process.env.PATH ?? "", ANTHROPIC_API_KEY: "sk-explicit" },
        resolveAmbientAuth: () => {
          resolutions += 1;
          return resolved();
        },
      }),
    );
    assert.equal(statuses.find((s) => s.runtime === "claude-code")?.available, true);
    assert.equal(resolutions, 0, "the operator's own answer is not second-guessed against disk");
  });
});
