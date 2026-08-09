/**
 * The Claude runner adapter: a thin wrapper over @anthropic-ai/claude-agent-sdk's
 * streaming `query()` API behind the contract `Runner`. It runs a stage to a terminal
 * result (batch) or across multi-turn human input (interactive), emits the normalised
 * trace envelope through the stage runner's `onTrace` as messages arrive, issues the
 * engine-owned summarisation turn, and cancels cleanly.
 *
 * No LLM call decides control flow: this is the inside of a stage. Sequencing, gates and
 * branching are the engine's, upstream of here. The pure SDK-message mapping lives in
 * ./claude-mappers.ts; the CYPACK-1177 buffered-response rule lives in the streaming loop
 * below (decide the response from the last assistant text, never from a turn that ends on
 * a tool call).
 */
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  query,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { JobStatus, Runner, RunnerContext } from "@dahrk/contracts";
import { consumeClaudeMessage, newBufferState, type BufferState } from "./claude-mappers.js";
import {
  HANDED_BACK_ARTIFACT_PATH,
  makeEmit,
  SUMMARISE_PROMPT,
  type EmittableEvent,
  type PolicyAwareRunnerContext,
  type PreExecutionCapability,
  type RuntimeSession,
  type RuntimeSessionHooks,
  type TurnResult,
} from "./runtime-session.js";
import { resolveStagePrompt, hasSystemPrompt } from "./prompt-assembly.js";
import { elicitOutcomeReply } from "./elicit-router.js";
import { runInteractiveLoop, runBatchLoop, maxTurnCeiling } from "./turn-loop.js";
import { ManagedMailbox } from "./mailbox.js";
import { createStageCompleteTool, type StageCompleteTool } from "./stage-complete-tool.js";
import { createAskUserQuestionTool, ASK_USER_QUESTION_ALIAS } from "./ask-user-question-tool.js";

/**
 * Anchor every stage to its worktree. The claude_code preset injects the dynamic
 * working-directory + git-status sections the model needs so it operates from its cwd and
 * never guesses an absolute repo path. Set here, once, so it applies to all workloads without
 * a per-workflow prompt nudge. (Omitting systemPrompt left the batch stage with no cwd context.)
 */
const CLAUDE_CODE_SYSTEM_PROMPT = { type: "preset", preset: "claude_code" } as const;

const userMsg = (text: string): SDKUserMessage => ({
  type: "user",
  parent_tool_use_id: null,
  message: { role: "user", content: text },
});

/** The initial `hooks.ask` before an interactive loop installs the router-backed one. Never invoked on
 *  the batch/summarise paths (they wire no `AskUserQuestion` shadow tool); the interactive loop replaces
 *  it before the opening turn. Degrades to the same soft note the router's no-reply path returns.
 *  Mirrors Pi's `defaultAsk`. */
const defaultAsk = async (): Promise<string> => elicitOutcomeReply({ kind: "noreply" });

/**
 * How a `ClaudeRuntimeSession` drives its underlying `ClaudeSessionLike`. Interactive owns a warm
 * streaming session (`push`/`end`) plus the stage-complete tool and the recap-only `summarising`
 * cell the `canUseTool` closure reads; batch creates a one-shot session lazily on its single
 * `sendTurn` (prompt-present, replays and ends), so it needs only the built `Options`.
 */
type ClaudeRuntimeMode =
  | { interactive: true; session: ClaudeSessionLike; stageTool: StageCompleteTool; summarising: { value: boolean } }
  | { interactive: false; options: Options };

const sessionIdOf = (msg: SDKMessage): string | undefined =>
  "session_id" in msg && typeof msg.session_id === "string" ? msg.session_id : undefined;

const policyCanUseTool = async (
  ctx: PolicyAwareRunnerContext,
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }> => {
  const verdict = ctx.authorizeToolUse?.(toolName, input);
  if (verdict?.verdict === "deny") {
    return { behavior: "deny", message: verdict.reason ?? `tool "${toolName}" denied by policy ${verdict.policy}` };
  }
  return { behavior: "allow", updatedInput: input };
};

/**
 * The interactive-stage tool decision, extracted pure so the DHK-223 tool-parity invariant is
 * unit-testable without invoking the SDK. The AskUserQuestion shadow (DHK-344) is injected additively
 * via `mcpServers`/`toolAliases`/`allowedTools` and NEVER appears here as a denial: arbitrary tools
 * (Bash/Write/Read) run exactly as in a batch stage, gated solely by the edge policy
 * (`ctx.authorizeToolUse`). The one denial is the engine-owned gate-exit summarisation turn, which is
 * recap-only: while `summarising`, every tool except the stage-complete exit is denied so the model
 * produces prose rather than starting fresh stage work.
 */
export const interactiveCanUseTool = (
  summarising: boolean,
  stageAllowedToolName: string,
  ctx: PolicyAwareRunnerContext,
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }> =>
  summarising && toolName !== stageAllowedToolName
    ? Promise.resolve({
        behavior: "deny",
        message: "Summarise from the work you just did; reply with the sentence only, no tools.",
      })
    : policyCanUseTool(ctx, toolName, input);

/**
 * Brokered MCP servers: point each declared server at the node's gateway proxy
 * (`${proxyBaseUrl}/<id>`), which holds the token and injects it upstream - the agent never sees the
 * raw secret. Programmatic `mcpServers` take precedence over a same-named entry in the repo
 * `.mcp.json`, so a brokered server overrides its unauthenticated repo definition. Returns undefined
 * when the stage declares none (or the proxy is absent), leaving repo `.mcp.json` untouched.
 * Module-level + pure so it is unit-testable without invoking the SDK.
 */
export function buildBrokeredMcpServers(ctx: RunnerContext): Options["mcpServers"] | undefined {
  const servers = ctx.config.mcpServers;
  if (!servers || servers.length === 0 || !ctx.mcpProxyBaseUrl) return undefined;
  const entries: Record<string, { type: "http" | "sse"; url: string }> = {};
  for (const s of servers) entries[s.id] = { type: s.type, url: `${ctx.mcpProxyBaseUrl}/${s.id}` };
  return entries as Options["mcpServers"];
}

/**
 * The SDK's OS-level sandbox (seatbelt on macOS, bubblewrap on Linux) - DHK-392, opt-in via
 * `DAHRK_SANDBOX=1`.
 *
 * This is the only layer that can stop an escape the tool-argument guard structurally cannot see: a
 * script that opens a path never named in argv, or one built from a shell variable. It is opt-in
 * because the SDK's own doc comment says filesystem limits come from permission rules "not via these
 * sandbox settings", while its schema exposes `filesystem.allowWrite`/`denyRead` - the two disagree,
 * and the runtime behaviour is unverified. So: wire it, prove it on a real run, then default it on.
 *
 * `failIfUnavailable: false` because `fs_confine` is the primary block and a Linux node without
 * bubblewrap must still run. `autoAllowBashIfSandboxed` stays FALSE: it would auto-approve Bash,
 * which is precisely the path our `canUseTool` block lives on.
 */
export function sandboxOptions(ctx: RunnerContext): Partial<Options> {
  if (process.env.DAHRK_SANDBOX !== "1") return {};
  const home = homedir();
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: false,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      filesystem: {
        // EVERY worktree of the run (DHK-251), not just the primary: a sibling the agent cannot write
        // is a repo it was checked out to change and cannot. `workspaces` is absent at N=1, so this is
        // the same list it always was for a single-repo run.
        allowWrite: [
          ...((ctx as RunnerContext & { workspaces?: Array<{ worktreePath: string }> }).workspaces ?? [
            ctx.workspace,
          ]).map((w) => w.worktreePath),
          ctx.workspace.scratchPath,
          tmpdir(),
        ],
        denyRead: [join(home, ".ssh"), join(home, ".aws"), join(home, ".gnupg"), "/Volumes"],
      },
    },
  };
}

/**
 * Brokered inference (DHK-89). A node has no login of its own, so the hub mints the provider key into
 * `runtimeEnv` (claude-code -> ANTHROPIC_API_KEY) or the subscription token onto `runtimeAuth`, and
 * delivers it on the Job; the edge threads it onto the RunnerContext. Pass it as the CLI subprocess env
 * so the runtime authenticates. The SDK's `env` REPLACES the inherited environment when set, so spread
 * `process.env` to keep PATH etc. The key rides the child-process env only, never the agent's own tool
 * surface.
 *
 * There is no ambient branch (DHK-1006). This used to fall back to resolving the HOST's own Claude
 * login - the macOS Keychain, `~/.claude/.credentials.json` - when the job carried no credential. A
 * stage now runs on the credential the hub attached or it does not run: returning `{}` here means the
 * SDK inherits `process.env` and reports its own authentication error, which is the honest outcome for
 * a job that arrived without one.
 */
export function runtimeEnvOptions(ctx: RunnerContext): Partial<Options> {
  const auth = runtimeAuthEnv(ctx);
  if (ctx.runtimeEnv || Object.keys(auth).length > 0) {
    return { env: { ...process.env, ...ctx.runtimeEnv, ...auth } };
  }
  return {};
}

/** The env var the Claude runtime reads a subscription (Claude Pro/Max) OAuth token from. Distinct
 *  from `ANTHROPIC_API_KEY`, which is the api-key path and arrives through `runtimeEnv`. */
const CLAUDE_OAUTH_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

/**
 * Which model this stage runs on: the stage's own, else the bound auth profile's `defaultModel`.
 *
 * Pi has honoured the profile default since it gained one (`selectStageModel`); Claude read
 * `config.model` and nothing else, so `AuthProfile.defaultModel` - a first-class field an operator
 * sets in the portal - did precisely nothing on a Claude stage. That was survivable while a runtime
 * was chosen by hand. It is not now that runtimes are DERIVED from the auth profile, which makes
 * `claude-code` the runtime for every Anthropic-bound account and therefore for most stages: an
 * account-wide default model would have been silently ignored across the board.
 *
 * Deliberately simpler than Pi's version, and it does not throw. Pi has to reconcile a model id
 * against a multi-provider catalogue, so an unresolvable id there is a wrong answer waiting to
 * happen; Claude speaks to exactly one provider and the SDK reports an unknown model itself. With
 * neither value set, the runtime picks - the correct no-opinion behaviour, not an error.
 */
export function selectClaudeModel(ctx: RunnerContext): string | undefined {
  return ctx.config.model ?? ctx.runtimeAuth?.defaultModel;
}

/** {@link selectClaudeModel} as a spreadable `Options` fragment, so an absent model omits the key
 *  entirely rather than setting it undefined (the SDK distinguishes the two). */
function modelOption(ctx: RunnerContext): Partial<Options> {
  const model = selectClaudeModel(ctx);
  return model ? { model } : {};
}

/**
 * Brokered inference from an OAUTH-SUBSCRIPTION auth profile (DHK-998).
 *
 * The api-key path above needs nothing from us: the broker mints the secret into `runtimeEnv` under
 * the provider's env var and the passthrough carries it. A subscription has no env var to mint into -
 * its token rides on `runtimeAuth` as a live triplet - so without a reader here, binding a pool to
 * "Anthropic (Claude Pro/Max)" credentialled precisely nothing and the stage fell through to whatever
 * ambient login the host happened to have. Pi has had this reader since DHK-511 (`pi-auth.ts`); this
 * is Claude's, deliberately much smaller: Claude speaks to exactly one provider, so there is no
 * `models.json`, no custom-provider entry and no persisted `auth.json` to clean up - just the token on
 * the child process's env, where the agent's own tool calls never see it.
 *
 * The hub refreshes before minting, so `access` is live on arrival; the node must never refresh it
 * itself (the provider rotates the refresh token on every use, and a per-stage rotation the hub does
 * not persist would strand the credential).
 *
 * Throws when the profile carries an OAuth subscription for some OTHER provider and nothing Anthropic:
 * `claude-code` cannot use a Copilot or Codex login, and running on silently unauthenticated would
 * fail on the first turn with a message blaming the agent instead of the binding.
 */
export function runtimeAuthEnv(ctx: RunnerContext): Record<string, string> {
  const providers = ctx.runtimeAuth?.providers;
  if (!providers || providers.length === 0) return {};
  const oauth = providers.filter((p) => p.kind === "oauth");
  if (oauth.length === 0) return {};
  const anthropic = oauth.find((p) => p.provider === "anthropic");
  if (anthropic) return { [CLAUDE_OAUTH_ENV]: anthropic.access };
  // An api-key hint alongside a foreign subscription still credentials the stage through
  // `runtimeEnv`, so only complain when the subscription is the ONLY thing on offer.
  if (providers.some((p) => p.kind === "api_key")) return {};
  const names = oauth.map((p) => p.provider).join(", ");
  throw new Error(
    `no Anthropic credential in the brokered auth profile: claude-code cannot authenticate with a ${names} subscription. ` +
      `Bind this pool to an Anthropic profile (api key or Claude Pro/Max), or run the stage on a runtime that supports ${names}.`,
  );
}

/**
 * The subset of the Claude Agent SDK's `query()` the adapter drives, behind an injectable factory
 * (mirroring Pi's `PiSessionLike`). Wrapping `query()` AND the interactive streaming mailbox here lets
 * a scripted `FakeClaudeSession` drive the adapter's orchestration without live inference or
 * credentials - the seam DHK-592 introduces so Claude's interactive settle logic is covered end-to-end.
 * A one-shot batch/summarise session iterates its messages directly; an interactive session owns a
 * `ManagedMailbox` and receives turns via `push()`/`end()`.
 */
export interface ClaudeSessionLike extends AsyncIterable<SDKMessage> {
  /** Interactive: enqueue a user turn (seed / coalesced human turn / summarise prompt). */
  push(msg: SDKUserMessage): void;
  /** Interactive: end the streaming mailbox so the underlying query drains and completes. */
  end(): void;
  /** Best-effort close of the underlying query. */
  close(): void;
  /** Cancel the in-flight turn. */
  interrupt(): Promise<void>;
}

export interface ClaudeSessionInit {
  /** One-shot prompt for batch/summarise. Absent => interactive: the session owns the mailbox and
   *  turns arrive via `push()`/`end()`. */
  prompt?: string;
  options: Options;
  /** Interactive only: the stage-complete tool handle, so a `FakeClaudeSession` can drive a
   *  tool-exit. The default factory ignores it (the real server is already in `options.mcpServers`). */
  stageTool?: StageCompleteTool;
}

export type CreateClaudeSession = (init: ClaudeSessionInit) => ClaudeSessionLike;

export interface ClaudeRunnerDeps {
  /** Override the session factory (tests inject a scripted fake). Defaults to the live `query()`. */
  createSession?: CreateClaudeSession;
}

/**
 * The live session factory: exactly today's `query()` + interactive `ManagedMailbox` usage, relocated
 * behind the injectable seam so production behaviour is unchanged. A batch/summarise call passes a
 * string `prompt` and iterates directly; an interactive call omits `prompt`, so the session owns a
 * streaming mailbox that `push()`/`end()` drive.
 */
const defaultCreateClaudeSession: CreateClaudeSession = ({ prompt, options }) => {
  const mailbox = prompt === undefined ? new ManagedMailbox<SDKUserMessage>() : undefined;
  const q = query({ prompt: mailbox ?? prompt!, options });
  const it = q[Symbol.asyncIterator]();
  return {
    [Symbol.asyncIterator]: () => it,
    push: (m) => mailbox?.push(m),
    end: () => mailbox?.end(),
    close: () => {
      try {
        q.close();
      } catch {
        /* best effort */
      }
    },
    interrupt: () => q.interrupt(),
  };
};

export function createClaudeRunner(deps: ClaudeRunnerDeps = {}): Runner & PreExecutionCapability {
  const createSession = deps.createSession ?? defaultCreateClaudeSession;
  const abortController = new AbortController();
  let cancelled = false;
  let active: ClaudeSessionLike | undefined;
  let sessionId: string | undefined;
  let costUsd: number | undefined;

  const baseOptions = (ctx: RunnerContext): Options => ({
    cwd: ctx.workspace.worktreePath,
    abortController,
    // The deterministic push-stage commit sets the harness author identity itself (see
    // GitService.commitAndPush); when the Claude runtime commits inside an interactive stage it must
    // NOT append its own `Co-Authored-By: Claude <noreply@anthropic.com>` trailer. `includeCoAuthoredBy`
    // is a Claude Code SETTINGS key (not a top-level Options field), so it rides the inline `settings`
    // object, which sits at the flag layer and overrides any project/local setting. Mirrors the cyrus
    // reference (EdgeWorker.ts writes the same key into .claude/settings.local.json).
    settings: {
      includeCoAuthoredBy: false,
      // DHK-392, defence in depth. The stage runner's `fs_confine` builtin is the real block (it is
      // what `canUseTool` below consults, and unlike these rules it covers Grep and Bash). These deny
      // rules close the same door from inside Claude Code, for the tools its permission system does
      // cover (Read/Glob/NotebookRead via `Read(...)`, Write/Edit via `Edit(...)`): credentials an
      // agent has no business reading, and the mounted volumes whose scan started all this. Deny
      // outranks allow, so a repo's own .claude/settings.json cannot undo them.
      permissions: {
        deny: [
          "Read(//Volumes/**)",
          "Read(~/.ssh/**)",
          "Read(~/.aws/**)",
          "Read(~/.gnupg/**)",
          "Read(~/Library/Keychains/**)",
        ],
      },
    },
    ...sandboxOptions(ctx),
    // Inherit the REPO's .mcp.json / .claude settings (build spec section 9): do NOT set
    // strictMcpConfig. Tool-policy enforcement is wired via `canUseTool` on each Options object.
    // Deliberately EXCLUDE "user": a stage must be hermetic to the worktree and not inherit the
    // edge operator's ~/.claude (their CLAUDE.md, settings, memory), which is machine-specific and
    // bleeds non-deterministic context across edges. "project"/"local" honour the repo's own
    // .claude/ + CLAUDE.md + .mcp.json, which is all section 9 actually requires. Claude auth is
    // keychain/OAuth and independent of settingSources, so dropping "user" does not affect it.
    settingSources: ["project", "local"],
    // Brokered inference env (DHK-89): a node has no login of its own.
    ...runtimeEnvOptions(ctx),
    ...modelOption(ctx),
    ...(ctx.sessionId ? { resume: ctx.sessionId } : {}),
    ...(ctx.config.skill ? { skills: [ctx.config.skill] } : {}),
  });

  /**
   * Emit the trace for one SDK message: capture the session id, persist the raw record, then
   * fold it through the pure buffered-response state machine (consumeClaudeMessage) and emit
   * the resulting events. Returns whether this was a turn-settling `result` and its response.
   */
  const handleMessage = (
    msg: SDKMessage,
    emit: (e: EmittableEvent, rawRef?: string) => void,
    ctx: RunnerContext,
    state: BufferState,
    suppressStageExit: boolean,
  ): { isResult: boolean; status?: JobStatus; responseText?: string } => {
    const found = sessionIdOf(msg);
    if (found) sessionId = found;
    if (msg.type === "result" && typeof msg.total_cost_usd === "number") costUsd = msg.total_cost_usd;
    const rawRef = ctx.writeRaw?.(msg);
    const res = consumeClaudeMessage(msg, state, suppressStageExit);
    for (const e of res.events) emit(e, rawRef);
    return { isResult: res.isResult, status: res.status, responseText: res.responseText };
  };

  const closeActive = (): void => {
    try {
      active?.close();
    } catch {
      /* best effort */
    }
    active = undefined;
  };

  /**
   * The single Claude `RuntimeSession` over the low-level `ClaudeSessionLike` transport, mirroring
   * Pi's `makePiRuntimeSession`. The Claude-specific concerns live here, above the transport seam and
   * below the runtime-agnostic loop: the buffered-response mapping (`handleMessage`/`consumeClaudeMessage`),
   * stage-complete detection and its document handback (`TurnResult.artifact`), the recap-only
   * `summarising` flag, and `sessionId`/`costUsd` capture off each message (into the runner's closure
   * state so `summarise()`/`cancel()` see the same values). Interactive owns a warm streaming session
   * (`push`/drain-to-`result`); batch creates its one-shot session lazily on the single `sendTurn`.
   */
  const makeClaudeRuntimeSession = (
    ctx: RunnerContext,
    hooks: RuntimeSessionHooks,
    mode: ClaudeRuntimeMode,
  ): RuntimeSession => {
    const state = newBufferState();
    const it = mode.interactive ? mode.session[Symbol.asyncIterator]() : undefined;

    // Pull messages until the in-flight interactive turn settles on a `result`; return its status and
    // last assistant text.
    const consumeInteractiveTurn = async (): Promise<{ status?: JobStatus; responseText?: string }> => {
      for (;;) {
        const { value: msg, done } = (await it!.next()) as IteratorResult<SDKMessage>;
        if (done) return {};
        const res = handleMessage(msg, hooks.emit, ctx, state, true);
        if (res.isResult) return { status: res.status, responseText: res.responseText };
      }
    };

    return {
      get sessionId(): string | undefined {
        return sessionId;
      },
      async sendTurn(text: string): Promise<TurnResult> {
        if (!mode.interactive) {
          // Batch: a one-shot session (prompt-present) replays its script and ends the stream. Created
          // lazily here so the FakeClaudeSession's replay-and-end behaviour is preserved.
          const session = createSession({ prompt: text, options: mode.options });
          active = session;
          let status: JobStatus | undefined;
          try {
            for await (const msg of session) {
              const res = handleMessage(msg, hooks.emit, ctx, state, false);
              if (res.isResult && res.status) status = res.status;
            }
          } finally {
            closeActive();
          }
          return { stageComplete: false, ...(status !== undefined ? { status } : {}) };
        }
        // Interactive: push the user turn onto the warm streaming session and drain to its settling
        // `result`. Let a throw propagate so the loop owns the terminal runtime_error/fail decision.
        mode.session.push(userMsg(text));
        const { status, responseText } = await consumeInteractiveTurn();
        const stageComplete = mode.stageTool.fired();
        // The handed-back document rides out as the stage artifact; the loop gates it on an ok status.
        const doc = stageComplete ? mode.stageTool.document() : null;
        return {
          stageComplete,
          ...(stageComplete ? { summary: mode.stageTool.summary() ?? undefined } : {}),
          ...(responseText !== undefined ? { responseText } : {}),
          ...(status !== undefined ? { status } : {}),
          ...(doc !== null
            ? { artifact: { path: ctx.config.emitArtifact ?? HANDED_BACK_ARTIFACT_PATH, content: doc } }
            : {}),
        };
      },
      async summariseTurn(): Promise<string> {
        // Only the interactive gate path summarises inline; batch never calls this.
        if (!mode.interactive) return "(no summary produced)";
        // Keep the turn recap-only: flip the flag the `canUseTool` closure reads so every tool but the
        // stage-complete exit is denied, then restore it.
        mode.summarising.value = true;
        try {
          mode.session.push(userMsg(SUMMARISE_PROMPT));
          const { responseText } = await consumeInteractiveTurn();
          return (responseText ?? "").trim() || "(no summary produced)";
        } catch {
          return "(no summary produced)";
        } finally {
          mode.summarising.value = false;
        }
      },
      cost(): number | undefined {
        return costUsd;
      },
      dispose(): void {
        if (!mode.interactive) return;
        // Interactive teardown (relocated from the post-loop cleanup): end the mailbox, drain any
        // trailing messages, then close. The drain is detached because the port's `dispose` is
        // synchronous; the mailbox `end()` happens synchronously so no turn is dropped.
        const iter = it!;
        mode.session.end();
        void (async () => {
          try {
            for (;;) {
              const { done } = await iter.next();
              if (done) break;
            }
          } catch {
            /* best effort */
          } finally {
            closeActive();
          }
        })();
      },
    };
  };

  return {
    runtime: "claude-code",

    // DHK-983: Claude always wires `canUseTool`, so every tool call is vetted before it runs. A
    // confinement deny that surfaces on the trace is therefore a blocked deny, never an escape.
    enforcesPreExecution: true,

    async runBatch(ctx, onTrace) {
      const hooks: RuntimeSessionHooks = { emit: makeEmit("claude-code", onTrace), ask: defaultAsk };
      const mcpServers = buildBrokeredMcpServers(ctx);
      const options: Options = {
        ...baseOptions(ctx),
        systemPrompt: CLAUDE_CODE_SYSTEM_PROMPT,
        // Brokered MCP servers merged additively with the repo's .mcp.json (settingSources).
        // Tools stay allowed by canUseTool below; we do NOT set a restrictive allowedTools here.
        ...(mcpServers ? { mcpServers } : {}),
        // Headless: allow tools to run without an interactive permission prompt (M6 wires policy).
        canUseTool: async (toolName, input) => policyCanUseTool(ctx, toolName, input),
      };
      const rt = makeClaudeRuntimeSession(ctx, hooks, { interactive: false, options });
      return runBatchLoop(rt, ctx, hooks, { cancelled: () => cancelled });
    },

    async runInteractive(ctx, turns, onTrace) {
      const emit = makeEmit("claude-code", onTrace);
      const stageTool = createStageCompleteTool();
      // The recap-only flag the gate-exit summarise turn flips; the `canUseTool` closure reads it. Held
      // on an object so the runtime session (which owns the summarise turn) and the options closure
      // share one cell.
      const summarising = { value: false };

      // The interactive session is built by the loop through this factory, once it has assembled the
      // router-backed hooks. The loop calls it SYNCHRONOUSLY before it awaits the opening turn, so the
      // `active`-before-first-await cancel guarantee below still holds, and the AskUserQuestion shadow
      // tool is wired to the FINAL `ask` at construction rather than a placeholder swapped in later.
      let rt: RuntimeSession | undefined;
      const makeSession = (hooks: RuntimeSessionHooks): RuntimeSession => {
        // DHK-344: map the agent's structured `AskUserQuestion` onto a Linear `select` elicitation rather
        // than letting it resolve to the headless default "the user did not answer".
        const askTool = createAskUserQuestionTool({ ask: (question) => hooks.ask(question) });

        // Interactive stages have full tool parity with batch stages: a prompt that writes files or
        // explores the repo works the same as in a batch stage (customers bring all kinds of prompts,
        // and Pi interactive already allows tools). The S2 spike gated tools to keep the stage
        // conversational and avoid an execute-loop that never settled a per-turn result; that risk is
        // accepted here and bounded by maxTurns (forces a result) plus the edge's job.timeout wall-clock
        // kill. Edge policy still observes every action via onTrace exactly as for batch. The one
        // exception is the gate-exit summarisation turn, which stays recap-only (no tools) via `summarising`.
        const brokered = buildBrokeredMcpServers(ctx);
        const options: Options = {
          ...baseOptions(ctx),
          // Keep the cwd-anchoring preset; fold the stage instruction in via `append` so the
          // interactive persona still gets it without losing the working-directory context.
          systemPrompt: hasSystemPrompt(ctx)
            ? { type: "preset", preset: "claude_code", append: resolveStagePrompt(ctx) }
            : CLAUDE_CODE_SYSTEM_PROMPT,
          // Inject the stage-complete exit tool and the AskUserQuestion shadow alongside any brokered
          // MCP servers (parity with batch).
          mcpServers: { dahrk: stageTool.server, ask: askTool.server, ...(brokered ?? {}) },
          // Redirect the built-in AskUserQuestion to the shadow tool so a structured question surfaces
          // as a Linear elicitation. The redirect is name-only and single-hop; the tool still runs, so
          // this is mapping, not gating (DHK-344 / DHK-223).
          toolAliases: { [ASK_USER_QUESTION_ALIAS]: askTool.allowedToolName },
          // Auto-approve the injected tools; `allowedTools` is an auto-approve list, not a whitelist, so
          // it does not restrict the other tools canUseTool allows.
          allowedTools: [stageTool.allowedToolName, askTool.allowedToolName],
          canUseTool: async (toolName, input) =>
            interactiveCanUseTool(summarising.value, stageTool.allowedToolName, ctx, toolName, input),
          maxTurns: maxTurnCeiling(),
          includePartialMessages: false,
        };

        // Create the streaming session and set `active` SYNCHRONOUSLY (before the loop's first await), so
        // a `cancel()` racing the opening turn still interrupts it.
        const session = createSession({ options, stageTool });
        active = session;
        rt = makeClaudeRuntimeSession(ctx, hooks, { interactive: true, session, stageTool, summarising });
        return rt;
      };
      const result = await runInteractiveLoop(ctx, turns, emit, makeSession, {
        signal: abortController.signal,
        cancelled: () => cancelled,
        cancel: () => this.cancel(),
        // Claude carries the stage instruction in its system prompt, so the seed can be a short kickoff.
        instructionInSystemPrompt: hasSystemPrompt(ctx),
      });
      rt?.dispose();
      return result;
    },

    async summarise(ctx) {
      // The engine-owned handoff turn: reuse the warm batch session by resuming it for a
      // constrained turn. It must not emit trace events (it is not the agent's stage work).
      // The resumed session carries the agentic claude_code preset, so DENY tools here: the
      // model must summarise from what it just did rather than starting fresh stage work. A
      // small turn budget (not 1) absorbs a denied-tool detour so the text answer still lands.
      if (!sessionId) return "(no summary: session not established)";
      const options: Options = {
        ...baseOptions(ctx),
        resume: sessionId,
        maxTurns: 4,
        canUseTool: async () => ({
          behavior: "deny",
          message: "Summarise from the work you just did; reply with the sentence only, no tools.",
        }),
      };
      try {
        let out = "";
        const session = createSession({ prompt: SUMMARISE_PROMPT, options });
        active = session;
        for await (const msg of session) {
          const found = sessionIdOf(msg);
          if (found) sessionId = found;
          if (msg.type === "result" && msg.subtype === "success") out += msg.result;
        }
        return out.trim() || "(no summary produced)";
      } catch (e) {
        return `(summary unavailable: ${(e as Error).message})`;
      } finally {
        closeActive();
      }
    },

    async cancel() {
      if (cancelled) return;
      cancelled = true;
      try {
        await active?.interrupt();
      } catch {
        /* best effort */
      }
      abortController.abort();
    },
  };
}
