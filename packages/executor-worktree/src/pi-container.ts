/**
 * The container Pi session factory: spawns `pi --mode rpc` inside
 * a Docker container and wraps the child in `PiRpcSession`, so the T6 adapter's orchestration
 * runs unchanged against a containerised Pi.
 *
 * Container lifecycle:
 *   - One container per stage job: the runner memoises the session, so `runBatch` + `summarise`
 *     share a single warm container. A new runner (new stage) spawns a new container.
 *   - Mount: `ctx.workspace.scratchPath` (telemetry + harness artefacts) appears inside the
 *     container at `/dahrk/scratch`. No customer worktree is mounted for meta-loop runs.
 *   - Inference env: `ctx.runtimeEnv` is injected as `-e KEY=VAL` pairs (never baked into the
 *     image), so provider keys and model overrides arrive at Pi without persisting credentials.
 *   - Model (DHK-982): the stage's configured model is resolved provider-aware on the host
 *     (`resolveStageModelId`, reusing the embedded path's `selectStageModel`) and passed as
 *     `--model <id>` on the container command, so a bare alias never lands on a provider the broker
 *     minted no key for. An unresolvable model fails loudly before the container starts.
 *   - Teardown: `dispose()` -> `docker kill <containerName>`. `--rm` removes the container
 *     automatically on exit.
 *
 * Still unsupported here: brokered MCP. This is a protocol limit of the pinned Pi, not merely "a larger
 * piece of work" - DHK-1055 established it by inspecting the SDK. Pi 0.84.1 ships no built-in MCP at all
 * (`docs/usage.md`), and its `--mode rpc` protocol offers no substitute for the embedded in-process
 * bridge: the command surface (`dist/modes/rpc/rpc-mode.js`; `docs/rpc.md` never mentions MCP) is a
 * closed switch with no command to register the brokered servers' tools so the model can call them, and
 * the only subprocess-initiated host-callback it emits is a fixed set of extension-UI dialogs
 * (select/confirm/input/editor) - which the gate and elicitation ride, but which is no MCP tunnel. So the
 * node-local gateway cannot be threaded to the container over the existing RPC channel at this pin. No
 * longer a silent gap (DHK-968): `PiRpcSession` declares `capabilities.brokeredMcp = false`, so a stage
 * that needs it gets a loud `capability-degraded` trace event from the runner rather than losing the
 * servers unremarked.
 *
 * Image: `DAHRK_PI_IMAGE` env var (default: `dahrk/pi:latest`). Override per-environment or
 * in tests via the `image` option.
 *
 * The `spawn` option is injected for tests (no Docker required); it defaults to the real
 * `node:child_process.spawn`.
 */
import { spawn as nodeSpawn } from "node:child_process";
import type { Runner, RunnerContext } from "@dahrk/contracts";
import { PiRpcSession } from "./pi-rpc-client.js";
import { createPiRunner, resolveStageModelId } from "./pi-adapter.js";
import type { PiSessionFactory, PiSessionLike } from "./pi-adapter.js";
import type { PreExecutionCapability } from "./runtime-session.js";

const DEFAULT_IMAGE = process.env.DAHRK_PI_IMAGE ?? "dahrk/pi:latest";

let _seq = 0;

export interface ContainerPiSessionOpts {
  /** Docker image containing `pi`. Default: `DAHRK_PI_IMAGE` env var or `dahrk/pi:latest`. */
  image?: string;
  /**
   * Host path to mount as `/dahrk/scratch` inside the container. Falls back to
   * `ctx.workspace.scratchPath` (set by the stage runner for every job). Pass explicitly
   * only when constructing the factory before a `RunnerContext` is available (e.g. tests).
   */
  scratchDir?: string;
  /** Injected for tests: replaces `node:child_process.spawn`. Default: the real spawn. */
  spawn?: typeof nodeSpawn;
  /**
   * Where the container's stderr goes. Default: `process.stderr`, prefixed.
   *
   * This is not merely a logging nicety. `stdio[2]` is a pipe, and nothing used to read it: a
   * container that wrote more than the ~64 KB pipe buffer would BLOCK on its next stderr write and
   * the session would hang, with the explanation sitting unread in the pipe. Draining it is what
   * makes that impossible - surfacing the message is the bonus.
   */
  onStderr?: (line: string) => void;
  /**
   * Resolve the stage's configured model to a concrete id conveyed into the container as `--model <id>`
   * (DHK-982), provider-aware via the embedded path's `selectStageModel` so a bare alias never lands on
   * a provider the broker minted no key for. Default: `resolveStageModelId` (loads the pinned SDK on the
   * host). Injected for tests, which have no SDK, to drive the spawn wiring and the loud-fail path.
   */
  resolveModelId?: (ctx: RunnerContext) => Promise<string | undefined>;
}

/**
 * Returns a `PiSessionFactory` that spawns `pi --mode rpc` inside a Docker container and
 * wraps it in a `PiRpcSession`. Pass to `createPiRunner({ createSession })` for isolation.
 */
export function createContainerPiSession(opts: ContainerPiSessionOpts = {}): PiSessionFactory {
  const {
    image = DEFAULT_IMAGE,
    scratchDir: optsScratchDir,
    spawn: spawnFn = nodeSpawn,
    resolveModelId = resolveStageModelId,
    onStderr = (line: string): void => void process.stderr.write(`pi-container: ${line}\n`),
  } = opts;

  return async (ctx: RunnerContext): Promise<PiSessionLike> => {
    // Resolve the stage model BEFORE spawning, provider-aware, so a bare alias never ships onto the wrong
    // provider (DHK-982). A loud resolution failure rejects here - no container is started on a substituted
    // model. Undefined means no model opinion, so the container command is left unchanged and Pi picks.
    const modelId = await resolveModelId(ctx);
    const modelArgs: string[] = modelId ? ["--model", modelId] : [];

    const containerName = `dahrk-pi-${Date.now()}-${++_seq}`;
    const resolvedScratchDir = optsScratchDir ?? ctx.workspace.scratchPath;

    const mountArgs: string[] = resolvedScratchDir ? ["-v", `${resolvedScratchDir}:/dahrk/scratch`] : [];

    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(ctx.runtimeEnv ?? {})) {
      envArgs.push("-e", `${k}=${v}`);
    }

    const child = spawnFn(
      "docker",
      ["run", "-i", "--rm", "--name", containerName, ...mountArgs, ...envArgs, image, "pi", "--mode", "rpc", ...modelArgs],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    // Drain stderr line-by-line. Without this the pipe fills and the container blocks (see `onStderr`).
    child.stderr?.setEncoding("utf8");
    let stderrBuf = "";
    child.stderr?.on("data", (chunk: string) => {
      stderrBuf += chunk;
      const lines = stderrBuf.split("\n");
      stderrBuf = lines.pop() ?? ""; // keep the partial line for the next chunk
      for (const line of lines) if (line.trim()) onStderr(line);
    });
    child.stderr?.on("end", () => {
      if (stderrBuf.trim()) onStderr(stderrBuf);
      stderrBuf = "";
    });

    const killContainer = (): Promise<void> =>
      new Promise<void>((resolve) => {
        const killer = spawnFn("docker", ["kill", containerName], { stdio: "ignore" } as Parameters<typeof nodeSpawn>[2]);
        killer.on("exit", () => resolve());
        killer.on("error", () => resolve());
      });

    return new PiRpcSession(child, { kill: killContainer });
  };
}

/**
 * Convenience factory: a Pi runner that isolates each stage job in a fresh Docker container.
 * The container is torn down when the stage completes (via `cancel()` -> `dispose()`).
 *
 * Pass to `deps.makeRunner` on managed nodes where container isolation is required. For
 * the embedded non-isolated path, use `createPiRunner()` directly.
 */
export function createIsolatedPiRunner(opts: ContainerPiSessionOpts = {}): Runner & PreExecutionCapability {
  // The container RPC session now implements and DECLARES the pre-execution gate (DHK-981/DHK-968:
  // `capabilities.preExecutionGate = true`), so this runner reports `enforcesPreExecution` true once a
  // stage opens its session - the edge treats an fs_confine deny on this path as a clean blocked deny,
  // exactly as embedded Pi. A back-end that could not gate would refuse a policy-gated stage outright.
  return createPiRunner({ createSession: createContainerPiSession(opts) });
}
