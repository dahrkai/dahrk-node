/**
 * Runtime auto-detect. On boot a token-only edge works out which agent runtimes it can actually serve
 * and advertises only those, so the hub never routes a Job to a runtime the node cannot run.
 * Overridable: `apps/edge-node` uses the operator's `DAHRK_RUNTIMES` when set and only falls back to
 * this probe otherwise.
 *
 * WHAT CHANGED, AND WHY. This used to shell out to `claude --version` / `pi --version` and advertise
 * whatever answered. That measured the wrong thing in both directions, because the host CLI is not
 * what executes a stage: `claude-adapter.ts` calls `query()` from `@anthropic-ai/claude-agent-sdk`,
 * which spawns the binary VENDORED INSIDE THAT SDK, and `pi-adapter.ts` runs `createAgentSession()`
 * from `@earendil-works/pi-coding-agent` in-process. Neither ever invokes the CLI the probe found. So
 * a container holding a brokered key advertised nothing (it could have run the stage perfectly well),
 * while a host with a logged-in `pi` advertised `pi` and then failed every Pi Job it was sent, because
 * the Pi adapter builds a hermetic per-stage config dir and never reads the machine-global `~/.pi`.
 * Note the converse trap, which cost a wrong assumption while writing this: Pi DOES pick provider keys
 * up from the process environment, so "no `~/.pi`" is not the same as "no ambient credential" - which
 * is why the Pi credential question is put to Pi itself rather than guessed at.
 *
 * Advertising is now the conjunction of two INDEPENDENT questions, which the old single probe
 * conflated:
 *
 *   1. CAPABILITY - can this process execute the runtime at all? That is "is the vendored SDK
 *      resolvable from here", nothing to do with PATH.
 *   2. CREDENTIALS - is there a way to authenticate a stage? Brokered means the hub puts a key on the
 *      Job, so anything capable qualifies. Ambient means the stage borrows a login that already
 *      exists on this host, which is a real signal for Claude and an impossible one for Pi.
 *
 * A runtime is advertised iff both hold. `probeRuntimeStatuses` returns the per-runtime reasoning
 * that `dahrk doctor` prints; `detectRuntimes` is the thin routing view (just the advertisable set).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CredentialMode, Runtime } from "@dahrk/contracts";
import {
  RUNTIME_SDK,
  canResolveSdk,
  piAmbientCredentialAvailable,
  resolveAmbientClaudeAuth,
  type AmbientAuthDeps,
  type AmbientAuthResolution,
} from "@dahrk/executor-worktree";
import { credentialLatch, type CredentialLatch } from "./credential-latch.js";

/** Where a stage's credentials would come from, or `none` if nothing can authenticate it here. */
export type CredentialSource = "brokered" | "ambient" | "none";

interface RuntimeSpec {
  runtime: Runtime;
  /** The npm package the adapter loads. Resolvable = this process can execute the runtime. Owned by
   *  `executor-worktree`, which is where the importing adapters live and where resolution must happen. */
  sdk: string;
  /** The host CLI. Probed ONLY as an ambient-login hint, never as the capability signal. */
  cmd: string;
  /** Whether this runtime's ambient credential can come from a host LOGIN (a CLI session / keychain),
   *  as opposed to only from the environment. Decides whether the CLI probe tells us anything. */
  ambientLogin: boolean;
}

const SPECS: readonly RuntimeSpec[] = [
  { runtime: "claude-code", sdk: RUNTIME_SDK["claude-code"]!, cmd: "claude", ambientLogin: true },
  // Pi's ambient credential can only ever come from the ENVIRONMENT, never from a host login:
  // `defaultCreatePiSession` writes a fresh per-stage config dir and points `ModelRuntime` at it,
  // deliberately never inheriting `~/.pi`. So a logged-in host `pi` proves nothing and is not probed -
  // but a provider key in the env is picked up by Pi directly, and `piAmbientCredentialAvailable` asks
  // Pi itself whether one is usable.
  { runtime: "pi", sdk: RUNTIME_SDK.pi!, cmd: "pi", ambientLogin: false },
];

/**
 * One runtime's advertisability, with the reasoning kept rather than collapsed to a boolean - the
 * operator's next question after "why is this node serving nothing" is always "which half is missing".
 */
export interface RuntimeStatus {
  runtime: Runtime;
  /** The runtime's SDK resolves from here, so a stage could execute. */
  capable: boolean;
  /** Where a stage's credentials would come from. `none` means the runtime is not advertisable. */
  credential: CredentialSource;
  /** `capable && credential !== "none"` - the routing answer. */
  available: boolean;
  /** One phrase explaining this verdict, for `dahrk doctor`. */
  detail: string;
  /** The host CLI's version, when one answered. Diagnostic only: it is NOT the version that runs a
   *  stage (that is the bundled SDK's), and the two routinely differ. */
  cliVersion?: string;
}

/** Default per-probe timeout. Raised from the original 3000ms: a cold Node-based CLI (`claude`, `pi`)
 *  on a host mid-IO-churn - e.g. right after an update-restart - can take longer than 3s to answer
 *  `--version`, and reading that as "not installed" is exactly the DHK-390 degradation. */
const DEFAULT_TIMEOUT_MS = 5000;

/** How many times to invoke a CLI before concluding it is absent. A single transient miss (a timed-out
 *  or spawn-hiccup probe on a busy host) must not delete a runtime from the advertisement, so we retry
 *  once. A CLI that is genuinely not on PATH (`ENOENT`) short-circuits without a retry - there is
 *  nothing to wait for - and a CLI that keeps erroring is still, correctly, not advertised. */
const DEFAULT_ATTEMPTS = 2;

/** Env vars that carry a usable Anthropic credential. Either one lets the Claude SDK authenticate
 *  with no host login at all, which is the common shape in a container that is not brokered. */
const CLAUDE_CREDENTIAL_ENV = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

export interface DetectOptions {
  /** How this node's stages are credentialled. Default `ambient`, matching `EdgeOptions`. */
  credentialMode?: CredentialMode;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  timeoutMs?: number;
  attempts?: number;
  /** Injectable module resolution, so the capability half is testable without touching node_modules. */
  canResolve?: (specifier: string) => boolean;
  /** Injectable "can Pi authenticate from this environment", so the credential half is testable
   *  without constructing a real Pi `ModelRuntime`. */
  piAmbientCredential?: (env: NodeJS.ProcessEnv) => Promise<boolean>;
  /** This node's refused-credential memory. Defaults to the process-wide latch the stage runner
   *  writes to; injected in tests so a probe never depends on process state. */
  latch?: CredentialLatch;
  /** Injectable ambient-credential resolution (DHK-1004), so detection is testable without a real host
   *  login or Keychain. Defaults to the same resolver the Claude adapter authenticates a stage with,
   *  which is what makes detection's answer and the stage's answer the same answer. */
  resolveAmbientAuth?: (deps: AmbientAuthDeps) => AmbientAuthResolution;
}

/** One `<cmd> --version` invocation. Resolves the trimmed first non-empty output line on exit 0;
 *  otherwise `{ retryable }`, where `retryable` is false ONLY for `ENOENT` (the command is not on
 *  PATH, so no amount of retrying will find it). A timeout, spawn hiccup or non-zero exit is retryable:
 *  it may be transient. Never rejects. */
function probeOnce(
  cmd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<{ version: string } | { retryable: boolean }> {
  return new Promise((resolve) => {
    // `env` is passed explicitly rather than inherited, so `opts.env` genuinely controls the whole
    // probe. Inheriting made the PATH lookup answer from the ambient process while the credential
    // check answered from the caller's env - two halves of one question disagreeing about the host.
    execFile(cmd, ["--version"], { timeout: timeoutMs, env }, (err, stdout) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        return resolve({ retryable: code !== "ENOENT" });
      }
      const line = stdout.split("\n").map((s) => s.trim()).find(Boolean);
      resolve({ version: line ?? "" });
    });
  });
}

/** Probe `<cmd> --version`, retrying a transient failure before concluding absence. Resolves the
 *  reported version string on success, else `undefined` (genuinely not installed). Never rejects. */
async function probe(
  cmd: string,
  timeoutMs: number,
  attempts: number,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await probeOnce(cmd, timeoutMs, env);
    if ("version" in result) return result.version;
    // Not on PATH: definitively absent, so a retry would only add `attempts * timeoutMs` of latency.
    if (!result.retryable) return undefined;
  }
  return undefined; // retries exhausted: treat as absent
}

/**
 * Is there an ambient Anthropic login on this host?
 *
 * An explicit env credential is conclusive. Otherwise fall back to "the `claude` CLI answered", which
 * is weak but is genuinely the best available signal: on macOS the CLI keeps its OAuth token in the
 * Keychain, so there is no credentials file to stat, and requiring one would report every logged-in
 * Mac as having no credentials. The file check covers the Linux/CI shape where there is one.
 */
function hasAmbientClaudeLogin(
  env: NodeJS.ProcessEnv,
  home: string,
  cliAnswered: boolean,
): boolean {
  if (CLAUDE_CREDENTIAL_ENV.some((k) => (env[k] ?? "").trim() !== "")) return true;
  if (existsSync(join(home, ".claude", ".credentials.json"))) return true;
  return cliAnswered;
}

/**
 * Work out every runtime's advertisability and why, in a stable order.
 *
 * The CLI probe still runs, but only where its answer can change something: as the last-resort
 * ambient-login hint for Claude. It is skipped entirely under `brokered`, where the hub supplies the
 * credential and the host's PATH is irrelevant - which also means a brokered node stops paying two
 * process spawns per re-probe.
 */
export async function probeRuntimeStatuses(opts: DetectOptions = {}): Promise<RuntimeStatus[]> {
  const credentialMode: CredentialMode = opts.credentialMode ?? "ambient";
  const env = opts.env ?? process.env;
  const home = opts.homeDir ?? homedir();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const canResolve = opts.canResolve ?? canResolveSdk;
  const latch = opts.latch ?? credentialLatch;
  const resolveAmbient = opts.resolveAmbientAuth ?? resolveAmbientClaudeAuth;

  const ambient = credentialMode === "ambient";
  const [versions, piAmbient] = await Promise.all([
    Promise.all(
      SPECS.map((s) => (ambient && s.ambientLogin ? probe(s.cmd, timeoutMs, attempts, env) : Promise.resolve(undefined))),
    ),
    // Only asked when it can change the answer: under `brokered` Pi is credentialled regardless.
    ambient ? (opts.piAmbientCredential ?? piAmbientCredentialAvailable)(env) : Promise.resolve(false),
  ]);

  return SPECS.map((spec, i) => {
    const cliVersion = versions[i];
    const capable = canResolve(spec.sdk);
    const base = { runtime: spec.runtime, capable, ...(cliVersion === undefined ? {} : { cliVersion }) };

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
    if (credentialMode === "brokered") {
      return { ...base, credential: "brokered" as const, available: true, detail: "brokered credentials from the hub" };
    }
    if (!spec.ambientLogin) {
      // Pi: the environment is the only ambient source, and Pi itself has just told us whether one of
      // its providers is usable from it. A host `pi` login is deliberately not consulted.
      if (piAmbient) {
        return { ...base, credential: "ambient" as const, available: true, detail: "provider key in the environment" };
      }
      return {
        ...base,
        credential: "none" as const,
        available: false,
        detail:
          "no provider key in the environment (a Pi stage never reads a `pi` login); set one or enrol into a brokered pool",
      };
    }
    // A login the provider has REFUSED outranks every local hint (DHK-998). The hints below only ever
    // establish that a login exists on this host; a revoked token satisfies all of them and still
    // fails every stage on its first turn, at $0.00, billed to the agent. The latch is the one signal
    // that came from the runtime actually trying to authenticate, so it wins.
    if (latch.isRefused(spec.runtime)) {
      return {
        ...base,
        credential: "none" as const,
        available: false,
        detail: `the provider refused this host's ${spec.cmd} login: re-authenticate as the user this node runs as (\`${spec.cmd} auth login\`), or set ${CLAUDE_CREDENTIAL_ENV[1]} in the node service definition`,
      };
    }
    // An explicit credential in the environment is the operator's own answer and outranks the stores.
    if (CLAUDE_CREDENTIAL_ENV.some((k) => (env[k] ?? "").trim() !== "")) {
      return { ...base, credential: "ambient" as const, available: true, detail: "credential in the environment" };
    }
    // Otherwise resolve the host login the same way a stage will (DHK-1004), so detection answers "can
    // this node authenticate" rather than the far weaker "does a login exist somewhere". The detail
    // carries the store it resolved from, and flags a divergence that would break any process reaching
    // the other one.
    const resolved = resolveAmbient({ homeDir: home });
    if (resolved.chosen) {
      return { ...base, credential: "ambient" as const, available: true, detail: resolved.detail };
    }
    // Stores were found but none is usable (expired). That is a real "cannot authenticate", and saying
    // so here stops the node advertising a runtime that would fail on its first turn.
    if (resolved.candidates.length > 0) {
      return { ...base, credential: "none" as const, available: false, detail: resolved.detail };
    }
    // No store we understand, but the host answered the CLI probe: it may be authenticating in a way we
    // do not model, so preserve the previous behaviour rather than grounding a working node.
    if (hasAmbientClaudeLogin(env, home, cliVersion !== undefined)) {
      return { ...base, credential: "ambient" as const, available: true, detail: "ambient login on this host" };
    }
    return {
      ...base,
      credential: "none" as const,
      available: false,
      detail: `no credentials: log in with \`${spec.cmd}\`, set ${CLAUDE_CREDENTIAL_ENV[0]}, or enrol into a brokered pool`,
    };
  });
}

/** The routing view: the runtimes this node can actually serve, in a stable order. */
export async function detectRuntimes(opts: DetectOptions = {}): Promise<Runtime[]> {
  const statuses = await probeRuntimeStatuses(opts);
  return statuses.filter((s) => s.available).map((s) => s.runtime);
}
