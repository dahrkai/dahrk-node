/**
 * `dahrk status`: the local report (running? enrolled? can I serve a Job? what is it doing?). The renderer
 * is pure, so these drive it with gathered facts; `runStatus` is driven with fake IO (no host, no
 * supervisor, no log).
 *
 * Two of these tests are contracts rather than assertions about wording, and they are the ones to keep if
 * everything else is rewritten: `status` performs NO network request, and the only process it spawns is the
 * supervisor probe. Everything the command learned to report here (in-flight jobs, the last connection, a
 * foreign node) is a local file read precisely so that those two stay true.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobLedgerEntry } from "@dahrk/edge";
import {
  isUnhealthy,
  lastConnection,
  renderStatus,
  resolvePresence,
  runStatus,
  type StatusDeps,
  type StatusFacts,
} from "../src/status.ts";
import { resolveServiceNames } from "../src/service.ts";
import { persistEnrolment, writeState } from "../src/state.ts";

const NOW = Date.parse("2026-07-13T12:00:00Z");

const facts = (over: Partial<StatusFacts> = {}): StatusFacts => ({
  clientVersion: "0.1.7",
  hubUrl: "wss://api.dahrk.ai",
  stateFile: "/home/u/.dahrk/node.json",
  state: { nodeId: "node-1", enrolToken: "sket_abc", name: "local-a1", tenantId: "t_default" },
  envToken: false,
  runtimes: [{ runtime: "claude-code", capable: true, credential: "brokered", available: true, detail: "brokered credentials from the hub" }],
  presence: { kind: "running", pid: 42 },
  jobs: [],
  service: { installed: true, running: true, pid: 42, loaded: true },
  // Checked recently, and current: the boring happy case, so a test that cares about currency has to say so.
  update: { kind: "current", checkedAt: NOW - 60_000 },
  updateIntervalMs: 6 * 3600_000,
  now: NOW,
  ...over,
});

const report = (over: Partial<StatusFacts> = {}): string => renderStatus(facts(over)).join("\n");

test("the verdict comes FIRST: the answer, before the working", () => {
  const first = renderStatus(facts()).find((l) => l.trim() !== "");
  assert.match(first ?? "", /Node running \(pid 42\)/);
});

test("the happy path names the node, its tenant, its runtime versions, and that it is idle", () => {
  const out = report();
  assert.match(out, /Enrolled\s+local-a1/);
  assert.match(out, /t_default/);
  assert.match(out, /Runtimes\s+claude-code/);
  assert.match(out, /Work\s+idle/);
});

test("the enrolment token is NEVER printed, not even a prefix", () => {
  assert.doesNotMatch(report(), /sket_/, "a partial token is still a token in a screenshot");
});

test("not enrolled says exactly how to enrol", () => {
  const out = report({ state: { nodeId: "node-1" } });
  assert.match(out, /Enrolled\s+no\s+run `dahrk start --token <token>` once to enrol/);
});

test("a token from the environment reads as enrolled-but-uncached, not as 'not enrolled'", () => {
  // The case a running service hits: the unit's env block holds the token, but nothing cached it yet.
  const out = report({ state: { nodeId: "node-1" }, envToken: true });
  assert.match(out, /Enrolled\s+via DAHRK_ENROL_TOKEN \(caches on the next successful start\)/);
});

test("a crash-loop is called out loudly, and points at the logs", () => {
  const out = report({ presence: { kind: "crashed" }, service: { installed: true, running: false, loaded: true } });
  assert.match(out, /NOT running/);
  assert.match(out, /crash-looping/);
  assert.match(out, /dahrk logs -f/);
});

test("a node the operator STOPPED is reported as stopped, not as a crash-loop", () => {
  // Same supervisor facts as the test above - installed, not running. Only the recorded intent differs,
  // which is the whole reason we record it: the supervisor cannot tell us why it is down.
  const out = report({ presence: { kind: "stopped" }, service: { installed: true, running: false, loaded: false } });
  assert.match(out, /Node stopped/);
  assert.doesNotMatch(out, /crash-looping/);
});

// --- Currency: status must never be silent about whether the client is current -----------------

test("an available update gets its own line, right under the verdict, where the eye already is", () => {
  const out = report({
    update: { kind: "available", checkedAt: NOW - 3600_000, current: "0.1.7", latest: "0.2.1", channel: "npm" },
  });
  assert.match(out, /Update available: 0\.1\.7 .* 0\.2\.1/);
  assert.match(out, /run `dahrk update`/);
  // It sits above the detail block, not buried inside it: the second non-blank line of the report.
  const visible = renderStatus(
    facts({ update: { kind: "available", checkedAt: NOW, current: "0.1.7", latest: "0.2.1", channel: "npm" } }),
  ).filter((l) => l.trim() !== "");
  assert.match(visible[1] ?? "", /Update available/);
});

test("being CURRENT is stated positively, and dated - silence used to mean this AND 'no idea'", () => {
  const out = report({ update: { kind: "current", checkedAt: NOW - 3 * 3600_000, latest: "0.1.7" } });
  assert.match(out, /Client\s+0\.1\.7\s+.*up to date \(checked 3h ago\)/);
});

test("the TICK is only for an answer inside the interval - not merely one that is not yet stale", () => {
  // The reported bug. A 10h old answer under a 6h interval is not stale enough to nag about, but a check
  // was due four hours ago and did not land, and 0.2.0 shipped in the gap. `status` said "✔ up to date"
  // throughout. Report the answer and its age; do not put a tick on a claim we cannot make.
  const out = report({
    update: { kind: "current", checkedAt: NOW - 10 * 3600_000, latest: "0.1.7" },
    updateIntervalMs: 6 * 3600_000,
  });
  assert.doesNotMatch(out, /up to date/, "a check was due and did not land - we are not vouching for this");
  assert.match(out, /latest known 0\.1\.7 \(checked 10h ago\)/, "still worth showing, just not blessing");
  assert.doesNotMatch(out, /to refresh/, "not stale enough to nag about either - that is a louder band");
});

test("NEVER having checked says so, and names the command that fixes it", () => {
  const out = report({ update: { kind: "unknown" } });
  assert.match(out, /Client\s+0\.1\.7\s+.*update status unknown - run `dahrk update --check`/);
  assert.doesNotMatch(out, /up to date/, "we have no business implying a clean bill of health");
});

test("a STALE answer is not presented as fact - no tick, and it points at the refresh", () => {
  // Well past the staleness bound. The registry may have moved several times since; saying "up to
  // date ✔" here would be believed, and would be a guess.
  const out = report({
    update: { kind: "current", checkedAt: NOW - 30 * 3600_000, latest: "0.1.7" },
    updateIntervalMs: 6 * 3600_000,
  });
  assert.match(out, /as of 1d 6h ago - run `dahrk update --check` to refresh/);
  assert.doesNotMatch(out, /✔ .*up to date/, "a week-old answer with a green tick is worse than no answer");
});

test("opting out of update checks means status says nothing about them at all", () => {
  // Distinct from `unknown`: the operator asked us to stop, so nagging them from the cache in a quieter
  // voice would be the same disrespect.
  const out = report({ update: undefined });
  assert.match(out, /Client\s+0\.1\.7\s*$/m);
  assert.doesNotMatch(out, /up to date|update status unknown|Update available/);
});

test("no service installed, and no runtimes, each explain the consequence", () => {
  const out = report({ presence: { kind: "not-installed" }, runtimes: [] });
  assert.match(out, /Node not installed/);
  assert.match(out, /none available - this node will serve no Jobs/);
});

// --- The two-source liveness check: a foreground / pm2 node is a REAL node --------------------

test("resolvePresence: a node held only by the pidfile is running, NOT 'not installed'", () => {
  // The bug this fixes: `status` asked launchd and nothing else, so a perfectly healthy
  // `dahrk start --foreground` (or pm2, or a container) reported as absent.
  const p = resolvePresence({ installed: false, running: false, loaded: false }, 4821, undefined);
  assert.deepEqual(p, { kind: "foreign", pid: 4821 });
  assert.match(renderStatus(facts({ presence: p })).join("\n"), /running under another supervisor \(pid 4821\)/);
});

test("resolvePresence: the supervisor wins when it has the node up", () => {
  assert.deepEqual(resolvePresence({ installed: true, running: true, pid: 7, loaded: true }, 7, undefined), {
    kind: "running",
    pid: 7,
  });
});

test("resolvePresence: installed, down, nobody holding the lock - crashed unless it was stopped on purpose", () => {
  // Loaded: the supervisor is holding this job and it still will not stay up.
  const down = { installed: true, running: false, loaded: true };
  assert.deepEqual(resolvePresence(down, undefined, undefined), { kind: "crashed" });
  assert.deepEqual(resolvePresence(down, undefined, "stopped"), { kind: "stopped" });
});

test("resolvePresence: a SWITCHED-OFF supervisor is not a crash-loop", () => {
  // The state a portal upgrade used to leave behind: the unit is on disk, nothing is loaded, and the
  // operator never asked for any of it. Calling it a crash-loop sent them to a log that was empty, because
  // the process had never run.
  const off = { installed: true, running: false, loaded: false, disabled: true };
  assert.deepEqual(resolvePresence(off, undefined, undefined), { kind: "not-loaded", disabled: true });
  // Intent decides first, and it must: `dahrk stop` IS a disable, so a deliberately stopped node has
  // exactly this shape and must never be reported as a fault.
  assert.deepEqual(resolvePresence(off, undefined, "stopped"), { kind: "stopped" });
  // Not loaded, but we could not find out whether that was deliberate: still broken, still not a crash-loop.
  assert.deepEqual(resolvePresence({ installed: true, running: false, loaded: false }, undefined, undefined), {
    kind: "not-loaded",
  });
});

test("a switched-off node names the disable, offers `dahrk start`, and fails the health check", () => {
  const out = report({
    presence: { kind: "not-loaded", disabled: true },
    service: { installed: true, running: false, loaded: false, disabled: true },
  });
  assert.match(out, /DISABLED/);
  assert.match(out, /dahrk start/);
  // The three commands that were offered before, all of which read an empty log or a log-shaped nothing.
  assert.doesNotMatch(out, /crash-looping/);
  assert.doesNotMatch(out, /dahrk logs -f/);
  assert.doesNotMatch(out, /dahrk diagnose/);
  // A node nobody switched off deliberately, which is down: `status` must exit non-zero for a health check.
  assert.equal(isUnhealthy({ presence: { kind: "not-loaded", disabled: true } }), true);
});

// --- In-flight work ---------------------------------------------------------------------------

const job = (over: Partial<JobLedgerEntry> = {}): JobLedgerEntry => ({
  jobId: "j1",
  runId: "r_8fa2c1",
  kind: "stage",
  stageId: "implement",
  startedAt: NOW - 4 * 60_000,
  nodePid: 42,
  ...over,
});

test("in-flight work names the run, the stage, and how long it has been going", () => {
  const out = report({ jobs: [job()] });
  assert.match(out, /Work\s+r_8fa2c1\s+\/\s+implement\s+4m/);
});

// --- Last-known connection (never a live one: status dials nothing) ---------------------------

test("lastConnection: reads the most recent EDGE_ marker, with its detail", () => {
  const at = "2026-07-13T11:00:00Z";
  const c = lastConnection([
    { msg: "EDGE_CONNECTED", time: "2026-07-13T10:00:00Z" },
    { msg: "EDGE_WELCOMED:local-a1", time: "2026-07-13T10:00:01Z" },
    { msg: "JOB_STARTED:j1", time: "2026-07-13T10:30:00Z" },
    { msg: "EDGE_DISCONNECTED:1006", time: at },
  ]);
  assert.deepEqual(c, { event: "disconnected", at: Date.parse(at), detail: "1006" });
});

test("lastConnection: a log with no connection markers yields nothing to claim", () => {
  assert.equal(lastConnection([{ msg: "JOB_STARTED:j1", time: "2026-07-13T10:00:00Z" }]), undefined);
});

test("lastConnection: a REJECTED node reads as rejected, not as the EDGE_CONNECTED that precedes it", () => {
  // The exact log the incident produced, and the exact reason `status` lied about it. `EDGE_CONNECTED` is
  // written when the socket opens - BEFORE the hub has looked at the token, which rides in the `hello` body
  // rather than a header - so every rejected connection has a `connected` marker sitting right in front of
  // the rejection. `status` only knew the first of those two, and duly reported a healthy connected node
  // that was in fact dying six times a minute.
  const at = "2026-07-13T11:00:02Z";
  const c = lastConnection([
    { msg: "RUNTIMES_DETECTED:claude-code", time: "2026-07-13T11:00:00Z" },
    { msg: "EDGE_CONNECTED", time: "2026-07-13T11:00:01Z" },
    { msg: "EDGE_REJECTED:4401 invalid or expired enrolment token", time: at },
  ]);
  assert.deepEqual(c, { event: "rejected", at: Date.parse(at), detail: "4401" });
});

// ---------------------------------------------------------------------------
// Markers belong to a PROCESS. `node.jsonl` is appended to across restarts and never rotated at boot,
// so the newest line in it is not automatically a fact about the node as it stands now.
// ---------------------------------------------------------------------------

test("lastConnection: a dead process's rejection never outranks the live process's welcome", () => {
  // The exact shape of the incident. A node was rejected, the bug behind that was fixed, the node
  // re-enrolled and was welcomed - and `status` still read the OLD process's park and reported a healthy
  // node as serving no Jobs, with a non-zero exit to match.
  const welcomed = "2026-08-03T21:38:00Z";
  const c = lastConnection(
    [
      { msg: "EDGE_REJECTED:4401 invalid or expired enrolment token", time: "2026-08-03T18:39:50Z", pid: 100 },
      { msg: "EDGE_PARKED:enrolment rejected", time: "2026-08-03T18:39:50Z", pid: 100 },
      { msg: "EDGE_CONNECTED", time: "2026-08-03T21:37:59Z", pid: 200 },
      { msg: "EDGE_WELCOMED:node-a", time: welcomed, pid: 200 },
    ],
    { pid: 200 },
  );
  assert.deepEqual(c, { event: "welcomed", at: Date.parse(welcomed) });
});

test("lastConnection: the live process's own rejection still wins - this must not over-correct", () => {
  const at = "2026-08-03T21:38:02Z";
  const c = lastConnection(
    [
      { msg: "EDGE_WELCOMED:node-a", time: "2026-08-03T18:00:00Z", pid: 100 },
      { msg: "EDGE_CONNECTED", time: "2026-08-03T21:38:01Z", pid: 200 },
      { msg: "EDGE_REJECTED:4401 invalid or expired enrolment token", time: at, pid: 200 },
    ],
    { pid: 200 },
  );
  assert.deepEqual(c, { event: "rejected", at: Date.parse(at), detail: "4401" });
});

test("lastConnection: records with no pid are unattributable, so a live node ignores them", () => {
  // Written by a client older than the pid field. They cannot be tied to any process, and treating them
  // as current is precisely the mistake being fixed - so a freshly upgraded node reports nothing until it
  // next connects, which is the truth.
  const c = lastConnection(
    [{ msg: "EDGE_PARKED:enrolment rejected", time: "2026-08-03T18:39:50Z" }],
    { pid: 200 },
  );
  assert.equal(c, undefined);
});

test("lastConnection: with the node DOWN, every marker counts again", () => {
  // No live process to scope to, so the last thing that happened is the useful fact - and the presence
  // line already says the node is not running.
  const at = "2026-08-03T18:39:50Z";
  const c = lastConnection([{ msg: "EDGE_PARKED:enrolment rejected", time: at, pid: 100 }]);
  assert.deepEqual(c, { event: "parked", at: Date.parse(at) });
});

test("a running node with nothing to report yet says so, and is not called unhealthy", () => {
  // Every `dahrk start` passes through this instant. It used to be papered over with whatever the previous
  // process last said, which is where the stale rejection came from.
  const f = facts({ presence: { kind: "running", pid: 200 } });
  assert.match(renderStatus(f).join("\n"), /connecting/);
  assert.equal(isUnhealthy(f), false);
});

test("a node that has NEVER connected still says nothing rather than 'connecting'", () => {
  const f = facts({ presence: { kind: "stopped" } });
  assert.doesNotMatch(renderStatus(f).join("\n"), /connecting/);
});

test("a parked node is UNHEALTHY, and status says what to do about it", () => {
  const connection = { event: "parked", at: NOW - 60_000 };
  assert.equal(isUnhealthy({ presence: { kind: "running", pid: 1 }, connection }), true);

  const out = report({ connection });
  assert.match(out, /serving no Jobs/);
  assert.match(out, /dahrk start --token/);
});

test("a welcomed node is healthy: status must not cry wolf over a node that is simply working", () => {
  assert.equal(
    isUnhealthy({ presence: { kind: "running", pid: 1 }, connection: { event: "welcomed", at: NOW } }),
    false,
  );
});

test("the hub line says when it was LAST known connected, and never claims it is connected NOW", () => {
  const out = report({ connection: { event: "welcomed", at: NOW - 2 * 3600_000 } });
  assert.match(out, /Hub\s+wss:\/\/api\.dahrk\.ai\s+\(welcomed 2h ago\)/);
});

/** Fake IO: a host with a launchd service whose probe output we control, and no jobs / log / pidfile. */
function deps(over: Partial<StatusDeps> & { stateDir: string }): StatusDeps {
  const lines: string[] = [];
  return {
    platform: "darwin",
    homeDir: "/home/u",
    env: { DAHRK_STATE_DIR: over.stateDir },
    probeRuntimes: async () => [{ runtime: "claude-code", capable: true, credential: "brokered", available: true, detail: "brokered credentials from the hub" }],
    fileExists: () => true,
    capture: () => ({ code: 0, stdout: '\t"PID" = 79747;\n' }),
    lockedPid: () => undefined,
    jobs: () => [],
    connection: () => undefined,
    now: () => NOW,
    out: (l) => void lines.push(l),
    ...over,
  };
}

test("runStatus: a running service exits 0 and reports the pid from the supervisor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-status-"));
  try {
    const out: string[] = [];
    const d = deps({ stateDir: dir, out: (l) => void out.push(l) });
    persistEnrolment(d.env, { token: "sket_abc", name: "local-a1", tenantId: "t_default" });

    const code = await runStatus({ clientVersion: "0.1.7", hubUrl: "wss://api.dahrk.ai" }, d);

    assert.equal(code, 0);
    assert.match(out.join("\n"), /Node running \(pid 79747\)/);
    assert.match(out.join("\n"), /Enrolled\s+local-a1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runStatus: a ledger entry owned by a DEAD process is not reported as live work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-status-"));
  try {
    const out: string[] = [];
    // The supervisor has the node up as pid 79747. The ledger still holds an entry from pid 111, a node
    // that died mid-stage. Boot reconciles that; `status` must not report it as something happening now.
    const d = deps({
      stateDir: dir,
      out: (l) => void out.push(l),
      jobs: () => [job({ nodePid: 111 }), job({ jobId: "j2", runId: "r_live", nodePid: 79747 })],
    });
    await runStatus({ clientVersion: "0.1.7", hubUrl: "wss://x" }, d);

    const text = out.join("\n");
    assert.match(text, /r_live/, "the live job is reported");
    assert.doesNotMatch(text, /r_8fa2c1/, "the dead process's leftover is not");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runStatus: installed but down exits 1, so it works as a health check in a script", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-status-"));
  try {
    // launchd knows the label but the job is not up: a plist with no "PID" key.
    const d = deps({ stateDir: dir, capture: () => ({ code: 0, stdout: '\t"LastExitStatus" = 78;\n' }) });
    assert.equal(await runStatus({ clientVersion: "0.1.7", hubUrl: "wss://x" }, d), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runStatus: an agent the supervisor was told not to run is diagnosed as exactly that", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-status-"));
  try {
    const out: string[] = [];
    const spawned: string[][] = [];
    // The whole outage, at the seam: `launchctl list` does not know the label (it was unloaded with `-w`),
    // and the disabled listing names us. Before this, `status` called it a crash-loop.
    const d = deps({
      stateDir: dir,
      out: (l) => void out.push(l),
      uid: 501,
      capture: (argv) => {
        spawned.push(argv);
        // The disabled listing names this node's own (state-dir-derived) label, not the default.
        const label = resolveServiceNames({ DAHRK_STATE_DIR: dir }).launchdLabel;
        return argv[1] === "list"
          ? { code: 113, stdout: "" }
          : { code: 0, stdout: `disabled services = {\n\t"${label}" => disabled\n}` };
      },
    });

    assert.equal(await runStatus({ clientVersion: "0.1.7", hubUrl: "wss://x" }, d), 1);
    const text = out.join("\n");
    assert.match(text, /DISABLED/);
    assert.match(text, /dahrk start/);
    assert.doesNotMatch(text, /crash-looping/);
    assert.deepEqual(spawned[1], ["launchctl", "print-disabled", "gui/501"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runStatus: a node stopped ON PURPOSE exits 0 - status must not cry wolf as a health check", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-status-"));
  try {
    // Byte-for-byte the supervisor facts of the crash-loop test above (unit present, no PID). The only
    // difference is that the operator ran `dahrk stop`. Reporting that as unhealthy would make every
    // deliberately-stopped node page someone.
    const d = deps({ stateDir: dir, capture: () => ({ code: 0, stdout: '\t"LastExitStatus" = 0;\n' }) });
    writeState(d.env, { desired: "stopped" });
    assert.equal(await runStatus({ clientVersion: "0.1.7", hubUrl: "wss://x" }, d), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runStatus: an update notice comes from the state file - status never dials the registry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-status-"));
  const realFetch = globalThis.fetch;
  try {
    const out: string[] = [];
    // Any fetch at all fails the test: `status` is the command that works on a plane.
    globalThis.fetch = (() => assert.fail("status must not perform any network request")) as typeof fetch;
    const d = deps({ stateDir: dir, out: (l) => void out.push(l) });
    writeState(d.env, { updateLatest: "0.9.9", updateCheckedAt: new Date().toISOString() });

    await runStatus({ clientVersion: "0.1.7", hubUrl: "wss://x" }, d);

    assert.match(out.join("\n"), /Update available: 0\.1\.7 .* 0\.9\.9/);
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runStatus: a never-installed service is not a failure (exit 0) and is not probed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-status-"));
  try {
    let probed = false;
    const d = deps({
      stateDir: dir,
      fileExists: () => false,
      capture: () => {
        probed = true;
        return { code: 0, stdout: "" };
      },
    });
    assert.equal(await runStatus({ clientVersion: "0.1.7", hubUrl: "wss://x" }, d), 0);
    assert.equal(probed, false, "no unit file: do not spawn the supervisor at all");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runStatus: status never dials the hub - it only reports the URL it would dial", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-status-"));
  try {
    const out: string[] = [];
    const d = deps({
      stateDir: dir,
      out: (l) => void out.push(l),
      capture: (argv) => {
        // The label follows this node's (temp) state dir, so it is the isolated one, not the default.
        const label = resolveServiceNames({ DAHRK_STATE_DIR: dir }).launchdLabel;
        assert.deepEqual(argv, ["launchctl", "list", label], "the only spawn is the supervisor probe");
        return { code: 0, stdout: '\t"PID" = 1;\n' };
      },
    });
    await runStatus({ clientVersion: "0.1.7", hubUrl: "wss://api.dahrk.ai" }, d);
    assert.match(out.join("\n"), /Hub\s+wss:\/\/api\.dahrk\.ai/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runStatus --json: parseable, carries the verdict, and still withholds the token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-status-"));
  try {
    const out: string[] = [];
    const d = deps({ stateDir: dir, out: (l) => void out.push(l) });
    persistEnrolment(d.env, { token: "sket_abc", name: "local-a1", tenantId: "t_default" });

    const code = await runStatus({ clientVersion: "0.1.7", hubUrl: "wss://x", json: true }, d);

    assert.equal(code, 0);
    const parsed = JSON.parse(out.join("\n"));
    assert.equal(parsed.healthy, true);
    assert.deepEqual(parsed.presence, { kind: "running", pid: 79747 });
    assert.equal(parsed.state.name, "local-a1");
    assert.equal(parsed.state.enrolToken, undefined, "a status blob gets pasted into issues");
    assert.doesNotMatch(out.join("\n"), /Enrolled/, "no human framing in --json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runStatus: CI (or an explicit opt-out) suppresses the update line entirely, even from cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-status-"));
  try {
    const out: string[] = [];
    const d = deps({ stateDir: dir, out: (l) => void out.push(l) });
    d.env.CI = "true";
    // There IS an update, and we know about it. The operator has asked not to hear about it.
    writeState(d.env, { updateLatest: "9.9.9", updateCheckedAt: new Date(NOW).toISOString() });

    await runStatus({ clientVersion: "0.1.7", hubUrl: "wss://x" }, d);

    assert.doesNotMatch(out.join("\n"), /Update available|up to date|update status unknown/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runStatus --json: carries the update kind, so a script can alert on it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-status-"));
  try {
    const out: string[] = [];
    const d = deps({ stateDir: dir, out: (l) => void out.push(l) });
    writeState(d.env, { updateLatest: "9.9.9", updateCheckedAt: new Date(NOW).toISOString() });

    const code = await runStatus({ clientVersion: "0.1.7", hubUrl: "wss://x", json: true }, d);

    const parsed = JSON.parse(out.join("\n"));
    assert.equal(parsed.update.kind, "available");
    assert.equal(parsed.update.latest, "9.9.9");
    assert.equal(code, 0, "an available update is NOT a health failure - status stays a usable check");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runStatus --json: a never-checked client is reported as unknown, not as healthy-and-current", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-status-"));
  try {
    const out: string[] = [];
    const d = deps({ stateDir: dir, out: (l) => void out.push(l) });
    await runStatus({ clientVersion: "0.1.7", hubUrl: "wss://x", json: true }, d);
    assert.equal(JSON.parse(out.join("\n")).update.kind, "unknown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
