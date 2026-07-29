// Fixture: a fake `pi --mode rpc` process. Reads LF-framed JSON commands on stdin and emits
// scripted JSONL responses + agent events on stdout, matching the Pi coding-agent JSONL RPC
// protocol. Every received command is echoed to
// stderr (a side channel the RPC client does not read) so the test can assert what was sent.
//
// A `prompt` scripts a text turn that also exercises a tool call and embeds a literal U+2028
// inside an assistant text delta, proving the subprocess path does not corrupt records whose
// JSON strings contain Unicode line separators (the Node `readline` pitfall rpc.md warns about).
import { StringDecoder } from "node:string_decoder";

const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

// DHK-981: the container-side Pi drives the pre-execution tool gate and structured elicitation as
// SUBPROCESS-initiated requests over the same stdio the host reads. This fixture models those two
// flows when asked to (keyed off env so the existing one-directional tests are untouched):
//   - FAKE_PI_GATE=1   -> a `tool_call_request` for a `write` before running it; on a `block` verdict
//                         the tool does NOT run and the reason is surfaced into the turn.
//   - FAKE_PI_ELICIT=1 -> an `elicit_request` carrying a structured question; the host's pick is
//                         embedded into the turn as an observable text delta.
const GATE = process.env.FAKE_PI_GATE === "1";
const ELICIT = process.env.FAKE_PI_ELICIT === "1";

// Outstanding subprocess-initiated requests awaiting the host's `*_response`, keyed by the id we
// assign. The stdin reader resolves them as the matching response frame arrives.
const pending = new Map();
let reqSeq = 0;
function request(type, fields) {
  const id = `sub-${++reqSeq}`;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    write({ type, id, ...fields });
  });
}

// The gate/elicit flows fire only on the FIRST prompt (the working turn); a follow-up prompt (e.g. the
// interactive loop's engine-owned summarise turn) is a plain turn, so it never re-raises a question
// after the human-turn stream has ended.
let served = false;

async function runPrompt(id) {
  const doExtras = !served;
  served = true;
  write({ type: "response", command: "prompt", ...(id ? { id } : {}), success: true });
  // Scripted text turn: reasoning -> (gate) -> one tool call + result -> (elicit) -> final response.
  write({ type: "agent_start" });
  write({ type: "turn_start" });
  write({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Planning via RPC." } });
  // Pre-execution tool gate over RPC: ask the host to vet a `write` before running it. On a `block`
  // verdict the tool does NOT run (no tool_execution_* events, so no action/observation reaches the
  // turn) - exactly as embedded Pi's gate hook stops a denied tool before its `execute`. The agent-
  // visible reason rides back in the tool_call_response (asserted at the client seam).
  if (GATE && doExtras) {
    const verdict = await request("tool_call_request", { toolName: "write", input: { path: "/etc/passwd", content: "x" } });
    if (!verdict.block) {
      write({ type: "tool_execution_start", toolName: "write", toolCallId: "w1", args: { path: "/etc/passwd" } });
      write({ type: "tool_execution_end", toolCallId: "w1", content: "written", isError: false });
    }
  }
  write({ type: "tool_execution_start", toolName: "bash", toolCallId: "c1", args: { command: "ls" } });
  write({ type: "tool_execution_end", toolCallId: "c1", content: "ok", isError: false });
  // Structured elicitation over RPC: ask the host a question and embed the human's pick into the turn.
  if (ELICIT && doExtras) {
    const answer = await request("elicit_request", {
      questions: [
        {
          question: "Which approach?",
          options: [{ label: "Option A", description: "the safe one" }, { label: "Option B", description: "the fast one" }],
          multiSelect: true,
        },
      ],
    });
    write({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `Picked: ${answer.text}` } });
  }
  // A literal U+2028 inside the delta (JSON.stringify leaves it unescaped).
      write({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Done via RPC. tail" } });
  write({ type: "turn_end", message: { stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
  write({ type: "agent_end", messages: [{ stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }] });
}

function onLine(line) {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    write({ type: "response", command: "parse", success: false, error: "bad json" });
    return;
  }
  // Echo the raw command to stderr for the test to inspect.
  process.stderr.write(JSON.stringify(cmd) + "\n");
  // Host replies to our subprocess-initiated requests (DHK-981): resolve the awaiting flow.
  if (cmd.type === "tool_call_response" || cmd.type === "elicit_response") {
    const resolve = pending.get(cmd.id);
    if (resolve) {
      pending.delete(cmd.id);
      resolve(cmd);
    }
    return;
  }
  const id = cmd.id;
  switch (cmd.type) {
    case "get_state":
      write({ type: "response", command: "get_state", ...(id ? { id } : {}), success: true, data: { sessionId: "pi-rpc-sess-1", isStreaming: false } });
      return;
    case "abort":
      write({ type: "response", command: "abort", ...(id ? { id } : {}), success: true });
      return;
    case "prompt":
      void runPrompt(id);
      return;
    default:
      write({ type: "response", command: cmd.type ?? "unknown", ...(id ? { id } : {}), success: false, error: "unsupported" });
  }
}

// Strict LF-only JSONL reader (mirrors the client): split on \n, strip a trailing \r.
const decoder = new StringDecoder("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  for (;;) {
    const nl = buffer.indexOf("\n");
    if (nl === -1) break;
    let line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length > 0) onLine(line);
  }
});
process.stdin.on("end", () => process.exit(0));
