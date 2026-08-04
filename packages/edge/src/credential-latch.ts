/**
 * The refused-credential latch: this node's memory of a runtime whose credential the provider has
 * rejected, so it stops advertising a runtime it cannot actually run.
 *
 * WHY A LATCH RATHER THAN A PROBE. "Is this credential still good" has no cheap honest answer that
 * does not involve spending it. A brokered token is live when the hub mints it and can be revoked at
 * the provider a minute later, with nothing local changing. The only way to learn that a credential is
 * dead is to have one refused, and that is exactly what a failed stage already tells us. So detection
 * does not poll: it remembers.
 *
 * This is now the ONLY credential signal detection consults. It used to sit alongside a set of host
 * probes - a credentials file, a responding `claude --version` - each of which was equally true of a
 * login revoked hours ago, and none of which reached the binary that actually runs a stage (the Agent
 * SDK spawns its own vendored copy). Those probes are gone with ambient credentials; this remains
 * because it is evidence rather than inference.
 *
 * The alternative - a liveness probe on the re-detect interval - would have to spend real tokens on a
 * real inference call, on a timer, forever, to answer a question that is almost always "yes". That is
 * a cost with no ceiling for a signal a failing stage hands us for nothing.
 *
 * DHK-998: a revoked OAuth credential let a node accept and burn one run per attempt at $0.00,
 * each billed to the agent, with nothing anywhere saying the credential was the problem.
 */
import type { JobStatus, Runtime } from "@dahrk/contracts";
import { REFUSED_CREDENTIAL_SUMMARY } from "@dahrk/executor-worktree";

/**
 * What one stage attempt proved about this node's credential for its runtime.
 *
 * Evidence, not inference: the runtime tried to authenticate and was told yes or no. The latch reads
 * the whole stage outcome rather than a pre-digested verdict so that WHICH outcomes speak to a
 * credential is decided here, in one place, instead of at every call site.
 */
export interface CredentialEvidence {
  /** The runtime that ran the stage. Absent on a check stage, which runs no agent. */
  runtime?: Runtime;
  status: JobStatus;
  /** The stage summary. A refusal is identified by the prefix `runBatchLoop` writes for it. */
  summary: string;
  /** True when this was a check stage. */
  isCheck: boolean;
}

/** One node's refused-credential memory. A set, not a flag: a node can serve several runtimes and a
 *  dead Anthropic login says nothing about a working provider key for another. */
export interface CredentialLatch {
  /**
   * Record what one stage attempt proved, and latch or clear accordingly.
   *
   * Takes the raw outcome deliberately, so the three judgements that decide whether a credential was
   * refused live together rather than at the caller:
   *
   * - A CHECK stage has no runtime and cannot speak to any credential.
   * - A refusal is keyed on the summary prefix the runtime-error classifier writes, NOT on
   *   `failureClass` alone: `config` also covers gaps that say nothing about the inference credential
   *   (an unbound git credential, a repo no node serves), and latching on those would take a healthy
   *   runtime off the air.
   * - Authenticating at all CLEARS the latch, which is what lets a re-credentialled pool bring the
   *   node back with no restart, on the next stage that succeeds.
   */
  record(evidence: CredentialEvidence): void;
  /** Is this runtime's credential currently known-bad? */
  isRefused(runtime: Runtime): boolean;
}

export function createCredentialLatch(): CredentialLatch {
  const bad = new Set<Runtime>();
  return {
    record: ({ runtime, status, summary, isCheck }) => {
      if (isCheck || !runtime) return;
      if (status === "fail" && summary.startsWith(REFUSED_CREDENTIAL_SUMMARY)) bad.add(runtime);
      else if (status === "ok") bad.delete(runtime);
    },
    isRefused: (runtime) => bad.has(runtime),
  };
}

/**
 * The process-wide latch, and the DEFAULT for both halves rather than the only path.
 *
 * A singleton because the two halves live in different modules with no shared composition root, and
 * must still agree within one node process: the stage runner records a refusal, and the re-detect pass
 * (which the edge client already runs on an interval, DHK-390) reads it and drops the runtime from the
 * advertisement. The stage runner is built inside `startEdgeNode`, while the re-detect half is an
 * `EdgeOptions.reprobeRuntimes` callback built in the CLI - so there is no one place that could hand
 * the same latch to both without threading it across the package boundary.
 *
 * Both `detect-runtimes` and the stage runner accept an injected latch (`opts.latch` / `deps.latch`),
 * so tests never touch this one and never leak refusals into each other.
 *
 * Note it is per-PROCESS: `dahrk doctor` runs in its own process and therefore reads a fresh, empty
 * latch. It cannot observe a refusal recorded by the running node.
 */
export const credentialLatch: CredentialLatch = createCredentialLatch();
