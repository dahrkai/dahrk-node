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
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import type { DetectOptions, HubProbeResult, RuntimeStatus } from "@dahrk/edge";
import { probeHub as realProbeHub, probeRuntimeStatuses } from "@dahrk/edge";
import { isAlive, parseLock } from "./lock.js";
import { detectManager, probeService, unitPath, type ServiceStatus } from "./service.js";
import { resolvePresence, type NodePresence } from "./status.js";
import { lockFile, readState, stateFile } from "./state.js";
import { dim, out as uiOut, symbol, verdict, type Level } from "./ui.js";

/** The minimum Node major this client supports (README: "Requires Node 22+"). */
export const MIN_NODE_MAJOR = 22;

export type CheckStatus = "pass" | "warn" | "fail";
export interface CheckResult {
  status: CheckStatus;
  label: string;
  detail?: string;
}

/** The doctor's own vocabulary, mapped onto the one every command shares. It used to print `[PASS]` /
 *  `[WARN]` / `[FAIL]` tags that existed nowhere else in the tool; now a tick means the same thing here as
 *  it does in `status` and `run preflight`. */
const LEVEL: Record<CheckStatus, Level> = { pass: "ok", warn: "warn", fail: "fail" };

/** Check the running Node version against the supported floor. */
export function checkNode(nodeVersion: string): CheckResult {
  const major = Number.parseInt(nodeVersion.replace(/^v/, "").split(".")[0] ?? "", 10);
  if (Number.isNaN(major)) {
    return { status: "warn", label: "Node version", detail: `could not parse "${nodeVersion}"` };
  }
  return major >= MIN_NODE_MAJOR
    ? { status: "pass", label: "Node version", detail: `v${major} (>= ${MIN_NODE_MAJOR})` }
    : {
        status: "fail",
        label: "Node version",
        detail: `v${major} is too old; Dahrk needs Node ${MIN_NODE_MAJOR}+`,
      };
}

/**
 * Check which agent runtimes this node can actually serve. None is a warning (the node boots but
 * serves nothing).
 *
 * Every runtime is listed, available or not, each with the reason from the probe. Reporting only the
 * good ones is what made the old output unactionable: an operator saw "none detected" and went
 * looking for software to install, when the answer is now usually credentials.
 */
export function checkRuntimes(statuses: RuntimeStatus[]): CheckResult {
  const available = statuses.filter((s) => s.available);
  const describe = (s: RuntimeStatus) =>
    `${s.runtime} ${s.available ? "" : "unavailable "}(${s.detail})`.replace("  ", " ");
  if (available.length === 0) {
    return {
      status: "warn",
      label: "Agent runtimes",
      detail: `none available, so the node will serve no Jobs. ${statuses.map(describe).join("; ")}`,
    };
  }
  return { status: "pass", label: "Agent runtimes", detail: statuses.map(describe).join(", ") };
}

/** Hub reachability. An enrolment rejection still counts as REACHED (the token, not the hub, is the
 *  problem - reported separately by {@link checkToken}). */
export function checkHub(hubUrl: string | undefined, probe: HubProbeResult | undefined): CheckResult {
  if (!hubUrl) {
    return {
      status: "fail",
      label: "Hub reachability",
      detail: "no hub URL configured (set DAHRK_HUB_URL or pass --hub-url)",
    };
  }
  if (!probe) {
    return { status: "warn", label: "Hub reachability", detail: `not checked (${hubUrl})` };
  }
  if (probe.ok) {
    return { status: "pass", label: "Hub reachability", detail: `connected to ${hubUrl}` };
  }
  switch (probe.reason) {
    case "rejected":
      return {
        status: "pass",
        label: "Hub reachability",
        detail: `reachable at ${hubUrl} (enrolment rejected - see token check)`,
      };
    case "unreachable":
      return { status: "fail", label: "Hub reachability", detail: `cannot reach ${hubUrl}: ${probe.detail}` };
    case "timeout":
      return {
        status: "fail",
        label: "Hub reachability",
        detail: `${hubUrl} connected but sent no welcome: ${probe.detail}`,
      };
    case "closed":
      return {
        status: "fail",
        label: "Hub reachability",
        detail: `${hubUrl} closed the socket (${probe.code}): ${probe.detail}`,
      };
  }
}

/** Enrolment-token presence + validity. Presence is known locally; validity comes from the probe. */
export function checkToken(
  tokenPresent: boolean,
  hubUrl: string | undefined,
  probe: HubProbeResult | undefined,
): CheckResult {
  if (!tokenPresent) {
    return {
      status: "fail",
      label: "Enrolment token",
      detail: "no token (pass --token or set DAHRK_ENROL_TOKEN)",
    };
  }
  if (!hubUrl || !probe) {
    return { status: "warn", label: "Enrolment token", detail: "present but not verified (no hub to check against)" };
  }
  if (probe.ok) {
    return { status: "pass", label: "Enrolment token", detail: `valid (tenant ${probe.tenantId})` };
  }
  if (probe.reason === "rejected") {
    switch (probe.code) {
      case 4400:
        return { status: "fail", label: "Enrolment token", detail: `hub saw no token: ${probe.detail}` };
      case 4401:
        return { status: "fail", label: "Enrolment token", detail: "invalid, expired, or revoked" };
      case 4404:
        return { status: "fail", label: "Enrolment token", detail: "the token's pool no longer exists" };
      case 4503:
        return {
          status: "warn",
          label: "Enrolment token",
          detail: "cannot verify: the hub has no enrolment secret configured",
        };
      default:
        return { status: "fail", label: "Enrolment token", detail: probe.detail };
    }
  }
  // Hub unreachable/timeout/closed: we have a token but could not put it to the test.
  return { status: "warn", label: "Enrolment token", detail: "present but unverified (hub not reachable)" };
}

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
function hostPresence(): { presence: NodePresence; service?: ServiceStatus } {
  const manager = detectManager(osPlatform());
  let service: ServiceStatus | undefined;
  if (manager !== "unsupported") {
    const unit = unitPath(manager, homedir());
    service = probeService(manager, existsSync(unit), captureProbe, {
      ...(process.getuid ? { uid: process.getuid() } : {}),
    });
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
