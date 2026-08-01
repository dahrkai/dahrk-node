/**
 * The passive update check. The feature is a nicety; its failure modes are not. These pin the three things
 * that would make it a liability rather than a help:
 *   - it fails OPEN (a registry having a bad day must never stop a node starting);
 *   - it is CACHED (a crash-looping daemon must not turn our outage into npm's);
 *   - opting out means out (no nagging from a stale cache).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BACKGROUND_FETCH_TIMEOUT_MS,
  cachedUpdate,
  isStale,
  isVouchable,
  checkForUpdate,
  checkIntervalMs,
  checkSuppressed,
  DEFAULT_INTERVAL_MS,
  FETCH_TIMEOUT_MS,
  jitterMs,
  renderCheckLogLine,
  renderUpdateLogLine,
  renderUpdateNotice,
  runUpdateCheck,
  shouldCheck,
  type UpdateCheckDeps,
} from "../src/update-check.ts";
import type { NodeState } from "../src/state.ts";

const NOW = Date.parse("2026-07-11T12:00:00Z");
const iso = (ms: number): string => new Date(ms).toISOString();

test("shouldCheck: asks once, then not again until the interval is up", () => {
  const env = {};
  assert.equal(shouldCheck(NOW, undefined, DEFAULT_INTERVAL_MS, env), true, "never checked: check now");
  assert.equal(shouldCheck(NOW, iso(NOW - 1000), DEFAULT_INTERVAL_MS, env), false, "just checked: do not");
  assert.equal(shouldCheck(NOW, iso(NOW - DEFAULT_INTERVAL_MS), DEFAULT_INTERVAL_MS, env), true, "a day on");
});

/**
 * Count the checks a scheduler ticking every `tickMs` actually performs over `horizonMs`.
 *
 * The one detail that matters is `FETCH_COST_MS`: `updateCheckedAt` records when a check RESOLVED, so it
 * is always written a little AFTER the tick that started it. That few milliseconds is the entire bug this
 * simulates - it is enough to push the next same-period tick under the gate, every single time.
 */
function simulateChecks(tickMs: number, intervalMs: number, horizonMs: number): number {
  const FETCH_COST_MS = 50;
  let last: string | undefined;
  let checks = 0;
  for (let t = tickMs; t <= horizonMs; t += tickMs) {
    if (!shouldCheck(NOW + t, last, intervalMs, {})) continue;
    checks++;
    last = iso(NOW + t + FETCH_COST_MS);
  }
  return checks;
}

test("CADENCE: a scheduler on the interval must not silently check at HALF the rate", () => {
  // The regression. `setInterval(tick, interval)` plus a gate of `now - checkedAt >= interval` looks
  // obviously correct and is not: the timestamp is written when the fetch resolves, so every tick lands
  // fractionally early, takes the not-due branch, and writes and logs nothing. A node reported itself
  // "checked and up to date" for ten hours on a six hour interval, and missed a release by two.
  const hour = 3_600_000;
  const interval = 6 * hour;
  const day = 24 * hour;

  assert.equal(simulateChecks(interval, interval, day), 4, "ticking ON the interval still checks 4x a day");
  assert.equal(simulateChecks(interval / 4, interval, day), 4, "and so does the sub-interval scheduler");
  // Belt and braces: whatever the tick rate, a day of a six hour interval is four checks, never two.
  for (const ticks of [1, 2, 3, 4, 6]) {
    assert.equal(simulateChecks(interval / ticks, interval, day), 4, `${ticks} ticks per interval`);
  }
});

test("shouldCheck: the skew tolerance never swallows the interval itself", () => {
  // The tolerance is a fudge for a timestamp written late, not licence to check early. It must stay well
  // inside the interval, and must not turn a deliberately tiny interval into one that never fires.
  assert.equal(shouldCheck(NOW, iso(NOW - 1000), DEFAULT_INTERVAL_MS, {}), false, "a second ago: no");
  assert.equal(shouldCheck(NOW, iso(NOW - 3_600_000), DEFAULT_INTERVAL_MS, {}), false, "an hour in: still no");
  // `DAHRK_UPDATE_CHECK_INTERVAL_MS=0` documents "check every start"; the tolerance must not break that.
  assert.equal(shouldCheck(NOW, iso(NOW), 0, {}), true, "a zero interval always checks");
  assert.equal(shouldCheck(NOW, iso(NOW - 1), 1000, {}), false, "a 1s interval is not widened to a minute");
});

test("shouldCheck: a nonsense or future timestamp checks now rather than never again", () => {
  // Being a day early is harmless. Silently never checking again is the exact failure we are fixing, so a
  // corrupt state file must not be able to cause it.
  assert.equal(shouldCheck(NOW, "not-a-date", DEFAULT_INTERVAL_MS, {}), true);
  assert.equal(shouldCheck(NOW, iso(NOW + 86_400_000), DEFAULT_INTERVAL_MS, {}), true, "clock jumped back");
});

test("suppression: ours, npm's de-facto one, and CI all switch it off", () => {
  assert.equal(checkSuppressed({}), false);
  assert.equal(checkSuppressed({ DAHRK_NO_UPDATE_CHECK: "1" }), true);
  assert.equal(checkSuppressed({ NO_UPDATE_NOTIFIER: "1" }), true, "honour the ecosystem's opt-out, not just ours");
  assert.equal(checkSuppressed({ CI: "true" }), true);
  assert.equal(shouldCheck(NOW, undefined, DEFAULT_INTERVAL_MS, { CI: "true" }), false);
});

test("checkIntervalMs: a garbage override falls back rather than becoming NaN", () => {
  // NaN compares false against everything, which would silently mean "check on every single start".
  assert.equal(checkIntervalMs({}), DEFAULT_INTERVAL_MS);
  assert.equal(checkIntervalMs({ DAHRK_UPDATE_CHECK_INTERVAL_MS: "0" }), 0);
  assert.equal(checkIntervalMs({ DAHRK_UPDATE_CHECK_INTERVAL_MS: "banana" }), DEFAULT_INTERVAL_MS);
  assert.equal(checkIntervalMs({ DAHRK_UPDATE_CHECK_INTERVAL_MS: "-5" }), DEFAULT_INTERVAL_MS);
});

test("jitterMs: stays inside the spread, so a fleet's checks scatter instead of stampeding", () => {
  assert.equal(jitterMs(0, 3600_000), 0);
  assert.ok(jitterMs(0.999, 3600_000) < 3600_000);
});

/** Fake IO: a controllable clock, registry, and state file. */
type SavedPatch = { updateCheckedAt?: string; updateLatest?: string; updateCheckFailedAt?: string };

function deps(over: Partial<UpdateCheckDeps> & { state?: NodeState } = {}): UpdateCheckDeps & {
  saved: SavedPatch[];
  fetches: number;
} {
  let state: NodeState = over.state ?? {};
  const saved: SavedPatch[] = [];
  let fetches = 0;
  return {
    env: {},
    now: () => NOW,
    binPath: "/usr/local/lib/node_modules/dahrk-node/dist/main.js",
    readState: () => state,
    saveResult: (patch) => {
      saved.push(patch);
      state = { ...state, ...patch };
    },
    fetchLatest: async () => {
      fetches++;
      return "0.2.1";
    },
    get saved() {
      return saved;
    },
    get fetches() {
      return fetches;
    },
    ...over,
  } as UpdateCheckDeps & { saved: typeof saved; fetches: number };
}

test("a newer version is reported, and named with the channel it would upgrade through", async () => {
  const d = deps();
  const found = await checkForUpdate("0.1.8", d);
  assert.deepEqual(found, { current: "0.1.8", latest: "0.2.1", channel: "npm" });
  assert.match(renderUpdateNotice(found!), /update available: 0\.1\.8 -> 0\.2\.1 \(npm: npm install -g dahrk-node@latest\)/);
  assert.equal(renderUpdateLogLine(found!), "UPDATE_AVAILABLE:0.2.1 current=0.1.8");
});

test("being current says nothing at all", async () => {
  assert.equal(await checkForUpdate("0.2.1", deps()), undefined);
  assert.equal(await checkForUpdate("9.9.9", deps()), undefined, "ahead of the registry is not an update");
});

test("FAIL OPEN: a registry that throws, times out, or lies is silently no-notice", async () => {
  const boom = deps({
    fetchLatest: async () => {
      throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
    },
  });
  assert.equal(await checkForUpdate("0.1.8", boom), undefined, "offline must never block or fail a start");

  const timeout = deps({
    fetchLatest: async () => {
      throw Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
    },
  });
  assert.equal(await checkForUpdate("0.1.8", timeout), undefined);

  const garbage = deps({ fetchLatest: async () => "not-a-version" });
  assert.equal(await checkForUpdate("0.1.8", garbage), undefined, "an unparseable version is not 'newer'");
});

test("OBSERVABLE: the three ways of saying nothing are told apart, and logged", async () => {
  // `checkForUpdate` returns undefined for current, not-due AND failed alike, and the daemon only ever
  // logged the fourth case. So the tick that quietly did nothing every interval left no trace anywhere -
  // not in the log, not in the state file - and the bug was invisible until someone compared a state file
  // timestamp against a publish time by hand.
  const current = await runUpdateCheck("0.2.1", deps());
  assert.deepEqual(current, { kind: "current", latest: "0.2.1" });
  assert.equal(renderCheckLogLine(current), "UPDATE_CHECK:current latest=0.2.1");

  const available = await runUpdateCheck("0.1.8", deps());
  assert.equal(available.kind, "available");
  assert.equal(renderCheckLogLine(available), "UPDATE_AVAILABLE:0.2.1 current=0.1.8");

  const fresh = deps({ state: { updateCheckedAt: iso(NOW - 1000), updateLatest: "0.2.1" } });
  const notDue = await runUpdateCheck("0.2.1", fresh);
  assert.deepEqual(notDue, { kind: "not-due", checkedAt: iso(NOW - 1000) });
  assert.equal(fresh.fetches, 0, "not-due must not touch the registry");
  assert.match(renderCheckLogLine(notDue)!, /^UPDATE_CHECK:not-due since=/);

  const suppressed = await runUpdateCheck("0.1.8", deps({ env: { CI: "true" } }));
  assert.deepEqual(suppressed, { kind: "suppressed" });
  assert.equal(renderCheckLogLine(suppressed), undefined, "opted out means no line either");
});

test("a FAILED check is recorded, so a node failing for a week cannot look current", async () => {
  // The fail-open path wrote nothing at all, which meant "every check has timed out since Tuesday" and
  // "checked a minute ago, you are current" were the same state file. `updateCheckedAt` deliberately does
  // NOT move: the age of the last real answer is what `status` reasons about, and advancing it on a
  // failure would launder "could not ask" into "asked recently".
  const boom = deps({
    state: { updateCheckedAt: iso(NOW - 7 * 86_400_000), updateLatest: "0.1.8" },
    fetchLatest: async () => {
      throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
    },
  });
  const outcome = await runUpdateCheck("0.1.8", boom);
  assert.equal(outcome.kind, "failed");
  assert.match(renderCheckLogLine(outcome)!, /^UPDATE_CHECK:failed reason=getaddrinfo/);
  assert.deepEqual(boom.saved, [{ updateCheckFailedAt: iso(NOW) }]);
  assert.equal(boom.saved[0]!.updateCheckedAt, undefined, "a failure must not pose as a successful check");
});

test("the periodic check gets a patient timeout, the start-path check a short one", async () => {
  // Nobody waits on the daemon's check, so giving up after 1.5s only loses releases on a slow link. The
  // start-path bound stays short because there an operator IS waiting.
  assert.ok(BACKGROUND_FETCH_TIMEOUT_MS > FETCH_TIMEOUT_MS, "the background bound must be the patient one");

  // A registry that answers in 80ms: too slow for a 20ms bound, comfortable for a 5s one. The same fetch
  // under the two bounds is the only thing that proves the deps' value is the one actually applied.
  const slowRegistry = (signal?: AbortSignal): Promise<string> =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve("0.2.1"), 80);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      });
    });

  const impatient = await runUpdateCheck("0.1.8", deps({ fetchTimeoutMs: 20, fetchLatest: slowRegistry }));
  assert.equal(impatient.kind, "failed", "a 20ms bound gives up on an 80ms registry");

  const patient = await runUpdateCheck("0.1.8", deps({ fetchTimeoutMs: 5_000, fetchLatest: slowRegistry }));
  assert.equal(patient.kind, "available", "a generous bound lets the same answer land");
});

test("CACHED: a second check inside the interval does not touch the registry", async () => {
  const d = deps();
  await checkForUpdate("0.1.8", d);
  assert.equal(d.fetches, 1);
  assert.deepEqual(d.saved, [{ updateCheckedAt: iso(NOW), updateLatest: "0.2.1" }]);

  // This is the crash-loop case: the daemon restarts every ThrottleInterval and calls this each boot.
  const again = await checkForUpdate("0.1.8", d);
  assert.equal(d.fetches, 1, "a restart loop must not become a registry flood");
  assert.deepEqual(
    again,
    { kind: "available", checkedAt: NOW, current: "0.1.8", latest: "0.2.1", channel: "npm" },
    "but we still know",
  );
});

test("opting out means out: no fetch, and no nagging from what the cache already knows", async () => {
  const d = deps({
    env: { DAHRK_NO_UPDATE_CHECK: "1" },
    state: { updateLatest: "0.2.1", updateCheckedAt: iso(NOW - 1000) },
  });
  assert.equal(await checkForUpdate("0.1.8", d), undefined);
  assert.equal(d.fetches, 0);
});

const BIN = "/usr/local/lib/node_modules/dahrk-node/dist/main.js";
const AT = "2026-07-13T12:00:00Z";

test("cachedUpdate: what `dahrk status` reads - the last answer, dated, and no network", () => {
  assert.deepEqual(cachedUpdate({ updateLatest: "0.2.1", updateCheckedAt: AT }, "0.1.8", BIN), {
    kind: "available",
    checkedAt: Date.parse(AT),
    current: "0.1.8",
    latest: "0.2.1",
    channel: "npm",
  });
});

test("cachedUpdate: 'you are current' and 'I have never checked' are DIFFERENT answers", () => {
  // The conflation this exists to fix. Both used to come back as `undefined`, so `status` printed an
  // identical bare version line whether it had just confirmed you were on the latest or had never once
  // managed to ask. A blank space cannot mean "you are fine" and "I have no idea" at the same time.
  assert.deepEqual(cachedUpdate({ updateLatest: "0.1.8", updateCheckedAt: AT }, "0.1.8", BIN), {
    kind: "current",
    checkedAt: Date.parse(AT),
    latest: "0.1.8",
  });
  assert.deepEqual(cachedUpdate({}, "0.1.8", BIN), { kind: "unknown" }, "nothing has ever asked");
});

test("cachedUpdate: an answer we cannot DATE is one we must not present as current", () => {
  // A `updateLatest` with no (or an unparseable) timestamp could be from ten minutes ago or from last year.
  // Without an age we cannot qualify the claim, so we decline to make it.
  assert.deepEqual(cachedUpdate({ updateLatest: "0.1.8" }, "0.1.8", BIN), { kind: "unknown" });
  assert.deepEqual(cachedUpdate({ updateLatest: "0.9.9", updateCheckedAt: "not-a-date" }, "0.1.8", BIN), {
    kind: "unknown",
  });
});

test("isStale: a cached answer goes stale at a MULTIPLE of the interval, so one knob moves both", () => {
  const now = Date.parse(AT);
  const hour = 3_600_000;
  const interval = 6 * hour;
  assert.equal(isStale(now - 3 * hour, now, interval), false, "fresher than one interval");
  assert.equal(isStale(now - 9 * hour, now, interval), false, "overdue, but still worth showing");
  assert.equal(isStale(now - 13 * hour, now, interval), true, "past 2 intervals: stop stating it as fact");
  // Someone who checks hourly hears about staleness sooner, without discovering a second knob.
  assert.equal(isStale(now - 3 * hour, now, hour), true);
});

test("isVouchable: the TICK is a narrower claim than merely not-stale", () => {
  // The gap between these two predicates is the bug this pair exists to close. A 10h old answer under a 6h
  // interval is not yet stale - still worth printing - but we have no business putting a green tick on it:
  // a check was due four hours ago and did not land, and 0.2.0 could have shipped in between. It did.
  const now = Date.parse(AT);
  const hour = 3_600_000;
  const interval = 6 * hour;
  assert.equal(isVouchable(now - 3 * hour, now, interval), true, "inside the interval: we did check");
  assert.equal(isVouchable(now - 10 * hour, now, interval), false, "a check was due and did not land");
  assert.equal(isStale(now - 10 * hour, now, interval), false, "...yet not stale enough to nag about");
});

test("BOUNDED: a registry that hangs forever is aborted, not waited on - a start must never hang", async () => {
  // The other fail-open tests inject a fetch that throws, which bypasses the timeout entirely. This one
  // pins the wiring: a registry that simply never answers (the realistic bad day - not a refused
  // connection, a black hole) must be cut off and treated as "no notice".
  let seen: AbortSignal | undefined;
  const d = deps({
    fetchLatest: (signal) => {
      seen = signal;
      return new Promise((_resolve, reject) => {
        // A pending real `fetch` holds an open socket, which holds the event loop open. This timer stands
        // in for that. Without it the loop would drain while we await - `AbortSignal.timeout`'s own timer
        // is unref'd and does not hold it - and the test runner would cancel this test rather than run it.
        const openSocket = setTimeout(() => reject(new Error("the registry never answered")), 30_000);
        signal?.addEventListener("abort", () => {
          clearTimeout(openSocket);
          reject(new Error("aborted"));
        });
      });
    },
  });

  const started = Date.now();
  const found = await checkForUpdate("0.1.8", d);
  const waited = Date.now() - started;

  assert.equal(found, undefined, "a hang is just another failure: say nothing and carry on");
  assert.ok(seen instanceof AbortSignal, "the check must pass a timeout signal, or it can wait forever");
  assert.ok(waited < 5_000, `the check waited ${waited}ms - it must be bounded by FETCH_TIMEOUT_MS`);
});
