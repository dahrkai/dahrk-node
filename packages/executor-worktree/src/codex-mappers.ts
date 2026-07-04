/**
 * Pure Codex SDK thread-event -> normalised trace envelope mapping. Ported verbatim from
 * the S3 spike (spikes/s3-trace-mapping/src/codex-adapter.ts). It maps Codex thread events
 * DIRECTLY onto the SAME envelope the Claude mapper produces, so a cross-runtime reader
 * (a later stage, an on_fail re-run, the optimiser) never sees a runtime-specific shape.
 *
 * Item coverage matches cyrus's (reasoning / agent_message / command_execution /
 * mcp_tool_call / file_change / web_search / error). Pure: no SDK calls, no I/O.
 */
import type { ThreadEvent, ThreadItem } from "@openai/codex-sdk";
import type { TraceMeta } from "@dahrk/contracts";
import type { EmittableEvent } from "./runner-shared.js";

export interface MapResult {
  events: EmittableEvent[];
  recognised: boolean;
}

function mapItem(item: ThreadItem): EmittableEvent[] {
  switch (item.type) {
    case "reasoning":
      return [{ type: "thought", subtype: "reasoning_text", text: item.text }];
    case "agent_message":
      return [{ type: "response", text: item.text }];
    case "command_execution":
      return [
        { type: "action", tool: "command", toolUseId: item.id, input: { command: item.command } },
        { type: "observation", toolUseId: item.id, output: item.aggregated_output, isError: item.status === "failed" },
      ];
    case "mcp_tool_call":
      return [
        { type: "action", tool: `${item.server}/${item.tool}`, toolUseId: item.id, input: item.arguments },
        { type: "observation", toolUseId: item.id, output: item.result?.content ?? item.error, isError: Boolean(item.error) },
      ];
    case "web_search":
      return [{ type: "action", tool: "web_search", toolUseId: item.id, input: { query: item.query } }];
    case "file_change":
      return [{ type: "action", tool: "apply_patch", toolUseId: item.id, input: item.changes }];
    case "todo_list":
      return [{ type: "thought", text: JSON.stringify(item.items) }];
    case "error":
      return [{ type: "error", kind: "item_error", message: item.message }];
    default:
      return [];
  }
}

/** Pure: one Codex thread event -> zero or more normalised trace events. */
export function mapCodexEvent(ev: ThreadEvent): MapResult {
  switch (ev.type) {
    case "item.completed":
      return { events: mapItem(ev.item), recognised: true };
    case "turn.completed":
      return {
        events: [
          { type: "state", event: "stage-exit", status: "ok", usage: mapUsage(ev.usage as Record<string, number> | null) },
        ],
        recognised: true,
      };
    case "turn.failed":
      return {
        events: [
          { type: "error", kind: "turn_failed", message: JSON.stringify(ev.error ?? {}) },
          { type: "state", event: "stage-exit", status: "fail" },
        ],
        recognised: true,
      };
    case "error":
      return { events: [{ type: "error", kind: "thread_error", message: ev.message }], recognised: true };
    // Lifecycle / interim updates: recognised, captured in raw sidecar, not normalised.
    case "thread.started":
    case "turn.started":
    case "item.started":
    case "item.updated":
      return { events: [], recognised: true };
    default:
      return { events: [], recognised: false };
  }
}

export function mapUsage(u: Record<string, number> | null): TraceMeta["usage"] {
  return {
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    cacheRead: u?.cached_input_tokens ?? 0,
    cacheCreate: 0,
  };
}
