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
  const id = cmd.id;
  switch (cmd.type) {
    case "get_state":
      write({ type: "response", command: "get_state", ...(id ? { id } : {}), success: true, data: { sessionId: "pi-rpc-sess-1", isStreaming: false } });
      return;
    case "abort":
      write({ type: "response", command: "abort", ...(id ? { id } : {}), success: true });
      return;
    case "prompt": {
      write({ type: "response", command: "prompt", ...(id ? { id } : {}), success: true });
      // Scripted text turn: reasoning -> one tool call + result -> final response.
      write({ type: "agent_start" });
      write({ type: "turn_start" });
      write({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Planning via RPC." } });
      write({ type: "tool_execution_start", toolName: "bash", toolCallId: "c1", args: { command: "ls" } });
      write({ type: "tool_execution_end", toolCallId: "c1", content: "ok", isError: false });
      // A literal U+2028 inside the delta (JSON.stringify leaves it unescaped).
      write({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Done via RPC. tail" } });
      write({ type: "turn_end", message: { stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
      write({ type: "agent_end", messages: [{ stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }] });
      return;
    }
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
