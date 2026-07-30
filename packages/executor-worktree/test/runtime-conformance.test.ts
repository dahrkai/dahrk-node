/**
 * The shared runtime conformance suite (DHK-967). Dahrk's full-parity mandate says a stage must behave
 * the same whichever runtime executes it - `claude-code` or `pi`. Before this file that parity was
 * ASSERTED, not tested: Pi and Claude had two independently written suites covering different slices, so
 * agreement between them was coincidence, and only Pi's suite carried cross-runtime assertions (a Claude
 * envelope change reddened Pi's tests and left Claude's green - the failure landing on the wrong side).
 *
 * This suite drives BOTH adapters through ONE identical assertion set. It lifts the pattern
 * `shared-loop.test.ts` uses one level down (a scripted session through the shared turn loop) up a
 * level: a table of runtime cases, each building a REAL runner (`createClaudeRunner` / `createPiRunner`)
 * through the injected session-factory seam both adapters already accept, scripted with the same fakes
 * the two adapter suites already prove. No production seam is added; no live SDK is touched.
 *
 * The assertions run only against the runtime-agnostic outputs: the `onTrace` envelope stream, the
 * `JobResult`, `ctx.authorizeToolUse`/`ctx.emitElicit` observed through the run, and
 * `enforcesPreExecution`. A deliberate regression in either adapter therefore reddens THAT adapter's row
 * and names it. Where a runtime legitimately lacks a capability the row carries an explicit skip with a
 * reason string, so the suite doubles as the machine-readable record of intentional divergence and the
 * acceptance harness any future runtime must pass. For the two embedded adapters both are
 * full-capability, so today there are zero skips - the mechanism is exercised structurally regardless.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import type {
  ElicitQuestion,
  HumanTurn,
  JobResult,
  PolicyOutcome,
  RunnerContext,
  TraceEvent,
} from "@dahrk/contracts";
import type { SDKMessage, SDKUserMessage, Options } from "@anthropic-ai/claude-agent-sdk";
import {
  createClaudeRunner,
  type ClaudeSessionInit,
  type ClaudeSessionLike,
} from "../src/claude-adapter.js";
import {
  createPiRunner,
  EMBEDDED_PI_CAPABILITIES,
  PI_STAGE_COMPLETE_TOOL,
  type AskUserQuestions,
  type PiSessionCapabilities,
  type PiSessionLike,
} from "../src/pi-adapter.js";
import type { PiEvent } from "../src/pi-mappers.js";
import type { StageCompleteTool } from "../src/stage-complete-tool.js";
import type { PolicyAwareRunnerContext } from "../src/runtime-session.js";
import { ManagedMailbox } from "../src/mailbox.js";

// --- Shared trace-schema validation (reused from pi-adapter.test.ts) ---------------------------------

const traceSchema = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.resolve("@dahrk/contracts"))), "..", "schemas", "trace.schema.json"),
    "utf8",
  ),
);
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(traceSchema);
const validateEvent = ajv.compile({ $ref: "https://dahrk.ai/schemas/trace.schema.json#/$defs/event" });

// --- Neutral helpers shared by every row ------------------------------------------------------------

type Runtime = "claude-code" | "pi";
const cm = (x: unknown): SDKMessage => x as SDKMessage;
const pe = (x: unknown): PiEvent => x as PiEvent;

const baseWorkspace = {
  repoId: "r",
  gitUrl: "https://github.com/skakel/skakel-test.git",
  repo: "r",
  baseBranch: "main",
  worktreePath: "/tmp/wt",
  scratchPath: "/tmp/wt/.dahrk/scratch",
};

/** A batch RunnerContext stamped with the row's runtime; extra fields (authorizeToolUse, writeRaw) are
 *  layered on by the scenario builders. */
const ctxBatch = (runtime: Runtime, over: Partial<RunnerContext> = {}): RunnerContext =>
  ({
    config: { runtime, interaction: "batch" },
    workspace: baseWorkspace,
    issueContext: "Fix the failing tests.",
    ...over,
  }) as RunnerContext;

/** An interactive RunnerContext stamped with the row's runtime, optionally carrying the elicit seam and
 *  tiny idle windows so the timeout path settles fast. */
const ctxInteractive = (
  runtime: Runtime,
  over: {
    emitElicit?: (q: ElicitQuestion) => void;
    authorizeToolUse?: (tool: string, input: unknown) => PolicyOutcome;
    exit?: string;
    firstReplyMs?: number;
    idleMs?: number;
  } = {},
): RunnerContext => {
  const { emitElicit, authorizeToolUse, exit, firstReplyMs, idleMs } = over;
  return {
    config: {
      runtime,
      interaction: "interactive",
      ...(exit ? { exit } : {}),
      ...(firstReplyMs !== undefined ? { firstReplyMs } : {}),
      ...(idleMs !== undefined ? { idleMs } : {}),
    },
    workspace: baseWorkspace,
    issueContext: "Fix the failing tests.",
    ...(emitElicit ? { emitElicit } : {}),
    ...(authorizeToolUse ? { authorizeToolUse } : {}),
  } as RunnerContext;
};

const humanTurn = (text: string): HumanTurn => ({ text, ts: "2026-07-30T00:00:00Z" });
const turnsFrom = (texts: string[]): AsyncIterable<HumanTurn> => ({
  async *[Symbol.asyncIterator]() {
    for (const t of texts) yield humanTurn(t);
  },
});
const neverTurns = (): AsyncIterable<HumanTurn> => new ManagedMailbox<HumanTurn>();

// The one structured question both seams raise (assertion 7). One neutral definition fed to each
// runtime's handler, so the ElicitQuestion the edge sees and the reply handed back are asserted identical.
const ELICIT_QUESTION: AskUserQuestions = [
  {
    question: "Which approach?",
    options: [
      { label: "Option A", description: "the safe one" },
      { label: "Option B", description: "the fast one" },
    ],
    multiSelect: true,
  },
];
const EXPECTED_ELICIT_PROMPT = "Which approach?\n\n- Option A: the safe one\n- Option B: the fast one";
const EXPECTED_ELICIT_OPTIONS = [
  { label: "Option A", value: "Option A" },
  { label: "Option B", value: "Option B" },
];
const ELICIT_HUMAN_PICK = "Option B";
const EXPECTED_ELICIT_REPLY = "The user selected: Option B";

// --- The two scripted fakes, lifted from the adapter suites -----------------------------------------

/** A per-turn Claude script: a fixed list of SDK messages, or a thunk producing them (a tool-exit /
 *  elicit turn is a thunk that drives the injected tools before emitting its result). Lifted from
 *  claude-adapter.test.ts. */
type ClaudeScriptStep = SDKMessage[] | (() => SDKMessage[] | Promise<SDKMessage[]>);

/** Scripted fake Claude session (lifted verbatim from claude-adapter.test.ts, plus `options` capture so
 *  the elicit scenario can reach the injected `ask` shadow tool - the analogue of driving `stageTool`). */
class FakeClaudeSession implements ClaudeSessionLike {
  prompts: string[] = [];
  closed = false;
  ended = false;
  interrupted = false;
  stageTool?: StageCompleteTool;
  options?: Options;
  /** Tool calls the SDK's `canUseTool` gate denied: recorded so the matching tool_result is dropped too. */
  blocked: { toolName: string; reason?: string }[] = [];
  private deniedToolUseIds = new Set<string>();
  private inbox = new ManagedMailbox<SDKMessage>();
  constructor(private readonly scripts: ClaudeScriptStep[]) {}

  bind(init: ClaudeSessionInit): ClaudeSessionLike {
    this.inbox = new ManagedMailbox<SDKMessage>();
    this.stageTool = init.stageTool;
    this.options = init.options;
    if (init.prompt !== undefined) {
      this.prompts.push(init.prompt);
      void this.replayAndEnd();
    }
    return this;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return this.inbox[Symbol.asyncIterator]();
  }

  push(msg: SDKUserMessage): void {
    this.prompts.push(typeof msg.message.content === "string" ? msg.message.content : "");
    void this.replayNext();
  }

  end(): void {
    this.ended = true;
    this.inbox.end();
  }

  close(): void {
    this.closed = true;
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
  }

  /** Invoke the injected `ask_user_question` shadow tool exactly as the live SDK's MCP handler would -
   *  the seam the elicit scenario uses to raise a question without running the live SDK, the analogue of
   *  how the tool-exit scenario calls `stageTool.capture`. Reaches the handler registered on the in-process
   *  MCP server the adapter placed at `options.mcpServers.ask` (createAskUserQuestionTool). */
  async invokeAsk(questions: AskUserQuestions): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server = (this.options as any)?.mcpServers?.ask;
    const handler = server?.instance?._registeredTools?.ask_user_question?.handler;
    if (typeof handler !== "function") throw new Error("ask shadow tool handler not reachable");
    const res = await handler({ questions }, {});
    return res.content?.[0]?.text ?? "";
  }

  private async replayNext(): Promise<void> {
    const step = this.scripts.shift() ?? [];
    const msgs = typeof step === "function" ? await step() : step;
    for (const m of msgs) await this.emitFiltered(m);
  }

  /**
   * Model the SDK's `canUseTool` permission gate (the Claude analogue of Pi's pre-execution
   * `tool_call` hook): a scripted `tool_use` is consulted against `options.canUseTool` BEFORE it is
   * surfaced; a `deny` drops the tool_use (no `action`) and its paired `tool_result` (no `observation`),
   * so a policy-violating tool is blocked before execution rather than run-then-annotated. An allowed
   * call is surfaced unchanged. Non-tool messages pass straight through.
   */
  private async emitFiltered(m: SDKMessage): Promise<void> {
    const anyMsg = m as unknown as { type: string; message?: { content?: unknown } };
    const content = anyMsg.message?.content;
    if (anyMsg.type === "assistant" && Array.isArray(content)) {
      const kept: unknown[] = [];
      for (const b of content as { type: string; [k: string]: unknown }[]) {
        if (b.type === "tool_use") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const decision = this.options?.canUseTool
            ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
              await (this.options.canUseTool as any)(String(b.name), b.input ?? {}, {})
            : { behavior: "allow" };
          if (decision.behavior === "deny") {
            this.blocked.push({ toolName: String(b.name), reason: decision.message });
            this.deniedToolUseIds.add(String(b.id));
            continue;
          }
        }
        kept.push(b);
      }
      if (kept.length === 0) return; // the whole message was denied tool calls
      this.inbox.push(cm({ ...anyMsg, message: { ...anyMsg.message, content: kept } }));
      return;
    }
    if (anyMsg.type === "user" && Array.isArray(content)) {
      const kept = (content as { type: string; tool_use_id?: string }[]).filter(
        (b) => !(b.type === "tool_result" && this.deniedToolUseIds.has(String(b.tool_use_id))),
      );
      if (kept.length === 0) return;
      this.inbox.push(cm({ ...anyMsg, message: { ...anyMsg.message, content: kept } }));
      return;
    }
    this.inbox.push(m);
  }

  private async replayAndEnd(): Promise<void> {
    await this.replayNext();
    this.inbox.end();
  }
}

/** A per-prompt Pi script step: a fixed list of native events, or a thunk the fake awaits. Lifted from
 *  pi-adapter.test.ts. */
type PiScriptStep = PiEvent[] | (() => PiEvent[] | Promise<PiEvent[]>);

/** Scripted fake Pi `AgentSession` (lifted verbatim from pi-adapter.test.ts, incl. its gate/askHandler
 *  capture and turn-ceiling abort modelling). */
class FakePiSession implements PiSessionLike {
  sessionId = "pi-sess-1";
  /** Stands in for the embedded session, so it declares the same full capability surface (DHK-968). */
  readonly capabilities: PiSessionCapabilities = EMBEDDED_PI_CAPABILITIES;
  agent = { state: { tools: ["read", "bash", "edit", "write"] as unknown[] } };
  prompts: string[] = [];
  aborted = false;
  disposed = false;
  askHandler?: (questions: AskUserQuestions) => Promise<string>;
  gate?: (toolName: string, input: unknown) => { block?: boolean; reason?: string } | undefined;
  blocked: { toolName: string; reason?: string }[] = [];
  cost: number | undefined;
  private listeners: Array<(e: PiEvent) => void> = [];
  constructor(private readonly scripts: PiScriptStep[], cost?: number) {
    this.cost = cost;
  }
  getSessionStats(): { cost?: number } {
    return { cost: this.cost };
  }
  subscribe(listener: (e: PiEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
  setAskUserQuestionHandler(handler: (questions: AskUserQuestions) => Promise<string>): void {
    this.askHandler = handler;
  }
  setToolCallGate(
    gate: (toolName: string, input: unknown) => { block?: boolean; reason?: string } | undefined,
  ): void {
    this.gate = gate;
  }
  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    const step = this.scripts.shift() ?? [];
    const script = typeof step === "function" ? await step() : step;
    const blockedCallIds = new Set<string>();
    for (const ev of script) {
      if (this.aborted) break;
      if (ev.type === "tool_execution_start") {
        const decision = this.gate?.(ev.toolName, ev.args);
        if (decision?.block) {
          this.blocked.push({ toolName: ev.toolName, reason: decision.reason });
          blockedCallIds.add(ev.toolCallId);
          continue;
        }
      }
      if (ev.type === "tool_execution_end" && blockedCallIds.has(ev.toolCallId)) continue;
      for (const l of [...this.listeners]) l(ev);
    }
    if (this.aborted) {
      for (const l of [...this.listeners]) l(pe({ type: "agent_end", messages: [{ stopReason: "aborted" }] }));
    }
  }
  async abort(): Promise<void> {
    this.aborted = true;
  }
  dispose(): void {
    this.disposed = true;
  }
}

// --- Canonical native scripts -----------------------------------------------------------------------

/** A Claude assistant text message carrying a session id. */
const asst = (text: string, sessionId = "claude-sess-1"): SDKMessage =>
  cm({ type: "assistant", session_id: sessionId, message: { role: "assistant", content: [{ type: "text", text }] } });
/** A Claude assistant thinking-only message (maps to a `thought`, never buffers text). */
const thinking = (text: string): SDKMessage =>
  cm({ type: "assistant", session_id: "claude-sess-1", message: { role: "assistant", content: [{ type: "thinking", thinking: text }] } });
/** A Claude assistant tool-use-only message (maps to an `action`, ends the turn on a tool call). */
const toolUse = (tool: string, id: string, input: unknown): SDKMessage =>
  cm({ type: "assistant", session_id: "claude-sess-1", message: { role: "assistant", content: [{ type: "tool_use", name: tool, id, input }] } });
/** A Claude user tool-result message (maps to an `observation`). */
const toolResult = (id: string, content: string): SDKMessage =>
  cm({ type: "user", session_id: "claude-sess-1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] } });
/** A Claude turn-settling `result` message. */
const resultMsg = (over: { status?: "ok" | "fail"; cost?: number; text?: string } = {}): SDKMessage => {
  const { status = "ok", cost, text = "" } = over;
  return cm({
    type: "result",
    subtype: status === "ok" ? "success" : "error_during_execution",
    session_id: "claude-sess-1",
    ...(cost !== undefined ? { total_cost_usd: cost } : {}),
    usage: {},
    duration_ms: 1,
    result: text,
  });
};

/** The Pi analogue of a canonical one-tool-using turn: thinking -> one tool call + result -> final text.
 *  Yields the SAME five-event envelope the Claude canonical turn does. Lifted from pi-adapter.test.ts. */
const PI_STAGE_SCRIPT: PiEvent[] = [
  pe({ type: "agent_start" }),
  pe({ type: "turn_start" }),
  pe({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Plan: run the tests." } }),
  pe({ type: "tool_execution_start", toolName: "bash", toolCallId: "call_1", args: { command: "pnpm test" } }),
  pe({ type: "tool_execution_end", toolCallId: "call_1", result: "3 passing", isError: false }),
  pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "All three tests pass." } }),
  pe({ type: "agent_end", messages: [{ stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 } }] }),
];

/** The Claude analogue: thinking -> tool_use -> tool_result -> final text -> result, WITHOUT an
 *  intervening buffered text between the tool call and the result (which would insert an extra `thought`),
 *  so it yields the identical five-event sequence Pi does (plan risk B). */
const claudeCanonicalSteps = (cost?: number): ClaudeScriptStep[] => [
  [
    thinking("Plan: run the tests."),
    toolUse("bash", "call_1", { command: "pnpm test" }),
    toolResult("call_1", "3 passing"),
    asst("All three tests pass."),
    resultMsg({ cost }),
  ],
];

// --- The runtime-neutral case table -----------------------------------------------------------------

/** The normalised outcome the shared assertions read - runtime-agnostic by construction. */
interface Outcome {
  events: TraceEvent[];
  result: Partial<JobResult> & { status: JobResult["status"]; summary?: string };
  prompts?: string[];
  elicited?: ElicitQuestion[];
  reply?: string;
  released?: boolean;
  enforcesPreExecution?: boolean;
}

/** Every assertion the suite makes, keyed so a row can record an intentional skip with a reason. */
type AssertionKey =
  | "envelope"
  | "buffered-response"
  | "per-turn-suppression"
  | "gate-batch"
  | "gate-interactive"
  | "enforces-pre-execution"
  | "elicitation"
  | "cost-reported"
  | "cost-unpriced"
  | "cancel-idempotent"
  | "idle-timeout"
  | "burst-coalescing"
  | "runtime-error"
  | "external-classification";

/**
 * One runtime row. Each scenario builder scripts the row's fake, builds its REAL runner through the
 * injected session factory, drives the run, and returns the runtime-agnostic `Outcome`. `skips` records
 * intentional divergence (assertion key -> reason); both embedded adapters are full-capability, so it is
 * empty today.
 */
interface RuntimeCase {
  name: Runtime;
  skips?: Partial<Record<AssertionKey, string>>;
  /** A canonical one-tool-using batch turn (thought->action->observation->response->state). */
  batchCanonical(cost?: number): Promise<Outcome>;
  /** A batch turn that ENDS on a tool call with no final assistant text (the buffered-response rule). */
  batchToolEnded(): Promise<Outcome>;
  /** An interactive stage that exits via the gate (turns exhausted), with one conversational human turn. */
  interactiveGate(): Promise<Outcome>;
  /** A batch turn calling a denied `write` and an allowed tool; the deny must block before execution. */
  batchGateDeny(): Promise<Outcome>;
  /** An interactive human turn calling a denied `write` and an allowed `read`; deny blocks before exec. */
  interactiveGateDeny(): Promise<Outcome>;
  /** Drive a minimal batch and report whether the runner pre-blocks tool calls (enforcesPreExecution). */
  enforcesPreExecution(): Promise<Outcome>;
  /** Raise a structured question mid interactive turn; the human picks; the pick returns into the turn. */
  interactiveElicit(): Promise<Outcome>;
  /** A canonical batch whose session cannot price the run (costUsd must be omitted, never a $0). */
  batchUnpriced(): Promise<Outcome>;
  /** A batch whose session/prompt throws the given message (runtime error classification). */
  batchThrows(message: string): Promise<Outcome>;
  /** An interactive stage cancelled mid-stage; reports the settle and whether the session was released. */
  cancelInteractive(): Promise<Outcome>;
  /** An interactive stage with no human reply within a tiny idle window (idle timeout). */
  timeoutInteractive(): Promise<Outcome>;
  /** An interactive stage fed a rapid burst of queued turns; reports the prompts the session received. */
  burstInteractive(): Promise<Outcome>;
}

/** The gate policy every gate scenario uses: deny `write`, allow everything else. */
const denyWrites = (tool: string): PolicyOutcome =>
  tool === "write"
    ? { verdict: "deny", policy: "fs_confine", reason: "write escapes the worktree" }
    : { verdict: "allow", policy: "none" };

// --- Claude row -------------------------------------------------------------------------------------

const claudeCase: RuntimeCase = {
  name: "claude-code",
  async batchCanonical(cost = 0.05) {
    const events: TraceEvent[] = [];
    const fake = new FakeClaudeSession(claudeCanonicalSteps(cost));
    const runner = createClaudeRunner({ createSession: (init) => fake.bind(init) });
    const result = await runner.runBatch(ctxBatch("claude-code"), (e) => events.push(e));
    return { events, result };
  },
  async batchToolEnded() {
    const events: TraceEvent[] = [];
    // Thinking -> tool_use -> tool_result -> result, with NO trailing assistant text: the turn ends on a
    // tool call, so the buffered-response rule emits no `response`.
    const fake = new FakeClaudeSession([
      [thinking("Plan."), toolUse("bash", "call_1", { command: "ls" }), toolResult("call_1", "file.txt"), resultMsg({})],
    ]);
    const runner = createClaudeRunner({ createSession: (init) => fake.bind(init) });
    const result = await runner.runBatch(ctxBatch("claude-code"), (e) => events.push(e));
    return { events, result };
  },
  async interactiveGate() {
    const events: TraceEvent[] = [];
    const fake = new FakeClaudeSession([
      [asst("What is the objective?"), resultMsg({})], // self-seeded opening turn
      [asst("Here is the answer."), resultMsg({})], // the human turn
      [asst("Explained the fix; tests pass."), resultMsg({})], // engine-owned summarise (gate)
    ]);
    const runner = createClaudeRunner({ createSession: (init) => fake.bind(init) });
    const result = await runner.runInteractive(ctxInteractive("claude-code"), turnsFrom(["what is wrong?"]), (e) =>
      events.push(e),
    );
    return { events, result };
  },
  async batchGateDeny() {
    const events: TraceEvent[] = [];
    const fake = new FakeClaudeSession([
      [
        thinking("Working."),
        toolUse("write", "w1", { path: "/etc/passwd", content: "x" }),
        toolResult("w1", "written"),
        toolUse("bash", "b1", { command: "ls" }),
        toolResult("b1", "file.txt"),
        asst("done"),
        resultMsg({}),
      ],
    ]);
    const runner = createClaudeRunner({ createSession: (init) => fake.bind(init) });
    const result = await runner.runBatch(ctxBatch("claude-code", { authorizeToolUse: denyWrites } as Partial<RunnerContext>), (e) =>
      events.push(e),
    );
    return { events, result };
  },
  async interactiveGateDeny() {
    const events: TraceEvent[] = [];
    const fake = new FakeClaudeSession([
      [asst("What to do?"), resultMsg({})], // opening turn
      [
        toolUse("write", "w2", { path: "/etc/passwd", content: "x" }),
        toolResult("w2", "written"),
        toolUse("read", "r2", { path: "/tmp/wt/README.md" }),
        toolResult("r2", "# Readme"),
        asst("read ok"),
        resultMsg({}),
      ],
      [asst("Used read safely."), resultMsg({})], // engine-owned summarise
    ]);
    const runner = createClaudeRunner({ createSession: (init) => fake.bind(init) });
    const result = await runner.runInteractive(
      ctxInteractive("claude-code", { authorizeToolUse: denyWrites }),
      turnsFrom(["do something"]),
      (e) => events.push(e),
    );
    return { events, result };
  },
  async enforcesPreExecution() {
    const events: TraceEvent[] = [];
    const fake = new FakeClaudeSession(claudeCanonicalSteps());
    const runner = createClaudeRunner({ createSession: (init) => fake.bind(init) });
    const result = await runner.runBatch(ctxBatch("claude-code"), (e) => events.push(e));
    return { events, result, enforcesPreExecution: runner.enforcesPreExecution };
  },
  async interactiveElicit() {
    const events: TraceEvent[] = [];
    const elicited: ElicitQuestion[] = [];
    const turns = new ManagedMailbox<HumanTurn>();
    let reply: string | undefined;
    const fake = new FakeClaudeSession([
      // Opening turn: the model calls the injected `ask` shadow tool, parks on the human, then continues
      // once the pick returns - the shape the live SDK's MCP handler has.
      async () => {
        reply = await fake.invokeAsk(ELICIT_QUESTION);
        turns.end(); // no further human turns -> settle to gate after this turn
        return [asst("Proceeding with the pick."), resultMsg({})];
      },
      [asst("Chose Option B."), resultMsg({})], // engine-owned summarise (gate)
    ]);
    const runner = createClaudeRunner({ createSession: (init) => fake.bind(init) });
    const onTrace = (e: TraceEvent): void => {
      events.push(e);
      if (e.type === "elicitation") turns.push(humanTurn(ELICIT_HUMAN_PICK));
    };
    const result = await runner.runInteractive(
      ctxInteractive("claude-code", { emitElicit: (q) => elicited.push(q) }),
      turns,
      onTrace,
    );
    return { events, result, elicited, reply };
  },
  async batchUnpriced() {
    const events: TraceEvent[] = [];
    const fake = new FakeClaudeSession(claudeCanonicalSteps(undefined)); // resultMsg carries no total_cost_usd
    const runner = createClaudeRunner({ createSession: (init) => fake.bind(init) });
    const result = await runner.runBatch(ctxBatch("claude-code"), (e) => events.push(e));
    return { events, result };
  },
  async batchThrows(message) {
    const events: TraceEvent[] = [];
    const throwing: ClaudeSessionLike = {
      [Symbol.asyncIterator]: () =>
        (async function* (): AsyncGenerator<SDKMessage> {
          throw new Error(message);
        })(),
      push: () => {},
      end: () => {},
      close: () => {},
      interrupt: async () => {},
    };
    const runner = createClaudeRunner({ createSession: () => throwing });
    const result = await runner.runBatch(ctxBatch("claude-code"), (e) => events.push(e));
    return { events, result };
  },
  async cancelInteractive() {
    const events: TraceEvent[] = [];
    const fake = new FakeClaudeSession([[asst("What is the objective?"), resultMsg({})]]);
    const runner = createClaudeRunner({ createSession: (init) => fake.bind(init) });
    const pending = runner.runInteractive(ctxInteractive("claude-code"), neverTurns(), (e) => events.push(e));
    await runner.cancel();
    await runner.cancel(); // idempotent: a second cancel is a no-op
    const result = await pending;
    return { events, result, released: fake.interrupted || fake.closed };
  },
  async timeoutInteractive() {
    const events: TraceEvent[] = [];
    const fake = new FakeClaudeSession([[asst("What is the objective?"), resultMsg({})]]);
    const runner = createClaudeRunner({ createSession: (init) => fake.bind(init) });
    const result = await runner.runInteractive(
      ctxInteractive("claude-code", { firstReplyMs: 20, idleMs: 20 }),
      neverTurns(),
      (e) => events.push(e),
    );
    return { events, result };
  },
  async burstInteractive() {
    const events: TraceEvent[] = [];
    const turns = new ManagedMailbox<HumanTurn>();
    const fake = new FakeClaudeSession([
      [asst("What should I do?"), resultMsg({})], // opening turn
      [asst("Working through them."), resultMsg({})], // the coalesced human turn
      [asst("Handled them."), resultMsg({})], // engine-owned summarise (gate)
    ]);
    const runner = createClaudeRunner({ createSession: (init) => fake.bind(init) });
    turns.push(humanTurn("t1"));
    turns.push(humanTurn("t2"));
    turns.push(humanTurn("t3"));
    turns.end();
    const result = await runner.runInteractive(ctxInteractive("claude-code"), turns, (e) => events.push(e));
    return { events, result, prompts: fake.prompts };
  },
};

// --- Pi row -----------------------------------------------------------------------------------------

const piCase: RuntimeCase = {
  name: "pi",
  async batchCanonical(cost = 0.05) {
    const events: TraceEvent[] = [];
    const fake = new FakePiSession([PI_STAGE_SCRIPT], cost);
    const runner = createPiRunner({ createSession: async () => fake });
    const result = await runner.runBatch(ctxBatch("pi"), (e) => events.push(e));
    return { events, result };
  },
  async batchToolEnded() {
    const events: TraceEvent[] = [];
    // thinking -> tool call -> no trailing text_delta: the turn ends on a tool call, so no `response`.
    const fake = new FakePiSession([
      [
        pe({ type: "agent_start" }),
        pe({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Plan." } }),
        pe({ type: "tool_execution_start", toolName: "bash", toolCallId: "call_1", args: { command: "ls" } }),
        pe({ type: "tool_execution_end", toolCallId: "call_1", result: "file.txt", isError: false }),
        pe({ type: "agent_end", messages: [{ stopReason: "stop" }] }),
      ],
    ]);
    const runner = createPiRunner({ createSession: async () => fake });
    const result = await runner.runBatch(ctxBatch("pi"), (e) => events.push(e));
    return { events, result };
  },
  async interactiveGate() {
    const events: TraceEvent[] = [];
    const fake = new FakePiSession([
      [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "What is the objective?" } }),
       pe({ type: "turn_end", message: { stopReason: "stop" } })],
      [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Here is the answer." } }),
       pe({ type: "turn_end", message: { stopReason: "stop" } })],
      [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Explained the fix; tests pass." } }),
       pe({ type: "agent_end", messages: [{ stopReason: "stop" }] })],
    ]);
    const runner = createPiRunner({ createSession: async () => fake });
    const result = await runner.runInteractive(ctxInteractive("pi"), turnsFrom(["what is wrong?"]), (e) =>
      events.push(e),
    );
    return { events, result };
  },
  async batchGateDeny() {
    const events: TraceEvent[] = [];
    const fake = new FakePiSession([
      [
        pe({ type: "agent_start" }),
        pe({ type: "tool_execution_start", toolName: "write", toolCallId: "w1", args: { path: "/etc/passwd", content: "x" } }),
        pe({ type: "tool_execution_end", toolCallId: "w1", result: "written", isError: false }),
        pe({ type: "tool_execution_start", toolName: "bash", toolCallId: "b1", args: { command: "ls" } }),
        pe({ type: "tool_execution_end", toolCallId: "b1", result: "file.txt", isError: false }),
        pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } }),
        pe({ type: "agent_end", messages: [{ stopReason: "stop" }] }),
      ],
    ]);
    const runner = createPiRunner({ createSession: async () => fake });
    const result = await runner.runBatch(ctxBatch("pi", { authorizeToolUse: denyWrites } as Partial<RunnerContext>), (e) =>
      events.push(e),
    );
    return { events, result };
  },
  async interactiveGateDeny() {
    const events: TraceEvent[] = [];
    const fake = new FakePiSession([
      [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "What to do?" } }),
       pe({ type: "turn_end", message: { stopReason: "stop" } })],
      [
        pe({ type: "tool_execution_start", toolName: "write", toolCallId: "w2", args: { path: "/etc/passwd", content: "x" } }),
        pe({ type: "tool_execution_end", toolCallId: "w2", result: "written", isError: false }),
        pe({ type: "tool_execution_start", toolName: "read", toolCallId: "r2", args: { path: "/tmp/wt/README.md" } }),
        pe({ type: "tool_execution_end", toolCallId: "r2", result: "# Readme", isError: false }),
        pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "read ok" } }),
        pe({ type: "turn_end", message: { stopReason: "stop" } }),
      ],
      [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Used read safely." } }),
       pe({ type: "agent_end", messages: [{ stopReason: "stop" }] })],
    ]);
    const runner = createPiRunner({ createSession: async () => fake });
    const result = await runner.runInteractive(
      ctxInteractive("pi", { authorizeToolUse: denyWrites }),
      turnsFrom(["do something"]),
      (e) => events.push(e),
    );
    return { events, result };
  },
  async enforcesPreExecution() {
    const events: TraceEvent[] = [];
    const fake = new FakePiSession([PI_STAGE_SCRIPT]);
    const runner = createPiRunner({ createSession: async () => fake });
    const result = await runner.runBatch(ctxBatch("pi"), (e) => events.push(e));
    return { events, result, enforcesPreExecution: runner.enforcesPreExecution };
  },
  async interactiveElicit() {
    const events: TraceEvent[] = [];
    const elicited: ElicitQuestion[] = [];
    const turns = new ManagedMailbox<HumanTurn>();
    let reply: string | undefined;
    const fake = new FakePiSession([
      async () => {
        reply = await fake.askHandler!(ELICIT_QUESTION);
        turns.end();
        return [
          pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Proceeding with the pick." } }),
          pe({ type: "turn_end", message: { stopReason: "stop" } }),
        ];
      },
      [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Chose Option B." } }),
       pe({ type: "agent_end", messages: [{ stopReason: "stop" }] })],
    ]);
    const runner = createPiRunner({ createSession: async () => fake });
    const onTrace = (e: TraceEvent): void => {
      events.push(e);
      if (e.type === "elicitation") turns.push(humanTurn(ELICIT_HUMAN_PICK));
    };
    const result = await runner.runInteractive(
      ctxInteractive("pi", { emitElicit: (q) => elicited.push(q) }),
      turns,
      onTrace,
    );
    return { events, result, elicited, reply };
  },
  async batchUnpriced() {
    const events: TraceEvent[] = [];
    const fake = new FakePiSession([PI_STAGE_SCRIPT]); // cost undefined
    const runner = createPiRunner({ createSession: async () => fake });
    const result = await runner.runBatch(ctxBatch("pi"), (e) => events.push(e));
    return { events, result };
  },
  async batchThrows(message) {
    const events: TraceEvent[] = [];
    const throwing: PiSessionLike = {
      sessionId: "pi-throw",
      capabilities: EMBEDDED_PI_CAPABILITIES,
      subscribe: (l) => {
        l(pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } }));
        return () => {};
      },
      prompt: async () => {
        throw new Error(message);
      },
      abort: async () => {},
      dispose: () => {},
    };
    const runner = createPiRunner({ createSession: async () => throwing });
    const result = await runner.runBatch(ctxBatch("pi"), (e) => events.push(e));
    return { events, result };
  },
  async cancelInteractive() {
    const events: TraceEvent[] = [];
    const fake = new FakePiSession([
      [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "What is the objective?" } }),
       pe({ type: "turn_end", message: { stopReason: "stop" } })],
    ]);
    const runner = createPiRunner({ createSession: async () => fake });
    const pending = runner.runInteractive(ctxInteractive("pi"), neverTurns(), (e) => events.push(e));
    await runner.cancel();
    await runner.cancel(); // idempotent
    const result = await pending;
    return { events, result, released: fake.aborted || fake.disposed };
  },
  async timeoutInteractive() {
    const events: TraceEvent[] = [];
    const fake = new FakePiSession([
      [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "What is the objective?" } }),
       pe({ type: "turn_end", message: { stopReason: "stop" } })],
    ]);
    const runner = createPiRunner({ createSession: async () => fake });
    const result = await runner.runInteractive(
      ctxInteractive("pi", { firstReplyMs: 20, idleMs: 20 }),
      neverTurns(),
      (e) => events.push(e),
    );
    return { events, result };
  },
  async burstInteractive() {
    const events: TraceEvent[] = [];
    const turns = new ManagedMailbox<HumanTurn>();
    const fake = new FakePiSession([
      [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "What should I do?" } }),
       pe({ type: "turn_end", message: { stopReason: "stop" } })],
      [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Working through them." } }),
       pe({ type: "turn_end", message: { stopReason: "stop" } })],
      [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Handled them." } }),
       pe({ type: "agent_end", messages: [{ stopReason: "stop" }] })],
    ]);
    const runner = createPiRunner({ createSession: async () => fake });
    turns.push(humanTurn("t1"));
    turns.push(humanTurn("t2"));
    turns.push(humanTurn("t3"));
    turns.end();
    const result = await runner.runInteractive(ctxInteractive("pi"), turns, (e) => events.push(e));
    return { events, result, prompts: fake.prompts };
  },
};

const CASES: RuntimeCase[] = [claudeCase, piCase];

// The skip mechanism is the machine-readable record of intentional divergence: any case that opts out of
// an assertion MUST carry a written reason. Today both embedded adapters are full-capability, so there
// are zero skips - this guard keeps that honest and fails loudly if a future skip is added blank.
test("conformance: every recorded skip carries a written reason", () => {
  for (const c of CASES) {
    for (const [key, reason] of Object.entries(c.skips ?? {})) {
      assert.ok(
        typeof reason === "string" && reason.trim().length > 0,
        `${c.name} skips "${key}" without a reason string`,
      );
    }
  }
});

/** Run a shared body as a sub-test per row, honouring a row's recorded skip-with-reason. */
const forEachCase = (
  key: AssertionKey,
  body: (t: test.TestContext, c: RuntimeCase) => Promise<void>,
): ((t: test.TestContext) => Promise<void>) => {
  return async (t) => {
    for (const c of CASES) {
      const reason = c.skips?.[key];
      await t.test(c.name, reason ? { skip: reason } : {}, async () => {
        await body(t, c);
      });
    }
  };
};

// --- Assertion 1: trace envelope sequence + ordering, asserted for BOTH ------------------------------

test(
  "conformance: a canonical one-tool turn yields the same schema-valid envelope sequence for both runtimes",
  forEachCase("envelope", async (_t, c) => {
    const { events, result } = await c.batchCanonical();
    assert.deepEqual(
      events.map((e) => e.type),
      ["thought", "action", "observation", "response", "state"],
      "the canonical turn maps to the identical five-event envelope on both runtimes",
    );
    const state = events[4] as Extract<TraceEvent, { type: "state" }>;
    assert.equal(state.event, "stage-exit");
    assert.equal(state.status, "ok");
    for (const e of events) {
      assert.equal(e.runtime, c.name, "every event is stamped with the row's runtime");
      assert.ok(validateEvent(e), `schema: ${JSON.stringify(validateEvent.errors)}`);
    }
    assert.equal(result.status, "ok");
  }),
);

// --- Assertion 2: the buffered-response rule (CYPACK-1177), asserted for BOTH ------------------------

test(
  "conformance: a batch turn ending on a tool call emits no response event on either runtime",
  forEachCase("buffered-response", async (_t, c) => {
    const { events, result } = await c.batchToolEnded();
    assert.deepEqual(
      events.map((e) => e.type),
      ["thought", "action", "observation", "state"],
      "a tool-ended turn has no response: the last text was tool-input narration, not the answer",
    );
    assert.ok(!events.some((e) => e.type === "response"), "no response event on a tool-ended turn");
    assert.equal(result.status, "ok");
  }),
);

const isAction = (e: TraceEvent, tool: string): boolean =>
  e.type === "action" && (e as Extract<TraceEvent, { type: "action" }>).tool === tool;
const isObservation = (e: TraceEvent, id: string): boolean =>
  e.type === "observation" && (e as Extract<TraceEvent, { type: "observation" }>).toolUseId === id;

// --- Assertion 4: pre-execution gate on the BATCH path, asserted for BOTH (closes the Claude gap) ----

test(
  "conformance: a policy-denied write is blocked before execution on the batch path for both runtimes",
  forEachCase("gate-batch", async (_t, c) => {
    const { events, result } = await c.batchGateDeny();
    assert.ok(!events.some((e) => isAction(e, "write")), "the denied write produces no action - it did not execute");
    assert.ok(!events.some((e) => isObservation(e, "w1")), "the denied write produces no observation");
    assert.ok(events.some((e) => isAction(e, "bash")), "the allowed tool still executes and produces an action");
    assert.ok(events.some((e) => isObservation(e, "b1")), "the allowed tool produces its observation");
    assert.equal(result.status, "ok");
  }),
);

// --- Assertion 5: pre-execution gate on the INTERACTIVE path, asserted for BOTH ----------------------

test(
  "conformance: a policy-denied write in a human turn is blocked before execution for both runtimes",
  forEachCase("gate-interactive", async (_t, c) => {
    const { events, result } = await c.interactiveGateDeny();
    assert.ok(!events.some((e) => isAction(e, "write")), "the denied write produces no action in interactive mode");
    assert.ok(!events.some((e) => isObservation(e, "w2")), "the denied write produces no observation in interactive mode");
    assert.ok(events.some((e) => isAction(e, "read")), "the allowed read still executes and produces an action");
    assert.equal(result.status, "ok");
  }),
);

// --- Assertion 6: both embedded adapters report they pre-block tool calls ----------------------------

test(
  "conformance: both embedded runtimes report enforcesPreExecution === true",
  forEachCase("enforces-pre-execution", async (_t, c) => {
    const { enforcesPreExecution } = await c.enforcesPreExecution();
    assert.equal(enforcesPreExecution, true, "an embedded session pre-blocks policy-violating tools before they run");
  }),
);

// --- Assertion 7: elicitation routes to the SAME outcome through both seams --------------------------

test(
  "conformance: a structured question reaches emitElicit identically and returns the same reply on both runtimes",
  forEachCase("elicitation", async (_t, c) => {
    const { events, result, elicited, reply } = await c.interactiveElicit();
    assert.equal(elicited?.length, 1, "the question reached the edge emitElicit seam exactly once");
    assert.equal(elicited![0]!.prompt, EXPECTED_ELICIT_PROMPT, "the prompt folds each option's description");
    assert.deepEqual(elicited![0]!.options, EXPECTED_ELICIT_OPTIONS, "options map label -> { label, value: label }");
    assert.equal(elicited![0]!.multiSelect, true, "multiSelect is carried into the ElicitQuestion");
    assert.equal(reply, EXPECTED_ELICIT_REPLY, "the human's pick returns into the turn with identical wording");
    const elicitEvt = events.find((e) => e.type === "elicitation");
    assert.ok(elicitEvt, "an elicitation audit trace event is emitted on raise");
    assert.ok(validateEvent(elicitEvt), `schema: ${JSON.stringify(validateEvent.errors)}`);
    assert.equal(result.status, "ok");
  }),
);

// --- Assertion 3: interactive per-turn stage-exit suppression, asserted for BOTH --------------------

test(
  "conformance: an interactive conversational turn emits a response but no per-turn stage-exit on either runtime",
  forEachCase("per-turn-suppression", async (_t, c) => {
    const { events, result } = await c.interactiveGate();
    assert.ok(events.some((e) => e.type === "response"), "a conversational turn produces a response");
    assert.ok(
      !events.some((e) => e.type === "state"),
      "the interactive path suppresses the per-turn stage-exit (the stage runner owns the single final one)",
    );
    assert.equal(result.status, "ok");
  }),
);

// --- Assertion 8: cost reported truthfully; never fabricated as $0, for BOTH -------------------------

test(
  "conformance: a priced session surfaces costUsd on both runtimes",
  forEachCase("cost-reported", async (_t, c) => {
    const { result } = await c.batchCanonical(0.0421);
    assert.equal(result.costUsd, 0.0421, "the session's real dollar cost is surfaced, not a silent $0");
  }),
);

test(
  "conformance: an unpriced session omits costUsd entirely on both runtimes (never a fabricated $0)",
  forEachCase("cost-unpriced", async (_t, c) => {
    const { result } = await c.batchUnpriced();
    assert.equal(result.costUsd, undefined);
    assert.ok(!("costUsd" in result), "the key is omitted, so the hub reads 'not reported', not '$0'");
  }),
);

// --- Assertion 9: cancel + dispose idempotence, for BOTH --------------------------------------------

test(
  "conformance: cancelling mid-stage settles fail with the cancelled summary and releases the session, idempotently",
  forEachCase("cancel-idempotent", async (_t, c) => {
    const { result, released } = await c.cancelInteractive();
    assert.equal(result.status, "fail");
    assert.equal(result.summary, "(stage cancelled)");
    assert.equal(released, true, "the underlying session is released on cancel");
  }),
);

// --- Assertion 10: idle timeout, for BOTH -----------------------------------------------------------

test(
  "conformance: no human reply within the idle window settles timeout on both runtimes",
  forEachCase("idle-timeout", async (_t, c) => {
    const { result } = await c.timeoutInteractive();
    assert.equal(result.status, "timeout");
    assert.equal(result.summary, "(stage timed out awaiting input)");
  }),
);

// --- Assertion 11: burst coalescing, for BOTH ------------------------------------------------------

test(
  "conformance: a rapid burst of human turns coalesces into one session turn on both runtimes",
  forEachCase("burst-coalescing", async (_t, c) => {
    const { result, prompts } = await c.burstInteractive();
    // prompts[0] is the self-seeded opening kickoff; prompts[1] is the single coalesced human turn.
    assert.equal(prompts?.[1], "t1\nt2\nt3", "the three queued turns folded into one prompt");
    assert.equal(result.status, "ok");
  }),
);

// --- Assertion 12: runtime error classification, for BOTH ------------------------------------------

test(
  "conformance: a thrown session emits runtime_error and settles fail on both runtimes",
  forEachCase("runtime-error", async (_t, c) => {
    const { events, result } = await c.batchThrows("network timeout");
    assert.equal(result.status, "fail");
    const err = events.find((e) => e.type === "error") as Extract<TraceEvent, { type: "error" }> | undefined;
    assert.ok(err && err.kind === "runtime_error", "a thrown session is reported as a runtime_error");
    assert.equal(err!.message, "network timeout");
  }),
);

test(
  "conformance: an upstream-transient throw carries failureClass external on both runtimes (DHK-569)",
  forEachCase("external-classification", async (_t, c) => {
    const { result } = await c.batchThrows("API Error: Stream idle timeout - partial response received");
    assert.equal(result.status, "fail");
    assert.equal(result.failureClass, "external", "an upstream transient is attributed external, not agent");
    assert.match(result.summary ?? "", /stream idle timeout/i, "the summary names the transient rather than a bare fail");
  }),
);
