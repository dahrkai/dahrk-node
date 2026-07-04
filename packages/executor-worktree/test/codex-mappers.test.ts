/**
 * Codex trace-mapping tests. Recorded Codex thread events (no live calls, no credentials)
 * map onto the SAME normalised envelope the Claude adapter produces. We assert each item
 * type the mapper covers, that large outputs survive intact (spill is the writer's job), and
 * that every emitted event validates against the contract schema.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import type { ThreadEvent } from "@openai/codex-sdk";
import type { TraceEvent } from "@dahrk/contracts";
import { mapCodexEvent } from "../src/codex-mappers.js";
import { makeEmit } from "../src/runner-shared.js";

const here = dirname(fileURLToPath(import.meta.url));
const traceSchema = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.resolve("@dahrk/contracts"))), "..", "schemas", "trace.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(traceSchema);
const validateEvent = ajv.compile({ $ref: "https://skakel.io/schemas/trace.schema.json#/$defs/event" });

const ev = (x: unknown): ThreadEvent => x as ThreadEvent;

function drive(fixtures: ThreadEvent[]): TraceEvent[] {
  const events: TraceEvent[] = [];
  const emit = makeEmit("codex", (e) => events.push(e), () => "2026-06-21T00:00:00Z");
  for (const e of fixtures) {
    for (const mapped of mapCodexEvent(e).events) emit(mapped);
  }
  return events;
}

test("a Codex thread maps reasoning/command/agent_message/turn-completed onto the envelope", () => {
  const fixtures = [
    ev({ type: "thread.started", thread_id: "thr_1" }),
    ev({ type: "turn.started" }),
    ev({ type: "item.completed", item: { id: "r1", type: "reasoning", text: "Plan: run the tests, then report." } }),
    ev({ type: "item.completed", item: { id: "c1", type: "command_execution", command: "pnpm test", aggregated_output: "Y".repeat(12_000), exit_code: 1, status: "failed" } }),
    ev({ type: "item.completed", item: { id: "e1", type: "error", message: "a non-fatal item error" } }),
    ev({ type: "item.completed", item: { id: "a1", type: "agent_message", text: "Three tests fail; the fixture date is stale." } }),
    ev({ type: "turn.completed", usage: { input_tokens: 9001, output_tokens: 210, cached_input_tokens: 8000 } }),
  ];

  const events = drive(fixtures);
  // reasoning -> thought; command_execution -> action + observation; item error -> error;
  // agent_message -> response; turn.completed -> state stage-exit (ok).
  assert.deepEqual(events.map((e) => e.type), ["thought", "action", "observation", "error", "response", "state"]);

  const action = events[1] as Extract<TraceEvent, { type: "action" }>;
  assert.equal(action.tool, "command");
  assert.equal(action.toolUseId, "c1");

  const obs = events[2] as Extract<TraceEvent, { type: "observation" }>;
  assert.equal(obs.isError, true, "a failed command is a failed observation");
  assert.equal((obs.output as string).length, 12_000, "large output is carried intact (the writer spills it)");

  const state = events[5] as Extract<TraceEvent, { type: "state" }>;
  assert.equal(state.status, "ok");
  assert.deepEqual(state.usage, { input: 9001, output: 210, cacheRead: 8000, cacheCreate: 0 });

  for (const e of events) assert.ok(validateEvent(e), `schema: ${JSON.stringify(validateEvent.errors)}`);
});

test("mcp_tool_call, web_search, file_change and todo_list map to actions/thoughts", () => {
  const fixtures = [
    ev({ type: "item.completed", item: { id: "m1", type: "mcp_tool_call", server: "dahrk", tool: "do", arguments: { a: 1 }, result: { content: "ok" }, status: "completed" } }),
    ev({ type: "item.completed", item: { id: "w1", type: "web_search", query: "restate awakeable" } }),
    ev({ type: "item.completed", item: { id: "f1", type: "file_change", changes: [{ path: "a.ts" }], status: "completed" } }),
    ev({ type: "item.completed", item: { id: "td1", type: "todo_list", items: [{ text: "step", done: false }] } }),
  ];
  const events = drive(fixtures);
  assert.deepEqual(events.map((e) => e.type), ["action", "observation", "action", "action", "thought"]);
  assert.equal((events[0] as Extract<TraceEvent, { type: "action" }>).tool, "dahrk/do");
  assert.equal((events[2] as Extract<TraceEvent, { type: "action" }>).tool, "web_search");
  assert.equal((events[3] as Extract<TraceEvent, { type: "action" }>).tool, "apply_patch");
  for (const e of events) assert.ok(validateEvent(e), `schema: ${JSON.stringify(validateEvent.errors)}`);
});

test("a failed turn maps to an error plus a failed stage-exit; unknown events are unrecognised", () => {
  const events = drive([ev({ type: "turn.failed", error: { message: "boom" } })]);
  assert.deepEqual(events.map((e) => e.type), ["error", "state"]);
  assert.equal((events[1] as Extract<TraceEvent, { type: "state" }>).status, "fail");
  for (const e of events) assert.ok(validateEvent(e), `schema: ${JSON.stringify(validateEvent.errors)}`);

  assert.equal(mapCodexEvent(ev({ type: "item.updated", item: { id: "x", type: "reasoning", text: "" } })).recognised, true);
  assert.equal(mapCodexEvent(ev({ type: "some_future_event" })).recognised, false);
});
