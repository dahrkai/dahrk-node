/**
 * The Pi RPC client: the second `PiSessionFactory` back-end for the Pi adapter.
 *
 * `PiRpcSession` drives a `pi --mode rpc` process (JSON-RPC over the process stdio) as a
 * `PiSessionLike`, so the T6 adapter's `runBatch`/`runInteractive`/`summarise`/`cancel`
 * orchestration runs unchanged against a containerised Pi. It takes an already-spawned child
 * (stdin writable + stdout readable) rather than spawning one, so this unit is testable against a
 * fixture subprocess and the container factory (Task 4) can hand it a `docker run -i` child.
 *
 * Protocol facts that shape this client (Pi coding-agent JSONL RPC):
 *   - Framing is strict LF-only JSONL. Split on `\n` only, strip a trailing `\r`. Node `readline`
 *     is NOT compliant (it also splits on U+2028/U+2029, valid inside JSON strings), so we use a
 *     byte-buffer decoder (`createLineDecoder`) instead.
 *   - `prompt` acks immediately (`{type:"response",command:"prompt",success:true}` means accepted,
 *     not done); the run finishes later at the `agent_end` event. The embedded `session.prompt()`
 *     resolves when the agent run finishes, so the RPC `prompt()` resolves on `agent_end` too:
 *     the event is delivered to subscribers FIRST (settling the mapper buffer), then the pending
 *     `prompt()` promise resolves.
 *   - Events on stdout match the mapper's `PiEvent` shape. Each parsed line is validated at the wire
 *     boundary by `parsePiEvent` (the stdout is untrusted subprocess output) and forwarded to
 *     subscribers with no re-mapping; the adapter maps them via `consumePiEvent`.
 *   - `abort` -> `{type:"abort"}` resolves on its command ack; `get_state` returns
 *     `data.sessionId`, a best-effort resume token.
 *
 * Bidirectional for the gate + elicitation (DHK-981): the protocol is otherwise one-directional
 * (events out, commands in), but the pre-execution tool gate (DHK-504) and structured elicitation
 * (DHK-505) both need the SUBPROCESS to ask the host and block on the answer. So two inbound request
 * frames are handled in `#onLine`, each answered with a matching `*_response` frame written back to
 * the child's stdin, routed through the SAME edge policy / elicit machinery the embedded path uses:
 *   - `{type:"tool_call_request", id, toolName, input}` -> the containerised Pi's pre-execution hook
 *     vetting a tool call. Answered `{type:"tool_call_response", id, block, reason?}`. No gate
 *     registered -> `block:false` (allow), matching embedded "no gate = the tool runs".
 *   - `{type:"elicit_request", id, questions}` -> the containerised `ask_user_question` tool raising a
 *     structured question. Answered `{type:"elicit_response", id, text}` with the human's pick (or the
 *     shared no-reply soft note when no handler is registered / the handler throws). These requests use
 *     the subprocess's own id space and never touch `#pendingResponses` (those are host-initiated).
 *
 * Cost (DHK-982): `getSessionStats()` surfaces the aggregate dollar figure Pi priced the session at,
 * queried over RPC (`get_session_stats`) once each `prompt()` run finishes and cached in `#lastCost`,
 * so the adapter's `cost()` reads a current value synchronously at the loop's terminus and the hub's
 * `cost_budget` acts on a real figure. A missing figure stays `undefined`, never a fabricated `0`
 * (DHK-434). Model selection is not this class's concern: the container factory resolves the stage's
 * model provider-aware (`resolveStageModelId`) and passes it as `--model <id>` on the container command,
 * failing loudly before this session is ever constructed rather than substituting silently.
 *
 * Still unsupported on the container path (DHK-982): brokered MCP. The embedded path's extension bridge
 * (`createBrokeredMcpExtension`) assumes an in-process Pi session it can register tools onto; there is no
 * in-process session here, and threading the gateway over RPC is a larger piece of work. A stage that
 * declares brokered MCP servers gets none of them inside the container - a deliberate gap, no longer a
 * silent one: the class declares `capabilities.brokeredMcp = false` (DHK-968), so the runner emits a
 * `capability-degraded` trace event when a stage needs it rather than dropping the servers unremarked.
 *
 * Degradation (Open Question 1): the RPC session has no `agent` handle, so `summarise`'s
 * tool-denial (which mutates `s.agent.state.tools`) is a no-op here. Accepted for the first cut
 * (meta-loop stages are telemetry-only); `agent` is intentionally omitted from this class, and the gap is
 * declared as `capabilities.summariseToolDenial = false` rather than left to be discovered at runtime.
 */
import { StringDecoder } from "node:string_decoder";
import { parsePiEvent, type PiEvent } from "./pi-mappers.js";
import { elicitOutcomeReply } from "./elicit-router.js";
import type { AskUserQuestions, PiSessionCapabilities, PiSessionLike } from "./pi-adapter.js";

/**
 * A strict LF-only JSONL splitter. `push` accepts a chunk (Buffer or string) and returns the
 * complete records it completes; `end` flushes any trailing record. Uses `StringDecoder` so a
 * multi-byte UTF-8 sequence split across chunks (e.g. the 3 bytes of U+2028) is buffered until
 * complete. Records are split on `\n` only; a trailing `\r` is stripped. This is the reader the
 * RPC docs mandate in place of Node `readline`.
 */
export function createLineDecoder(): {
  push(chunk: Buffer | string): string[];
  end(): string[];
} {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const drain = (): string[] => {
    const lines: string[] = [];
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl === -1) break;
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      lines.push(line);
    }
    return lines;
  };
  return {
    push(chunk) {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      return drain();
    },
    end() {
      buffer += decoder.end();
      const lines = drain();
      if (buffer.length > 0) {
        const last = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
        buffer = "";
        lines.push(last);
      }
      return lines;
    },
  };
}

/** The minimal child-process shape `PiRpcSession` drives: LF-framed JSON in, JSONL out. */
export interface PiRpcChild {
  readonly stdin: NodeJS.WritableStream | null;
  readonly stdout: NodeJS.ReadableStream | null;
}

export interface PiRpcSessionOptions {
  /**
   * Called exactly once on `dispose()` to tear down the underlying transport (e.g. `docker kill`).
   * `PiRpcSession` guarantees idempotency, so the callback need not guard against a second call.
   */
  kill?: () => void | Promise<void>;
}

/** A Pi RPC command response frame (`{type:"response", ...}`). */
interface PiRpcResponse {
  type: "response";
  command?: string;
  id?: string;
  success?: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(err: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const isResponse = (msg: unknown): msg is PiRpcResponse =>
  typeof msg === "object" && msg !== null && (msg as { type?: unknown }).type === "response";

/** A subprocess-initiated request to vet a tool call before it runs (DHK-981/DHK-504). */
interface PiToolCallRequest {
  type: "tool_call_request";
  id?: string;
  toolName: string;
  input: unknown;
}
/** A subprocess-initiated request to raise a structured question (DHK-981/DHK-505). */
interface PiElicitRequest {
  type: "elicit_request";
  id?: string;
  questions: AskUserQuestions;
}
const isToolCallRequest = (msg: unknown): msg is PiToolCallRequest =>
  typeof msg === "object" && msg !== null && (msg as { type?: unknown }).type === "tool_call_request";
const isElicitRequest = (msg: unknown): msg is PiElicitRequest =>
  typeof msg === "object" && msg !== null && (msg as { type?: unknown }).type === "elicit_request";

export class PiRpcSession implements PiSessionLike {
  /**
   * The container RPC back-end's declared capability surface (DHK-968). The gate, elicitation and cost
   * all land over RPC (DHK-981/982), so they are `true`; brokered MCP and the summarise turn's tool
   * denial do not (no in-process session to register tools onto, no `agent` handle), so they are `false`.
   * DECLARED rather than inferred from method presence, so the runner refuses (gate/elicit) or warns
   * (MCP) on a gap instead of the old silent `?.` no-op.
   */
  readonly capabilities: PiSessionCapabilities = {
    preExecutionGate: true,
    elicitation: true,
    cost: true,
    brokeredMcp: false,
    summariseToolDenial: false,
  };
  #sessionId: string | undefined;
  #listeners: Array<(ev: PiEvent) => void> = [];
  /** Command responses awaited by id (correlated via the optional `id` field). */
  #pendingResponses = new Map<string, Deferred<PiRpcResponse>>();
  /** The in-flight `prompt()` resolver, settled on the next `agent_end`. */
  #pendingAgentEnd: Deferred<void> | undefined;
  #reqCounter = 0;
  #disposed = false;
  /**
   * The last session cost queried over RPC, or `undefined` when the session has priced nothing (or a
   * stats query failed). Refreshed after each `prompt()` finishes and read synchronously by
   * `getSessionStats()` at the loop's terminus (DHK-982). Never coerced to `0`: a missing figure stays
   * `undefined` so the hub's `cost_budget` policy reads "not reported", not a fabricated `$0` (DHK-434).
   */
  #lastCost: number | undefined;
  readonly #child: PiRpcChild;
  #kill: (() => void | Promise<void>) | undefined;
  /** The adapter's pre-execution tool gate (DHK-504); consulted for each `tool_call_request`. */
  #toolCallGate: ((toolName: string, input: unknown) => { block?: boolean; reason?: string } | undefined) | undefined;
  /** The adapter's structured-question dispatcher (DHK-505); consulted for each `elicit_request`. */
  #askHandler: ((questions: AskUserQuestions) => Promise<string>) | undefined;

  constructor(child: PiRpcChild, options: PiRpcSessionOptions = {}) {
    this.#child = child;
    this.#kill = options.kill;
    const decoder = createLineDecoder();
    const onData = (chunk: Buffer | string): void => {
      for (const line of decoder.push(chunk)) if (line.length > 0) this.#onLine(line);
    };
    child.stdout?.on("data", onData);
    child.stdout?.on("end", () => {
      for (const line of decoder.end()) if (line.length > 0) this.#onLine(line);
    });
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  subscribe(listener: (ev: PiEvent) => void): () => void {
    this.#listeners.push(listener);
    return () => {
      this.#listeners = this.#listeners.filter((l) => l !== listener);
    };
  }

  /** Register the pre-execution tool gate (DHK-504); the adapter wires this to the edge policy. Once
   *  set, an inbound `tool_call_request` is answered by consulting it, so a container-isolated stage
   *  enforces policy before a tool runs, exactly as embedded Pi does. */
  setToolCallGate(gate: (toolName: string, input: unknown) => { block?: boolean; reason?: string } | undefined): void {
    this.#toolCallGate = gate;
  }

  /** Register the structured-question dispatcher (DHK-505); the adapter wires this to the shared elicit
   *  router. Once set, an inbound `elicit_request` is routed through it to a Linear elicitation and the
   *  human's pick is handed back to the containerised turn. */
  setAskUserQuestionHandler(handler: (questions: AskUserQuestions) => Promise<string>): void {
    this.#askHandler = handler;
  }

  async prompt(text: string): Promise<void> {
    if (this.#disposed) throw new Error("pi rpc session disposed");
    const agentEnd = deferred<void>();
    this.#pendingAgentEnd = agentEnd;
    const ack = await this.#send("prompt", { message: text });
    if (ack.success === false) {
      this.#pendingAgentEnd = undefined;
      throw new Error(ack.error ?? "prompt rejected");
    }
    await agentEnd.promise;
    // The run has finished, so its cost is now final: query it over RPC and cache it (DHK-982). This
    // completes BEFORE `prompt()` resolves, so the value is current when the loop reads `getSessionStats()`
    // synchronously at the terminus. A failed query leaves the last-known value untouched - never a 0.
    await this.#refreshCost();
  }

  /**
   * Refresh `#lastCost` from Pi's aggregate session stats over RPC (DHK-982), the container analogue of
   * the embedded `getSessionStats().cost`. Only a finite numeric `data.cost` updates the cache; anything
   * else (a session that cannot price the run, a disposed session, a failed query) leaves the previous
   * value in place, so a missing figure is reported as `undefined`, never a fabricated `0` (DHK-434).
   */
  async #refreshCost(): Promise<void> {
    if (this.#disposed) return;
    try {
      const res = await this.#send("get_session_stats", {});
      const cost = res.data?.cost;
      if (typeof cost === "number" && Number.isFinite(cost)) this.#lastCost = cost;
    } catch {
      /* best effort: a failed stats query leaves the last-known cost (or undefined) untouched */
    }
  }

  async abort(): Promise<void> {
    if (this.#disposed) return;
    await this.#send("abort", {});
  }

  /** Best-effort refresh of the resume token from `get_state`; swallows a failed lookup. */
  async getState(): Promise<void> {
    if (this.#disposed) return;
    try {
      const res = await this.#send("get_state", {});
      const id = res.data?.sessionId;
      if (typeof id === "string" && id) this.#sessionId = id;
    } catch {
      /* best effort: the resume token is optional */
    }
  }

  /**
   * The aggregate session cost, read synchronously by the adapter's `cost()` at the loop's terminus
   * (DHK-982). Returns `{ cost }` only when a finite figure was queried after a prompt; otherwise
   * `undefined`, so an unpriced container run reports no cost rather than a fabricated `0` (DHK-434) -
   * matching the embedded path's `getSessionStats()`.
   */
  getSessionStats(): { cost?: number } | undefined {
    return typeof this.#lastCost === "number" ? { cost: this.#lastCost } : undefined;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      this.#child.stdin?.end();
    } catch {
      /* stream may already be closed */
    }
    const err = new Error("pi rpc session disposed");
    for (const d of this.#pendingResponses.values()) d.reject(err);
    this.#pendingResponses.clear();
    if (this.#pendingAgentEnd) {
      this.#pendingAgentEnd.reject(err);
      this.#pendingAgentEnd = undefined;
    }
    if (this.#kill) {
      const kill = this.#kill;
      this.#kill = undefined;
      void kill();
    }
  }

  /** Write a command as one LF-terminated JSON line and await its correlated response. */
  #send(type: string, fields: Record<string, unknown>): Promise<PiRpcResponse> {
    const id = `req-${++this.#reqCounter}`;
    const d = deferred<PiRpcResponse>();
    this.#pendingResponses.set(id, d);
    try {
      this.#child.stdin?.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    } catch (e) {
      this.#pendingResponses.delete(id);
      d.reject(e as Error);
    }
    return d.promise;
  }

  /** Write a subprocess-request reply as one LF-terminated JSON line. Unlike `#send`, it allocates no
   *  pending-response entry (the id belongs to the subprocess's request, not a host-initiated command)
   *  and is a no-op once disposed, so a late reply cannot throw on a closed stream. */
  #reply(obj: Record<string, unknown>): void {
    if (this.#disposed) return;
    try {
      this.#child.stdin?.write(`${JSON.stringify(obj)}\n`);
    } catch {
      /* stream may already be closed */
    }
  }

  #onLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // ignore an unparseable line rather than crash the reader
    }
    if (isResponse(msg)) {
      const id = msg.id;
      if (typeof id === "string") {
        const pending = this.#pendingResponses.get(id);
        if (pending) {
          this.#pendingResponses.delete(id);
          pending.resolve(msg);
        }
      }
      return;
    }
    // Subprocess-initiated requests (DHK-981). Handled BEFORE `parsePiEvent` (they are not agent
    // events) and always answered - even with no gate/handler or after a dispose race - so the
    // containerised agent never blocks forever waiting on the host.
    if (isToolCallRequest(msg)) {
      const decision = this.#toolCallGate?.(msg.toolName, msg.input);
      this.#reply({
        type: "tool_call_response",
        id: msg.id,
        block: Boolean(decision?.block),
        ...(decision?.reason ? { reason: decision.reason } : {}),
      });
      return;
    }
    if (isElicitRequest(msg)) {
      const { id, questions } = msg;
      const handler = this.#askHandler;
      // Fire the handler and write the reply asynchronously so the synchronous reader loop is not
      // stalled: subsequent lines (and the elicit reply's own turn events) keep flowing. On any throw,
      // fall back to the shared no-reply soft note rather than leaving the container parked.
      void (async () => {
        let text: string;
        try {
          text = handler ? await handler(questions) : elicitOutcomeReply({ kind: "noreply" });
        } catch {
          text = elicitOutcomeReply({ kind: "noreply" });
        }
        this.#reply({ type: "elicit_response", id, text });
      })();
      return;
    }
    // Anything that is not a command response should be an agent event. Validate it at this boundary
    // (the wire is untrusted subprocess stdout) rather than casting straight to `PiEvent`: a `null`, a
    // primitive, or a malformed `message_update` would otherwise crash the mapper on first field access.
    const ev = parsePiEvent(msg);
    if (!ev) return; // not a command response and not a well-formed agent event: drop it
    for (const l of [...this.#listeners]) l(ev);
    // Deliver-then-resolve: the buffer settles on agent_end before the prompt promise resolves.
    if (ev.type === "agent_end" && this.#pendingAgentEnd) {
      const d = this.#pendingAgentEnd;
      this.#pendingAgentEnd = undefined;
      d.resolve();
    }
  }
}
