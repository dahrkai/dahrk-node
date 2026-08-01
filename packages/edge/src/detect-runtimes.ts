/**
 * Runtime auto-detect. On boot a token-only edge works out which agent runtimes it can actually serve
 * and advertises only those, so the hub never routes a Job to a runtime the node cannot run.
 * Overridable: `apps/edge-node` uses the operator's `DAHRK_RUNTIMES` when set and only falls back to
 * this probe otherwise.
 *
 * WHAT THIS MEASURES. Capability, and nothing else: can this process execute the runtime at all,
 * i.e. is the vendored SDK resolvable from here. That has nothing to do with PATH. The host CLI is
 * NOT what executes a stage - `claude-adapter.ts` calls `query()` from `@anthropic-ai/claude-agent-sdk`,
 * which spawns the binary vendored inside that SDK, and `pi-adapter.ts` runs `createAgentSession()`
 * from `@earendil-works/pi-coding-agent` in-process. Neither ever invokes a CLI on PATH.
 *
 * WHAT IT NO LONGER MEASURES, AND WHY. This used to answer a second, independent question: where would
 * a stage's credentials come from? Under `ambient` that meant sniffing the host for a login a stage
 * could borrow - the `claude` CLI, the macOS Keychain, `~/.claude/.credentials.json`, provider keys in
 * the environment - and withholding a runtime when nothing was found. That whole axis is gone: the hub
 * brokers every credential, so anything capable is also credentialled, and the host's own logins are
 * never consulted. Worth being explicit about what that deletes, because each was a real source of
 * bugs: an advertisement that depended on which shell started the service (it bakes in a PATH), on a
 * Keychain ACL that let `claude` read an item but not `security`, and on a token that could be revoked
 * without anything local changing.
 *
 * The one credential signal that survives is the {@link CredentialLatch}: a BROKERED credential the
 * provider actually refused. That is not a guess about the host, it is the runtime having tried and
 * been told no, so a node stops advertising a runtime it has just proved it cannot authenticate.
 */
import type { Runtime } from "@dahrk/contracts";
import { RUNTIME_SDK, canResolveSdk } from "@dahrk/executor-worktree";
import { credentialLatch, type CredentialLatch } from "./credential-latch.js";

/** Where a stage's credentials come from, or `none` when this node cannot authenticate the runtime. */
export type CredentialSource = "brokered" | "none";

interface RuntimeSpec {
  runtime: Runtime;
  /** The npm package the adapter loads. Resolvable = this process can execute the runtime. Owned by
   *  `executor-worktree`, which is where the importing adapters live and where resolution must happen. */
  sdk: string;
}

const SPECS: readonly RuntimeSpec[] = [
  { runtime: "claude-code", sdk: RUNTIME_SDK["claude-code"]! },
  { runtime: "pi", sdk: RUNTIME_SDK.pi! },
];

/**
 * One runtime's advertisability, with the reasoning kept rather than collapsed to a boolean - the
 * operator's next question after "why is this node serving nothing" is always "which half is missing".
 */
export interface RuntimeStatus {
  runtime: Runtime;
  /** The runtime's SDK resolves from here, so a stage could execute. */
  capable: boolean;
  /** Where a stage's credentials come from. `none` means the runtime is not advertisable. */
  credential: CredentialSource;
  /** `capable && credential !== "none"` - the routing answer. */
  available: boolean;
  /** One phrase explaining this verdict, for `dahrk doctor`. */
  detail: string;
}

export interface DetectOptions {
  env?: NodeJS.ProcessEnv;
  /** Injectable module resolution, so capability is testable without touching node_modules. */
  canResolve?: (specifier: string) => boolean;
  /** This node's refused-credential memory. Defaults to the process-wide latch the stage runner
   *  writes to; injected in tests so a probe never depends on process state. */
  latch?: CredentialLatch;
}

/** Work out every runtime's advertisability and why, in a stable order. */
export async function probeRuntimeStatuses(opts: DetectOptions = {}): Promise<RuntimeStatus[]> {
  const canResolve = opts.canResolve ?? canResolveSdk;
  const latch = opts.latch ?? credentialLatch;

  return SPECS.map((spec) => {
    const capable = canResolve(spec.sdk);
    const base = { runtime: spec.runtime, capable };

    if (!capable) {
      // The install itself is broken: the bundle references an SDK the published manifest did not
      // pull in. Say which package, because the fix is a reinstall or a release, not a login.
      return {
        ...base,
        credential: "none" as const,
        available: false,
        detail: `cannot run here: ${spec.sdk} is not installed (reinstall dahrk-node)`,
      };
    }
    // A credential the provider has REFUSED (DHK-998). Unlike every host hint this replaced, this one
    // came from the runtime actually trying to authenticate and being told no, so it is worth acting
    // on: keep advertising and every stage dies on its first turn, at $0.00, billed to the agent.
    if (latch.isRefused(spec.runtime)) {
      return {
        ...base,
        credential: "none" as const,
        available: false,
        detail:
          "the provider refused this node's brokered credential: check the auth profile bound to this node's pool in the portal",
      };
    }
    return { ...base, credential: "brokered" as const, available: true, detail: "brokered credentials from the hub" };
  });
}

/** The routing view: the runtimes this node can actually serve, in a stable order. */
export async function detectRuntimes(opts: DetectOptions = {}): Promise<Runtime[]> {
  const statuses = await probeRuntimeStatuses(opts);
  return statuses.filter((s) => s.available).map((s) => s.runtime);
}
