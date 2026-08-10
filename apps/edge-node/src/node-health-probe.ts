/**
 * The half of a node health report that needs a child process (DHK-1059).
 *
 * `packages/edge` answers a `node-health-request` from its own process - Node version, runtime
 * resolution, disk, worktree writability - and stays free of `node:child_process`, the same line
 * `onUpgrade` draws. Two facts fall outside that: whether a supervisor unit is installed and running,
 * and whether `git` resolves on PATH. Both need a shell, so they live here and are injected as
 * `EdgeOptions.probeHostChecks`.
 *
 * ASYNC THROUGHOUT, unlike the `execFileSync` the CLI's own `doctor` uses. This runs on the socket's
 * event loop: a synchronous spawn here would stall heartbeats, trace streaming and every run sharing
 * this node for as long as the probe took. `doctor` can block a terminal; this cannot block a fleet.
 *
 * Every probe fails soft. A health check that cannot answer one question must still answer the rest -
 * the hub is waiting on a bounded timeout, and a partial report is worth far more than a timeout.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CheckResult } from "@dahrk/edge";
import { checkTools } from "@dahrk/edge";
import { checkService, hostPresence } from "./doctor.js";

const exec = promisify(execFile);

/** True if `cmd` resolves on PATH. The shell builtin runs via `sh -c`; `cmd` is always one of our own
 *  literals, so there is nothing to escape. A miss is a non-zero exit, not an error. */
async function commandPresent(cmd: string): Promise<boolean> {
  try {
    await exec("sh", ["-c", `command -v ${cmd}`], { timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Gather the child-process-dependent health facts.
 *
 * Returns only what it could actually determine: a probe that throws contributes nothing rather than a
 * fabricated verdict. The report is honest about being partial; it is never wrong.
 */
export async function probeHostChecks(): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];

  // Just git now: the docker probe went in DHK-1070 (see `ToolPresence`), so this collapses to one spawn.
  try {
    checks.push(...checkTools({ git: await commandPresent("git") }));
  } catch {
    // Deliberately silent: `commandPresent` already swallows a miss, so reaching here means the spawn
    // machinery itself is unusable, and inventing "git is missing" from that would send an operator to
    // reinstall something that is fine.
  }

  try {
    const { presence, service } = hostPresence();
    checks.push(checkService(presence, service));
  } catch {
    // As above: no row beats a wrong one.
  }

  return checks;
}
