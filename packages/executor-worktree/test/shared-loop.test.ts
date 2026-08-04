/**
 * The shared interactive/batch loop, proven once against a runtime-agnostic `FakeRuntimeSession`.
 *
 * `runInteractiveLoop`/`runBatchLoop` (turn-loop.ts) drive the `RuntimeSession` port - a
 * turn-level seam (`sendTurn`/`summariseTurn`/`cost`/`dispose`) - and never see a `PiEvent` or an
 * `SDKMessage`. This suite scripts a fake session's per-turn `TurnResult`s and asserts the loop's
 * settle state machine across the five exit kinds (tool-exit / gate / timeout / cancel / coalesce)
 * plus self-seeding and `cost()`/`sessionId` surfacing. Pi's and (later) Claude's runtime-specific
 * coverage lives in their own adapter suites; this proves the loop that both drive.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { ElicitQuestion, HumanTurn, RunnerContext } from "@dahrk/contracts";
import { runInteractiveLoop, runBatchLoop, classifyRuntimeError, REFUSED_CREDENTIAL_SUMMARY } from "../src/turn-loop.js";
import { ManagedMailbox } from "../src/mailbox.js";
import type {
  EmittableEvent,
  RuntimeSession,
  RuntimeSessionHooks,
  TurnResult,
} from "../src/runtime-session.js";

/**
 * A scripted `RuntimeSession`: each `sendTurn` shifts the next scripted `TurnResult` (default a
 * plain ok turn), `summariseTurn` returns a fixed sentence, and `cost()`/`sessionId` surface fixed
 * values. It records every turn text, the summarise-call count, and `dispose()`.
 */
class FakeRuntimeSession implements RuntimeSession {
  readonly sessionId?: string;
  turns: string[] = [];
  summariseCalls = 0;
  disposed = false;
  private readonly queue: TurnResult[];
  private readonly summaryText: string;
  private readonly costValue: number | undefined;
  constructor(opts: { results?: TurnResult[]; summary?: string; cost?: number; sessionId?: string } = {}) {
    this.queue = [...(opts.results ?? [])];
    this.summaryText = opts.summary ?? "(fake summary)";
    this.costValue = opts.cost;
    this.sessionId = opts.sessionId;
  }
  async sendTurn(text: string): Promise<TurnResult> {
    this.turns.push(text);
    return this.queue.shift() ?? { stageComplete: false, status: "ok" };
  }
  async summariseTurn(): Promise<string> {
    this.summariseCalls++;
    return this.summaryText;
  }
  cost(): number | undefined {
    return this.costValue;
  }
  dispose(): void {
    this.disposed = true;
  }
}

/** A `RuntimeSession` whose `sendTurn` throws, to drive the loop's runtime-error boundary. */
class ThrowingRuntimeSession implements RuntimeSession {
  readonly sessionId = "throw-sess";
  constructor(private readonly message: string) {}
  async sendTurn(): Promise<TurnResult> {
    throw new Error(this.message);
  }
  async summariseTurn(): Promise<string> {
    return "(unused)";
  }
  cost(): number | undefined {
    return undefined;
  }
  dispose(): void {}
}

const ctx = (over: Partial<RunnerContext> = {}): RunnerContext => ({
  config: { runtime: "pi", interaction: "interactive" } as RunnerContext["config"],
  workspace: { worktreePath: "/tmp/wt", branch: "main" } as RunnerContext["workspace"],
  issueContext: "Fix the failing tests.",
  ...over,
});

/** An interactive ctx with tiny idle windows so the timeout path settles fast. */
const fastCtx = (over: Partial<RunnerContext> = {}): RunnerContext =>
  ctx({
    config: { runtime: "pi", interaction: "interactive", firstReplyMs: 20, idleMs: 20 } as RunnerContext["config"],
    ...over,
  });

const makeHooks = (events: EmittableEvent[] = []): RuntimeSessionHooks => ({
  emit: (e) => events.push(e),
  ask: async () => "No response from the user; proceed with your best judgement.",
});

/**
 * Drive the interactive loop against a pre-built fake session. The loop now owns session construction:
 * it assembles the router-backed hooks and calls a factory to build the session, so the test supplies
 * an `emit` sink and a factory that returns the fake. `ask` is assembled by the loop, not the test.
 */
const runInteractive = (
  session: RuntimeSession,
  c: RunnerContext,
  turns: AsyncIterable<HumanTurn>,
  value: Parameters<typeof runInteractiveLoop>[4],
  events: EmittableEvent[] = [],
): Promise<Awaited<ReturnType<typeof runInteractiveLoop>>> =>
  runInteractiveLoop(c, turns, (e) => events.push(e), () => session, value);

const opts = (over: Partial<Parameters<typeof runInteractiveLoop>[4]> = {}) => {
  const controller = new AbortController();
  return {
    controller,
    value: {
      signal: controller.signal,
      cancelled: () => false,
      cancel: async () => {},
      instructionInSystemPrompt: false,
      ...over,
    } as Parameters<typeof runInteractiveLoop>[4],
  };
};

/** An async iterable that never yields and never ends: models "no human is watching yet". */
const neverTurns = (): AsyncIterable<HumanTurn> => new ManagedMailbox<HumanTurn>();

const emptyTurns = (): AsyncIterable<HumanTurn> => ({
  // eslint-disable-next-line require-yield
  async *[Symbol.asyncIterator]() {
    return;
  },
});

test("interactive tool-exit: the opening turn's stage-complete ends the stage with its summary, no summarise turn", async () => {
  const session = new FakeRuntimeSession({
    results: [{ stageComplete: true, summary: "Refactored the parser.", status: "ok" }],
  });
  const { value } = opts();
  const result = await runInteractive(session, ctx(), neverTurns(), value);

  assert.equal(result.status, "ok");
  assert.equal(result.summary, "Refactored the parser.");
  assert.equal(session.summariseCalls, 0, "a tool exit needs no engine summarise turn");
  assert.equal(session.turns.length, 1, "only the self-seeded opening turn ran");
});

test("interactive self-seed: the opening sendTurn fires from the resolved prompt before any human turn", async () => {
  const session = new FakeRuntimeSession();
  const { value } = opts();
  await runInteractive(session, ctx(), emptyTurns(), value);

  assert.match(session.turns[0] ?? "", /Fix the failing tests\./, "the seed folds in the ticket brief");
});

test("interactive gate: turns exhausted calls summariseTurn once and returns its text", async () => {
  const session = new FakeRuntimeSession({ summary: "Explained the fix; tests pass." });
  const { value } = opts();
  const result = await runInteractive(session, ctx(), emptyTurns(), value);

  assert.equal(result.status, "ok");
  assert.equal(result.summary, "Explained the fix; tests pass.");
  assert.equal(session.summariseCalls, 1);
});

test("interactive timeout: no reply within the idle window settles timeout and invokes cancel", async () => {
  const session = new FakeRuntimeSession();
  let cancelCalls = 0;
  const { value } = opts({ cancel: async () => void cancelCalls++ });
  const result = await runInteractive(session, fastCtx(), neverTurns(), value);

  assert.equal(result.status, "timeout");
  assert.equal(result.summary, "(stage timed out awaiting input)");
  assert.equal(cancelCalls, 1, "the timeout path cancels the runner");
  assert.equal(session.summariseCalls, 0);
});

test("interactive cancel: an aborted signal settles fail with the cancelled summary, no summarise turn", async () => {
  const session = new FakeRuntimeSession();
  const { controller, value } = opts();
  controller.abort(); // pre-abort: the first race after the seed sees the cancel
  const result = await runInteractive(session, ctx(), neverTurns(), value);

  assert.equal(result.status, "fail");
  assert.equal(result.summary, "(stage cancelled)");
  assert.equal(session.summariseCalls, 0);
});

test("interactive coalesce: a burst of rapid turns within COALESCE_MS collapses into one sendTurn", async () => {
  const session = new FakeRuntimeSession();
  const turns = new ManagedMailbox<HumanTurn>();
  turns.push({ text: "a", ts: "t" });
  turns.push({ text: "b", ts: "t" });
  turns.end();
  const { value } = opts();
  await runInteractive(session, ctx(), turns, value);

  assert.equal(session.turns[1], "a\nb", "the burst is joined into a single prompt after the seed");
  assert.equal(session.turns.length, 2, "seed + one coalesced human turn");
  assert.equal(session.summariseCalls, 1, "turns then exhaust -> gate summarise");
});

test("interactive: cost() and sessionId are surfaced onto the result", async () => {
  const session = new FakeRuntimeSession({ cost: 0.19, sessionId: "pi-sess-1" });
  const { value } = opts();
  const result = await runInteractive(session, ctx(), emptyTurns(), value);

  assert.equal(result.costUsd, 0.19);
  assert.equal(result.sessionId, "pi-sess-1");
});

test("interactive: an unpriced session omits costUsd entirely (never a fabricated $0)", async () => {
  const session = new FakeRuntimeSession(); // cost undefined
  const { value } = opts();
  const result = await runInteractive(session, ctx(), emptyTurns(), value);

  assert.equal(result.costUsd, undefined);
  assert.ok(!("costUsd" in result));
});

test("interactive elicit routing: a session that calls hooks.ask mid-turn reaches the router-backed ask handed in at construction", async () => {
  // Proves the loop assembles the router-backed `ask` and hands it to the session via the factory - the
  // seam that used to be a mutated `hooks.ask` field read lazily by the adapters. The fake raises an
  // elicitation on its opening turn; the queued human turn settles it through the shared router.
  const turns = new ManagedMailbox<HumanTurn>();
  const events: EmittableEvent[] = [];
  let captured: RuntimeSessionHooks | undefined;
  let askReply: string | undefined;
  const session: RuntimeSession = {
    async sendTurn(): Promise<TurnResult> {
      if (askReply === undefined) {
        const pending = captured!.ask({
          prompt: "Pick one",
          options: [{ label: "A" }, { label: "B" }],
        } as ElicitQuestion);
        // `ask` registers with the router synchronously, so a turn pushed now settles it as the reply.
        turns.push({ text: "B", ts: "t" });
        turns.end();
        askReply = await pending;
      }
      return { stageComplete: false, status: "ok" };
    },
    async summariseTurn(): Promise<string> {
      return "(fake summary)";
    },
    cost: () => undefined,
    dispose: () => {},
  };
  const { value } = opts();
  const result = await runInteractiveLoop(
    ctx(),
    turns,
    (e) => events.push(e),
    (hooks) => {
      captured = hooks;
      return session;
    },
    value,
  );

  assert.equal(askReply, "The user selected: B", "the reply routes through the shared elicit router");
  assert.equal(result.status, "ok");
  const elicit = events.find((e) => e.type === "elicitation");
  assert.ok(elicit && elicit.type === "elicitation", "the raised question emitted an elicitation trace event");
  assert.equal(elicit.prompt, "Pick one");
});

test("batch: one sendTurn settles ok and surfaces cost + sessionId", async () => {
  const session = new FakeRuntimeSession({ results: [{ stageComplete: false, status: "ok" }], cost: 0.04, sessionId: "b1" });
  const result = await runBatchLoop(session, ctx(), makeHooks(), { cancelled: () => false });

  assert.equal(result.status, "ok");
  assert.equal(result.costUsd, 0.04);
  assert.equal(result.sessionId, "b1");
  assert.match(session.turns[0] ?? "", /Fix the failing tests\./, "batch sends the resolved stage prompt");
});

test("batch: a thrown sendTurn emits runtime_error and settles fail", async () => {
  const events: EmittableEvent[] = [];
  const session = new ThrowingRuntimeSession("network timeout");
  const result = await runBatchLoop(session, ctx(), makeHooks(events), { cancelled: () => false });

  assert.equal(result.status, "fail");
  const err = events.find((e) => e.type === "error");
  assert.ok(err && err.type === "error");
  assert.equal(err.kind, "runtime_error");
  assert.equal(err.message, "network timeout");
});

test("batch: a cancelled runner settles fail and suppresses the runtime_error emit", async () => {
  const events: EmittableEvent[] = [];
  const session = new ThrowingRuntimeSession("late abort");
  const result = await runBatchLoop(session, ctx(), makeHooks(events), { cancelled: () => true });

  assert.equal(result.status, "fail");
  assert.ok(!events.some((e) => e.type === "error"), "a cancel-driven throw is not reported as a runtime error");
});

test("batch: an upstream API transient throw settles fail with failureClass external and a truthful summary (DHK-569)", async () => {
  const events: EmittableEvent[] = [];
  const session = new ThrowingRuntimeSession("API Error: Stream idle timeout - partial response received");
  const result = await runBatchLoop(session, ctx(), makeHooks(events), { cancelled: () => false });

  assert.equal(result.status, "fail");
  assert.equal(result.failureClass, "external", "an upstream transient is attributed external, not agent");
  assert.match(result.summary ?? "", /stream idle timeout/i, "the summary names the transient rather than a bare fail");
  const err = events.find((e) => e.type === "error");
  assert.ok(err && err.type === "error" && err.kind === "runtime_error", "the runtime_error is still emitted");
});

test("batch: a genuine agent-task failure stays unclassified so the engine still bills it agent (DHK-569)", async () => {
  // A non-transient throw: nothing about the upstream API, so the adapter must NOT claim external.
  const throwResult = await runBatchLoop(
    new ThrowingRuntimeSession("assertion failed: expected 3 tests to pass"),
    ctx(),
    makeHooks(),
    { cancelled: () => false },
  );
  assert.equal(throwResult.status, "fail");
  assert.equal(throwResult.failureClass, undefined, "a genuine task failure carries no failureClass");
  assert.equal(throwResult.summary, undefined, "no synthetic transient summary is attached");

  // A plain `status: fail` turn (no throw at all) is likewise the agent's own verdict.
  const session = new FakeRuntimeSession({ results: [{ stageComplete: false, status: "fail" }] });
  const failResult = await runBatchLoop(session, ctx(), makeHooks(), { cancelled: () => false });
  assert.equal(failResult.status, "fail");
  assert.equal(failResult.failureClass, undefined, "a plain fail turn stays unclassified");
});

test("batch: a cancel-driven transient throw is NOT attributed external (DHK-569)", async () => {
  // When the harness watchdog cancels the runner, sendTurn throws mid-stream. That throw is not an
  // upstream transient we should own here - the stage-runner owns the watchdog attribution - so the
  // loop leaves failureClass unset under `cancelled`.
  const session = new ThrowingRuntimeSession("API Error: Stream idle timeout - partial response received");
  const result = await runBatchLoop(session, ctx(), makeHooks(), { cancelled: () => true });
  assert.equal(result.status, "fail");
  assert.equal(result.failureClass, undefined, "a cancel-driven throw is never classified by the loop");
});

test("classifyRuntimeError recognises the upstream-transient vocabulary and nothing else (DHK-569)", () => {
  for (const transient of [
    "API Error: Stream idle timeout - partial response received",
    "Overloaded",
    "529 overloaded_error",
    "429 Too Many Requests: rate limit exceeded",
    "504 Gateway Timeout",
    "500 Internal Server Error",
    "502 Bad Gateway",
    "503 Service Unavailable",
    "read ECONNRESET",
    "socket hang up",
  ]) {
    assert.equal(classifyRuntimeError(transient), "external", `\`${transient}\` should class external`);
  }
  for (const agentSide of [
    "assertion failed: expected 3 tests to pass",
    "TypeError: cannot read property 'x' of undefined",
    "the plan did not compile",
    "",
  ]) {
    assert.equal(classifyRuntimeError(agentSide), undefined, `\`${agentSide}\` should stay unclassified`);
  }
});

test("batch: a refused credential settles fail with failureClass config and names the credential", async () => {
  // Verbatim from run-057ae9a4 (DHK-998): the Agent SDK throws this when the ambient OAuth login has
  // been revoked. The stage never ran a turn and cost $0, yet it was billed to the agent.
  const events: EmittableEvent[] = [];
  const session = new ThrowingRuntimeSession(
    "Claude Code returned an error result: Failed to authenticate. API Error: 401 OAuth access token has been revoked.",
  );
  const result = await runBatchLoop(session, ctx(), makeHooks(events), { cancelled: () => false });

  assert.equal(result.status, "fail");
  assert.equal(result.failureClass, "config", "a refused credential is the operator's to fix, never the agent's");
  assert.match(result.summary ?? "", /refused the credential/i, "the summary says the credential was refused");
  assert.match(result.summary ?? "", /revoked/i, "and carries the provider's own words");
  const err = events.find((e) => e.type === "error");
  assert.ok(err && err.type === "error" && err.kind === "runtime_error", "the runtime_error is still emitted");
});

test("classifyRuntimeError separates a refused credential from a transient", () => {
  for (const refused of [
    // Both verbatim from 2026-07-30: the claude-code ambient login, and the Pi platform tenant's
    // console spend cap. Neither is a Dahrk defect and neither is the agent's doing.
    "Claude Code returned an error result: Failed to authenticate. API Error: 401 OAuth access token has been revoked.",
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-08-01 at 00:00 UTC."}}',
    "authentication_failed",
    "401 Unauthorized",
    "403 Forbidden",
    "invalid api key",
    "Your credit balance is too low to access the API",
    // Verbatim from the preflight runs of 2026-08-04: the pool was bound to a Copilot, then an OpenAI
    // subscription, and `claude-code` cannot authenticate with either. The vendor is healthy and the
    // credential is valid - only the operator can re-point the pool. The edge's OUTER job catch now
    // asks this too, because `runtimeAuthEnv` throws before the loop is ever entered and the answer
    // was being thrown away: the hub then read "Anthropic" in the message and billed an outage.
    "no Anthropic credential in the brokered auth profile: claude-code cannot authenticate with a openai-codex subscription.",
  ]) {
    assert.equal(classifyRuntimeError(refused), "config", `\`${refused}\` should class config`);
  }
  // A 429 is the provider THROTTLING a working credential, not refusing it: it must stay a
  // retryable transient, so the transient family has to be tested first.
  assert.equal(
    classifyRuntimeError("429 Too Many Requests: rate limit exceeded"),
    "external",
    "throttling a valid credential stays external",
  );
});

// --- the refused-credential summary shape ----------------------------------------------------------
//
// Link 1 of the refused-credential chain (DHK-998). The edge's latch decides a runtime is dead by
// matching this summary's PREFIX, so the shape is a cross-package seam, not prose. Pinned here at the
// source: reword `RUNTIME_ERROR_SUMMARY.config` or narrow `classifyRuntimeError` and this reddens in
// the package that caused it, rather than silently switching the latch off two packages away.

test("batch: a refused credential settles fail with a summary the edge's latch can recognise (DHK-998)", async () => {
  const events: EmittableEvent[] = [];
  const session = new ThrowingRuntimeSession("401 OAuth access token has been revoked");
  const result = await runBatchLoop(session, ctx(), makeHooks(events), { cancelled: () => false });

  assert.equal(result.status, "fail");
  assert.equal(result.failureClass, "config", "a refused credential is not the agent's fault");
  assert.ok(
    result.summary?.startsWith(REFUSED_CREDENTIAL_SUMMARY),
    `the summary must START with the exported prefix so the latch's startsWith matches: got ${result.summary}`,
  );
  assert.match(result.summary ?? "", /revoked/i, "and still carries the provider's own words");
});

test("batch: the refusal prefix is a prefix, not a substring, for every refusal vocabulary (DHK-998)", async () => {
  // The latch uses startsWith. A classifier that produced "stage failed: provider refused..." would
  // satisfy a substring check and silently never latch.
  for (const message of ["401 OAuth access token has been revoked", "credit balance is too low", "billing hard limit reached"]) {
    const result = await runBatchLoop(new ThrowingRuntimeSession(message), ctx(), makeHooks(), {
      cancelled: () => false,
    });
    assert.equal(result.failureClass, "config", `classified: ${message}`);
    assert.equal(
      result.summary?.indexOf(REFUSED_CREDENTIAL_SUMMARY),
      0,
      `the prefix must be at index 0 for: ${message}`,
    );
  }
});

test("interactive: a refused credential settles fail with the prefix, so the latch latches (DHK-1018)", async () => {
  // The interactive loop used to catch the throw, set `exited = "gate"` and leave `status` at its
  // initialised "ok", never calling `classifyRuntimeError`. Fed to the edge's credential latch, "ok" is
  // the ACCEPTANCE branch - so a refused credential CLEARED a standing refusal and put the runtime back
  // on the air, the DHK-1002 failure running backwards.
  const events: EmittableEvent[] = [];
  const { value } = opts();
  const session = new ThrowingRuntimeSession("401 OAuth access token has been revoked");
  const result = await runInteractive(session, fastCtx(), emptyTurns(), value, events);

  assert.ok(
    events.some((e) => e.type === "error" && e.kind === "runtime_error"),
    "the throw is still reported in the trace",
  );
  assert.equal(result.status, "fail", "a refused credential is not a successful stage");
  assert.equal(result.failureClass, "config", "and is not the agent's fault");
  assert.ok(
    result.summary.startsWith(REFUSED_CREDENTIAL_SUMMARY),
    `the summary must carry the prefix the edge latch matches: got ${result.summary}`,
  );
});

test("interactive: a refused credential is never asked to summarise on the dead session (DHK-1018)", async () => {
  // The gate branch runs the engine-owned summarisation turn on the warm session. After a refusal that
  // session cannot authenticate, so summarising either throws again or bills a second refused call to
  // produce a recap of nothing. A classified failure must settle before that branch.
  let summariseCalls = 0;
  class RefusingThenCountingSession extends ThrowingRuntimeSession {
    override async summariseTurn(): Promise<string> {
      summariseCalls++;
      return "(should never be reached)";
    }
  }
  const { value } = opts();
  const result = await runInteractive(
    new RefusingThenCountingSession("credit balance is too low"),
    fastCtx(),
    emptyTurns(),
    value,
  );

  assert.equal(result.status, "fail");
  assert.equal(summariseCalls, 0, "no summarisation turn is attempted on a session that cannot authenticate");
});

test("interactive: an UNCLASSIFIED throw keeps its gate-exit recap (DHK-1018 scope line)", async () => {
  // Deliberately unchanged. A genuine agent-task failure mid-conversation is the agent's own verdict,
  // and its recap is worth having; only failures the agent is not answerable for settle `fail` here.
  // Note this leaves an interactive throw reporting `ok` where the batch loop would report `fail` - a
  // known asymmetry, called out in the ticket rather than fixed under a credential-latch change.
  const { value } = opts();
  const result = await runInteractive(
    new ThrowingRuntimeSession("assertion failed: expected 3 tests to pass"),
    fastCtx(),
    emptyTurns(),
    value,
  );

  assert.equal(result.status, "ok", "unchanged: an unclassified throw still exits via the gate branch");
  assert.equal(result.failureClass, undefined, "and carries no attribution");
});

test("interactive: a cancel-driven throw is never classified as a runtime failure (DHK-1018)", async () => {
  // Mirrors the batch loop's guard: a throw caused by our own abort must not be reported as the
  // provider refusing anything, or cancelling a stage would de-advertise a healthy runtime.
  const { controller, value } = opts();
  controller.abort();
  const cancelledOpts = { ...value, cancelled: () => true };
  const result = await runInteractive(
    new ThrowingRuntimeSession("401 OAuth access token has been revoked"),
    fastCtx(),
    emptyTurns(),
    cancelledOpts as typeof value,
  );

  assert.equal(result.failureClass, undefined, "a cancel-driven throw carries no failure class");
  assert.ok(!result.summary.startsWith(REFUSED_CREDENTIAL_SUMMARY), "and no refusal prefix");
});
