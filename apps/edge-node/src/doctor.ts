/**
 * `dahrk doctor` - a preflight that tells the operator, in one pass, whether this host can run a node
 * and reach the hub before they commit to `dahrk start`. It checks four things:
 *
 *   1. Node version   - the runtime this client needs (Node 22+, per the README).
 *   2. Agent runtimes - which runtimes this node can both execute and credential (none = serves no Jobs).
 *   3. Hub            - is the hub URL configured and does the WebSocket actually connect?
 *   4. Token          - is an enrolment token present, and does the hub accept it (valid vs
 *                       expired/invalid/pool-unknown)? Both are learned from one handshake probe.
 *
 * The check builders are pure (they take already-gathered inputs and return a verdict), so they are
 * unit-tested without a network or a specific host; `runDoctor` is the thin IO shell that gathers the
 * inputs, prints the report, and returns the process exit code (non-zero iff any check FAILED - a WARN
 * alone still passes).
 *
 * Since DHK-1059 those builders live in `@dahrk/edge` rather than here, because the HUB can now ask the
 * same question over the socket (`node-health-request`) and `packages/edge` cannot import from this
 * app. What stays here is what needs a child process - the supervisor probe - plus the terminal
 * rendering, which is this command's own job.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import type { CheckResult, CheckStatus, DetectOptions, HubProbeResult, RuntimeStatus } from "@dahrk/edge";
import {
  checkHub,
  checkNode,
  checkRuntimes,
  checkToken,
  probeHub as realProbeHub,
  probeRuntimeStatuses,
} from "@dahrk/edge";
import { isAlive, parseLock } from "./lock.js";
import { detectManager, probeService, resolveServiceNames, unitPath, type ServiceStatus } from "./service.js";
import { resolvePresence, type NodePresence } from "./status.js";
import { lockFile, readState, stateFile } from "./state.js";
import { dim, out as uiOut, symbol, verdict, type Level } from "./ui.js";

// The pure check builders now live in `@dahrk/edge` (DHK-1059), so this command and the hub's
// `node-health-request` handler answer from ONE implementation. Two copies of a health check is how a
// node comes to report itself fine to one caller and broken to another. Re-exported rather than merely
// imported because `preflight.ts` and both test files import them from here.
export {
  MIN_NODE_MAJOR,
  checkNode,
  checkRuntimes,
  checkHub,
  checkToken,
} from "@dahrk/edge";
export type { CheckResult, CheckStatus } from "@dahrk/edge";

/** The doctor's own vocabulary, mapped onto the one every command shares. It used to print `[PASS]` /
 *  `[WARN]` / `[FAIL]` tags that existed nowhere else in the tool; now a tick means the same thing here as
 *  it does in `status` and `run preflight`. */
const LEVEL: Record<CheckStatus, Level> = { pass: "ok", warn: "warn", fail: "fail" };

/**
 * Is anything on this host actually going to RUN the node?
 *
 * The check doctor did not have, and the one that would have named a whole outage in a sentence. A node
 * whose launchd agent had been disabled passed every other check here - Node runs, the runtimes resolve, the
 * hub answers, the token is valid - and was nevertheless dead, because nothing was going to start it. The
 * supervisor was the one thing nobody asked.
 *
 * It is deliberately generous about ABSENCE. `doctor` is a preflight, meant to be run on a bare host before
 * `dahrk start`, so "no unit installed" is a pass and not a finding. The only failure is a node that is
 * installed and switched off, which is never anything but wrong.
 *
 * A crash-loop is a warning here rather than a failure: doctor can legitimately catch a node inside its
 * restart throttle, and `status` is the command that shouts about a node that will not stay up.
 */
export function checkService(presence: NodePresence, service?: ServiceStatus): CheckResult {
  const label = "Service";
  switch (presence.kind) {
    case "running":
      return { status: "pass", label, detail: `running${presence.pid ? ` (pid ${presence.pid})` : ""}` };
    case "foreign":
      return { status: "pass", label, detail: `running under another supervisor (pid ${presence.pid})` };
    case "not-installed":
      return { status: "pass", label, detail: "not installed yet - `dahrk start` installs and loads it" };
    case "stopped":
      return { status: "pass", label, detail: "stopped on purpose - `dahrk start` brings it back" };
    case "no-supervisor":
      return { status: "warn", label, detail: "no launchd or systemd here; run `dahrk start --foreground`" };
    case "not-loaded":
      return {
        status: "fail",
        label,
        detail: presence.disabled
          ? "the service is DISABLED, so nothing will start it. Run `dahrk start` to re-enable and load it."
          : "installed but never loaded by the supervisor. Run `dahrk start`.",
      };
    case "crashed":
      return {
        status: "warn",
        label,
        detail: `loaded but not running${service?.lastExit ? ` (last exit ${service.lastExit})` : ""} - see \`dahrk logs\``,
      };
  }
}

/** Render the gathered checks into the report body, ending with an overall pass/fail summary line.
 *
 *  The verdict comes LAST here, not first as it does in `status`, because a doctor's checks are the point:
 *  you run it to read them. `status` answers one question, so it leads with the answer; `doctor` answers
 *  four, so it shows its working and then adds them up. */
export function formatReport(checks: CheckResult[]): string {
  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const lines = checks.map((c) => `  ${symbol(LEVEL[c.status])} ${c.label}${c.detail ? `: ${dim(c.detail)}` : ""}`);
  const summary =
    failed > 0
      ? verdict("fail", `${failed} check${failed === 1 ? "" : "s"} failed${warned ? `, ${warned} warning${warned === 1 ? "" : "s"}` : ""}.`)
      : warned > 0
        ? verdict("warn", `Passed with ${warned} warning${warned === 1 ? "" : "s"}.`)
        : verdict("ok", "All checks green.");
  return ["", ...lines, "", summary].join("\n");
}

/** Injectable IO/probes so `runDoctor` can be exercised without a network or a real host. */
export interface DoctorDeps {
  nodeVersion: string;
  probeRuntimes: (opts?: DetectOptions) => Promise<RuntimeStatus[]>;
  probeHub: typeof realProbeHub;
  /** How the node is present on this host, from the same gatherer `status` uses. ONE dep rather than a
   *  platform / homedir / capture / lockfile bundle, so the doctor tests stay a table of presences and
   *  cannot accidentally spawn `launchctl` in CI. */
  presence: () => { presence: NodePresence; service?: ServiceStatus };
  out: (line: string) => void;
}

/** The real presence gathering: ask the supervisor, ask the pidfile, and let `resolvePresence` - the same
 *  function `status` uses - decide what the two of them mean together. */
/** The supervisor's view of this node. Exported since DHK-1059: the socket's `probeHostChecks` needs
 *  exactly this, and a second copy of the manager/unit/lock/state resolution is precisely how
 *  `service.ts` and `status.ts` once came to disagree about where the logs lived. */
export function hostPresence(): { presence: NodePresence; service?: ServiceStatus } {
  const manager = detectManager(osPlatform());
  let service: ServiceStatus | undefined;
  if (manager !== "unsupported") {
    // Same state-dir-derived name the install/start paths use, so `doctor` probes this node's own unit.
    const names = resolveServiceNames(process.env);
    const unit = unitPath(manager, homedir(), names);
    service = probeService(
      manager,
      existsSync(unit),
      captureProbe,
      { ...(process.getuid ? { uid: process.getuid() } : {}) },
      names,
    );
  }
  const held = parseLock(readLock(lockFile(process.env)));
  const lockedPid = held !== undefined && isAlive(held) ? held : undefined;
  const desired = readState(stateFile(process.env)).desired;
  return { presence: resolvePresence(service, lockedPid, desired), ...(service ? { service } : {}) };
}

/** The pidfile's contents, or undefined when there is none. Absent is the normal case (no node running),
 *  so it is not an error worth propagating. */
function readLock(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Run a probe and read its exit code + stdout. stderr is dropped: `launchctl list` on an unknown label
 *  writes there, and the exit code is the answer we want. */
function captureProbe(argv: string[]): { code: number; stdout: string } {
  const [cmd, ...args] = argv;
  try {
    const stdout = execFileSync(cmd as string, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return { code: 0, stdout };
  } catch (e) {
    const status = (e as { status?: unknown }).status;
    return { code: typeof status === "number" ? status : 1, stdout: "" };
  }
}

const defaultDeps = (): DoctorDeps => ({
  nodeVersion: process.versions.node,
  probeRuntimes: probeRuntimeStatuses,
  probeHub: realProbeHub,
  presence: hostPresence,
  out: uiOut,
});

export interface DoctorInputs {
  hubUrl?: string;
  token?: string;
  clientVersion?: string;
  /** This machine's real node id, presented on the probe `hello` (DHK-1041). The hub claims a one-shot
   *  enrolment token for whoever presents it, so doctor must check the token AS this node: probing under
   *  a borrowed id spent the token on a phantom and left the node unable to enrol at all. */
  nodeId: string;
}

/**
 * Gather inputs, run the checks, print the report, and return the exit code (0 = no failures,
 * 1 = at least one FAIL). `inputs` are the already-resolved hub URL / token (flags overlaid on env).
 */
export async function runDoctor(inputs: DoctorInputs, deps: Partial<DoctorDeps> = {}): Promise<number> {
  const d = { ...defaultDeps(), ...deps };
  const statuses = await d.probeRuntimes({});

  const probe = inputs.hubUrl
    ? await d.probeHub({
        hubUrl: inputs.hubUrl,
        ...(inputs.token ? { enrolToken: inputs.token } : {}),
        runtimes: statuses.filter((s) => s.available).map((s) => s.runtime),
        ...(inputs.clientVersion ? { clientVersion: inputs.clientVersion } : {}),
        nodeId: inputs.nodeId,
      })
    : undefined;

  // There used to be a re-probe here: the hub was the authority on credential mode, so doctor asked it
  // and re-ran detection when the local assumption disagreed. Detection no longer asks a credential
  // question at all - it answers "is this runtime's SDK resolvable" - so the first probe is the answer.

  const host = d.presence();

  const checks: CheckResult[] = [
    checkNode(d.nodeVersion),
    checkRuntimes(statuses),
    checkService(host.presence, host.service),
    checkHub(inputs.hubUrl, probe),
    checkToken(Boolean(inputs.token), inputs.hubUrl, probe),
  ];

  d.out(formatReport(checks));
  return checks.some((c) => c.status === "fail") ? 1 : 0;
}
