/**
 * The node's own health check, as pure builders plus the wire report they fold into.
 *
 * ## Why these live here and not in the CLI
 *
 * `dahrk doctor` and `dahrk run preflight` already computed every one of these facts, in
 * `apps/edge-node`. But the CLI is the wrong home once the HUB can ask the same question over the
 * socket: `packages/edge` cannot import from `apps/edge-node` (the dependency runs the other way), so
 * a socket handler that wanted "is this node healthy" would have had to reimplement it - and two
 * implementations of a health check is how a node comes to report itself fine to one caller and broken
 * to another.
 *
 * So the PURE builders moved down here and the CLI re-exports them. One answer, three callers.
 *
 * ## What deliberately did not move
 *
 * - Anything needing `node:child_process`. This package is the wire client and stays free of it (the
 *   same line `onUpgrade` draws). The supervisor and tool probes are injected instead, as
 *   `probeHostChecks` on `EdgeOptions`.
 * - The REPO checks (`checkRepo`, `probeRepo`). They stay in the CLI, and their absence here is
 *   structural rather than stylistic: a node-scoped report is returned over the wire and summarised
 *   into a durable node event, and the repo checks are the only ones whose `detail` strings can carry
 *   a customer path. A gatherer that takes no repo path cannot leak one. "Can this node reach my repo"
 *   is a real question, but it needs a clone and a credential, so it is a preflight RUN pinned to the
 *   node - not this.
 */
import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import { join } from "node:path";
import type { NodeHealthReport, PreflightSection } from "@dahrk/contracts";
import type { HubProbeResult } from "./hub-probe.js";
import type { RuntimeStatus } from "./detect-runtimes.js";

/** The minimum Node major this client supports (README: "Requires Node 22+"). */
export const MIN_NODE_MAJOR = 22;

/** Below this, a clone plus a worktree may not fit. A warning, never a hard failure: the node runs. */
export const LOW_DISK_BYTES = 512 * 1024 * 1024;

export type CheckStatus = "pass" | "warn" | "fail";

export interface CheckResult {
  status: CheckStatus;
  label: string;
  detail?: string;
}

/**
 * Which tools resolve on PATH. Gathered by the caller (it needs a shell); interpreted here.
 *
 * Just one now, and the short list is the point. Every other probe was removed because its absence
 * taught the operator to look in exactly the wrong place, and the whole list has one explanation here:
 *
 * - The SSH-key, `claude`-login and `gh` CLI probes went in DHK-1006, because every credential is
 *   brokered by the hub: git authenticates with a minted installation token over HTTPS, the PR is
 *   opened hub-side through the GitHub App, and inference authenticates on the auth profile the run
 *   resolves to. None of them is consulted at run time.
 * - `docker` went in DHK-1070. Docker is reached only by the container-isolated Pi runtime, behind
 *   `DAHRK_PI_ISOLATION=container` - a flag no shipped configuration turns on. A normal `claude-code`
 *   stage never touches Docker and a normal `pi` stage runs in-process, so on any node we support the
 *   row reported on something that cannot happen, and when Docker was absent its `warn` dragged an
 *   otherwise-healthy node's verdict to "healthy, with findings" for a tool it will never use. See
 *   `docs/adr/0002-stage-isolation-is-the-node-boundary.md`.
 */
export interface ToolPresence {
  git: boolean;
}

// -- pure sub-checks ---------------------------------------------------------

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
  const describe = (s: RuntimeStatus): string =>
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

/** The client/worktree floor beyond the Node-version check: is the clone target writable? Unwritable is
 *  a hard floor failure - the node cannot build a worktree, so no stage can run on it at all. */
export function checkWorktreeRoot(writable: boolean): CheckResult {
  return writable
    ? { status: "pass", label: "Worktree root", detail: "writable" }
    : { status: "fail", label: "Worktree root", detail: "not writable; the node cannot create worktrees here" };
}

export function checkDiskSpace(freeBytes: number | undefined): CheckResult {
  if (freeBytes === undefined) {
    return { status: "warn", label: "Free space", detail: "could not be determined" };
  }
  const gib = (freeBytes / (1024 * 1024 * 1024)).toFixed(1);
  return freeBytes >= LOW_DISK_BYTES
    ? { status: "pass", label: "Free space", detail: `${gib} GiB` }
    : { status: "warn", label: "Free space", detail: `only ${gib} GiB free; a clone + worktree may not fit` };
}

/**
 * The tool floor: just `git`, and its absence is a hard failure - no stage can run without it, and it
 * is git that spends the brokered GitHub App token to clone and fetch.
 *
 * Git earns a row HERE even though `git-available` was dropped from the hub's preflight probes as
 * tautological. That was correct there: preflight's check stage runs inside a worktree git already
 * built, so git is provably present. This check runs in-process against a node that may never have run a
 * job, where git's absence is genuinely possible. Same tool, different question, different answer - do
 * not "fix" the inconsistency away. (`docker` was removed in DHK-1070; see {@link ToolPresence}.)
 *
 * Returns an array because it once carried several rows; keeping the shape means the callers that spread
 * it need no change as the list shrinks.
 */
export function checkTools(tools: ToolPresence): CheckResult[] {
  const git: CheckResult = tools.git
    ? { status: "pass", label: "git", detail: "installed" }
    : { status: "fail", label: "git", detail: "not found; git is required to run a workflow" };
  return [git];
}

/**
 * The node's stage-concurrency load: how many of its bounded slots are in use (DHK-1137).
 *
 * A node now runs at most a CPU-derived number of stages at once and queues the rest (see
 * `concurrency.ts`), and this row is what makes that bound observable BEFORE oversubscription causes
 * damage rather than after. Below the bound it passes; at or over it the node is full and further work
 * is queueing, which is the amber a shared card should show - a limitation the node still runs with, not
 * a fault, so it maps to the same `warn` a thin disk does.
 */
export function checkCapacity(inUse: number, max: number): CheckResult {
  return inUse >= max
    ? { status: "warn", label: "Stage capacity", detail: `${inUse} of ${max} stage slots in use; further stages queue` }
    : { status: "pass", label: "Stage capacity", detail: `${inUse} of ${max} stage slots in use` };
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
        // The HUB is misconfigured, not the token, so this must not read as "your token is bad" - it
        // would send the operator to re-mint a token that was never the problem.
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

// -- the deterministic read --------------------------------------------------

/**
 * Turn the findings into the plain-English read the report leads with.
 *
 * The CLI's preflight has always synthesised this deterministically rather than asking a model, and
 * since DHK-1059 so does the hub's. Shared here so the terminal, the portal card and the node health
 * dialog all read the same sentence for the same facts.
 *
 * `allClear` is the all-green read, and it is a parameter because the two callers checked different
 * things: the CLI preflight examines a repo and its default names one, but the node health check takes
 * no repo path at all (see the module header), so it passes an override that claims only what it
 * measured. Attesting to an unchecked repo is the exact defect DHK-1070 removed.
 */
export function synthesise(
  checks: CheckResult[],
  allClear = "The floor is sound. Node, repo, and tools all check out - this host is ready to run a workflow.",
): string {
  const fails = checks.filter((c) => c.status === "fail");
  const warns = checks.filter((c) => c.status === "warn");
  const list = (cs: CheckResult[]): string =>
    cs.map((c) => `${c.label.toLowerCase()} (${c.detail ?? "finding"})`).join("; ");
  if (fails.length > 0) {
    return `The floor is unsound: ${list(fails)}. Fix ${fails.length === 1 ? "this" : "these"} before running a workflow here.`;
  }
  if (warns.length > 0) {
    return `The floor is sound, with ${warns.length} early warning${warns.length === 1 ? "" : "s"}: ${list(warns)}. ${warns.length === 1 ? "It does" : "These do"} not block a run, but ${warns.length === 1 ? "is" : "are"} worth addressing.`;
  }
  return allClear;
}

/** The node health report's all-green read: it names only what a node-scoped check measures. Unlike the
 *  CLI preflight's default all-clear, it cannot claim a repo was checked, because this report examines
 *  none - so a node-scoped attestation cannot carry a customer path into the hub's durable node event. */
const NODE_ALL_CLEAR = "The floor is sound. This node checks out - ready to run a workflow.";

// -- the wire report ---------------------------------------------------------

/** A stable, machine-readable id per check label, so the portal card can key rows across reports.
 *  Derived rather than declared: the labels are the vocabulary the terminal already prints, and a
 *  second hand-maintained id list is a thing to forget to update. */
const sectionId = (label: string): string => label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** `pass` is ok, `warn` is a limitation the node still runs with, `fail` needs action. Note this maps
 *  onto PREFLIGHT's section vocabulary, which is deliberate - one card renders both - even though the
 *  two verdicts differ (see `NodeHealthReport`). */
const SECTION_STATUS: Record<CheckStatus, PreflightSection["status"]> = {
  pass: "ok",
  warn: "skipped",
  fail: "finding",
};

/**
 * Fold the gathered checks into the wire report.
 *
 * The verdict is the worst status present, and `unsound` is a state preflight has no equivalent for: a
 * node with too old a runtime, an unwritable worktree root or no git is not "healthy with findings",
 * it is a machine no stage can run on. That distinction is the whole reason `NodeHealthReport` is a
 * separate type from `PreflightReport` rather than a reuse of it.
 */
export function buildNodeHealthReport(
  checks: readonly CheckResult[],
  tookMs: number,
  now: number,
): NodeHealthReport {
  const sections: PreflightSection[] = checks.map((c) => ({
    id: sectionId(c.label),
    label: c.label,
    status: SECTION_STATUS[c.status],
    detail: c.detail ?? c.status,
  }));

  const verdict: NodeHealthReport["verdict"] = checks.some((c) => c.status === "fail")
    ? "unsound"
    : checks.some((c) => c.status === "warn")
      ? "findings"
      : "ok";

  return {
    verdict,
    sections,
    readMarkdown: synthesise([...checks], NODE_ALL_CLEAR),
    gatheredAt: now,
    tookMs,
  };
}

// -- host probes that need no child process ----------------------------------

/** Resolve a directory's writability by probing access (W_OK); a missing dir is not writable. */
export function isWritable(dir: string): boolean {
  try {
    accessSync(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk up to the nearest ancestor of `dir` that actually exists.
 *
 * The worktree root is created ON DEMAND, so on a node that has not run a job yet it does not exist -
 * and probing it directly answers "not writable" for a machine that is perfectly healthy. What matters
 * is whether the nearest existing ancestor is writable, because that is what the mkdir will need.
 *
 * This is not hypothetical and it is not a test artefact: a BRAND-NEW node is precisely the one whose
 * health an operator checks first, and reporting it `unsound` is the most damaging false negative this
 * report can produce. CI caught it (`an injected host probe's checks are folded into the report` went
 * `unsound` on a fresh runner); it passed locally only because the author's worktree root existed.
 */
export function nearestExisting(dir: string): string {
  let cur = dir;
  while (!existsSync(cur)) {
    const parent = join(cur, "..");
    if (parent === cur) break;
    cur = parent;
  }
  return cur;
}
