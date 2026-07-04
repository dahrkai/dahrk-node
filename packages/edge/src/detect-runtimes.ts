/**
 * Runtime auto-detect. On boot a token-only edge probes which agent runtimes are actually
 * installed on the host and advertises only those, so the hub never routes a Job to a runtime the node
 * cannot run. Overridable: `apps/edge-node` uses the operator's `DAHRK_RUNTIMES` when set and only
 * falls back to this probe otherwise.
 *
 * The probe shells out to each runtime's CLI `--version` (the design-doc contract). Note the runner
 * adapters embed the vendor SDKs rather than the CLI, so a responding `--version` is a proxy for "this
 * runtime is installed and on PATH", which is the routing signal we want. A probe that errors, exits
 * non-zero, or exceeds the timeout is treated as "not installed".
 */
import { execFile } from "node:child_process";
import type { Runtime } from "@dahrk/contracts";

/** One probe per runtime: the CLI to invoke and the `Runtime` it maps to. */
const PROBES: ReadonlyArray<{ runtime: Runtime; cmd: string }> = [
  { runtime: "claude-code", cmd: "claude" },
  { runtime: "codex", cmd: "codex" },
  { runtime: "pi", cmd: "pi" },
];

/** Run `<cmd> --version` and resolve true iff it exits 0 within the timeout. Never rejects. */
function probe(cmd: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, ["--version"], { timeout: timeoutMs }, (err) => resolve(!err));
  });
}

/**
 * Probe every candidate runtime concurrently and return the ones that responded, in a stable order.
 * @param timeoutMs per-probe timeout (default 3000).
 */
export async function detectRuntimes(timeoutMs = 3000): Promise<Runtime[]> {
  const results = await Promise.all(PROBES.map((p) => probe(p.cmd, timeoutMs)));
  return PROBES.filter((_, i) => results[i]).map((p) => p.runtime);
}
