/**
 * Compile-time conformance guard for the hand-authored `PiEvent` union in `pi-mappers.ts`.
 *
 * `pi-adapter.ts` loads `@earendil-works/pi-coding-agent` by DYNAMIC import, so `tsc` never resolves
 * the SDK against the mapper and any drift in Pi's event shapes is invisible to the build. This module
 * is the explicit static assertion that closes that gap - the type-level analogue of
 * `test/pi-sdk-exports.test.ts`, which fails at runtime when the SDK drops a symbol the adapter
 * destructures. Here the failure is a `tsc` error (`pnpm typecheck` / `pnpm build`) the moment a Pi
 * bump:
 *   - adds an event `type` we do not classify, so we cannot silently drop a newly-traceable event, or
 *   - renames or removes a field the mapper dereferences on a mapped variant.
 *
 * `import type` only: no SDK value is imported, so this stays runtime-free and the mapper it guards
 * stays pure. The module has no runtime body - the assertions are the type aliases below, which `tsc`
 * evaluates and which fail to compile if an assertion is not exactly `true`.
 */
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { PiEvent } from "./pi-mappers.js";

/** Fails to compile unless `T` is exactly `true`. */
type Assert<T extends true> = T;

/** The SDK event variant selected by its `type` discriminant. */
type SdkEvent<T extends AgentSessionEvent["type"]> = Extract<AgentSessionEvent, { type: T }>;

/** `true` iff `K` is a declared property of `T`. */
type HasField<T, K extends PropertyKey> = K extends keyof T ? true : false;

// 1. EXHAUSTIVENESS - every event `type` the SDK can emit is one `PiEvent` recognises (either a mapped
//    kind or a member of `PI_NOISE_EVENT_TYPES`). A Pi bump that introduces a new event type reddens
//    here until we decide to map it or list it as noise: the guard against silently dropping an event
//    we should be tracing. The tuple wrap stops the conditional from distributing, so the whole union
//    is compared at once.
type _AllSdkTypesRecognised = Assert<[AgentSessionEvent["type"]] extends [PiEvent["type"]] ? true : false>;

// 2. MAPPED-FIELD PRESENCE - the fields the mapper dereferences on each mapped variant still exist on
//    the SDK's declaration. Renaming e.g. `tool_execution_end.result` reddens here.
type _ToolStartToolName = Assert<HasField<SdkEvent<"tool_execution_start">, "toolName">>;
type _ToolStartCallId = Assert<HasField<SdkEvent<"tool_execution_start">, "toolCallId">>;
type _ToolStartArgs = Assert<HasField<SdkEvent<"tool_execution_start">, "args">>;
type _ToolEndCallId = Assert<HasField<SdkEvent<"tool_execution_end">, "toolCallId">>;
type _ToolEndResult = Assert<HasField<SdkEvent<"tool_execution_end">, "result">>;
type _ToolEndIsError = Assert<HasField<SdkEvent<"tool_execution_end">, "isError">>;
type _MsgUpdateBody = Assert<HasField<SdkEvent<"message_update">, "assistantMessageEvent">>;
type _TurnEndMessage = Assert<HasField<SdkEvent<"turn_end">, "message">>;
type _AgentEndMessages = Assert<HasField<SdkEvent<"agent_end">, "messages">>;
type _AgentEndWillRetry = Assert<HasField<SdkEvent<"agent_end">, "willRetry">>;

// 3. NON-DRIFT of the field the spike misread - `tool_execution_end` carries `result`, NOT `content`,
//    so the observation output is not silently empty. If a future SDK reintroduces `content`, this
//    reddens so the mapper's source field is re-examined rather than shadowed.
type _ToolEndHasNoContent = Assert<HasField<SdkEvent<"tool_execution_end">, "content"> extends false ? true : false>;

/** Aggregates the assertions so a reader sees they are intentional and none is tree-shaken from review.
 *  A change that violates any assertion above fails to compile before this alias is reached. */
export type PiEventConformance = [
  _AllSdkTypesRecognised,
  _ToolStartToolName,
  _ToolStartCallId,
  _ToolStartArgs,
  _ToolEndCallId,
  _ToolEndResult,
  _ToolEndIsError,
  _MsgUpdateBody,
  _TurnEndMessage,
  _AgentEndMessages,
  _AgentEndWillRetry,
  _ToolEndHasNoContent,
];
