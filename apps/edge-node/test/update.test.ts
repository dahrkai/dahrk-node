import { test } from "node:test";
import assert from "node:assert/strict";
import { isDrivableChannel } from "@dahrk/contracts";
import {
  detectChannel,
  isNewer,
  planRemoteUpgrade,
  upgradeCommand,
  runUpdate,
  wireChannel,
  type UpdateDeps,
} from "../src/update.ts";

test("isNewer: strictly-newer core wins; equal and older do not; garbage never claims an update", () => {
  assert.equal(isNewer("0.2.0", "0.1.3"), true);
  assert.equal(isNewer("1.0.0", "0.9.9"), true);
  assert.equal(isNewer("0.1.4", "0.1.3"), true);
  assert.equal(isNewer("0.1.3", "0.1.3"), false);
  assert.equal(isNewer("0.1.2", "0.1.3"), false);
  // A `v` prefix and a prerelease/build tail are tolerated (compared by core).
  assert.equal(isNewer("v0.2.0", "0.1.3"), true);
  assert.equal(isNewer("0.2.0-rc.1", "0.1.3"), true);
  // Unparseable either side => false (never claim an unverifiable update).
  assert.equal(isNewer("not-a-version", "0.1.3"), false);
  assert.equal(isNewer("0.2.0", "unknown"), false);
});

test("detectChannel: npm path, Homebrew Cellar path, and everything else unknown", () => {
  assert.equal(detectChannel("/usr/local/lib/node_modules/dahrk-node/dist/main.js"), "npm");
  assert.equal(detectChannel("/opt/homebrew/lib/node_modules/dahrk-node/dist/main.js"), "npm");
  assert.equal(detectChannel("/opt/homebrew/Cellar/dahrk/0.1.3/libexec/bin/dahrk"), "homebrew");
  assert.equal(detectChannel("/usr/local/Cellar/dahrk/0.1.3/libexec/bin/dahrk"), "homebrew");
  assert.equal(detectChannel("/Users/me/src/dahrk-node/apps/edge-node/dist/main.js"), "unknown");
  assert.equal(detectChannel(undefined), "unknown");
});

test("upgradeCommand: npm/homebrew have a command, unknown has none", () => {
  assert.deepEqual(upgradeCommand("npm")?.argv, ["npm", "install", "-g", "dahrk-node@latest"]);
  assert.deepEqual(upgradeCommand("homebrew")?.argv, ["brew", "upgrade", "dahrkai/tap/dahrk"]);
  assert.equal(upgradeCommand("unknown"), null);
});

/** Collect the printed lines and record whether an upgrade was spawned, so runUpdate is observable.
 *
 *  The default host has NO node running, which is the case where the restart question never comes up at
 *  all. The tests that care about it opt in with `nodeRunning: () => true`. */
const NOW = Date.parse("2026-07-13T12:00:00Z");

function harness(over: Partial<UpdateDeps>): {
  deps: Partial<UpdateDeps>;
  lines: string[];
  ran: string[][];
  counter: { restarts: number };
  saved: Array<{ updateCheckedAt: string; updateLatest: string }>;
} {
  const lines: string[] = [];
  const ran: string[][] = [];
  const counter = { restarts: 0 };
  const saved: Array<{ updateCheckedAt: string; updateLatest: string }> = [];
  const deps: Partial<UpdateDeps> = {
    binPath: "/usr/local/lib/node_modules/dahrk-node/dist/main.js", // npm channel by default
    out: (l) => lines.push(l),
    runUpgrade: (argv) => {
      ran.push(argv);
      return { code: 0, output: "npm warn ERESOLVE overriding peer dependency\nchanged 123 packages" };
    },
    saveResult: (patch) => void saved.push(patch),
    now: () => NOW,
    nodeRunning: () => false,
    interactive: () => false,
    confirm: async () => true,
    restart: async () => {
      counter.restarts++;
      return 0;
    },
    // Idle by default. Stubbed rather than left to the real dep on purpose: the default reads this
    // HOST's job ledger, so without it every test here would quietly depend on whether the developer's
    // own node happened to be running a stage.
    inFlightJobCount: () => 0,
    ...over,
  };
  // `counter` is returned as an object, not a number: destructuring a getter would snapshot it at zero
  // and every "did it restart?" assertion would silently pass.
  return { deps, lines, ran, counter, saved };
}

test("runUpdate: already current is a no-op, exit 0, and runs nothing", async () => {
  const { deps, lines, ran } = harness({ fetchLatest: async () => "0.1.3" });
  const code = await runUpdate({ currentVersion: "0.1.3", check: false }, deps);
  assert.equal(code, 0);
  assert.equal(ran.length, 0);
  assert.match(lines.join("\n"), /Already on the latest version \(0\.1\.3\)/);
});

test("runUpdate --check: reports current -> latest and how to apply, but runs nothing", async () => {
  const { deps, lines, ran } = harness({ fetchLatest: async () => "0.2.0" });
  const code = await runUpdate({ currentVersion: "0.1.3", check: true }, deps);
  assert.equal(code, 0);
  assert.equal(ran.length, 0);
  const out = lines.join("\n");
  assert.match(out, /Update available: 0\.1\.3 .* 0\.2\.0/);
  assert.match(out, /npm install -g dahrk-node@latest/);
});

test("runUpdate: an available update on the npm channel runs the upgrade and reports old->new", async () => {
  const { deps, lines, ran } = harness({ fetchLatest: async () => "0.2.0" });
  const code = await runUpdate({ currentVersion: "0.1.3", check: false }, deps);
  assert.equal(code, 0);
  assert.deepEqual(ran, [["npm", "install", "-g", "dahrk-node@latest"]]);
  const out = lines.join("\n");
  assert.match(out, /Update available: 0\.1\.3 .* 0\.2\.0/);
  assert.match(out, /Upgraded to 0\.2\.0/);
});

test("runUpdate: a SUCCESSFUL upgrade hides the package manager's wall of noise", async () => {
  // npm prints a screen of ERESOLVE peer-dependency warnings about our own transitive zod on every
  // successful global install. It is alarming, it is not actionable, and it is not a problem.
  const { deps, lines } = harness({ fetchLatest: async () => "0.2.0" });
  await runUpdate({ currentVersion: "0.1.3", check: false }, deps);
  assert.doesNotMatch(lines.join("\n"), /ERESOLVE/);
});

test("runUpdate --verbose: ...but shows it when asked", async () => {
  const { deps, lines } = harness({ fetchLatest: async () => "0.2.0" });
  await runUpdate({ currentVersion: "0.1.3", check: false, verbose: true }, deps);
  assert.match(lines.join("\n"), /ERESOLVE/);
});

test("runUpdate: a failing upgrade surfaces its exit code AND its output, verbose or not", async () => {
  const { deps, lines } = harness({
    fetchLatest: async () => "0.2.0",
    runUpgrade: () => ({ code: 7, output: "EACCES: permission denied" }),
  });
  const code = await runUpdate({ currentVersion: "0.1.3", check: false }, deps);
  assert.equal(code, 7);
  const out = lines.join("\n");
  assert.match(out, /Upgrade failed \(exit 7\)/);
  assert.match(out, /EACCES: permission denied/, "on failure the output is the whole point");
});

// --- The restart question: `dahrk start` never picked up an upgrade, and used to say it would ---

test("runUpdate: a running node is offered a restart, and `dahrk start` is NEVER the advice", async () => {
  const { deps, lines, counter } = harness({
    fetchLatest: async () => "0.2.0",
    nodeRunning: () => true,
    interactive: () => true,
    confirm: async () => true,
  });
  await runUpdate({ currentVersion: "0.1.3", check: false }, deps);
  const out = lines.join("\n");
  assert.equal(counter.restarts, 1, "saying yes restarts the node");
  assert.match(out, /Node restarted on the new build/);
  // The old bug: it told you to run `dahrk start`, which no-ops on a running node and picks up nothing.
  assert.doesNotMatch(out, /`dahrk start`/);
});

test("runUpdate: declining the restart says how to do it later, and does not restart", async () => {
  const { deps, lines, counter } = harness({
    fetchLatest: async () => "0.2.0",
    nodeRunning: () => true,
    interactive: () => true,
    confirm: async () => false,
  });
  await runUpdate({ currentVersion: "0.1.3", check: false }, deps);
  assert.equal(counter.restarts, 0);
  assert.match(lines.join("\n"), /Run `dahrk restart` when you are ready/);
});

test("runUpdate: a non-interactive caller is told to restart, never prompted", async () => {
  const { deps, lines, counter } = harness({
    fetchLatest: async () => "0.2.0",
    nodeRunning: () => true,
    interactive: () => false,
    confirm: async () => assert.fail("must not prompt when nobody is there to answer"),
  });
  await runUpdate({ currentVersion: "0.1.3", check: false }, deps);
  assert.equal(counter.restarts, 0);
  assert.match(lines.join("\n"), /Run `dahrk restart` to pick this up/);
});

test("runUpdate: with NO node running there is nothing to restart, so nothing is said about it", async () => {
  const { deps, lines, counter } = harness({ fetchLatest: async () => "0.2.0", nodeRunning: () => false });
  await runUpdate({ currentVersion: "0.1.3", check: false }, deps);
  assert.equal(counter.restarts, 0);
  assert.doesNotMatch(lines.join("\n"), /restart/i, "advice about a problem nobody has is just noise");
});

test("runUpdate: an unknown channel prints the per-channel commands instead of running", async () => {
  const { deps, lines, ran } = harness({
    binPath: "/Users/me/src/dahrk-node/dist/main.js",
    fetchLatest: async () => "0.2.0",
  });
  const code = await runUpdate({ currentVersion: "0.1.3", check: false }, deps);
  assert.equal(code, 0);
  assert.equal(ran.length, 0);
  const out = lines.join("\n");
  assert.match(out, /Could not tell how this client was installed/);
  assert.match(out, /npm install -g dahrk-node@latest/);
  assert.match(out, /brew upgrade dahrkai\/tap\/dahrk/);
  assert.match(out, /install\.sh/);
});

test("runUpdate: a registry failure reports it and exits 1 without running", async () => {
  const { deps, lines, ran } = harness({
    fetchLatest: async () => {
      throw new Error("registry responded 503");
    },
  });
  const code = await runUpdate({ currentVersion: "0.1.3", check: false }, deps);
  assert.equal(code, 1);
  assert.equal(ran.length, 0);
  assert.match(lines.join("\n"), /Could not determine the latest version: registry responded 503/);
});

// --- The cache: fetching the truth and then forgetting it is the bug -----------------------------

test("runUpdate: writes down what the registry said, so `dahrk status` is not left guessing", async () => {
  // `status` is offline by contract - it can only ever report what someone else has already learned. This
  // command used to fetch the true latest version, print it, and throw it away, so you could be told 0.2.0
  // exists and have `status` go on insisting it knew nothing about any update.
  const { deps, saved } = harness({ fetchLatest: async () => "0.2.0" });
  await runUpdate({ currentVersion: "0.1.3", check: false }, deps);
  assert.deepEqual(saved, [{ updateCheckedAt: new Date(NOW).toISOString(), updateLatest: "0.2.0" }]);
});

test("runUpdate --check: persists too - it is the ONLY way to refresh a stale cache by hand", async () => {
  // The daemon's periodic check is the only other writer, so on a machine whose node is not running this is
  // the sole command that can bring `status` up to date. A --check that reported the truth and forgot it
  // would leave the operator no way out of a stale answer at all.
  const { deps, saved, ran } = harness({ fetchLatest: async () => "0.2.0" });
  await runUpdate({ currentVersion: "0.1.3", check: true }, deps);
  assert.equal(ran.length, 0, "--check still changes nothing on disk except what we now know");
  assert.deepEqual(saved, [{ updateCheckedAt: new Date(NOW).toISOString(), updateLatest: "0.2.0" }]);
});

test("runUpdate: 'already current' is a fact worth recording, not just printing", async () => {
  // Otherwise the cache stays `unknown` forever on a machine that is perfectly up to date, and `status`
  // keeps saying "update status unknown" to someone who has just been told they are current.
  const { deps, saved } = harness({ fetchLatest: async () => "0.1.3" });
  await runUpdate({ currentVersion: "0.1.3", check: false }, deps);
  assert.deepEqual(saved, [{ updateCheckedAt: new Date(NOW).toISOString(), updateLatest: "0.1.3" }]);
});

test("runUpdate: a registry failure writes NOTHING - we must not record an answer we never got", async () => {
  const { deps, saved } = harness({
    fetchLatest: async () => {
      throw new Error("ENOTFOUND");
    },
  });
  assert.equal(await runUpdate({ currentVersion: "0.1.3", check: false }, deps), 1);
  assert.deepEqual(saved, [], "a failed check must leave the previous answer, and its age, untouched");
});

// --- the hub-driven upgrade (DHK-1001) ------------------------------------------------------------

test("wireChannel: `homebrew` crosses to the wire as `brew`, or a drivable node reads as manual", () => {
  // The two vocabularies were invented separately and disagree on exactly one word. Both sides are
  // strings, so no type would have caught it: an ack saying "homebrew" fails the hub's
  // `isDrivableChannel` check and settles a perfectly upgradeable node as `manual` - a silent,
  // plausible-looking failure that produces a copy-paste command instead of an upgrade.
  assert.equal(wireChannel("homebrew"), "brew");
  assert.equal(wireChannel("npm"), "npm");
  assert.equal(wireChannel("unknown"), "unknown");

  // Asserted against the REAL contract, not a copy of its strings: this is the predicate the hub runs on
  // the ack to decide between driving the upgrade and telling the operator to run it themselves. Every
  // channel we can actually drive locally must pass it, or the two halves disagree in production only.
  for (const local of ["npm", "homebrew"] as const) {
    assert.ok(
      isDrivableChannel(wireChannel(local)),
      `the hub would refuse to drive a ${local} install (sent as "${wireChannel(local)}")`,
    );
  }
  assert.equal(isDrivableChannel(wireChannel("unknown")), false, "and an unknown install is never driven");
});

test("planRemoteUpgrade: a drivable channel accepts, upgrades, and ALWAYS restarts - no TTY needed", async () => {
  // The reason this is not just `runUpdate`. `offerRestart` refuses to restart without a TTY, so under a
  // daemon the upgrade lands on disk and the node keeps serving the OLD build for ever - and the hub,
  // seeing a version that never moved, settles the intent `silent`. Nobody is at a terminal here; being
  // asked to upgrade is the consent.
  const { deps, ran, counter, saved } = harness({ interactive: () => false, nodeRunning: () => true });
  const plan = planRemoteUpgrade("0.2.0", deps);
  assert.equal(plan.accepted, true);
  assert.equal(plan.channel, "npm");
  await plan.apply!();
  assert.deepEqual(ran, [["npm", "install", "-g", "dahrk-node@latest"]]);
  assert.equal(counter.restarts, 1, "a node that does not restart is still on the old build");
  assert.deepEqual(saved, [{ updateCheckedAt: new Date(NOW).toISOString(), updateLatest: "0.2.0" }]);
});

test("planRemoteUpgrade: never prompts, even where `runUpdate` would have", async () => {
  let asked = 0;
  const { deps, counter } = harness({
    interactive: () => true, // a TTY is present, and it must still not be consulted
    nodeRunning: () => true,
    confirm: async () => {
      asked++;
      return false;
    },
  });
  await planRemoteUpgrade("0.2.0", deps).apply!();
  assert.equal(asked, 0, "a remote upgrade has nobody to ask - the hub already decided");
  assert.equal(counter.restarts, 1);
});

test("planRemoteUpgrade: an undrivable install refuses UP FRONT rather than failing at the deadline", async () => {
  // curl / from-source: no package manager to invoke. Answering immediately is what turns a five minute
  // wait ending in "did not reconnect" into a command on the row.
  const { deps, ran } = harness({ binPath: "/opt/dahrk/bin/dahrk" });
  const plan = planRemoteUpgrade("0.2.0", deps);
  assert.equal(plan.accepted, false);
  assert.equal(plan.channel, "unknown");
  assert.equal(plan.apply, undefined, "nothing to run, so nothing is offered to run");
  assert.deepEqual(ran, []);
});

test("planRemoteUpgrade: a BUSY node refuses without installing anything", async () => {
  // The half-applied state this exists to prevent. The old order was install-then-restart, and the
  // restart is guarded against killing in-flight jobs - so a busy node swapped the package on disk,
  // failed to bounce, and went on serving the old build. `dahrk status` then read the package (new) and
  // the portal read the handshake (old), and both were telling the truth.
  //
  // `ran` being empty is the whole assertion: refusing after `runUpgrade` would be no fix at all.
  const { deps, ran, counter, saved } = harness({ inFlightJobCount: () => 1 });
  const plan = planRemoteUpgrade("0.2.0", deps);
  assert.equal(plan.accepted, false, "a busy node says no");
  assert.equal(plan.channel, "npm", "and it is honest that the channel WAS drivable - that is what makes this `refused` rather than `manual`");
  assert.equal(plan.apply, undefined, "nothing is offered to run");
  assert.deepEqual(ran, [], "the package manager is never invoked");
  assert.equal(counter.restarts, 0, "and the node is never restarted out from under its jobs");
  assert.deepEqual(saved, [], "nothing is recorded as installed, because nothing was");
});

test("planRemoteUpgrade: an idle node still upgrades - the busy guard is not a blanket refusal", async () => {
  const { deps, ran, counter } = harness({ inFlightJobCount: () => 0 });
  const plan = planRemoteUpgrade("0.2.0", deps);
  assert.equal(plan.accepted, true);
  await plan.apply!();
  assert.deepEqual(ran, [["npm", "install", "-g", "dahrk-node@latest"]]);
  assert.equal(counter.restarts, 1);
});

test("planRemoteUpgrade: a failing package manager throws rather than reporting a phantom success", async () => {
  const { deps, counter } = harness({
    runUpgrade: () => ({ code: 243, output: "npm error EACCES: permission denied" }),
  });
  await assert.rejects(() => planRemoteUpgrade("0.2.0", deps).apply!(), /exit 243/);
  assert.equal(counter.restarts, 0, "a failed upgrade must not restart onto the same build");
});

test("planRemoteUpgrade: a failed RESTART throws - the upgrade is on disk but not in effect", async () => {
  const { deps } = harness({ restart: async () => 1 });
  await assert.rejects(() => planRemoteUpgrade("0.2.0", deps).apply!(), /restart failed/);
});

test("planRemoteUpgrade: honours the hub's PINNED target, and never re-reads `latest`", async () => {
  // The hub pins the target when the intent opens precisely so a release landing mid-rollout cannot fail
  // a node against a version nobody asked it to install.
  let fetched = 0;
  const { deps, saved } = harness({
    fetchLatest: async () => {
      fetched++;
      return "0.3.0";
    },
  });
  await planRemoteUpgrade("0.2.0", deps).apply!();
  assert.equal(fetched, 0, "the registry is not consulted - the hub already decided the target");
  assert.equal(saved[0]!.updateLatest, "0.2.0");
});
