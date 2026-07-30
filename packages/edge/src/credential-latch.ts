/**
 * The refused-credential latch: this node's memory of a runtime whose AMBIENT login the provider has
 * rejected, so it stops advertising a runtime it cannot actually run.
 *
 * WHY A LATCH RATHER THAN A PROBE. Detection asks two questions of each runtime (see
 * `detect-runtimes.ts`): can this process execute it, and can a stage authenticate. For an ambient
 * Claude login the second question has no cheap honest answer. "A credentials file exists" and
 * "`claude --version` answered" are both true of a login the provider revoked hours ago, and the host
 * CLI those probes reach is not even the binary that runs a stage - the Agent SDK spawns its own
 * vendored copy. The only way to learn that a credential is dead is to have one refused, and that is
 * exactly what a failed stage already tells us. So detection does not poll: it remembers.
 *
 * The alternative - a liveness probe on the re-detect interval - would have to spend real tokens on a
 * real inference call, on a timer, forever, to answer a question that is almost always "yes". That is
 * a cost with no ceiling for a signal a failing stage hands us for nothing.
 *
 * DHK-998: a revoked ambient OAuth login let a node accept and burn one run per attempt at $0.00,
 * each billed to the agent, with nothing anywhere saying the credential was the problem.
 */
import type { Runtime } from "@dahrk/contracts";

/** One node's refused-credential memory. A set, not a flag: a node can serve several runtimes and a
 *  dead Anthropic login says nothing about a working provider key for another. */
export interface CredentialLatch {
  /** The provider refused this runtime's credential. Latches until something clears it. */
  markRefused(runtime: Runtime): void;
  /** A stage authenticated on this runtime, so whatever was wrong is no longer wrong. Clearing on
   *  success is what lets a node recover from a plain `claude auth login` with no restart. */
  markAccepted(runtime: Runtime): void;
  /** Is this runtime's credential currently known-bad? */
  isRefused(runtime: Runtime): boolean;
  /** Every currently-refused runtime, for `dahrk doctor` and tests. */
  refused(): Runtime[];
}

export function createCredentialLatch(): CredentialLatch {
  const bad = new Set<Runtime>();
  return {
    markRefused: (runtime) => {
      bad.add(runtime);
    },
    markAccepted: (runtime) => {
      bad.delete(runtime);
    },
    isRefused: (runtime) => bad.has(runtime),
    refused: () => [...bad],
  };
}

/**
 * The process-wide latch. A singleton because the two halves live in different modules and must agree
 * within one node process: the stage runner records a refusal, and the re-detect pass (which the edge
 * client already runs on an interval, DHK-390) reads it and drops the runtime from the advertisement.
 * Both `detect-runtimes` and the stage runner accept an injected latch, so tests never touch this.
 */
export const credentialLatch: CredentialLatch = createCredentialLatch();
